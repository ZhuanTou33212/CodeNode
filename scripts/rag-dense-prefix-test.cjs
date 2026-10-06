'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEmbedder } = require('../electron/embedder/index.cjs');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const { createVectorStore } = require('../electron/vectorStore/index.cjs');
async function main() {
  const calls = [];
  const embedder = createEmbedder({ embedProvider: 'openai', embedDim: 256, embedKey: 'test',
    embedQueryPrefix: 'query:', embedDocumentPrefix: 'passage: ' });
  embedder.embedOpenAi = async (texts) => { calls.push(texts); return texts.map(() => [1, 0]); };
  await embedder.embed(['用户问题'], { inputType: 'query' });
  await embedder.embed(['source body'], { inputType: 'document' });
  await embedder.embed(['untyped']);
  assert.deepEqual(calls, [['query: 用户问题'], ['passage: source body'], ['untyped']]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-dense-prefix-'));
  try {
    const a = createVectorStore({ backend: 'sqlite', root, dim: 256, queryPrefix: 'query: ', documentPrefix: 'passage: ' });
    const b = createVectorStore({ backend: 'sqlite', root, dim: 256 });
    assert.notEqual(/** @type {any} */ (a).file, /** @type {any} */ (b).file, 'Prefix changes must not reuse persisted vectors');
    await a.close(); await b.close();
    fs.writeFileSync(path.join(root, 'lexical.ts'), 'export const exactNeedle = "restart session restart session restart session";');
    fs.writeFileSync(path.join(root, 'semantic.ts'), 'export function rotateCredentials() { return "fresh credential"; }');
    const index = new LocalRagIndex(root, { embedProvider: 'openai', embedKey: 'test', embedDim: 256, memorySemanticMaxChunks: 5000 });
    index.ensureEmbedder = () => ({ isLocal: () => false, embed: async (texts, options) => texts.map((text) => {
      if (options?.inputType === 'query') return [1, 0];
      return String(text).includes('semantic.ts') ? [1, 0] : [0.01, 1];
    }) });
    const result = await index.retrieve('restart session', { mode: 'vector', pureVector: true });
    assert.equal(result.results[0].path, 'semantic.ts', 'Pure Dense must not favor stronger lexical match');
    assert.equal(/** @type {any} */ (result.stats).pureVector, true);
    assert.equal(/** @type {any} */ (result.stats).graph.expanded, 0);
    const disabled = new LocalRagIndex(root);
    await assert.rejects(disabled.retrieve('restart session', { mode: 'vector', pureVector: true }), /学习式/);
    const hash = new LocalRagIndex(root, { embedProvider: 'local' });
    await assert.rejects(hash.retrieve('restart session', { mode: 'vector', pureVector: true }), /学习式/);
    const capped = new LocalRagIndex(root, { embedProvider: 'openai', embedKey: 'test', memorySemanticMaxChunks: 0 });
    await assert.rejects(capped.retrieve('restart session', { mode: 'vector', pureVector: true }), /独立语义召回/);
    console.log('DENSE/PREFIX: PASS (query versus document, cache identity, semantic-only ranking, no graph leakage, no silent fallback)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
