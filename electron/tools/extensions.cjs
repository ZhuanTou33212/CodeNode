'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('./result.cjs');
const { ConfirmationLevel } = require('./context.cjs');
const { safeEnvironment } = require('../envPolicy.cjs');
const sandbox = require('../sandbox.cjs');

/**
 * 拆分命令行。
 *
 * 第 7 项修复：整段字符串如果本身就是一个**存在的可执行文件路径**（Windows 上常见
 * `C:\Program Files\nodejs\node.exe`），即使没加引号也直接当单个 token —— 旧实现按空格硬拆，
 * 结果 spawn 的是 `C:\Program`，报 `ENOENT`。含引号的写法仍然照旧处理。
 */
function splitCommand(command) {
  const raw = String(command || '').trim();
  if (raw && !/^["']/.test(raw) && /\s/.test(raw)) {
    try {
      if (fs.existsSync(raw)) return [raw];
    } catch {}
  }
  const tokens = [];
  let current = '';
  let quote = '';
  for (const c of raw) {
    if ((c === '"' || c === "'") && !quote) { quote = c; continue; }
    if (c === quote) { quote = ''; continue; }
    if (/\s/.test(c) && !quote) {
      if (current) { tokens.push(current); current = ''; }
    } else current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

function readManifest(projectRoot) {
  const files = [
    path.join(projectRoot || '.', '.codenode', 'extensions.json'),
    path.join(projectRoot || '.', 'config', 'extensions.json'),
  ];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.extensions) ? parsed.extensions : [];
      return list.map((item) => ({ ...item, source: file })).filter((item) => item && item.name);
    } catch {}
  }
  return [];
}

/**
 * spawn 失败时补一句可操作的原因：ENOENT + 命令里含空格，十有八九是路径没加引号。
 * 这类错误只报 `spawn C:\Program ENOENT` 时，用户完全看不出该怎么修（第 7 项实测踩到）。
 */
function spawnErrorHint(command, error) {
  const text = String((error && error.message) || error || '');
  if (/ENOENT/.test(text) && /\s/.test(String(command || '').trim())) {
    return text + '（扩展/MCP 的 command 含空格，请写成带引号的形式，例如 command="C:\\Program Files\\nodejs\\node.exe"）';
  }
  return text;
}

function runExternal(root, command, args, extraEnv, signal, allowlist, context) {
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, error: '扩展执行已取消' });
  const tokens = splitCommand(command);
  if (!tokens.length) return Promise.resolve({ ok: false, error: '扩展命令为空' });
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    let child;
    try {
      // 扩展与 hook 也走统一执行隔离层（与 shell 同一策略），不再各自 spawn
      child = sandbox.guardedSpawn(
        { file: tokens[0], args: [...tokens.slice(1), ...(Array.isArray(args) ? args.map(String) : [])] },
        {
          cwd: root,
          env: safeEnvironment({ CODENODE_TOOL_ARGS: JSON.stringify(args || {}), ...(extraEnv || {}) }, allowlist),
          policy: sandbox.currentPolicy(context),
          context,
        }
      );
    } catch (e) {
      finish({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    const append = (data) => { output += String(data); if (output.length > 20000) output = output.slice(-20000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const onAbort = () => { sandbox.killSandboxed(child); finish({ ok: false, output, error: '扩展执行已取消', cancelled: true }); };
    signal && signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) onAbort();
    const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { sandbox.killSandboxed(child, true); cleanup(); finish({ ok: false, output, error: '扩展执行超时' }); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); cleanup(); finish({ ok: false, output, error: spawnErrorHint(command, e) }); });
    child.on('close', (code) => { clearTimeout(timer); cleanup(); finish({ ok: code === 0, output, exitCode: code }); });
  });
}

function runMcpTool(root, extension, tool, args, signal, context) {
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, error: 'MCP 执行已取消' });
  const tokens = splitCommand(extension.command);
  if (!tokens.length) return Promise.resolve({ ok: false, error: 'MCP command 为空' });
  const callTimeoutMs = Math.max(1000, Number(extension.timeoutMs) || 120000);
  // 握手单独计时：旧实现把 initialize 和 tools/call 一起发出去、只等 id=2，**从不校验握手结果**
  // （探针实测：server 对 initialize 完全不回应，工具调用照样成功）—— 于是「不是 MCP server」
  // 或「server 启动失败」这类问题会被报成 tools/call 层的怪错误，排查方向全错。
  const handshakeMs = Math.max(500, Math.min(5000, Math.floor(callTimeoutMs / 4)));
  return new Promise((resolve) => {
    let child;
    let buffer = '';
    let finished = false;
    let timer;
    let onAbort = null;
    let handshaken = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      sandbox.killSandboxed(child);
      resolve(result);
    };
    try {
      // MCP 需要双向 stdio，Windows Job 代理不适用 → 走 guardedMcpSpawn（有包装后端则隔离，否则如实降级）
      child = sandbox.guardedMcpSpawn(
        { file: tokens[0], args: [...tokens.slice(1), ...(Array.isArray(extension.args) ? extension.args.map(String) : [])] },
        { cwd: root, env: safeEnvironment({ PYTHONUTF8: '1' }, extension.envAllowlist), policy: sandbox.currentPolicy(context), context }
      );
    } catch (e) { finish({ ok: false, error: spawnErrorHint(extension.command, e) }); return; }
    const send = (message) => { try { child.stdin.write(JSON.stringify(message) + '\n'); } catch {} };
    /** 握手成功后：发 notifications/initialized + tools/call，并开始整体调用计时 */
    const startCall = () => {
      handshaken = true;
      if (timer) clearTimeout(timer);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool.name, arguments: args || {} } });
      timer = setTimeout(() => finish({ ok: false, error: 'MCP 调用超时' }), callTimeoutMs);
    };
    const parse = (data) => {
      buffer += String(data);
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        finish({ ok: false, error: 'MCP response exceeds 1MiB' });
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !handshaken) {
            if (message.error) {
              finish({ ok: false, error: 'MCP 握手失败：' + JSON.stringify(message.error) });
              return;
            }
            startCall();
            continue;
          }
          if (message.id === 2) {
            if (message.error) finish({ ok: false, error: JSON.stringify(message.error) });
            else finish({ ok: true, output: JSON.stringify(message.result || {}) });
          }
        } catch {}
      }
    };
    child.stdout?.on('data', parse);
    child.stderr?.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, error: spawnErrorHint(extension.command, e) }));
    child.on('close', (code) => { if (!finished) finish({ ok: false, error: `MCP 进程提前退出（${code}）` }); });
    onAbort = () => finish({ ok: false, error: 'MCP 扩展执行已取消', cancelled: true });
    signal && signal.addEventListener('abort', onAbort, { once: true });
    // 先握手，再调用；握手超时/失败都如实报出来
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: extension.protocolVersion || '2024-11-05', capabilities: {}, clientInfo: { name: 'CodeNode', version: '0.12.0' } } });
    timer = setTimeout(
      () => finish({ ok: false, error: 'MCP 握手超时（' + handshakeMs + 'ms 内未收到 initialize 应答）：server 可能不是 MCP stdio server，或启动被环境/权限拦住' }),
      handshakeMs,
    );
  });
}

async function runHook(root, hook, args, signal, allowlist, context) {
  if (!hook) return { ok: true };
  const command = typeof hook === 'string' ? hook : hook.command;
  if (!command) return { ok: true };
  return runExternal(root, command, args || {}, { CODENODE_HOOK: '1' }, signal, allowlist, context);
}

function registerProjectExtensions(registry, projectRoot) {
  for (const extension of readManifest(projectRoot)) {
    const name = String(extension.name).trim();
    if (!name || registry.contains(name)) continue;
    if (Array.isArray(extension.tools) && extension.tools.length) {
      for (const tool of extension.tools) {
        if (!tool || !tool.name || registry.contains(String(tool.name))) continue;
        registry.register(String(tool.name), String(tool.description || `${name} MCP 工具`), tool.parameters || { type: 'object', properties: {} }, async (context, args) => {
          // #10：MCP 分支此前只给「来源」，连 command 都不给（非 MCP 分支反而给了）——
          // 对话框是用户唯一的判断依据，这里必须能看到**要跑什么、带什么参数**。
          const commandLine = String(extension.command || '') +
            (Array.isArray(extension.args) && extension.args.length ? ' ' + extension.args.map(String).join(' ') : '');
          const argsJson = JSON.stringify(args || {});
          const ok = await context.confirm(
            ConfirmationLevel.WRITE,
            `运行扩展 ${name}.${tool.name}`,
            `来源：${extension.source}\n命令：${commandLine}\n参数（JSON）：${argsJson.length > 2000 ? argsJson.slice(0, 2000) + '…（已截断）' : argsJson}`
          );
          if (!ok) return AgentToolResult.error('已取消扩展执行');
          const before = await runHook(context.projectRoot(), extension.hooks?.before, args, context.signal && context.signal(), extension.envAllowlist, context);
          if (!before.ok) return AgentToolResult.error('前置 Hook 失败：' + before.error);
          const result = String(extension.kind || '').toLowerCase() === 'mcp'
            ? await runMcpTool(context.projectRoot(), extension, { ...tool, name: String(tool.name) }, args || {}, context.signal && context.signal(), context)
            : await runExternal(context.projectRoot(), String(extension.command || ''), args || {}, { CODENODE_EXTENSION_TOOL: String(tool.name) }, context.signal && context.signal(), extension.envAllowlist, context);
          const after = await runHook(context.projectRoot(), extension.hooks?.after, { args, result }, context.signal && context.signal(), extension.envAllowlist, context);
          if (!after.ok) return AgentToolResult.error('后置 Hook 失败：' + after.error);
          if (!result.ok) return AgentToolResult.error(`扩展 ${name}.${tool.name} 执行失败：${result.error || ''}`);
          context.audit(`extension ${name}.${tool.name} ok`);
          return AgentToolResult.ok(result.output || `扩展 ${name}.${tool.name} 已完成`, { extension: name, tool: tool.name, output: result.output || '' });
        });
      }
      continue;
    }
    if (!extension.command) continue;
    registry.register(
      name,
      String(extension.description || `项目扩展：${name}`) + '（参数会以 CODENODE_TOOL_ARGS JSON 环境变量传入）',
      extension.parameters || { type: 'object', properties: {} },
      async (context, args) => {
        const ok = await context.confirm(ConfirmationLevel.WRITE, `运行项目扩展 ${name}`, `来源：${extension.source}\n命令：${extension.command}`);
        if (!ok) return AgentToolResult.error('已取消扩展执行');
        const before = await runHook(context.projectRoot(), extension.hooks?.before, args, context.signal && context.signal(), extension.envAllowlist, context);
        if (!before.ok) return AgentToolResult.error('前置 Hook 失败：' + before.error);
        const result = await runExternal(context.projectRoot(), String(extension.command), args || {}, { CODENODE_EXTENSION: name }, context.signal && context.signal(), extension.envAllowlist, context);
        const after = await runHook(context.projectRoot(), extension.hooks?.after, { args, result }, context.signal && context.signal(), extension.envAllowlist, context);
        if (!after.ok) return AgentToolResult.error('后置 Hook 失败：' + after.error);
        context.audit(`extension ${name} exit=${result.exitCode ?? 'error'}`);
        if (!result.ok) return AgentToolResult.error(`扩展 ${name} 执行失败：${result.error || ''}\n${result.output || ''}`);
        return AgentToolResult.ok(`扩展 ${name} 已完成（退出码 ${result.exitCode}）\n${result.output || ''}`, { extension: name, exitCode: result.exitCode, output: result.output || '' });
      }
    );
  }
  return registry;
}

module.exports = { registerProjectExtensions, readManifest, safeEnvironment };
