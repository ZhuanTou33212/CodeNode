#!/usr/bin/env node
/**
 * mock-mcp-server.cjs —— 最小 MCP stdio server（独立进程，供 mcp-session 用例驱动真实 stdio 往返）
 *
 * 行为：
 *   - initialize            → 正常应答（含 protocolVersion / capabilities / serverInfo）
 *   - notifications/*       → 不回应（JSON-RPC 通知）
 *   - tools/list            → 声明 echo / slow 两个工具
 *   - tools/call(echo)      → { content: [{type:'text', text:'ECHO:<text>'}], mcpPid }
 *   - tools/call(crash)     → 直接 process.exit(3)（用于验证「server 崩了要如实报」）
 *   - 其它                  → JSON-RPC error -32601
 *
 * 用法：node mock-mcp-server.cjs <log.jsonl> [--握不上手]
 *   log.jsonl 每行记录 {pid, method, id} —— 用例据此断言「只 spawn 了一次、只问了一次 tools/list」。
 */
'use strict';

const fs = require('fs');
const logFile = process.argv[2] || null;
const noHandshake = process.argv.includes('--握不上手');

function log(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify(Object.assign({ pid: process.pid, at: Date.now() }, entry)) + '\n');
  } catch {}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    log({ method: msg.method || null, id: msg.id === undefined ? null : msg.id });
    if (msg.id === undefined) continue; // 通知
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n');
    if (msg.method === 'initialize') {
      if (noHandshake) continue; // 故意不回应 → 用例验证握手超时路径
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });
      continue;
    }
    if (msg.method === 'tools/list') {
      reply({
        tools: [
          { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'crash', description: '自杀（测试用）', inputSchema: { type: 'object', properties: {} } },
        ],
      });
      continue;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === 'crash') {
        log({ method: 'crash-exit' });
        process.exit(3);
      }
      if (name === 'echo') {
        reply({ content: [{ type: 'text', text: 'ECHO:' + String(args.text || '') }], mcpPid: process.pid });
        continue;
      }
      fail(-32602, 'unknown tool: ' + name);
      continue;
    }
    fail(-32601, 'method not found: ' + msg.method);
  }
});
process.stdin.on('end', () => process.exit(0));
