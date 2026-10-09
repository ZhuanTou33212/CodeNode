'use strict';
const http = require('http');
const readline = require('readline');
const endpoint = process.env.CODENODE_MCP_ENDPOINT || '';
if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(process.env.CODENODE_MCP_TOKEN || '')) throw new Error('Invalid MCP run capability');
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) return;
  let message; try { message = JSON.parse(line); } catch { return; }
  const fail = () => { if (message.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'CodeNode tool bridge unavailable' } }) + '\n'); };
  const req = http.request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CODENODE_MCP_TOKEN, 'Content-Type': 'application/json' } }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    res.on('end', () => { if (message.id == null) return; if (res.statusCode !== 200) { fail(); return; } process.stdout.write(body + '\n'); });
  });
  req.on('error', fail); req.setTimeout(120000, () => req.destroy()); req.end(line);
});
