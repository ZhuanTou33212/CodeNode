/**
 * mcpClient.cjs —— MCP stdio 会话（复用 + `tools/list` 缓存）
 *
 * 短板（对照文档 §5 #5）：此前每调一次 MCP 工具就 `spawn` 一个新 server 进程，跑完立刻杀掉 ——
 *   · 冷启动开销按调用次数线性叠加（Node/Python 写的 server 每次都是几百毫秒起）；
 *   · 每次都要重做 `initialize` 握手；
 *   · 从不发 `tools/list`，所以「server 到底声明了哪些工具」无从得知，
 *     清单与真实能力不一致时（拼错工具名、server 版本变了）只能等 tools/call 报一句难懂的错。
 *
 * 现在：**每个 (项目, 扩展) 一条常驻会话**，握手一次、`tools/list` 一次（缓存），
 * 之后所有调用复用同一条 stdio 通道；空闲 `idleMs` 后自动关闭（不留孤儿进程），
 * server 意外退出时如实标记并让下一次调用重新拉起。
 *
 * 保留的既有约束（不许因为「复用」而放松）：
 *   · spawn 只走 `sandbox.guardedMcpSpawn`（有包装后端则隔离，否则如实降级）；
 *   · 单条响应累计超过 1MiB → 中止会话（防一个失控 server 把内存吃穿）；
 *   · 握手超时 / 握手失败的错误文案与旧实现一致（排查方向不能因为重构而变模糊）；
 *   · 取消（abort）→ 关闭会话并如实报「已取消」。
 */
'use strict';

const sandbox = require('../sandbox.cjs');

/**
 * extensions.cjs 与 mcpClient.cjs 互相 require（前者在模块加载期就要拿到后者）——
 * 顶层解构会在循环依赖里拿到 undefined（实测：`spawnErrorHint is not a function`）。
 * 所以一律**在调用时**再取。
 */
function spawnErrorHint(command, error) {
  return require('./extensions.cjs').spawnErrorHint(command, error);
}

const DEFAULT_IDLE_MS = 120000;
const HANDSHAKE_FLOOR_MS = 500;
const HANDSHAKE_CEIL_MS = 5000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/** @type {Map<string, any>} */
const sessions = new Map();
const stats = { spawns: 0, handshakes: 0, toolLists: 0, calls: 0, reused: 0, idleClosed: 0, crashes: 0 };

function sessionKey(root, extension) {
  return String(root) + '::' + String((extension && extension.name) || '') + '::' + String((extension && extension.command) || '');
}

/**
 * 建会话（不在这里做 RPC，只负责 spawn + 收行 + 分发）。
 * @returns {{ child: any, pid: number|null, send: Function, onLine: Function, onError: Function, onExit: Function, isClosed: Function, close: Function }}
 */
function openTransport(root, extension, options) {
  const { tokens, context, signal } = options;
  const child = sandbox.guardedMcpSpawn(
    { file: tokens[0], args: [...tokens.slice(1), ...(Array.isArray(extension.args) ? extension.args.map(String) : [])] },
    {
      cwd: root,
      env: require('./extensions.cjs').safeEnvironment({ PYTHONUTF8: '1' }, extension.envAllowlist),
      policy: sandbox.currentPolicy(context),
      context,
    }
  );
  stats.spawns += 1;
  const listeners = [];
  const errorListeners = [];
  let buffer = '';
  let closed = false;
  // spawn 失败（ENOENT 等）是**异步**事件：不挂 'error' 监听，Node 会当成未捕获异常直接把进程带走
  // （mcp-handshake 用例的「不存在的路径」分支实测踩到）。这里转成可等待的错误。
  child.on('error', (error) => {
    for (const listener of errorListeners.slice()) listener(error);
  });
  child.stdout?.on('data', (data) => {
    buffer += String(data);
    if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) {
      for (const listener of listeners.slice()) listener({ __overflow: true });
      buffer = '';
      return;
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      for (const listener of listeners.slice()) listener(message);
    }
  });
  child.stderr?.on('data', () => {});
  return {
    child,
    pid: child.pid || null,
    send(message) {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
        return true;
      } catch {
        return false;
      }
    },
    onLine(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    onExit(listener) {
      child.on('close', listener);
    },
    isClosed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        sandbox.killSandboxed(child);
      } catch {}
    },
  };
}

/** 关闭某个会话（幂等） */
function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  // 主动关闭（空闲回收 / run 结束）不能被统计成「崩溃」——否则监控数字全是噪声
  session.closing = true;
  session.transport.close();
  return true;
}

/** 关闭所有会话（run 结束 / 进程退出时调用，避免留下孤儿进程） */
function closeAll() {
  const keys = [...sessions.keys()];
  for (const key of keys) closeSession(key);
  return keys.length;
}

/** 供判据/审计使用的计数（不含内容，只有次数） */
function snapshot() {
  return Object.assign({}, stats, { active: sessions.size });
}

/** 当前活跃会话的键（判据按「这条会话在不在」断言，避免全局计数互相干扰） */
function activeKeys() {
  return [...sessions.keys()];
}

function resetStats() {
  for (const k of Object.keys(stats)) stats[k] = 0;
}

/** 空闲计时：到点就关（unref，不阻塞进程退出） */
function armIdle(key, idleMs) {
  const session = sessions.get(key);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timer = setTimeout(() => {
    if (sessions.get(key) === session) {
      closeSession(key);
      stats.idleClosed += 1;
    }
  }, Math.max(50, Number(idleMs) || DEFAULT_IDLE_MS));
  if (timer && typeof timer.unref === 'function') timer.unref();
  session.idleTimer = timer;
}

/**
 * 拿一条已握手（且已缓存 tools/list）的会话。
 * @returns {Promise<any>} `{ok:true, session}` 或 `{ok:false, error, handshake?}`
 */
async function ensureSession(root, extension, options) {
  const key = sessionKey(root, extension);
  const existing = sessions.get(key);
  if (existing && !existing.transport.isClosed() && !existing.crashed) return { ok: true, session: existing };
  if (existing) closeSession(key); // 崩过 / 已关：清掉重来

  // 必须用与扩展执行同一套 splitCommand：它处理引号路径（`"C:\\Program Files\\node.exe" ...`），
  // 朴素 split(/\s+/) 会把 `C:\Program Files\nodejs\node.exe` 拆成两段 → spawn ENOENT（实测踩到）
  const tokens = require('./extensions.cjs').splitCommand(String(extension.command || ''));
  if (!tokens.length) return { ok: false, error: 'MCP command 为空' };
  const callTimeoutMs = Math.max(1000, Number(extension.timeoutMs) || 120000);
  const handshakeMs = Math.max(HANDSHAKE_FLOOR_MS, Math.min(HANDSHAKE_CEIL_MS, Math.floor(callTimeoutMs / 4)));

  let transport;
  try {
    transport = openTransport(root, extension, { tokens, context: options.context, signal: options.signal });
  } catch (error) {
    return { ok: false, error: spawnErrorHint(extension.command, error) };
  }

  const session = {
    key,
    extension,
    transport,
    handshake: null,
    declaredTools: null,
    toolsListAt: null,
    crashed: false,
    idleTimer: null,
    pending: new Map(),
    nextId: 1,
    protocolVersion: extension.protocolVersion || '2024-11-05',
  };
  sessions.set(key, session);
  transport.onError((error) => {
    session.spawnError = error;
    for (const pending of session.pending.values()) pending.reject(error);
    session.pending.clear();
  });
  transport.onExit((code) => {
    const intentional = session.closing === true;
    session.crashed = true;
    // 挂起的请求立刻失败，不要等到超时（用户等的是「为什么没反应」，不是 120 秒）
    for (const pending of session.pending.values()) pending.reject(new Error(`MCP 进程提前退出（${code}）`));
    session.pending.clear();
    if (!intentional) stats.crashes += 1;
  });

  /** 发一个请求并等它的应答（按 id 分发；通知帧忽略） */
  const request = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error('MCP 调用超时（' + method + '）'));
      }, timeoutMs);
      session.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          session.pending.delete(id);
          if (message && message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message ? message.result : null);
        },
        reject: (error) => {
          clearTimeout(timer);
          session.pending.delete(id);
          reject(error);
        },
      });
      transport.onLine((message) => {
        if (message && message.__overflow) {
          const pendingAll = [...session.pending.values()];
          session.pending.clear();
          session.crashed = true;
          for (const p of pendingAll) p.reject(new Error('MCP response exceeds 1MiB'));
          closeSession(key);
          return;
        }
        if (!message || message.id === undefined) return; // 通知帧（如 notifications/*）
        const pending = session.pending.get(message.id);
        if (pending) pending.resolve(message);
      });
      if (!transport.send({ jsonrpc: '2.0', id, method, params: params || {} })) {
        session.pending.get(id).reject(new Error('MCP stdin 不可写（会话已关闭）'));
      }
    });

  try {
    session.handshake = await request('initialize', { protocolVersion: session.protocolVersion, capabilities: {}, clientInfo: { name: 'CodeNode', version: '0.12.0' } }, handshakeMs);
    stats.handshakes += 1;
  } catch (error) {
    closeSession(key);
    if (session.spawnError) {
      return { ok: false, error: spawnErrorHint(extension.command, session.spawnError), handshake: false };
    }
    const reason = String((error && error.message) || error);
    return {
      ok: false,
      error:
        'MCP 握手失败（' + reason + '）：server 可能不是 MCP stdio server，或启动被环境/权限拦住',
      handshake: false,
    };
  }
  transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // tools/list 只发一次并缓存：既省一轮往返，也让「server 实际声明了哪些工具」可回查
  try {
    const listed = await request('tools/list', {}, handshakeMs * 2);
    session.declaredTools = ((listed && listed.tools) || []).map((t) => String((t && t.name) || '')).filter(Boolean);
    session.toolsListAt = new Date().toISOString();
    stats.toolLists += 1;
  } catch {
    // tools/list 失败不致命：有的 server 只实现了 tools/call。如实记「没拿到清单」，不编造
    session.declaredTools = null;
  }
  return { ok: true, session };
}

/**
 * 调用 MCP 工具（复用会话）。
 * @returns {Promise<{ok: boolean, output?: string, error?: string, cancelled?: boolean, session?: any, declaredTools?: string[]|null}>}
 */
async function callTool(root, extension, tool, args, signal, context) {
  if (signal && signal.aborted) return { ok: false, cancelled: true, error: 'MCP 执行已取消' };
  const key = sessionKey(root, extension);
  const before = sessions.get(key);
  const ready = await ensureSession(root, extension, { context, signal });
  if (!ready.ok) {
    if (before && before.transport && !before.transport.isClosed()) stats.reused += 1;
    return { ok: false, error: ready.error };
  }
  const session = ready.session;
  if (before && before === session) stats.reused += 1;
  const callTimeoutMs = Math.max(1000, Number(extension.timeoutMs) || 120000);
  try {
    const result = await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('MCP 扩展执行已取消'), { cancelled: true }));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error('MCP 调用超时'));
      }, callTimeoutMs);
      session.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          session.pending.delete(id);
          if (signal) signal.removeEventListener('abort', onAbort);
          if (message && message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message ? message.result : null);
        },
        reject: (error) => {
          clearTimeout(timer);
          session.pending.delete(id);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      if (!session.transport.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name, arguments: args || {} } })) {
        reject(new Error('MCP stdin 不可写（会话已关闭）'));
      }
    });
    stats.calls += 1;
    armIdle(key, extension.idleMs);
    const declared = session.declaredTools;
    const hint =
      Array.isArray(declared) && !declared.includes(String(tool.name))
        ? '（注意：server 的 tools/list 里没有 ' + tool.name + '，可用：' + declared.join('、') + '）'
        : '';
    return { ok: true, output: JSON.stringify(result || {}) + (hint ? '\n' + hint : ''), declaredTools: declared };
  } catch (error) {
    const message = String((error && error.message) || error);
    if (error && error.cancelled) {
      closeSession(key);
      return { ok: false, cancelled: true, error: message };
    }
    // 单次调用失败不一定要扔掉整条会话（比如 tool 内部报错）——只有会话已崩才清
    if (session.crashed) closeSession(key);
    else armIdle(key, extension.idleMs);
    return { ok: false, error: message };
  }
}

/** 供扩展注册时「先问一次 server 声明了什么」用（失败返回 null，不抛） */
async function declaredTools(root, extension, options) {
  const ready = await ensureSession(root, extension, options || {});
  if (!ready.ok) return null;
  return ready.session.declaredTools;
}

module.exports = { callTool, ensureSession, closeSession, closeAll, declaredTools, snapshot, resetStats, sessionKey, activeKeys, DEFAULT_IDLE_MS, MAX_BUFFER_BYTES };
