'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRagIndex } = require("../../electron/rag/index.cjs");
const { decorateChunk, sourceOffsets } = require("../../electron/rag/chunkMetadata.cjs");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-symbol-terms-'));
  const index = new LocalRagIndex(root, { embedProvider: 'none' });
  try {
    const final = 'export function verifyFaithfulness(answer) {\n  if (answer.claims.length > 24) return false;\n  return true;\n}\n';
    const planning = 'export function assessAnswerability(question) {\n  if (question.facts.length > 12) return false;\n  return true;\n}\n';
    fs.writeFileSync(path.join(root, 'final.ts'), final); fs.writeFileSync(path.join(root, 'planning.ts'), planning);
    const result = await index.retrieve('最终答案支持性校验断言上限', { mode: 'file', topK: 2 });
    assert.equal(result.results[0].path, 'final.ts');
    assert.ok(result.results[0].excerpt.includes('claims.length > 24'));
    assert.ok(!result.results[0].excerpt.includes('最终答案支持性'), 'Search vocabulary must not become source evidence');
    const chunk = { path: 'final.ts', symbol: 'verifyFaithfulness', qualifiedSymbol: 'verifyFaithfulness',
      startLine: 1, endLine: 4, kind: 'function', content: final };
    const decorated = decorateChunk(chunk, final, sourceOffsets(final));
    assert.equal(decorated.content, final); assert.equal(decorated.sourceMapping.startOffset, 0);
    assert.equal(decorated.sourceMapping.endOffset, final.length);
    assert.ok(decorated.searchText.includes('最终答案支持性'));
    assert.ok(!/12|24/.test(decorated.metadata.retrievalTerms), 'Vocabulary must not inject expected answers');
    console.log('SYMBOL TERMS: PASS (nearby concept retrieval, unchanged evidence and offsets, no injected thresholds)');
  } finally {
    index.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('rag-symbol-terms-')) throw new Error('Cleanup boundary');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
