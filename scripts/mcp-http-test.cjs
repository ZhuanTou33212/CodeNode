/**
 * mcp-http-test.cjs —— MCP 的 streamable HTTP transport（对照文档 §5 #5 的剩余项）
 *
 * 短板：MCP 此前只支持 stdio（spawn 本地进程），远端/容器化 server 一个都接不上。
 *
 * 判据（用**进程内 mock HTTP server** 记请求取证，不看客户端自我报告）：
 *   A JSON 应答：initialize → tools/list（一次，缓存）→ tools/call（两次复用同一会话，不重新 spawn）
 *   B SSE 应答：`text/event-stream` 逐帧取同 id 应答；找不到同 id → 如实报错
 *   C 出网策略：sandbox.network=deny（出厂默认）时**拒绝**并说清怎么放开
 *   D 错误语义：HTTP 500 / 空应答 / 非 JSON → 各自如实报错，不假装成功
 *   E 会话与头：`mcp-session-id` 记住并在后续请求带上；配置里的自定义头真的发出去了
 *   F transport 选择：显式 transport / url-无-command / 默认 stdio 三种写法都判对
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const mcpClient = require('../electron/tools/mcpClient.cjs');
const mcpHttp = require('../electron/tools/mcpHttpTransport.cjs');
const sandbox = require('../electron/sandbox.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-mcp-http-'));
const policyAllow = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
const policyDeny = sandbox.resolvePolicy({ mode: 'off', network: 'deny' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policyAllow);

/** mock MCP HTTP server：记请求 + 按模式回 JSON 或 SSE */
function startMockMcp(mode) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let message = {};
      try {
        message = JSON.parse(body || '{}');
      } catch {}
      requests.push({ method: message.method || null, id: message.id === undefined ? null : message.id, sessionId: req.headers['mcp-session-id'] || null, custom: req.headers['x-codenode-test'] || null });
      const reply = (result) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (mode === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-123' });
          // SSE 里先塞一个无关帧（客户端必须按 id 找，而不是取第一帧）
          res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n\n' + 'event: message\ndata: ' + payload + '\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
        res.end(payload);
      };
      if (mode === 'error500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (mode === 'empty') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
        res.end('');
        return;
      }
      if (mode === 'notjson') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
        res.end('这不是 JSON');
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202, { 'mcp-session-id': 'sess-123' });
        res.end('');
        return;
      }
      if (message.method === 'initialize') {
        reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-http-mcp', version: '1.0.0' } });
        return;
      }
      if (message.method === 'tools/list') {
        reply({ tools: [{ name: 'echo' }, { name: 'other' }] });
        return;
      }
      if (message.method === 'tools/call') {
        const name = (message.params && message.params.name) || '';
        if (name === 'echo') {
          reply({ content: [{ type: 'text', text: 'HTTP-ECHO:' + String((message.params.arguments || {}).text || '') }] });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool: ' + name } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {any} */ (server.address());
      resolve({
        port: addr.port,
        requests,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function httpExtension(port, extra) {
  return Object.assign(
    { name: 'mock-http-mcp', kind: 'mcp', transport: 'http', url: 'http://127.0.0.1:' + port + '/mcp', timeoutMs: 20000, idleMs: 5000, source: 'test' },
    extra || {}
  );
}

(async () => {
  // ==================== A. JSON 应答 + 会话复用 ====================
  console.log('\n== A. JSON 应答 + 会话复用 ==');
  {
    const mock = await startMockMcp('json');
    mcpClient.resetStats();
    const ext = httpExtension(mock.port, { headers: { 'x-codenode-test': 'yes' } });
    const first = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'one' }, null, undefined);
    const second = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'two' }, null, undefined);
    check('[A] 第一次调用成功（内容来自真实 HTTP 应答）', first.ok === true && /HTTP-ECHO:one/.test(String(first.output)), String(first.output).slice(0, 60));
    check('[A] 第二次调用成功（复用会话）', second.ok === true && /HTTP-ECHO:two/.test(String(second.output)), String(second.output).slice(0, 60));
    check('[A] **没有 spawn 任何进程**（HTTP 不该有子进程）', mcpClient.snapshot().spawns === 0, JSON.stringify(mcpClient.snapshot()));
    check('[A] initialize 只做一次', mock.requests.filter((r) => r.method === 'initialize').length === 1, JSON.stringify(mock.requests.map((r) => r.method)));
    check('[A] tools/list 只问一次（缓存）', mock.requests.filter((r) => r.method === 'tools/list').length === 1, String(mock.requests.filter((r) => r.method === 'tools/list').length));
    check('[A] tools/call 两次', mock.requests.filter((r) => r.method === 'tools/call').length === 2);
    check('[A] 声明清单被缓存（echo/other）', Array.isArray(first.declaredTools) && first.declaredTools.join(',') === 'echo,other', JSON.stringify(first.declaredTools));
    check('[A] stats.reused 记录了复用', mcpClient.snapshot().reused >= 1, JSON.stringify(mcpClient.snapshot().reused));
    await mock.stop();
  }

  // ==================== B. SSE 应答 ====================
  console.log('\n== B. SSE 应答 ==');
  {
    const mock = await startMockMcp('sse');
    mcpClient.resetStats();
    const ext = httpExtension(mock.port);
    const res = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'sse' }, null, undefined);
    check('[B] SSE 应答能按 id 找到正确那一帧（不被无关帧带偏）', res.ok === true && /HTTP-ECHO:sse/.test(String(res.output)), String(res.output || res.error).slice(0, 70));
    check('[B] SSE 模式下 tools/list 也解析成功', Array.isArray(res.declaredTools) && res.declaredTools.length === 2, JSON.stringify(res.declaredTools));
    const picked = mcpHttp.pickFromSse(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"ok":1}}\n\n',
      9
    );
    check('[B] pickFromSse 纯函数：按 id 命中', picked && picked.result && picked.result.ok === 1, JSON.stringify(picked));
    const unmatched = mcpHttp.pickFromSse('data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n', 9);
    check('[B] pickFromSse：没有同 id → 如实标 __unmatched（而不是取第一帧蒙混）', unmatched && unmatched.__unmatched && Array.isArray(unmatched.__unmatched), JSON.stringify(unmatched));
    await mock.stop();
  }

  // ==================== C. 出网策略：deny 时拒绝 ====================
  console.log('\n== C. 出网策略 ==');
  {
    const mock = await startMockMcp('json');
    const ext = httpExtension(mock.port);
    const denyCtx = { sandbox: () => policyDeny };
    const res = await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'x' }, null, denyCtx);
    check('[C] network=deny（出厂默认）→ 拒绝并说明怎么放开', res.ok === false && /sandbox\.network=deny/.test(String(res.error)) && /allow 或 inherit/.test(String(res.error)), String(res.error).slice(0, 90));
    check('[C] 拒绝时不发任何请求（终端判据：mock 一条都没收到）', mock.requests.length === 0, 'requests=' + mock.requests.length);
    await mock.stop();
  }

  // ==================== D. 错误语义 ====================
  console.log('\n== D. 错误语义 ==');
  {
    /** @type {Array<[string, RegExp, string]>} */
    const cases = [
      ['error500', /HTTP 500/, 'HTTP 500 → 报出状态码'],
      ['empty', /应答为空/, '空应答 → 如实报空'],
      ['notjson', /不是 JSON/, '非 JSON → 如实报不是 JSON'],
    ];
    for (const [mode, pattern, label] of cases) {
      const mock = await startMockMcp(mode);
      mcpClient.resetStats();
      const res = await mcpClient.callTool(root, httpExtension(mock.port), { name: 'echo' }, { text: 'x' }, null, undefined);
      check('[D] ' + label, res.ok === false && pattern.test(String(res.error)), String(res.error).slice(0, 70));
      await mock.stop();
    }
    // 工具层报错（JSON-RPC error 帧）要透出 server 的原因
    const mock = await startMockMcp('json');
    mcpClient.resetStats();
    const res = await mcpClient.callTool(root, httpExtension(mock.port), { name: 'nope' }, {}, null, undefined);
    check('[D] JSON-RPC error 帧 → 透出 server 的原因', res.ok === false && /unknown tool: nope/.test(String(res.error)), String(res.error).slice(0, 70));
    await mock.stop();
  }

  // ==================== E. 会话 id 与自定义头 ====================
  console.log('\n== E. 会话 id 与自定义头 ==');
  {
    const mock = await startMockMcp('json');
    mcpClient.resetStats();
    const ext = httpExtension(mock.port, { headers: { 'x-codenode-test': 'yes' } });
    await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'a' }, null, undefined);
    await mcpClient.callTool(root, ext, { name: 'echo' }, { text: 'b' }, null, undefined);
    const initialize = mock.requests.find((r) => r.method === 'initialize');
    const later = mock.requests.filter((r) => r.method !== 'initialize');
    check('[E] 首个请求没有 session 头，之后的请求都带上 mcp-session-id', initialize && initialize.sessionId === null && later.length > 0 && later.every((r) => r.sessionId === 'sess-123'), JSON.stringify({ first: initialize && initialize.sessionId, later: later.map((r) => r.sessionId) }));
    check('[E] 配置里的自定义头真的发出去了', mock.requests.every((r) => r.custom === 'yes'), JSON.stringify(mock.requests.map((r) => r.custom).slice(0, 3)));
    await mock.stop();
  }

  // ==================== F. transport 选择 ====================
  console.log('\n== F. transport 选择 ==');
  {
    check('[F] 显式 transport=http', mcpClient.extensionTransport({ transport: 'http', url: 'http://x/mcp' }) === 'http');
    check('[F] 显式 transport=streamable-http', mcpClient.extensionTransport({ transport: 'streamable-http', url: 'http://x/mcp' }) === 'http');
    check('[F] 只给 url 不给 command → http', mcpClient.extensionTransport({ url: 'http://x/mcp' }) === 'http');
    check('[F] 只给 command → stdio（向后兼容）', mcpClient.extensionTransport({ command: 'node server.cjs' }) === 'stdio');
    check('[F] 都给了但显式 stdio → stdio（显式优先）', mcpClient.extensionTransport({ transport: 'stdio', command: 'npx x', url: 'http://x' }) === 'stdio');
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'mcpHttpTransport.cjs'), 'utf8');
    check('[F] 请求头注入被拦（配置也可能被写坏）', /请求头含非法字符/.test(src) && /\[\\r\\n\]/.test(src));
    check('[F] 走 publicHttp.request（地址解析+固定/字节上限）', /require\('\.\.\/publicHttp\.cjs'\)/.test(src) && /httpRequest\(/.test(src));
    check('[F] 显式声明放行私有地址（本地 MCP server 是用户自己配的端点）', /allowPrivateHosts: true/.test(src));
    check('[F] 不自动跟随重定向（POST 语义各家不同，如实报错）', /不允许的响应：重定向到/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'publicHttp.cjs'), 'utf8')));
  }

  mcpClient.closeAll();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'MCP HTTP TEST: PASS' : 'MCP HTTP TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('MCP HTTP TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
