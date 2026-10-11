'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../../config/agent.backends.json');
const { killProcessTree } = require('../processTree.cjs');
const { launchEnvironment } = require('./network.cjs');
const { redact } = require('../redaction.cjs');

// Some Agents ship a Windows executable whose name differs from the documented
// launch name (Qoder's `qodercli`/`qoder`, the renamed Claude Code adapter).
// Aliases only widen discovery; the primary name is always tried first.
function commandCandidates(command) {
  const aliases = config.commandAliases?.[command];
  return Array.isArray(aliases) && aliases.length ? [command, ...aliases.filter(alias => typeof alias === 'string' && alias && alias !== command)] : [command];
}
// npm bin targets are usually .js/.mjs, but some packages point at an
// extension-less launcher. Only a Node shebang proves it is safe to run with
// the bundled Node runtime instead of executing it directly.
function isNodeScript(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(200);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return /^#![^\n]*\bnode\b/.test(buffer.subarray(0, read).toString('utf8'));
  } catch { return false; } finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }
}
function resolveInDir(command, dir) {
  if (process.platform === 'win32') {
    const exe = path.join(dir, command + '.exe');
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
    const packageMap = { opencode: ['opencode-ai', 'bin', 'opencode.exe'], openclaw: ['openclaw', 'openclaw.mjs'] };
    const parts = packageMap[command];
    if (parts) {
      const candidate = path.join(dir, 'node_modules', ...parts);
      if (fs.existsSync(candidate)) return command === 'openclaw' ? { command: process.execPath, prefix: [candidate] } : { command: candidate, prefix: [] };
    }
    const scripts = path.join(dir, command + '.cmd');
    if (fs.existsSync(scripts)) {
      const content = fs.readFileSync(scripts, 'utf8');
      const target = content.match(/"%dp0%\\node_modules\\([^" ]+)"/i);
      if (target) {
        const candidate = path.join(dir, 'node_modules', target[1]);
        const executable = fs.existsSync(candidate);
        if (executable && /\.exe$/i.test(target[1])) return { command: candidate, prefix: [] };
        if (executable && (/\.(?:js|mjs|cjs)$/i.test(target[1]) || isNodeScript(candidate))) return { command: process.execPath, prefix: [candidate] };
      }
    }
    const hermes = path.join(dir, 'hermes.exe'); if (command === 'hermes' && fs.existsSync(hermes)) return { command: hermes, prefix: [] };
    return null;
  }
  const candidate = path.join(dir, command);
  return fs.existsSync(candidate) ? { command: candidate, prefix: [] } : null;
}
function resolveCommand(command) {
  if (pathIsAbsolute(command)) {
    if (!fs.existsSync(command)) throw new Error('可执行文件不存在：' + command);
    if (process.platform === 'win32' && /\.(?:mjs|js|py)$/i.test(command)) {
      const runner = /\.py$/i.test(command) ? process.env.PYTHON || 'python' : process.execPath;
      return { command: runner, prefix: [command] };
    }
    return { command, prefix: [] };
  }
  const names = commandCandidates(command);
  const roots = [...String(process.env.PATH || '').split(path.delimiter)];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
  for (const name of names) for (const dir of roots) {
    if (!dir) continue;
    const resolved = resolveInDir(name, dir);
    if (resolved) return resolved;
  }
  throw new Error('未找到程序：' + command + (names.length > 1 ? '（别名 ' + names.slice(1).join('、') + ' 也不存在）' : ''));
}
function pathIsAbsolute(value) { return require('path').isAbsolute(value); }

class StdioRpc extends EventEmitter {
  constructor(command, args, cwd, options = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false; this.buffer = ''; this.stderrTail=[];
    this.child = null; this.spawnError = null;
    this.ready = (async () => {
      const resolved = resolveCommand(command); const network = await launchEnvironment();
      const env = { ...network.env, ...(options.env || {}) };
      if (resolved.command === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      this.proxySource = network.proxySource;
      this.child = (options.spawn || spawn)(resolved.command, [...resolved.prefix, ...(args || [])],
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', chunk => this.receive(chunk));
      this.child.stderr.on('data', chunk => {const value=String(redact(String(chunk)));this.stderrTail.push(value.slice(-4000));if(this.stderrTail.length>8)this.stderrTail.shift();this.emit('stderr',value.slice(-4000));});
      this.child.on('error', error => { this.spawnError = error; this.disconnected(error); });
      this.child.on('exit', (code, signal) => this.disconnected(new Error('Agent 进程退出 (' + (signal || code) + ')'+(this.stderrTail.length?'：'+this.stderrTail.join('\n'):''))));
      this.child.stdin.on('error', error => this.disconnected(error));
    })();
  }
  async send(message) { await this.ready; if (this.closed) throw new Error('Agent 协议连接已关闭'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  async request(method, params, timeout = config.requestTimeoutMs) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error('Agent 请求超时：' + method)); }, timeout);
      this.pending.set(String(id), { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params: params || {} }).catch(error => {
        clearTimeout(timer); this.pending.delete(String(id)); reject(error);
      });
    });
  }
  async respond(id, result) { return this.send({ jsonrpc: '2.0', id, result }); }
  async respondError(id, code, message, data) { return this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data: redact(data) }) } }); }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > config.maxMessageBytes) { this.disconnected(new Error('Agent 协议消息超过限制')); void this.close(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { this.disconnected(new Error('Agent 返回无效 JSON')); void this.close(); return; }
      if (message.method) this.emit(message.id != null ? 'request' : 'notification', message);
      else {
        const item = this.pending.get(String(message.id)); if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(String(message.id));
        if (message.error) {
          /** @type {Error & {code?: any, data?: any, method?: string}} */
          const error = new Error(message.error.message || 'Agent 协议错误');
          error.code = message.error.code;
          error.data = redact(message.error.data);
          error.method = item.method;
          item.reject(error);
        } else item.resolve(message.result);
      }
    }
  }
  disconnected(error) {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
  async close() {
    await this.ready.catch(() => {});
    if (!this.child || this.child.exitCode != null) return;
    this.disconnected(new Error('Agent 协议连接已关闭'));
    await new Promise(resolve => {
      if (process.platform !== 'win32') { killProcessTree(this.child, true); resolve(true); return; }
      const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { this.child.kill(); resolve(true); }, config.shutdownTimeoutMs);
      killer.once('exit', () => { clearTimeout(timer); resolve(true); }); killer.once('error', () => { clearTimeout(timer); resolve(true); });
    });
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref();
  }
}
module.exports = { StdioRpc, resolveCommand };
