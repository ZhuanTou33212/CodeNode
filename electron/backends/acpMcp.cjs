'use strict';
const http = require('http');
const crypto = require('crypto');
const path = require('path');
// Each run owns its server and bearer capability. Neither is written into settings.
async function createToolBridge(registry, context, emit) {
  const token = crypto.randomBytes(32).toString('hex');
  let active = true;
  const controller = new AbortController();
  const parentSignal = context.signal();
  const cancel = () => controller.abort();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  if (parentSignal?.aborted) cancel();
  context = context.fork({ signal: controller.signal, readOnly: context.readOnly() });
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!active || req.method !== 'POST' || req.url !== '/mcp' || req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end('{}'); return; }
    let data = '';
    try {
      for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 1024 * 1024) { res.writeHead(413); res.end('{}'); return; } }
      const m = JSON.parse(data); let result;
      if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codenode', version: require('../../package.json').version } };
      else if (m.method === 'tools/list') result = { tools: registry.listTools().map(spec => ({ name: spec.name, description: spec.description || '', inputSchema: spec.inputSchema || { type: 'object' } })) };
      else if (m.method === 'tools/call') {
        if (!active || context.cancelled()) throw new Error('会话已取消');
        if (calls >= 8) throw new Error('MCP 并发调用超过上限');
        const name = m.params?.name;
        if (!registry.contains(name)) { res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } })); return; }
        const callId = crypto.randomUUID();
        emit({ kind: 'tool', toolCalls: [{ name, callId, args: require('../redaction.cjs').redact(m.params.arguments), ok: null }] });
        calls++;
        let value;
        try { value = await registry.execute(name, m.params.arguments || {}, context, { toolCallId: callId }); } finally { calls--; }
        emit({ kind: 'tool_result', toolCalls: [{ name, callId, ok: value.ok === true, data: require('../redaction.cjs').redact(value) }] });
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.ok !== true };
      } else if (m.method === 'ping') result = {};
      else if (m.id == null) { res.writeHead(204); res.end(); return; }
      else { res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    } catch (error) { if (!res.writableEnded) { res.writeHead(400); res.end(JSON.stringify({ error: { code: -32603, message: require('../redaction.cjs').redact(error.message) } })); } }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(null)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动 CodeNode MCP');
  const endpoint = 'http://127.0.0.1:' + address.port + '/mcp';
  const relay = path.join(__dirname, 'acpMcpRelay.cjs');
  return {
    descriptor: { name: 'codenode', command: process.execPath, args: [relay], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'CODENODE_MCP_ENDPOINT', value: endpoint }, { name: 'CODENODE_MCP_TOKEN', value: token }] },
    close: async () => { active = false; cancel(); parentSignal?.removeEventListener('abort', cancel); server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve(null))); },
  };
}
module.exports = { createToolBridge };
