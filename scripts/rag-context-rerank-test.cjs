'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const { rerankCandidates } = require('../electron/rag/rerank.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-context-rerank-'));
  try {
    const text = 'const RETRY_LIMIT = 7;\n\nexport function retryPayment(attempt: number) {\n  return attempt < RETRY_LIMIT;\n}\n';
    fs.writeFileSync(path.join(root, 'retry.ts'), text);
    const index = new LocalRagIndex(root, { adjacentContextLines: 12, maxContextChars: 1000 });
    const result = await index.retrieve('retryPayment', { mode: 'file', topK: 1 });
    assert.equal(result.results.length, 1);
    const adjacent = result.results[0].contexts.find((context) => context.kind === 'adjacent');
    assert.ok(adjacent && adjacent.excerpt.includes('const RETRY_LIMIT = 7;'));
    const lines = text.split('\n');
    for (const source of [result.results[0], ...result.results[0].contexts]) {
      assert.equal(lines.slice(source.startLine - 1, source.endLine).join('\n').trimEnd(), source.excerpt.trimEnd());
    }
    assert.ok(result.results[0].excerpt.length + result.results[0].contexts.reduce((sum, part) => sum + part.excerpt.length, 0) <= 1000);
    const none = new LocalRagIndex(root, { adjacentContextLines: 0 });
    const plain = await none.retrieve('retryPayment', { mode: 'file', topK: 1 });
    assert.ok(!plain.results[0].contexts.some((context) => context.kind === 'adjacent'));
    fs.writeFileSync(path.join(root, 'config.ts'), 'const PRIVATE_DEFAULTS = Object.freeze({\n  chunkLimit: 100,\n  timeoutMs: 500,\n});\nconst oneLine = { a: 1, b: 2 };\n');
    index.refresh(true);
    const properties = index.chunks.filter((chunk) => chunk.kind === 'property' && chunk.parentSymbol === 'PRIVATE_DEFAULTS');
    assert.deepEqual(properties.map((chunk) => chunk.qualifiedSymbol), ['PRIVATE_DEFAULTS.chunkLimit', 'PRIVATE_DEFAULTS.timeoutMs']);
    assert.ok(properties.every((chunk) => chunk.contexts.some((context) => context.content.includes('PRIVATE_DEFAULTS'))));
    assert.ok(index.chunks.some((chunk) => chunk.content.includes('a: 1, b: 2')), 'Same-line properties remain intact');
    const candidates = [{ chunk: { id: 'a', path: 'a.ts', content: 'value a' } }, { chunk: { id: 'b', path: 'b.ts', content: 'value b' } }];
    await assert.rejects(rerankCandidates('query', candidates, { client: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) }), /覆盖不完整/);
    await assert.rejects(rerankCandidates('query', candidates, { client: async () => ({ results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }] }) }), /重复/);
    await assert.rejects(rerankCandidates('query', candidates, { client: async () => ({ results: [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0 }] }) }), /必须为数字/);
    const controller = new AbortController();
    const pending = rerankCandidates('query', candidates, { signal: controller.signal, client: async () => new Promise(() => {}) });
    controller.abort(new Error('Test cancellation'));
    await assert.rejects(pending, /cancellation/);
    console.log('CONTEXT/RERANK: PASS (private constant block, adjacent source line mapping, char budget, disable switch, complete scores, duplicate/null rejection, cancellation)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
