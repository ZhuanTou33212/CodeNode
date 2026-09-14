'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const { runAgentChat } = require('../electron/agent.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-boundary-'));
  const originalFetch = global.fetch;
  try {
    const file = path.join(root, 'example.txt');
    fs.writeFileSync(file, 'alpha alpha alpha content');
    const index = new LocalRagIndex(root, { embedProvider: 'local' });
    index.refresh();
    const old = await index.chunkVector(index.chunks[0]);
    fs.writeFileSync(file, 'bravo bravo bravo content');
    index.invalidate('example.txt');
    index.refresh();
    const fresh = await index.chunkVector(index.chunks[0]);
    assert.notDeepStrictEqual(fresh, old, 'same path and line range must not reuse old vector');
    fs.unlinkSync(file);
    index.refresh();
    assert.strictEqual(index.chunkVectors.size, 0);
    let requests = 0;
    global.fetch = async () => {
      requests++;
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: {
        tool_calls: [{ index: 0, id: 'call-' + requests,
          function: { name: 'ping', arguments: '{}' } }],
      } }] }) + '\n\ndata: [DONE]\n\n');
    };
    const events = [];
    const result = await runAgentChat({
      cfg: { apiBase: 'https://fixture.test', model: 'fixture', maxTokens: 10, compression: { enabled: false } },
      messages: [{ role: 'user', content: 'loop' }],
      tools: {
        registry: { toOpenAiTools: () => [], execute: async () => ({ ok: true, text: 'ok', data: {} }) },
        context: { projectRoot: () => null },
      },
      onDelta: event => events.push(event),
    });
    assert.strictEqual(requests, 12);
    assert.strictEqual(result.stopReason, 'iteration_limit');
    assert.ok(result.error);
    assert.ok(!events.some(event => event.kind === 'done'));
    console.log('AGENT BOUNDARY: PASS');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

