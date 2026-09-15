/**
 * 工程侧通道：graph:save / graph:open、project:choose / create / list / read / write / search /
 * project:run / run:start / run:stop / run:input、project:save / load、extensions:list。
 *
 * 这一组连同它专用的一整套 helper（目录遍历、路径边界、命令白名单与流式执行、审计写入）一起搬出来：
 * 它们此前散在 main.cjs 里，且只被这几条通道使用 —— 留在原处只会让"工程命令怎么被执行"这件事
 * 被窗口逻辑淹没。
 *
 * 依赖：Node 内建与 cnode/toolkit/ragIndex 之类的无状态模块本模块自己 require；
 * 带状态的应用单例（sandbox 执行隔离策略）与 Electron 的 dialog/窗口句柄由 register(ctx) 注入。
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const cnode = require('../cnode.cjs');
const toolkit = require('../tools/toolkit.cjs');
const ragIndex = require('../rag/index.cjs');
const runStore = require('../runStore.cjs');
const agent = require('../agent.cjs');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'target',
  'out',
  'build',
  '.idea',
  '.vscode',
  '.codenode',
  '.cache',
  '.next',
  '.obsidian',
  'logs',
]);

const PROJECT_COMMANDS = new Set([
  'npm', 'npx', 'node', 'git', 'python', 'python3', 'py', 'java', 'javac',
  'mvn', 'mvnw', 'mvnw.cmd', 'gradle', 'gradlew', 'gradlew.bat', 'go', 'cargo',
  'cmd', 'powershell', 'pwsh',
]);

/** 终端会话：sessionId → { sessionId, child, timer, done }（project:run:start/stop/input 共享） */
const projectProcesses = new Map();

async function walkProject(root) {
  const files = [];
  const queue = [''];
  const MAX = 20000;
  while (queue.length && files.length < MAX) {
    const relDir = queue.shift();
    const absDir = path.join(root, relDir);
    let items;
    try {
      items = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (IGNORE_DIRS.has(it.name)) continue;
      const rel = relDir ? `${relDir}/${it.name}` : it.name;
      const abs = path.join(absDir, it.name);
      if (it.isDirectory()) {
        queue.push(rel);
      } else if (it.isFile()) {
        if (files.length >= MAX) break;
        let size = 0;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {}
        files.push({ relPath: rel, size });
      }
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function safeProjectPath(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(root, relPath);
  return full === resolvedRoot || full.startsWith(resolvedRoot + path.sep) ? full : null;
}

function splitProjectCommand(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  for (const c of String(command || '')) {
    if ((c === '"' || c === "'") && !quote) { quote = c; continue; }
    if (c === quote) { quote = ''; continue; }
    if (/\s/.test(c) && !quote) {
      if (current) { tokens.push(current); current = ''; }
    } else current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

function decodeProcessOutput(buf) {
  try {
    const text = Buffer.from(buf || '').toString('utf8');
    return text.includes('\uFFFD') ? Buffer.from(buf || '').toString('latin1') : text;
  } catch { return String(buf || ''); }
}

/** 工程审计：写到 <root>/.codenode/audit.jsonl（脱敏后），失败不抛 */
function auditLog(projectRoot, entry) {
  try {
    if (!projectRoot) return;
    const dir = path.join(projectRoot, '.codenode');
    require('fs').mkdirSync(dir, { recursive: true });
    runStore.appendJsonl(path.join(dir, 'audit.jsonl'), { ts: new Date().toISOString(), entry: agent.redactSecrets(String(entry || '')) });
  } catch {}
}

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   dialog: import('electron').Dialog,
 *   getFocusedWindow: () => import('electron').BrowserWindow | null,
 *   sandbox: any,
 * }} ctx
 */
function register(ctx) {
  const { ipcMain, dialog, getFocusedWindow, sandbox } = ctx;

  /** 与 Agent 工具共用同一套执行隔离策略（同一把锁，不留后门） */
  function spawnProjectProcess(tokens, base, cwd) {
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const policy = sandbox.currentPolicy(null);
    if (process.platform === 'win32' || (base !== 'powershell' && base !== 'pwsh' && base !== 'cmd')) {
      // 需要交互式 stdin：Windows Job 代理会接管 stdin，故这里只在不干扰 stdio 的包装后端下隔离，
      // 其余情况如实降级并写审计（见 sandbox.guardedInteractiveSpawn）
      return sandbox.guardedInteractiveSpawn({ file: tokens[0], args: tokens.slice(1) }, { cwd, env, policy });
    }
    const raw = tokens.slice(1).join(' ');
    if (base === 'cmd') return sandbox.guardedInteractiveSpawn({ file: '/bin/sh', args: ['-lc', raw] }, { cwd, env, policy });
    const sleep = raw.match(/Start-Sleep\s+(?:-Seconds\s+)?(\d+)/i);
    const output = raw.match(/Write-Output\s+(.+)$/i);
    const parts = [];
    if (sleep) parts.push('sleep ' + Math.min(3600, Number(sleep[1])));
    if (output) parts.push("printf '%s\\n' '" + output[1].trim().replace(/^['"]|['"]$/g, '').replace(/'/g, "'\\''") + "'");
    return sandbox.guardedInteractiveSpawn({ file: '/bin/sh', args: ['-lc', parts.join('; ') || 'true'] }, { cwd, env, policy });
  }

  function runProjectCommand(root, command, timeoutSeconds = 120) {
    const tokens = splitProjectCommand(command);
    const base = (tokens[0] || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (!tokens.length) return Promise.resolve({ ok: false, error: '命令为空' });
    if (!PROJECT_COMMANDS.has(base)) return Promise.resolve({ ok: false, error: `命令不在白名单：${tokens[0]}` });
    const cwd = path.resolve(root || '.');
    let child;
    try {
      child = spawnProjectProcess(tokens, base, cwd);
    } catch (e) {
      return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
    }
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const finish = (result) => { if (settled) return; settled = true; resolve(result); };
      const append = (data) => { output += decodeProcessOutput(data); if (output.length > 120000) output = output.slice(-120000); };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, output: output + '\n…（命令超时，已终止）', exitCode: -1, timedOut: true, error: '执行超时' });
      }, Math.max(1, Number(timeoutSeconds) || 120) * 1000);
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, output, exitCode: -1, error: String((e && e.message) || e) }); });
      child.on('close', (exitCode) => { clearTimeout(timer); finish({ ok: exitCode === 0, output, exitCode }); });
    });
  }

  function startProjectStream(event, root, command, timeoutSeconds = 180) {
    const tokens = splitProjectCommand(command);
    const base = (tokens[0] || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (!tokens.length) return { ok: false, error: '命令为空' };
    if (!PROJECT_COMMANDS.has(base)) return { ok: false, error: `命令不在白名单：${tokens[0]}` };
    const sessionId = 'term-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const cwd = path.resolve(root || '.');
    let child;
    try { child = spawnProjectProcess(tokens, base, cwd); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const job = { sessionId, child, timer: null, done: false };
    projectProcesses.set(sessionId, job);
    const send = (payload) => { try { if (!event.sender.isDestroyed()) event.sender.send('project:run:event', { sessionId, ...payload }); } catch {} };
    const finish = (payload) => {
      if (job.done) return;
      job.done = true;
      if (job.timer) clearTimeout(job.timer);
      projectProcesses.delete(sessionId);
      send(payload);
    };
    const output = (data) => send({ kind: 'output', text: decodeProcessOutput(data) });
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    job.timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ kind: 'done', exitCode: -1, timedOut: true, error: '执行超时' }); }, Math.max(1, Number(timeoutSeconds) || 180) * 1000);
    child.on('error', (e) => finish({ kind: 'error', exitCode: -1, error: String((e && e.message) || e) }));
    child.on('close', (exitCode) => finish({ kind: 'done', exitCode }));
    return { ok: true, sessionId };
  }

  ipcMain.handle('graph:save', async (_event, payload) => {
    const { canceled, filePath } = await dialog.showSaveDialog(getFocusedWindow(), {
      title: '另存为 CodeNode 工程',
      defaultPath: 'workflow.cnode',
      filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, cnode.encodeCnode(payload));
    return { ok: true, filePath };
  });

  ipcMain.handle('graph:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getFocusedWindow(), {
      title: '打开 CodeNode 工程',
      filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { ok: false };
    const data = fs.readFileSync(filePaths[0]);
    const dec = cnode.decodeCnode(data);
    if (!dec.ok) return { ok: false, filePath: filePaths[0], error: dec.error };
    return {
      ok: true,
      filePath: filePaths[0],
      data: {
        graph: dec.graph,
        workspace: dec.workspace,
        manifest: dec.manifest,
        canvases: dec.canvases || null,
        warnings: dec.warnings,
      },
    };
  });

  ipcMain.handle('project:choose', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getFocusedWindow(), {
      title: '选择项目目录',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return { ok: false };
    return { ok: true, root: filePaths[0] };
  });

  ipcMain.handle('project:create', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(getFocusedWindow(), {
      title: '新建 CodeNode 项目',
      defaultPath: '未命名项目.cnode',
      filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
    });
    if (canceled || !filePath) return { ok: false };
    const buf = cnode.encodeCnode({
      graph: { revision: 1, nodes: [], edges: [] },
      workspace: { viewport: { x: 0, y: 0, zoom: 1 } },
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return { ok: true, filePath, root: path.dirname(filePath) };
  });

  ipcMain.handle('project:list', async (_event, root) => {
    try {
      const files = await walkProject(root);
      return { ok: true, files };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('project:read', async (_event, root, relPath, options) => {
    try {
      const resolvedRoot = path.resolve(root);
      const full = path.resolve(root, relPath);
      if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
        return { ok: false, error: '路径越界' };
      }
      // 二进制读取（图像节点用）：只接受图片扩展名，转成 data URL 给渲染进程显示
      if (options && options.binary) {
        const ext = path.extname(full).toLowerCase();
        const mimeByExt = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
        };
        const mime = mimeByExt[ext];
        if (!mime) return { ok: false, error: '不是支持的图片格式：' + (ext || '未知') };
        const MAX_IMG = 8 * 1024 * 1024;
        const stat = await fsp.stat(full);
        if (stat.size > MAX_IMG) {
          return { ok: false, error: `图片过大（${(stat.size / 1048576).toFixed(1)}MB，上限 8MB）` };
        }
        const buf = await fsp.readFile(full);
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, mtimeMs: stat.mtimeMs };
      }
      const MAX = 1024 * 1024;
      const buf = await fsp.readFile(full, 'utf-8');
      const stat = await fsp.stat(full);
      const truncated = buf.length > MAX;
      return { ok: true, content: truncated ? buf.slice(0, MAX) : buf, truncated, mtimeMs: stat.mtimeMs };
    } catch {
      return { ok: false, error: '无法读取（可能为二进制文件）' };
    }
  });

  ipcMain.handle('project:write', async (_event, root, relPath, content, backup = true, expectedMtimeMs) => {
    try {
      const full = safeProjectPath(root, relPath);
      if (!full || !String(relPath || '').trim()) return { ok: false, error: '路径越界或为空' };
      const value = String(content ?? '');
      if (expectedMtimeMs != null && fs.existsSync(full)) {
        const current = (await fsp.stat(full)).mtimeMs;
        if (Math.abs(current - Number(expectedMtimeMs)) > 1) return { ok: false, conflict: true, currentContent: await fsp.readFile(full, 'utf8'), currentMtimeMs: current, error: '文件已被外部修改' };
      }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      if (backup && fs.existsSync(full)) await fsp.copyFile(full, full + '.bak');
      await fsp.writeFile(full, value, 'utf-8');
      try { ragIndex.invalidateProjectIndex(root, relPath); } catch {}
      auditLog(root, `editor_write ${relPath} bytes=${Buffer.byteLength(value, 'utf8')}`);
      return { ok: true, bytes: Buffer.byteLength(value, 'utf8'), mtimeMs: (await fsp.stat(full)).mtimeMs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('project:search', async (_event, root, query, maxResults = 80) => {
    try {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return { ok: true, matches: [] };
      const limit = Math.max(1, Number(maxResults) || 80);
      const files = await walkProject(root);
      const matches = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        if (file.size > 1024 * 1024) continue;
        const full = safeProjectPath(root, file.relPath);
        if (!full) continue;
        let content;
        try { content = await fsp.readFile(full, 'utf8'); } catch { continue; }
        if (content.includes('\u0000')) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: file.relPath, line: i + 1, text: lines[i].trim().slice(0, 220) });
          }
        }
      }
      return { ok: true, matches };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('project:run', async (_event, root, command, timeoutSeconds) => {
    return runProjectCommand(root || '.', command, timeoutSeconds);
  });

  ipcMain.handle('project:run:start', async (event, root, command, timeoutSeconds) => {
    return startProjectStream(event, root || '.', command, timeoutSeconds);
  });

  ipcMain.handle('project:run:stop', async (_event, sessionId) => {
    const job = projectProcesses.get(String(sessionId || ''));
    if (!job) return { ok: false };
    try { job.child.kill('SIGTERM'); } catch {}
    return { ok: true };
  });

  ipcMain.handle('project:run:input', async (_event, sessionId, input) => {
    const job = projectProcesses.get(String(sessionId || ''));
    if (!job || job.done || !job.child?.stdin?.writable) return { ok: false };
    try { job.child.stdin.write(String(input ?? '') + '\n'); return { ok: true }; } catch { return { ok: false }; }
  });

  ipcMain.handle('extensions:list', async (_event, root) => {
    const builtins = toolkit.buildDefaultRegistryWithConfig({}).listTools().map((tool) => ({
      name: tool.name,
      kind: '内置工具',
      description: tool.description,
      enabled: true,
      source: 'CodeNode Toolkit',
    }));
    const files = [
      root && path.join(root, '.codenode', 'extensions.json'),
      root && path.join(root, 'config', 'extensions.json'),
    ].filter(Boolean);
    for (const file of files) {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.extensions) ? parsed.extensions : [];
        for (const item of list) {
          if (!item || !item.name) continue;
          builtins.push({
            name: String(item.name),
            kind: String(item.kind || '项目扩展'),
            description: String(item.description || ''),
            enabled: item.enabled !== false,
            source: file,
          });
        }
        break;
      } catch {}
    }
    return { ok: true, extensions: builtins };
  });

  ipcMain.handle('project:save', async (_event, target, payload) => {
    try {
      if (!target) return { ok: false, error: '未指定保存位置' };
      const isFile = String(target).toLowerCase().endsWith('.cnode');
      const filePath = isFile ? path.resolve(target) : path.join(path.resolve(target), 'workflow.cnode');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, cnode.encodeCnode(payload));
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('project:load', async (_event, target) => {
    try {
      const isFile = String(target).toLowerCase().endsWith('.cnode');
      const filePath = isFile ? path.resolve(target) : path.join(path.resolve(target), 'workflow.cnode');
      const data = fs.readFileSync(filePath);
      const dec = cnode.decodeCnode(data);
      if (!dec.ok) return { ok: false, error: dec.error };
      return {
        ok: true,
        filePath,
        data: {
          graph: dec.graph,
          workspace: dec.workspace,
          manifest: dec.manifest,
          canvases: dec.canvases || null,
          warnings: dec.warnings,
        },
      };
    } catch {
      return { ok: false, error: '未找到 .cnode 工程文件' };
    }
  });
}

module.exports = { register, auditLog, safeProjectPath, walkProject, splitProjectCommand };
