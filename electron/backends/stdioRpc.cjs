'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../../config/agent.backends.json');
const { killProcessTree } = require('../processTree.cjs');
const { launchEnvironment } = require('./network.cjs');
const { redact } = require('../redaction.cjs');

function resolveCommand(command) {
  if (pathIsAbsolute(command)) {
    if (!fs.existsSync(command)) throw new Error('可执行文件不存在：' + command);
    if (process.platform === 'win32' && /\.(?:mjs|js|py)$/i.test(command)) {
      const runner = /\.py$/i.test(command) ? process.env.PYTHON || 'python' : process.execPath;
      return { command: runner, prefix: [command] };
    }
    return { command, prefix: [] };
  }
  const roots = [...String(process.env.PATH || '').split(require('path').delimiter)];
  if (process.env.APPDATA) roots.push(require('path').join(process.env.APPDATA, 'npm'));
  for (const dir of roots) {
    if (!dir) continue;
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
        const nodeScript = content.match(/"%dp0%\\node_modules\\([^" ]+\.(?:js|mjs))"/i);
        if (nodeScript) { const candidate = path.join(dir, 'node_modules', nodeScript[1]); if (fs.existsSync(candidate)) return { command: process.execPath, prefix: [candidate] }; }
      }
      const hermes = path.join(dir, 'hermes.exe'); if (command === 'hermes' && fs.existsSync(hermes)) return { command: hermes, prefix: [] };
    } else {
      const candidate = require('path').join(dir, command);
      if (require('fs').existsSync(candidate)) return { command: candidate, prefix: [] };
    }
  }
  throw new Error('未找到程序：' + command);
}
function pathIsAbsolute(value) { return require('path').isAbsolute(value); }

class StdioRpc extends EventEmitter {
  constructor(command, args, cwd, options = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false; this.buffer = ''; this.stderrTail=[];
    this.child = null; this.spawnError = null;
    this.ready = (async () => {
      const resolved = resolveCommand(command); const network = await launchEnvironment();
      const env = { ...network.env, ...(options.env || {}) };
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
