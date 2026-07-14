import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codenode-mcp-test-'));
const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], {
  env: { ...process.env, CODENODE_MCP_PORT: '0', CODENODE_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for MCP server');
};

await waitFor(() => /listening on 127\.0\.0\.1:\d+/.test(stderr));
const port = Number(stderr.match(/127\.0\.0\.1:(\d+)/)[1]);

const health = await fetch(`http://127.0.0.1:${port}/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {
  status: 'ok',
  server: 'codenode',
  delivery: 'mcp-queue',
  canInjectCodexConversation: false
});

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
await waitFor(() => stdout.includes('"id":1'));
assert.equal(JSON.parse(stdout.trim().split('\n')[0]).result.serverInfo.name, 'codenode');

const response = await fetch(`http://127.0.0.1:${port}/markdown`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' },
  body: JSON.stringify({ filename: 'request.md', content: '# Test\n\nlanguage: go\n' })
});
assert.equal(response.status, 201);
assert.deepEqual(await response.json(), {
  filename: 'request.md',
  sequence: 1,
  status: 'queued',
  delivery: 'mcp-queue',
  requiresUserTurn: true,
  nextPrompt: '处理最新 CodeNode 请求'
});

const nodeResponse = await fetch(`http://127.0.0.1:${port}/markdown`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' },
  body: JSON.stringify({ filename: 'node-request.md', content: '---\naction: build-node\nlanguage: go\n---\n\n# Node Test\n' })
});
assert.equal(nodeResponse.status, 201);

const queueResponse = await fetch(`http://127.0.0.1:${port}/markdown`);
assert.equal(queueResponse.status, 200);
const queue = await queueResponse.json();
assert.equal(queue.requests.length, 2);
assert.equal(queue.requests[0].sequence, 1);
assert.equal(queue.requests[0].nodeName, 'Test');
assert.equal(queue.requests[0].action, 'build-program');
assert.equal(queue.requests[0].filename, 'request.md');
assert.equal(queue.requests[1].sequence, 2);
assert.equal(queue.requests[1].nodeName, 'Node Test');
assert.equal(queue.requests[1].action, 'build-node');
assert.equal(queue.requests[1].filename, 'node-request.md');

stdout = '';
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codenode_read_latest_markdown', arguments: {} } })}\n`);
await waitFor(() => stdout.includes('"id":2'));
assert.match(stdout, /language: go/);

child.kill();
await fs.rm(dataDir, { recursive: true, force: true });
console.log('CodeNode MCP smoke test passed');
