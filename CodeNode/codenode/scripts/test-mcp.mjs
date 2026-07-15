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
const markdown = request => `# ${request.nodes[0].name}\n\n## BuildRequest\n\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\`\n`;
const output = { workspaceRoot: 'E:\\CodeNode', relativePath: 'output/test' };
const node = { id: 'node-main', name: 'Program Test', category: 'transform', prompt: 'test', inputs: [], outputs: [] };
const programRequest = {
  schemaVersion: '3.0', requestId: 'request-program', mode: 'executable-workflow', action: 'build-program',
  scope: { kind: 'reachable-graph', targetNodeId: node.id }, language: 'go', entry: node.id, expression: node.id,
  output: { ...output, artifactPolicy: 'executable' }, execution: { compile: true, run: true }, nodes: [node], edges: [], requiresConfirmation: true
};
const documentNode = { id: 'doc-main', name: 'Document Test', category: 'section', prompt: 'document', inputs: [], outputs: [], documentation: { role: 'section', summary: 'document', markdownFragment: '' } };
const documentRequest = {
  schemaVersion: '3.0', requestId: 'request-document', mode: 'markdown-blueprint', action: 'build-markdown',
  scope: { kind: 'selected-node', targetNodeId: documentNode.id }, output: { ...output, artifactPolicy: 'markdown-only' },
  execution: { compile: false, run: false }, nodes: [documentNode], edges: [], requiresConfirmation: true
};

try {
  await waitFor(() => /listening on 127\.0\.0\.1:\d+/.test(stderr));
  const port = Number(stderr.match(/127\.0\.0\.1:(\d+)/)[1]);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).canInjectCodexConversation, false);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  await waitFor(() => stdout.includes('"id":1'));
  assert.equal(JSON.parse(stdout.trim().split('\n')[0]).result.serverInfo.name, 'codenode');

  const response = await fetch(`http://127.0.0.1:${port}/markdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' },
    body: JSON.stringify({ filename: 'request.md', content: markdown(programRequest) })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).mode, 'executable-workflow');

  const documentResponse = await fetch(`http://127.0.0.1:${port}/markdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' },
    body: JSON.stringify({ filename: 'document-request.md', content: markdown(documentRequest) })
  });
  assert.equal(documentResponse.status, 201);

  const queue = await (await fetch(`http://127.0.0.1:${port}/markdown`)).json();
  assert.equal(queue.requests.length, 2);
  assert.deepEqual(queue.requests.map(item => item.sequence), [1, 2]);
  assert.equal(queue.requests[0].action, 'build-program');
  assert.equal(queue.requests[1].mode, 'markdown-blueprint');

  const invalidResponse = await fetch(`http://127.0.0.1:${port}/markdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' },
    body: JSON.stringify({ filename: 'invalid.md', content: '# Missing JSON' })
  });
  assert.equal(invalidResponse.status, 400);

  await fs.writeFile(path.join(dataDir, 'inbox', 'legacy.md'), '# Legacy 2.0 request', 'utf8');
  await fs.writeFile(path.join(dataDir, 'inbox', 'legacy.md.queue.json'), JSON.stringify({ sequence: 3 }), 'utf8');
  const queueWithLegacy = await (await fetch(`http://127.0.0.1:${port}/markdown`)).json();
  assert.equal(queueWithLegacy.requests.find(item => item.filename === 'legacy.md').mode, 'invalid');
  const deleteLegacy = await fetch(`http://127.0.0.1:${port}/markdown?filename=legacy.md`, { method: 'DELETE', headers: { 'X-CodeNode-Bridge': '1' } });
  assert.equal(deleteLegacy.status, 200);

  const deleteResponse = await fetch(`http://127.0.0.1:${port}/markdown?filename=request.md`, { method: 'DELETE', headers: { 'X-CodeNode-Bridge': '1' } });
  assert.equal(deleteResponse.status, 200);
  await assert.rejects(fs.access(path.join(dataDir, 'inbox', 'request.md.queue.json')));

  stdout = '';
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codenode_read_latest_markdown', arguments: {} } })}\n`);
  await waitFor(() => stdout.includes('"id":2'));
  assert.match(stdout, /markdown-blueprint/);

  stdout = '';
  const result = {
    status: 'failed', summary: 'Document validation failed',
    diagnostics: [{ severity: 'error', scope: 'document', nodeId: 'doc-main', message: 'Missing referenced file' }],
    nodeResults: [{ nodeId: 'doc-main', status: 'failed' }]
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codenode_mark_processed', arguments: { filename: 'document-request.md', result } } })}\n`);
  await waitFor(() => stdout.includes('"id":3'));
  const savedResult = await (await fetch(`http://127.0.0.1:${port}/result?filename=document-request.md`)).json();
  assert.equal(savedResult.status, 'failed');
  assert.equal(savedResult.mode, 'markdown-blueprint');
  assert.equal(savedResult.diagnostics[0].nodeId, 'doc-main');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/markdown`)).json()).requests.length, 0);
} finally {
  child.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
}
console.log('CodeNode MCP dual-mode smoke test passed');
