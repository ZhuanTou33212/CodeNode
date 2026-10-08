'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const config = require('../../config/agent.backends.json');
const { killProcessTree } = require('../processTree.cjs');

// Never interpolate a configured command into cmd.exe/PowerShell. npm's shim
// resolves to its native binary on Windows, so packaged Electron needs no Node.
function resolveExecutable(command = 'codex') {
  if (command !== 'codex') {
    if (!path.isAbsolute(command) || !fs.statSync(command).isFile()) throw new Error('Codex 可执行文件不存在');
    return command;
  }
  const directories = String(process.env.PATH || '').split(path.delimiter);
  if (process.env.APPDATA) directories.push(path.join(process.env.APPDATA, 'npm'));
  // Prefer native executables on PATH before resolving npm script shims.
  for (const directory of directories) {
    const native = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(native) && fs.statSync(native).isFile()) return native;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const desktop = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(desktop)) {
      const candidates = fs.readdirSync(desktop).map(entry => path.join(desktop, entry, 'codex.exe')).filter(file => fs.existsSync(file));
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  }
  for (const directory of directories) {
    if (process.platform === 'win32') {
      const pkg = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
      for (const platform of [process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64']) {
        const triple = platform.endsWith('x64') ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
        for (const bin of ['bin', 'codex']) {
          const candidate = path.join(pkg, platform, 'vendor', triple, bin, 'codex.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  throw new Error('未找到 Codex CLI，请安装 Codex 或在 Agent 后端设置中指定可执行文件');
}

class RpcClient extends EventEmitter {
  constructor(command, cwd, deps = {}) {
    super();
    this.pending = new Map(); this.seq = 0; this.closed = false; this.buffer = '';
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('CODEX_INTERNAL_') || key === 'CODEX_THREAD_ID') delete env[key];
    this.child = (deps.spawn || spawn)(resolveExecutable(command), ['app-server', '--listen', 'stdio://'],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // Drain diagnostics without copying local configuration/credentials to UI.
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.disconnected(error));
    this.child.on('exit', (code, signal) => this.disconnected(new Error('Codex app-server 已退出 (' + (signal || code) + ')')));
    this.child.stdin.on('error', error => this.disconnected(error));
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > config.maxMessageBytes) {
      this.disconnected(new Error('Codex 协议消息超过限制')); this.close(); return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.disconnected(new Error('Codex 返回无效 JSON 协议')); this.close(); return; }
      if (message.method) {
        try { this.emit(message.id != null ? 'request' : 'notification', message); }
        catch (error) { this.disconnected(error); this.close(); return; }
      }
      else {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'Codex 协议请求失败'));
        else pending.resolve(message.result);
      }
    }
  }
  send(message) {
    if (this.closed) throw new Error('Codex 连接已关闭');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, timeout = config.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时：' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  disconnected(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
  async close() {
    if (this.closing) return this.closing;
    this.disconnected(new Error('Codex 连接已关闭'));
    // Finish killing the owned tree before closing stdin: EOF can make the
    // parent exit first and orphan its MCP/tool descendants on Windows.
    this.closing = new Promise(resolve => {
      const dispose = () => { this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.unref(); resolve(undefined); };
      if (this.child.exitCode != null) { dispose(); return; }
      if (process.platform !== 'win32') { killProcessTree(this.child, true); dispose(); return; }
      const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { this.child.kill(); dispose(); }, config.shutdownTimeoutMs);
      const done = () => { clearTimeout(timer); dispose(); };
      killer.once('exit', done); killer.once('error', done);
    });
    return this.closing;
  }
}
function executableVersion(command) {
  return new Promise((resolve, reject) => execFile(resolveExecutable(command), ['--version'],
    { windowsHide: true, timeout: config.requestTimeoutMs, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim().replace(/^codex-cli\s+/, ''))));
}
module.exports = { RpcClient, resolveExecutable, executableVersion };
