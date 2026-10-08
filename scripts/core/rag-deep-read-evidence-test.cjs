'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { buildDefaultRegistryWithConfig } = require("../../electron/tools/toolkit.cjs");
const { buildToolContent, validateRagGrounding } = require("../../electron/agent.cjs");
const { buildEvidence, buildClaims, verifyFaithfulness } = require("../../electron/rag/faithfulness.cjs");
const { hasIgnoredDir } = require("../../electron/tools/fsCore.cjs");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-deep-read-'));
  try {
    fs.writeFileSync(path.join(root, 'limit.ts'), 'export const limit = 5;\nexport function allowed(n) { return n < limit; }\n');
    const registry = buildDefaultRegistryWithConfig({ projectRoot: root });
    const context = new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {} });
    fs.mkdirSync(path.join(root, 'src/cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/cache/handler.ts'), 'export const CACHE_BUSINESS_MARKER = 1;');
    assert.equal(hasIgnoredDir('src/cache/handler.ts'), false);
    assert.equal(hasIgnoredDir('cache/generated.ts'), true);
    assert.equal(hasIgnoredDir('node_modules/pkg/src/cache/handler.ts'), true);
    const search = await registry.execute('search_files', { pattern: 'CACHE_BUSINESS_MARKER' }, context);
    assert.equal(search.ok, true); assert.ok(search.data.matches.some((line) => line.includes('src/cache/handler.ts')));
    const result = await registry.execute('read_file', { path: 'limit.ts', offset: 1, maxLines: 2 }, context);
    assert.equal(result.ok, true);
    assert.ok(result.data.evidenceText.includes('export const limit = 5;'));
    const projected = buildToolContent(result, 'read_file', false, false, 120000);
    assert.equal(projected.split('export const limit = 5;').length - 1, 1, 'Do not double-send deep-read code');
    assert.ok(projected.includes('L1 | export const limit = 5;'));
    assert.ok(projected.includes('L2 | export function allowed(n)'));
    assert.ok(!result.data.evidenceText.includes('L1 |'), 'Display numbering must not enter source evidence');
    const second = await registry.execute('read_file', { path: 'limit.ts', offset: 2, maxLines: 1 }, context);
    assert.ok(buildToolContent(second, 'read_file', false, false, 120000).includes('L2 | export function allowed(n)'));
    assert.equal(buildEvidence([{ name: 'read_file', ok: true, data: second.data }], '见 [limit.ts#L2]。')[0].text,
      'export function allowed(n) { return n < limit; }');
    fs.writeFileSync(path.join(root, 'page.ts'), 'first\r\n' + '汉😀'.repeat(700) + '\r\nlast');
    const page = await registry.execute('read_file', { path: 'page.ts', offset: 2, maxLines: 1, maxChars: 1000 }, context);
    assert.equal(page.data.startLine, 2); assert.equal(page.data.endLine, 2);
    assert.equal(page.data.nextOffset, 2); assert.equal(page.data.nextCharOffset, 1000);
    assert.ok(page.modelContent.includes('L2 | '));
    const next = await registry.execute('read_file', { path: 'page.ts', offset: page.data.nextOffset,
      charOffset: page.data.nextCharOffset, maxLines: 1, maxChars: 1000 }, context);
    assert.equal(next.data.startLine, 2); assert.equal(next.data.charOffset, 1000);
    assert.ok(next.modelContent.includes('L2 | '));
    const partialEvidence = buildEvidence([{ name: 'read_file', ok: true, data: next.data }], '见 [page.ts#L2]。')[0];
    assert.equal(partialEvidence.partialFirstLine, true); assert.equal(partialEvidence.partialLastLine, true);
    assert.equal(partialEvidence.text, next.data.evidenceText);
    assert.ok(projected.includes(result.data.sourceSha256), 'Preserve source version for write preconditions');
    const calls = [{ name: 'read_file', ok: true, data: result.data }];
    const answer = '限制值为 5。[limit.ts#L1-L1]';
    const evidence = buildEvidence(calls, answer);
    assert.equal(evidence.length, 1); assert.equal(evidence[0].citation, 'limit.ts#L1-L1');
    assert.equal(evidence[0].text, 'export const limit = 5;');
    assert.equal(validateRagGrounding(answer, calls).status, 'valid');
    assert.equal(validateRagGrounding('限制值为 5。[limit.ts#L100-L100]', calls).status, 'invalid');
    assert.equal(validateRagGrounding('限制值为 5。', calls).status, 'missing');
    const faithful = await verifyFaithfulness(answer, calls, async () => JSON.stringify({ claims: [
      { id: 1, verdict: 'entailed', evidence: [{ citation: 'limit.ts#L1-L1', quote: 'export const limit = 5;' }] },
    ] }));
    assert.equal(faithful.supported, true);
    assert.equal(buildEvidence([{ ...calls[0], ok: false }], answer).length, 0);
    const scalar = buildEvidence([{ name: 'query_scalars', ok: true, data: { items: [{ key: 'node:x:goal', value: '验证付款逻辑' }] } }], '目标为验证付款逻辑。[scalar:node:x:goal]');
    assert.equal(scalar[0].text, '验证付款逻辑');
    const numericCalls = [{ name: 'query_scalars', ok: true, data: { items: [{ key: 'node:x:count', value: 5 }] } }];
    assert.equal(buildClaims('不支持。[limit.ts#L1-L1]').length, 1);
    assert.equal(buildClaims('5 [scalar:node:x:count]').length, 1);
    const numeric = await verifyFaithfulness('5 [scalar:node:x:count]', numericCalls, async () => JSON.stringify({ claims: [
      { id: 1, verdict: 'entailed', evidence: [{ citation: 'scalar:node:x:count', quote: '5' }] },
    ] }));
    assert.equal(numeric.supported, true, 'A valid short scalar value is still factual evidence');
    assert.equal(validateRagGrounding('5 [scalar:node:x:count]', numericCalls).status, 'valid');
    const many = [{ name: 'read_file', ok: true, data: { path: 'large.ts', startLine: 1, endLine: 1000,
      evidenceText: Array.from({ length: 1000 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\n') } }];
    assert.equal(buildEvidence(many, '第 900 个值是 899。[large.ts#L900-L900]')[0].text, 'const value899 = 899;');
    console.log('DEEP READ EVIDENCE: PASS (real read contract, one model projection, source hash, cited subranges, scalar evidence, failed-source exclusion, citation validity)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
