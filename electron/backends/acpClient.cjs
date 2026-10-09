'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { resolveInRoot, isSensitivePath } = require('../tools/impl/shared.cjs');
const { atomicWriteFile } = require('../atomicFile.cjs');
const { guardedSpawn } = require('../sandbox.cjs');
const { killProcessTree } = require('../processTree.cjs');
const limits = require('../../config/agent.backends.json').acpLimits;
function invalid(message) { return Object.assign(new Error(message), { code: -32602 }); }
function denied(message) { return Object.assign(new Error(message), { code: -32000 }); }
class AcpClient {
  constructor(owner) { this.owner = owner; this.terminals = new Map(); }
  file(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw invalid('ACP path 必须是绝对路径');
    const full = resolveInRoot(this.owner.cwd, value);
    if (!full || isSensitivePath(path.relative(this.owner.cwd, full))) throw denied('路径越界或受保护');
    return full;
  }
  async approve(what, detail) {
    const o = this.owner;
    if (o.stopping || o.input?.signal?.aborted || o.settings.sandbox === 'read-only') throw denied('当前会话只读或已取消');
    o.emit({ kind: 'backend_approval', phase: 'requested' });
    let ok = false;
    try { ok = !!(await o.input?.confirm?.('HIGH', what, detail)); }
    finally { o.emit({ kind: 'backend_approval', phase: 'resolved', accepted: ok }); }
    if (!ok || o.stopping || o.input?.signal?.aborted) throw denied('用户拒绝或会话已取消');
  }
  async handle(method, p) {
    const o = this.owner;
    if (p.sessionId !== o.sessionId || !o.sessionId) throw invalid('未知 ACP 会话');
    if (method === 'fs/read_text_file') {
      const full = this.file(p.path);
      let text = await o.input?.readEditorText?.(full);
      if (typeof text !== 'string') { if (fs.statSync(full).size > limits.fileBytes) throw invalid('文件超过读取上限'); text = fs.readFileSync(full, 'utf8'); }
      if (Buffer.byteLength(text) > limits.fileBytes) throw invalid('编辑器内容超过读取上限');
      if (p.line != null && (!Number.isSafeInteger(p.line) || p.line < 1)) throw invalid('line 必须为正整数');
      if (p.limit != null && (!Number.isSafeInteger(p.limit) || p.limit < 1)) throw invalid('limit 必须为正整数');
      if (p.line != null || p.limit != null) text = text.split('\n').slice((p.line || 1) - 1, p.limit == null ? undefined : (p.line || 1) - 1 + p.limit).join('\n');
      return { content: text };
    }
    if (method === 'fs/write_text_file') {
      const full = this.file(p.path);
      if (typeof p.content !== 'string' || Buffer.byteLength(p.content) > limits.fileBytes) throw invalid('写入内容无效或超过上限');
      const rel = path.relative(o.cwd, full).replace(/\\/g, '/');
      if (require('../goalScope.cjs').violations([{ path: rel }], o.input?.goalWriteScope).length) throw denied('超出 Task 写入范围');
      const draft = await o.input?.readEditorText?.(full);
      const original = fs.existsSync(full) ? fs.readFileSync(full) : null;
      if (typeof draft === 'string' && draft !== original?.toString('utf8')) throw denied('文件存在尚未保存的编辑内容');
      const sha = original ? crypto.createHash('sha256').update(original).digest('hex') : 'absent';
      await this.approve('ACP 写入项目文件', rel + '\n' + p.content.slice(0, 1200));
      this.file(p.path);
      const latestDraft = await o.input?.readEditorText?.(full);
      if (typeof latestDraft === 'string' && latestDraft !== original?.toString('utf8')) throw denied('审批期间编辑器内容发生变化');
      atomicWriteFile(full, p.content, 'utf8', { expectedSha256: sha });
      o.emit({ kind: 'file_change', fileChange: { path: rel, action: original ? 'modified' : 'added', status: 'changed', source: 'acp-client' } });
      return {};
    }
    if (method === 'terminal/create') {
      if (o.input?.goalWriteScope?.length) throw denied('Task 有限定写入范围，不能授予任意终端命令权限');
      if (typeof p.command !== 'string' || !p.command || /[\0\r\n]/.test(p.command) || (p.args != null && (!Array.isArray(p.args) || p.args.some(x => typeof x !== 'string' || x.includes('\0'))))) throw invalid('终端命令无效');
      if (this.terminals.size >= limits.terminals) throw denied('终端数量超过上限');
      const cwd = p.cwd == null ? o.cwd : this.file(p.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw invalid('cwd 必须是目录');
      const env = { ...process.env };
      if (p.command === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      if (p.env != null && (!Array.isArray(p.env) || p.env.some(x => !x || typeof x.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name) || typeof x.value !== 'string' || x.value.includes('\0')))) throw invalid('终端环境变量无效');
      for (const entry of p.env || []) env[entry.name] = entry.value;
      const limit = p.outputByteLimit == null ? limits.terminalBytes : p.outputByteLimit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.terminalBytes) throw invalid('outputByteLimit 无效');
      await this.approve('ACP 运行项目命令', JSON.stringify({ command: p.command, args: p.args || [], cwd, env: p.env || [] }));
      if (this.terminals.size >= limits.terminals) throw denied('终端数量超过上限');
      this.file(cwd);
      const child = (o.deps.guardedSpawn || guardedSpawn)({ file: p.command, args: p.args || [], cwd, env }, { policy: o.input?.sandboxPolicy });
      const id = crypto.randomUUID();
      /** @type {any} */
      const record = { child, output: '', truncated: false, exitStatus: null, done: null, timer: null };
      this.terminals.set(id, record);
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      const append = text => {
        record.output += text;
        let bytes = Buffer.from(record.output);
        if (bytes.length > limit) { let start = bytes.length - limit; while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++; record.output = bytes.subarray(start).toString('utf8'); record.truncated = true; }
        o.emit({ kind: 'backend_terminal', terminalId: id, output: record.output, truncated: record.truncated, exitStatus: record.exitStatus });
      };
      [child.stdout, child.stderr].forEach((stream, i) => stream?.on('data', chunk => append(decoders[i].write(Buffer.from(chunk)))));
      record.done = new Promise(resolve => {
        let ended = false;
        const end = status => { if (ended) return; ended = true; clearTimeout(record.timer); decoders.forEach(d => append(d.end())); record.exitStatus = status; append(''); resolve(status); };
        child.once('error', error => { append(error.message); end({ exitCode: 1 }); });
        child.once('close', (code, signal) => end({ ...(code == null ? {} : { exitCode: code }), ...(signal ? { signal } : {}) }));
      });
      record.timer = setTimeout(() => this.kill(record), limits.terminalTimeoutMs);
      child.stdin?.end();
      return { terminalId: id };
    }
    if (method.startsWith('terminal/')) {
      const record = this.terminals.get(p.terminalId);
      if (!record) throw invalid('未知或已释放的终端');
      if (method === 'terminal/output') return { output: record.output, truncated: record.truncated, ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}) };
      if (method === 'terminal/wait_for_exit') return await record.done;
      if (method === 'terminal/kill' || method === 'terminal/release') { await this.kill(record); if (method === 'terminal/release') this.terminals.delete(p.terminalId); return {}; }
    }
    throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
  }
  async kill(record) { clearTimeout(record.timer); if (!record.exitStatus) { killProcessTree(record.child, true); await Promise.race([record.done, new Promise(resolve => setTimeout(resolve, 2000))]); } }
  async close() { await Promise.all([...this.terminals.values()].map(r => this.kill(r))); this.terminals.clear(); }
}
module.exports = { AcpClient, invalid, denied };
