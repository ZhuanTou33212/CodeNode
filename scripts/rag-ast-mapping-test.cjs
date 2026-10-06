'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRagIndex } = require('../electron/rag/index.cjs');
const { analyzeCode } = require('../electron/rag/codeStructure.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-ast-'));
async function main() {
  try {
    const text = ['export class Ledger {', '  /** Unicode 金额😀 context */', '  settle(value: number) {',
      '    function adjust(amount: number) {', ...Array.from({ length: 100 }, (_, n) => `      const phase${n} = amount + ${n};`),
      '      return amount;', '    }', '    return adjust(value);', '  }', '}'].join('\r\n');
    fs.writeFileSync(path.join(root, 'ledger.ts'), text);
    const structure = analyzeCode('ledger.ts', text);
    const method = /** @type {any} */ (structure.segments.find((segment) => segment.kind === 'method'));
    assert.equal(method.qualifiedSymbol, 'Ledger.settle');
    assert.ok(method.closures.some((closure) => closure.name === 'adjust'));
    const index = new LocalRagIndex(root, { chunkLines: 16, chunkOverlap: 3 });
    index.refresh(true);
    const chunks = index.chunks.filter((chunk) => chunk.symbol === 'settle');
    assert.ok(chunks.length > 5);
    for (const chunk of chunks) {
      assert.ok(chunk.endLine - chunk.startLine < 16);
      const map = chunk.sourceMapping;
      const raw = text.slice(map.startOffset, map.endOffset);
      assert.equal(raw.replace(/\r\n?/g, '\n').trimEnd(), chunk.content);
      assert.ok(chunk.searchText.includes('Ledger.settle'));
      assert.ok(!chunk.content.includes('signature:'));
    }
    assert.ok(chunks.some((chunk) => chunk.metadata.closure.includes('adjust')));
    const covered = new Set(chunks.flatMap((chunk) => Array.from({ length: chunk.endLine - chunk.startLine + 1 }, (_, n) => chunk.startLine + n)));
    for (let line = method.startLine; line <= method.endLine; line++) assert.ok(covered.has(line));
    console.log('RAG AST MAPPING: PASS (long method, closure, CRLF, Unicode, source isolation)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
