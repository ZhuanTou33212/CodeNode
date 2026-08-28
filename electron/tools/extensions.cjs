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
      return list.map((item) => ({ ...item, source: file })).filter((item) => item && item.name);
    } catch {}
  }
  return [];
}

function runExternal(root, command, args, extraEnv) {
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
        env: { ...process.env, CODENODE_TOOL_ARGS: JSON.stringify(args || {}), ...(extraEnv || {}) },
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

function runMcpTool(root, extension, tool, args) {
  const tokens = splitCommand(extension.command);
  if (!tokens.length) return Promise.resolve({ ok: false, error: 'MCP command 为空' });
  return new Promise((resolve) => {
    let child;
    let buffer = '';
    let finished = false;
    let timer;
    const finish = (result) => { if (!finished) { finished = true; if (timer) clearTimeout(timer); try { child?.kill('SIGTERM'); } catch {} resolve(result); } };
    try {
      child = spawn(tokens[0], [...tokens.slice(1), ...(Array.isArray(extension.args) ? extension.args.map(String) : [])], { cwd: root, shell: false, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); return; }
    const send = (message) => { try { child.stdin.write(JSON.stringify(message) + '\n'); } catch {} };
    const parse = (data) => {
      buffer += String(data);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            if (message.error) finish({ ok: false, error: JSON.stringify(message.error) });
            else finish({ ok: true, output: JSON.stringify(message.result || {}) });
          }
        } catch {}
      }
    };
    child.stdout?.on('data', parse);
    child.stderr?.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', (code) => { if (!finished) finish({ ok: false, error: `MCP 进程提前退出（${code}）` }); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: extension.protocolVersion || '2024-11-05', capabilities: {}, clientInfo: { name: 'CodeNode', version: '0.12.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool.name, arguments: args || {} } });
    timer = setTimeout(() => finish({ ok: false, error: 'MCP 调用超时' }), Math.max(1000, Number(extension.timeoutMs) || 120000));
  });
}

async function runHook(root, hook, args) {
  if (!hook) return { ok: true };
  const command = typeof hook === 'string' ? hook : hook.command;
  if (!command) return { ok: true };
  return runExternal(root, command, args || {}, { CODENODE_HOOK: '1' });
}

function registerProjectExtensions(registry, projectRoot) {
  for (const extension of readManifest(projectRoot)) {
    const name = String(extension.name).trim();
    if (!name || registry.contains(name)) continue;
    if (Array.isArray(extension.tools) && extension.tools.length) {
      for (const tool of extension.tools) {
        if (!tool || !tool.name || registry.contains(String(tool.name))) continue;
        registry.register(String(tool.name), String(tool.description || `${name} MCP 工具`), tool.parameters || { type: 'object', properties: {} }, async (context, args) => {
          const ok = await context.confirm(ConfirmationLevel.WRITE, `运行扩展 ${name}.${tool.name}`, `来源：${extension.source}`);
          if (!ok) return AgentToolResult.error('已取消扩展执行');
          await runHook(context.projectRoot(), extension.hooks?.before, args);
          const result = String(extension.kind || '').toLowerCase() === 'mcp'
            ? await runMcpTool(context.projectRoot(), extension, { ...tool, name: String(tool.name) }, args || {})
            : await runExternal(context.projectRoot(), String(extension.command || ''), args || {}, { CODENODE_EXTENSION_TOOL: String(tool.name) });
          await runHook(context.projectRoot(), extension.hooks?.after, { args, result });
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
        await runHook(context.projectRoot(), extension.hooks?.before, args);
        const result = await runExternal(context.projectRoot(), String(extension.command), args || {}, { CODENODE_EXTENSION: name });
        await runHook(context.projectRoot(), extension.hooks?.after, { args, result });
        context.audit(`extension ${name} exit=${result.exitCode ?? 'error'}`);
        if (!result.ok) return AgentToolResult.error(`扩展 ${name} 执行失败：${result.error || ''}\n${result.output || ''}`);
        return AgentToolResult.ok(`扩展 ${name} 已完成（退出码 ${result.exitCode}）\n${result.output || ''}`, { extension: name, exitCode: result.exitCode, output: result.output || '' });
      }
    );
  }
  return registry;
}

module.exports = { registerProjectExtensions, readManifest };
