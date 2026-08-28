'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AgentToolResult } = require('./result.cjs');
const { ConfirmationLevel } = require('./context.cjs');

function splitCommand(command) {
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

function readManifest(projectRoot) {
  const files = [
    path.join(projectRoot || '.', '.codenode', 'extensions.json'),
    path.join(projectRoot || '.', 'config', 'extensions.json'),
  ];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.extensions) ? parsed.extensions : [];
      return list.map((item) => ({ ...item, source: file })).filter((item) => item && item.name && item.command);
    } catch {}
  }
  return [];
}

function runExternal(root, command, args) {
  const tokens = splitCommand(command);
  if (!tokens.length) return Promise.resolve({ ok: false, error: '扩展命令为空' });
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    let child;
    try {
      child = spawn(tokens[0], [...tokens.slice(1), ...(Array.isArray(args) ? args.map(String) : [])], {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CODENODE_TOOL_ARGS: JSON.stringify(args || {}) },
      });
    } catch (e) {
      finish({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    const append = (data) => { output += String(data); if (output.length > 20000) output = output.slice(-20000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ ok: false, output, error: '扩展执行超时' }); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, output, error: String((e && e.message) || e) }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, output, exitCode: code }); });
  });
}

function registerProjectExtensions(registry, projectRoot) {
  for (const extension of readManifest(projectRoot)) {
    const name = String(extension.name).trim();
    if (!name || registry.contains(name)) continue;
    registry.register(
      name,
      String(extension.description || `项目扩展：${name}`) + '（参数会以 CODENODE_TOOL_ARGS JSON 环境变量传入）',
      extension.parameters || { type: 'object', properties: {} },
      async (context, args) => {
        const ok = await context.confirm(ConfirmationLevel.WRITE, `运行项目扩展 ${name}`, `来源：${extension.source}\n命令：${extension.command}`);
        if (!ok) return AgentToolResult.error('已取消扩展执行');
        const result = await runExternal(context.projectRoot(), String(extension.command), args || {});
        context.audit(`extension ${name} exit=${result.exitCode ?? 'error'}`);
        if (!result.ok) return AgentToolResult.error(`扩展 ${name} 执行失败：${result.error || ''}\n${result.output || ''}`);
        return AgentToolResult.ok(`扩展 ${name} 已完成（退出码 ${result.exitCode}）\n${result.output || ''}`, { extension: name, exitCode: result.exitCode, output: result.output || '' });
      }
    );
  }
  return registry;
}

module.exports = { registerProjectExtensions, readManifest };
