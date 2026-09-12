const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const APP_ICON_SOURCE = path.join(__dirname, '..', 'codenode-icon.png');

function resolveAppIcon() {
  if (fs.existsSync(APP_ICON)) return APP_ICON;
  if (fs.existsSync(APP_ICON_SOURCE)) return APP_ICON_SOURCE;
  return undefined;
}

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.codenode.desktop');
  } catch {}
}

// Windows 控制台切换为 UTF-8，避免终端面板打印中文乱码
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001 >nul', { stdio: 'ignore' });
  } catch {}
}

/**
 * 控制台日志面板：把主进程的 console.log/info/warn/error 同时写入
 * <exe 目录>/logs/console.log。打包后的便携版 exe 没有附着控制台，配合
 * “CodeNode 控制台.cmd”启动器（桌面快捷方式指向它）即可在独立的 cmd 面板实时查看日志。
 */
function setupConsoleLog() {
  try {
    const dir = path.join(path.dirname(process.execPath), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'console.log');
    const stamp = () => '[' + new Date().toISOString() + '] ';
    const toStr = (a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return String(a && a.stack ? a.stack : a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const write = (args) => {
      try {
        fs.appendFileSync(file, stamp() + args.map(toStr).join(' ') + '\n', 'utf-8');
      } catch {}
    };
    const hook = (original) =>
      function (...args) {
        write(args);
        if (original) original.apply(console, args);
      };
    console.log = hook(console.log);
    console.info = hook(console.info);
    console.warn = hook(console.warn);
    console.error = hook(console.error);
  } catch {}
}
setupConsoleLog();

const cnode = require('./cnode.cjs');
const agent = require('./agent.cjs');
const ragIndex = require('./rag/index.cjs');
const toolkit = require('./tools/toolkit.cjs');
const modelStore = require('./modelStore.cjs');
const { GraphModel } = require('./tools/GraphModel.cjs');
const { AgentToolContext } = require('./tools/context.cjs');
const { makeBridge } = require('./tools/bridge.cjs');
const { getScalarStore } = require('./scalars/index.cjs');
const memoryStore = require('./memory.cjs');
const runStore = require('./runStore.cjs');
const extensionStore = require('./tools/extensions.cjs');
const { SubagentManager } = require('./subagents.cjs');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** 正在运行的 Agent 请求：requestId → AbortController（用于「停止思考」） */
const activeRequests = new Map();

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

const PROJECT_COMMANDS = new Set([
  'npm', 'npx', 'node', 'git', 'python', 'python3', 'py', 'java', 'javac',
  'mvn', 'mvnw', 'mvnw.cmd', 'gradle', 'gradlew', 'gradlew.bat', 'go', 'cargo',
  'cmd', 'powershell', 'pwsh',
]);
const projectProcesses = new Map();

function decodeProcessOutput(buf) {
  try {
    const text = Buffer.from(buf || '').toString('utf8');
    return text.includes('\uFFFD') ? Buffer.from(buf || '').toString('latin1') : text;
  } catch { return String(buf || ''); }
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

function spawnProjectProcess(tokens, base, cwd) {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  if (process.platform === 'win32' || (base !== 'powershell' && base !== 'pwsh' && base !== 'cmd')) {
    return spawn(tokens[0], tokens.slice(1), { cwd, shell: false, windowsHide: true, env });
  }
  const raw = tokens.slice(1).join(' ');
  if (base === 'cmd') return spawn('/bin/sh', ['-lc', raw], { cwd, shell: false, env });
  const sleep = raw.match(/Start-Sleep\s+(?:-Seconds\s+)?(\d+)/i);
  const output = raw.match(/Write-Output\s+(.+)$/i);
  const parts = [];
  if (sleep) parts.push('sleep ' + Math.min(3600, Number(sleep[1])));
  if (output) parts.push("printf '%s\\n' '" + output[1].trim().replace(/^['"]|['"]$/g, '').replace(/'/g, "'\\''") + "'");
  return spawn('/bin/sh', ['-lc', parts.join('; ') || 'true'], { cwd, shell: false, env });
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'CodeNode Next',
    backgroundColor: '#14161a',
    icon: resolveAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.CODENODE_TEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const report = await win.webContents.executeJavaScript(`(async()=>{
          const out = { hasApi: !!window.codenode, keys: window.codenode ? Object.keys(window.codenode) : [] };
          try { const r = await window.codenode.listProject('E:\\\\codenode_nw\\\\codenode-desktop-next'); out.list = { ok: r.ok, n: r.files && r.files.length, err: r.error }; } catch(e){ out.list = 'THREW:'+e.message; }
          try { const r = await window.codenode.readProjectFile('E:\\\\codenode_nw\\\\codenode-desktop-next','src/App.tsx'); out.read = { ok: r.ok, len: r.content && r.content.length, err: r.error }; } catch(e){ out.read = 'THREW:'+e.message; }
          const tproj = 'E:\\\\codenode_nw\\\\logs\\\\testproj\\\\我的项目.cnode';
          try { const s = await window.codenode.saveProject(tproj, { graph: { nodes: [{ id: 'n1', type: 'task' }], edges: [] }, workspace: { viewport: { x: 0, y: 0, zoom: 1 } } }); out.save = { ok: s.ok, filePath: s.filePath, err: s.error }; } catch(e){ out.save = 'THREW:'+e.message; }
          try { const l = await window.codenode.loadProject(tproj); out.load = { ok: l.ok, nodes: l.data && l.data.graph && l.data.graph.nodes && l.data.graph.nodes.length, manifest: l.data && l.data.manifest && l.data.manifest.format, warn: l.data && l.data.warnings, err: l.error }; } catch(e){ out.load = 'THREW:'+e.message; }
          try {
            const gres = await (async()=>{
              const st = window.__codenodeStore;
              if (!st) return { error: 'no store' };
              const g = st.getState();
              g.load([
                { id:'n1', type:'start', position:{x:0,y:0}, data:{label:'开始',status:'done'} },
                { id:'n2', type:'task', position:{x:200,y:0}, data:{label:'任务',status:'pending'} },
                { id:'n3', type:'end', position:{x:400,y:0}, data:{label:'结束',status:'pending'} }
              ], [ { id:'e1', source:'n1', target:'n2' }, { id:'e2', source:'n2', target:'n3' } ]);
              g.layoutNodes();
              await new Promise((r)=>setTimeout(r,200));
              const s = st.getState();
              const xs = s.nodes.map(n=>Math.round(n.position.x)).sort((a,b)=>a-b);
              const ys = s.nodes.map(n=>Math.round(n.position.y));
              const rows = new Set(ys).size;
              return {
                nodeCount: s.nodes.length,
                singleRow: rows === 1,
                ascending: xs.every((v,i)=>i===0||v>xs[i-1]),
                groupNodes: s.nodes.filter(n=>n.type==='group').length
              };
            })();
            out.layout = gres;
          } catch(e){ out.layout = 'THREW:'+e.message; }
          try {
            const persist = await (async()=>{
              const st = window.__codenodeStore;
              const d = st.getState().getDocument();
              const save = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode', {
                graph: d,
              });
              const load = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode');
              return {
                saved: save.ok,
                loaded: load.ok,
                nodes: load.data && load.data.graph && load.data.graph.nodes && load.data.graph.nodes.length
              };
            })();
            out.persist = persist;
          } catch(e){ out.persist = 'THREW:'+e.message; }
          try {
            const ag = await (async()=>{
              const g = await window.codenode.agentGreeting(null);
              const c = await window.codenode.agentConfig(null);
              const chat = await window.codenode.agentChat({ projectRoot: null, prompt: 'hi', history: [], canvasSummary: '[]' });
              return { greeting: g, config: c, chat };
            })();
            out.agent = ag;
          } catch(e){ out.agent = 'THREW:'+e.message; }
          try {
            const cw = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'scope-t', type:'scope', position:{x:120,y:120}, data:{ label:'范围', status:'pending', width:320, height:220, childIds:[] } });
              g.addNode({ id:'task-t', type:'task', position:{x:180,y:180}, data:{ label:'任务', status:'pending' } });
              g.addToScope('task-t', 'scope-t');
              await new Promise((r)=>setTimeout(r,200));
              const s = st.getState();
              const scope = s.nodes.find((n)=>n.type==='scope');
              return {
                scopes: s.nodes.filter((n)=>n.type==='scope').length,
                tasks: s.nodes.filter((n)=>n.type==='task').length,
                memberCount: scope && scope.data && scope.data.childIds ? scope.data.childIds.length : 0
              };
            })();
            out.chatwindow = cw;
          } catch(e){ out.chatwindow = 'THREW:'+e.message; }
          try {
            const sc = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'t1', type:'task', position:{x:100,y:100}, data:{label:'任务',status:'done'} });
              g.addNode({ id:'s1', type:'scope', position:{x:100,y:340}, data:{label:'范围',status:'pending',width:320,height:220,childIds:['t1']} });
              const doc = st.getState().getDocument();
              const payload = { graph: doc, workspace:{viewport:{x:0,y:0,zoom:1}}, manifest: {} };
              const s = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode', payload);
              const l = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode');
              const nodes = (l.data && l.data.graph && l.data.graph.nodes) || [];
              const scopeNode = nodes.find((n)=>n.type==='scope');
              return {
                saved: s.ok, loaded: l.ok, saveErr: s.error,
                types: nodes.map((n)=>n.type).sort().join(','),
                taskCount: nodes.filter((n)=>n.type==='task').length,
                scopeMembers: scopeNode && scopeNode.data && scopeNode.data.childIds ? scopeNode.data.childIds.join(',') : ''
              };
            })();
            out.savechat = sc;
          } catch(e){ out.savechat = 'THREW:'+e.message; }
          try {
            const sv = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'t1', type:'task', position:{x:50,y:50}, data:{label:'任务A',status:'pending',prompt:''} });
              g.addNode({ id:'t2', type:'task', position:{x:300,y:50}, data:{label:'任务B',status:'done',prompt:''} });
              g.onConnect({ source:'t1', target:'t2' });
              // 模拟 projectActions.buildPayload()
              const doc = st.getState().getDocument();
              const payload = {
                graph: doc,
                workspace: { viewport: { x: 5, y: 6, zoom: 1 } },
                manifest: { name: '保存链路测试', documentId: 'save-test-doc' }
              };
              const dir = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir';
              const file = dir + '\\\\proj.cnode';
              const sDir = await window.codenode.saveProject(dir, payload);
              const sFile = await window.codenode.saveProject(file, payload);
              const lFile = await window.codenode.loadProject(file);
              return {
                sDir: { ok: sDir.ok, filePath: sDir.filePath, err: sDir.error },
                sFile: { ok: sFile.ok, filePath: sFile.filePath, err: sFile.error },
                lFile: { ok: lFile.ok, nodes: lFile.data && lFile.data.graph && lFile.data.graph.nodes && lFile.data.graph.nodes.length, edges: lFile.data && lFile.data.graph && lFile.data.graph.edges && lFile.data.graph.edges.length, warn: lFile.data && lFile.data.warnings, err: lFile.error }
              };
            })();
            out.savetest = sv;
          } catch(e){ out.savetest = 'THREW:'+e.message; }
          try {
            const sess = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂内容');
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请在画布创建 2 个任务节点并连线。');
              const s1 = window.__codenodeSession.getState();
              const first = s1.sessions[s1.order[0]];
              const active = s1.current();
              return {
                chatOk: !!r.reply || r.tools.length > 0,
                sessionCount: s1.order.length,
                activeLabel: active ? active.label : null,
                activeNodes: active ? active.doc.root.nodes.length : -1,
                completed: s1.order.filter((id)=>s1.sessions[id].status==='completed').length,
                firstNodeCount: first ? first.doc.root.nodes.length : -1,
                graphNodes: window.__codenodeStore.getState().nodes.length
              };
            })();
            out.sessionsim = sess;
          } catch(e){ out.sessionsim = 'THREW:'+e.message; }
          try {
            const sp = await (async()=>{
              const ss = window.__codenodeSession.getState();
              ss.syncActiveGraph();
              const active = ss.current();
              const sessions = ss.order.map((id)=>ss.sessions[id]).filter(Boolean).map((s)=>({
                id: s.id, label: s.label, prompt: s.prompt, status: s.status,
                createdAt: s.createdAt, nodeCount: s.nodeCount, summary: s.summary || '',
                root: s.doc.root
              }));
              const file = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir\\\\sessions.cnode';
              const payload = {
                graph: active ? active.doc.root : { nodes: [], edges: [] },
                canvases: { sessions, messages: ss.messages },
                workspace: { viewport: { x:0, y:0, zoom:1 } },
                manifest: { name: '会话持久化测试' }
              };
              const s = await window.codenode.saveProject(file, payload);
              const l = await window.codenode.loadProject(file);
              const sess2 = l.data && l.data.canvases && l.data.canvases.sessions;
              return {
                saved: s.ok,
                loaded: l.ok,
                stored: Array.isArray(sess2) ? sess2.length : 0,
                lastNodes: sess2 && sess2[sess2.length-1] ? sess2[sess2.length-1].root.nodes.length : -1,
                lastLabel: sess2 && sess2[sess2.length-1] ? sess2[sess2.length-1].label : null,
                messages: l.data && l.data.canvases && Array.isArray(l.data.canvases.messages) ? l.data.canvases.messages.length : 0
              };
            })();
            out.sesspersist = sp;
          } catch(e){ out.sesspersist = 'THREW:'+e.message; }
          try {
            const rc = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂内容');
              // 模拟用户手动新建节点
              graph.addNode({ id:'m1', type:'task', position:{x:40,y:40}, data:{label:'节点甲',status:'pending',prompt:''} });
              graph.addNode({ id:'m2', type:'task', position:{x:240,y:40}, data:{label:'节点乙',status:'pending',prompt:''} });
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请阅读画布中的节点并制作：把两个节点连接起来，并说明每个节点应该做什么。');
              const s1 = window.__codenodeSession.getState();
              const active = s1.current();
              const lastAgent = [...s1.messages].reverse().find((m)=>m.role==='assistant');
              const toolNames = (lastAgent && lastAgent.tools ? lastAgent.tools.map(t=>t.name) : []);
              const wbm = lastAgent && lastAgent.tools ? lastAgent.tools.find(t=>t.name==='get_workbench_model') : null;
              return {
                chatOk: !!r.reply || r.tools.length>0,
                sessionCount: s1.order.length,
                activeLabel: active ? active.label : null,
                activeNodes: active ? active.doc.root.nodes.length : -1,
                toolNames: toolNames.join(','),
                wbmSawNodes: !!(wbm && JSON.stringify(wbm.data || '').indexOf('节点甲') >= 0),
                replyHasNodes: !!(r.reply && r.reply.indexOf('节点甲') >= 0)
              };
            })();
            out.readcanvas = rc;
          } catch(e){ out.readcanvas = 'THREW:'+e.message; }
          try {
            const lt = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              // 加载用户保存的 t9.cnode（节点在画布1，画布2/3 为空）
              const l = await window.codenode.loadProject('E:\\\\Dev_1\\\\t9.cnode');
              const sessData = l.data && l.data.canvases && l.data.canvases.sessions;
              if (Array.isArray(sessData)) {
                const list = sessData.map((sd, i)=>({
                  id: sd.id || ('c'+i), label: sd.label || ('画布'+(i+1)), prompt: sd.prompt || '',
                  status: (sd.status==='active'||sd.status==='completed') ? sd.status : 'active',
                  createdAt: sd.createdAt||0, nodeCount: sd.nodeCount||0, summary: sd.summary||'',
                  doc: { root: { nodes: sd.root ? sd.root.nodes : [], edges: sd.root ? sd.root.edges : [] } }
                }));
                ss.restoreSessions(list, (l.data.canvases.messages)||[], undefined);
              }
              const s1 = window.__codenodeSession.getState();
              const active = s1.current();
              const before = { label: active?active.label:null, nodes: active?active.doc.root.nodes.length:-1 };
              // 让 Agent 阅读画布并制作
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请阅读当前画布上的全部节点并制作。');
              const s2 = window.__codenodeSession.getState();
              const a2 = s2.current();
              const lastAgent = [...s2.messages].reverse().find((m)=>m.role==='assistant');
              const wbm = lastAgent && lastAgent.tools ? lastAgent.tools.find(t=>t.name==='get_workbench_model') : null;
              return {
                loaded: l.ok,
                beforeLabel: before.label,
                beforeNodes: before.nodes,
                afterLabel: a2 ? a2.label : null,
                afterNodes: a2 ? a2.doc.root.nodes.length : -1,
                sessionCount: s2.order.length,
                wbmDataLen: wbm ? JSON.stringify(wbm.data||'').length : 0,
                replyOk: !!r.reply
              };
            })();
            out.loadt9 = lt;
          } catch(e){ out.loadt9 = 'THREW:'+e.message; }
          try {
            const mt = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂');
              const chat = window.__codenodeChat.getState();
              await chat.send('请创建 2 个任务节点并连线。');
              const s1 = window.__codenodeSession.getState();
              const c2 = s1.current();
              await chat.send('请阅读当前画布并继续制作：在每个节点后补充一个说明节点。');
              const s2 = window.__codenodeSession.getState();
              const c3 = s2.current();
              await new Promise((r)=>setTimeout(r, 1100));
              // 检查横向自动整理
              const nodes = window.__codenodeStore.getState().nodes;
              const xs = nodes.map(n=>Math.round(n.position.x));
              const ys = nodes.map(n=>Math.round(n.position.y));
              const sorted = [...xs].sort((a,b)=>a-b);
              const horizontal = xs.length>1 && sorted[sorted.length-1] > sorted[0];
              const rows = new Set(ys).size;
              return {
                turn1Canvas: c2 ? c2.label : null,
                turn1Nodes: c2 ? c2.doc.root.nodes.length : -1,
                turn2Canvas: c3 ? c3.label : null,
                turn2Nodes: c3 ? c3.doc.root.nodes.length : -1,
                sessionCount: s2.order.length,
                nodeCount: nodes.length,
                horizontal: horizontal,
                rowCount: rows
              };
            })();
            out.multiturn = mt;
          } catch(e){ out.multiturn = 'THREW:'+e.message; }
          try {
            const lw = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('', '');
              for(let i=1;i<=15;i++){
                graph.addNode({ id:'w'+i, type:'task', position:{x:40,y:40}, data:{label:'节点'+i,status:'pending'} });
              }
              graph.layoutNodes();
              await new Promise((r)=>setTimeout(r,150));
              const nodes = window.__codenodeStore.getState().nodes;
              const xs = nodes.map(n=>Math.round(n.position.x)).sort((a,b)=>a-b);
              const ys = nodes.map(n=>Math.round(n.position.y));
              const rows = new Set(ys).size;
              const ascending = xs.every((v,i)=>i===0||v>xs[i-1]);
              return { count: nodes.length, rowCount: rows, firstRowXAscending: ascending, singleLine: rows === 1 };
            })();
            out.layoutwrap = lw;
          } catch(e){ out.layoutwrap = 'THREW:'+e.message; }
          return out;
        })()`);
        require('fs').mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
        require('fs').writeFileSync(
          path.join(__dirname, '..', 'logs', 'test-report.json'),
          JSON.stringify(report, null, 2),
          'utf-8'
        );
      } catch (e) {
        require('fs').writeFileSync(
          path.join(__dirname, '..', 'logs', 'test-report.json'),
          JSON.stringify({ hookError: String((e && e.stack) || e) }),
          'utf-8'
        );
      }
      app.exit(0);
    });
  }
}

ipcMain.handle('graph:save', async (_event, payload) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '另存为 CodeNode 工程',
    defaultPath: 'workflow.cnode',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
  });
  if (canceled || !filePath) return { ok: false };
  require('fs').writeFileSync(filePath, cnode.encodeCnode(payload));
  return { ok: true, filePath };
});

ipcMain.handle('graph:open', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 CodeNode 工程',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const data = require('fs').readFileSync(filePaths[0]);
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
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  return { ok: true, root: filePaths[0] };
});

ipcMain.handle('project:create', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '新建 CodeNode 项目',
    defaultPath: '未命名项目.cnode',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const buf = cnode.encodeCnode({
    graph: { revision: 1, nodes: [], edges: [] },
    workspace: { viewport: { x: 0, y: 0, zoom: 1 } },
  });
  require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
  require('fs').writeFileSync(filePath, buf);
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

ipcMain.handle('project:read', async (_event, root, relPath) => {
  try {
    const resolvedRoot = path.resolve(root);
    const full = path.resolve(root, relPath);
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, error: '路径越界' };
    }
    const MAX = 1024 * 1024;
    const buf = await fsp.readFile(full, 'utf-8');
    const stat = await fsp.stat(full);
    const truncated = buf.length > MAX;
    return { ok: true, content: truncated ? buf.slice(0, MAX) : buf, truncated, mtimeMs: stat.mtimeMs };
  } catch (e) {
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
    const files = await walkProject(root);
    const matches = [];
    for (const file of files) {
      if (matches.length >= Math.max(1, Number(maxResults) || 80)) break;
      if (file.size > 1024 * 1024) continue;
      const full = safeProjectPath(root, file.relPath);
      if (!full) continue;
      let content;
      try { content = await fsp.readFile(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000')) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < Math.max(1, Number(maxResults) || 80); i++) {
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
    require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
    require('fs').writeFileSync(filePath, cnode.encodeCnode(payload));
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:load', async (_event, target) => {
  try {
    const isFile = String(target).toLowerCase().endsWith('.cnode');
    const filePath = isFile ? path.resolve(target) : path.join(path.resolve(target), 'workflow.cnode');
    const data = require('fs').readFileSync(filePath);
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
  } catch (e) {
    return { ok: false, error: '未找到 .cnode 工程文件' };
  }
});

function auditLog(projectRoot, entry) {
  try {
    if (!projectRoot) return;
    const dir = path.join(projectRoot, '.codenode');
    require('fs').mkdirSync(dir, { recursive: true });
    runStore.appendJsonl(path.join(dir, 'audit.jsonl'), { ts: new Date().toISOString(), entry: agent.redactSecrets(String(entry || '')) });
  } catch {}
}

/** 保存文档到工程文件（save_project 工具用）。 */
function saveDoc(projectRoot, projectFile, model) {
  const doc = model ? model.doc : null;
  const graph = (doc && doc.root) || { nodes: [], edges: [] };
  const filePath = projectFile
    ? path.resolve(projectFile)
    : path.join(path.resolve(projectRoot || '.'), 'workflow.cnode');
  require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
  require('fs').writeFileSync(
    filePath,
    cnode.encodeCnode({
      graph,
      workspace: {},
      manifest: {},
    })
  );
  return filePath;
}

ipcMain.handle('agent:config', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  const store = modelStore.getModels(app.getPath('userData'), cfg);
  return {
    configured: !!cfg.apiKey,
    model: cfg.model,
    soul,
    toolsEnabled: cfg.tools.toolsEnabled,
    ragEnabled: cfg.rag.enabled,
    models: modelStore.toPublicModels(store.models),
    activeModelId: store.activeId,
  };
});

// ---- 多模型接入管理（models.json，userData） ----
ipcMain.handle('models:list', async (_event) => {
  const cfg = agent.loadConfig(null);
  const store = modelStore.getModels(app.getPath('userData'), cfg);
  return { models: modelStore.toPublicModels(store.models), activeId: store.activeId };
});

ipcMain.handle('models:save', async (_event, model) => {
  if (!model || !model.id) return { ok: false, error: '缺少模型 id' };
  const cfg = agent.loadConfig(null);
  const userDataDir = app.getPath('userData');
  const store = modelStore.getModels(userDataDir, cfg);
  const existing = store.models.find((item) => item && item.id === model.id);
  const incoming = { ...model };
  // UI 不会回传已保存的密钥；空值表示保留主进程中的旧密钥。
  if (!String(incoming.apiKey || '').trim() && existing && existing.apiKey) incoming.apiKey = existing.apiKey;
  delete incoming.apiKeySet;
  const models = store.models.filter((m) => m.id !== incoming.id);
  models.push(incoming);
  modelStore.writeModels(userDataDir, models, store.activeId || model.id);
  return { ok: true, models: modelStore.toPublicModels(models), activeId: store.activeId || model.id };
});

ipcMain.handle('models:delete', async (_event, id) => {
  const cfg = agent.loadConfig(null);
  const userDataDir = app.getPath('userData');
  const store = modelStore.getModels(userDataDir, cfg);
  const models = store.models.filter((m) => m.id !== id);
  const activeId = store.activeId === id ? (models[0] ? models[0].id : null) : store.activeId;
  modelStore.writeModels(userDataDir, models, activeId);
  return { ok: true, models: modelStore.toPublicModels(models), activeId };
});

ipcMain.handle('models:active', async (_event, id) => {
  const cfg = agent.loadConfig(null);
  const userDataDir = app.getPath('userData');
  const store = modelStore.getModels(userDataDir, cfg);
  if (!store.models.some((m) => m.id === id)) return { ok: false, error: '模型不存在' };
  modelStore.writeModels(userDataDir, store.models, id);
  return { ok: true, activeId: id };
});

ipcMain.handle('agent:greeting', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  return { greeting: soul.greeting, name: soul.name, configured: !!cfg.apiKey };
});

ipcMain.handle('agent:tools', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot });
  const subagentManager = new SubagentManager({ agent, toolkit, cfg, registry });
  subagentManager.register(registry);
  toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot });
  return {
    enabled: cfg.tools.toolsEnabled,
    tools: registry.listTools().map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    })),
  };
});

ipcMain.handle('agent:chat', async (event, payload) => {
  const { projectRoot, prompt, history, canvasSummary, nodeId, requestId, document, projectFile, modelId, model: reqModel, reasoningEffort: reqEffort } = payload || {};
  const sender = event.sender;
  let runId = null;
  const sendDelta = (d) => {
    if (!sender.isDestroyed()) sender.send('agent:delta', { requestId, ...d });
  };
  try {
    const cfg = agent.loadConfig(projectRoot);
    const maxConcurrentRuns = Number(cfg.limits && cfg.limits.maxConcurrentRuns) || 2;
    if (requestId && activeRequests.has(requestId)) return { ok: false, error: '重复的 Agent requestId' };
    if (activeRequests.size >= maxConcurrentRuns) return { ok: false, error: '当前 Agent 正在执行其他任务，请稍后再试（并发上限 ' + maxConcurrentRuns + '）' };
    // 优先按 modelId 从 models.json 读取该模型的接入配置（apiBase/apiKey/model）
    const baseCfg = agent.loadConfig(null);
    const sel = modelId ? modelStore.findModel(app.getPath('userData'), baseCfg, modelId) : null;
    if (sel) {
      if (sel.apiBase) cfg.apiBase = sel.apiBase;
      if (sel.apiKey) cfg.apiKey = sel.apiKey;
      if (sel.model) cfg.model = sel.model;
    } else if (reqModel) {
      cfg.model = reqModel;
    }
    if (reqEffort) cfg.reasoningEffort = reqEffort;
    if (!cfg.apiKey) {
      return { ok: false, error: '未配置 API Key（模型管理中填写或 config/agent.properties）' };
    }
    runId = runStore.normalizeRunId(requestId || 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    runStore.recoverInterrupted(projectRoot);
    runStore.startRun(projectRoot, runId, { prompt: String(prompt || '').slice(0, 4000), model: cfg.model, nodeId: nodeId || null });
    const onAgentDelta = (delta) => {
      sendDelta(delta);
      if (!delta || !delta.kind) return;
      if (delta.kind === 'tool_result' && Array.isArray(delta.toolCalls)) {
        runStore.appendEvent(projectRoot, runId, 'tool_result', {
          tools: delta.toolCalls.map((item) => ({ name: item && item.name, ok: item && item.ok, elapsedMs: item && item.elapsedMs })),
        });
      } else if (['start', 'error', 'stopped', 'done'].includes(delta.kind)) {
        runStore.appendEvent(projectRoot, runId, delta.kind, { error: delta.error || null });
      }
    };
    const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));

    // 先装配工具注册表：用于系统提示中的工具引导，也用于工具循环
    let registry = null;
    if (cfg.tools.toolsEnabled) {
      registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot });
    }
    let subagentManager = null;
    if (registry) {
      subagentManager = new SubagentManager({
        agent,
        toolkit,
        cfg,
        registry,
        runId,
        onDelta: onAgentDelta,
      });
      subagentManager.register(registry);
      toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot });
    }
    const toolGuide = agent.buildToolGuide(registry ? registry.listTools() : []);
    const memory = projectRoot ? memoryStore.readMemory(projectRoot) : { entries: [] };
    const memoryText = memory.entries.slice(-30).map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content}`).join('\n');
    const skills = projectRoot ? extensionStore.readManifest(projectRoot).filter((item) => String(item.kind || '').toLowerCase() === 'skills') : [];
    const skillsText = skills.map((item) => `- ${item.name}: ${item.instructions || item.description || '按项目扩展定义执行'}`).join('\n');
    const messages = [{ role: 'system', content: agent.buildSystemPrompt(soul, canvasSummary, toolGuide, memoryText, skillsText) }];
    for (const m of history || []) {
      if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: prompt });
    agent.logConversation(projectRoot, {
      ts: new Date().toISOString(),
      role: 'user',
      content: prompt,
      nodeId: nodeId || null,
    });

    // ---- 装配工具 ----
    let tools = null;
    let model = null;
    let bridge = null;
    let dirty = false;
    const controller = new AbortController();
    if (registry && registry.listTools().length > 0) {
        bridge = makeBridge(sender);
        model = new GraphModel(document || undefined);
        const scalarStore = cfg.scalars && cfg.scalars.enabled !== false && projectRoot ? getScalarStore(projectRoot) : null;
        const undoStack = [];
        const redoStack = [];
        const context = new AgentToolContext({
          projectRoot,
          model,
          runId: requestId || '',
          role: 'supervisor',
          signal: controller.signal,
          scalarStore,
          confirm: (level, what, detail) => bridge.confirm(level, what, detail),
          askUser: (question, options) => bridge.askUser(question, options),
          ui: (action, args) => bridge.ui(action, args),
          audit: (entry) => {
            auditLog(projectRoot, entry);
            runStore.appendEvent(projectRoot, runId, 'audit', { entry: String(entry || '').slice(0, 2000) });
          },
          mutateWorkbench: async (fn) => {
            undoStack.push(JSON.parse(JSON.stringify(model.doc)));
            if (redoStack.length) redoStack.length = 0;
            fn(model);
            dirty = true;
            return true;
          },
          undo: async () => {
            if (undoStack.length) {
              redoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(undoStack.pop()));
              dirty = true;
            }
          },
          redo: async () => {
            if (redoStack.length) {
              undoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(redoStack.pop()));
              dirty = true;
            }
          },
          saveProject: async () => {
            const saved = saveDoc(projectRoot, projectFile, model);
            sendDelta({ kind: 'saved', filePath: saved });
            return saved;
          },
          conversationHistory: () =>
            messages.filter((m) => m.role !== 'system').slice(-20).map((m) => ({ role: m.role, content: m.content })),
          notifyFileChange: (rel, kind, detail) => {
            ragIndex.invalidateProjectIndex(projectRoot, rel);
            sendDelta({ kind: 'file_change', fileChange: { path: rel, kind, detail } });
          },
          ragConfig: cfg.rag,
        });
        tools = { registry, context };
    }

    sendDelta({ kind: 'start' });
    activeRequests.set(runId, controller);
    let result;
    try {
      result = await agent.runAgentChat({
        cfg,
        messages,
        onDelta: onAgentDelta,
        tools,
        signal: controller.signal,
      });
    } finally {
      activeRequests.delete(runId);
    }
    agent.logConversation(projectRoot, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: result.content,
      reasoning: result.reasoning || null,
      toolCalls: result.toolCalls || null,
      usage: result.usage || null,
      grounding: result.grounding || null,
    });
    runStore.finishRun(projectRoot, runId, result.error ? 'error' : result.aborted ? 'cancelled' : 'completed', {
      toolCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      usage: result.usage || null,
      grounding: result.grounding || null,
      error: result.error || null,
    });
    sendDelta({ kind: 'done' });
    const out = {
      ok: !result.error,
      reply: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
      grounding: result.grounding,
    };
    if (result.aborted) out.aborted = true;
    if (result.error) out.error = result.error;
    if (dirty && model) out.document = model.doc;
    if (bridge) bridge.cleanup();
    return out;
  } catch (e) {
    if (runId) runStore.finishRun(projectRoot, runId, 'error', { error: String((e && e.message) || e) });
    sendDelta({ kind: 'error', error: String((e && e.message) || e) });
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('agent:stop', (_event, requestId) => {
  const controller = requestId ? (activeRequests.get(requestId) || activeRequests.get(runStore.normalizeRunId(requestId))) : null;
  if (controller) controller.abort();
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
