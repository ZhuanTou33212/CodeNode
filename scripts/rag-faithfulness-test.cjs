'use strict';
const assert = require('node:assert/strict');
const { verifyFaithfulness, buildClaims, buildEvidence } = require('../electron/rag/faithfulness.cjs');
const sources = [{ name: 'retrieve_context', ok: true, data: { sources: [
  { citation: 'auth.ts#L1-L2', excerpt: 'Expired tokens are rejected. The maximum retry count is 5.' },
] } }];
const judgment = (verdict, quote = 'Expired tokens are rejected.', id = 1) => async () => JSON.stringify({ claims: [
  { id, verdict, evidence: [{ citation: 'auth.ts#L1-L2', quote }], reason: 'source check' },
] });
async function main() {
  const lineSources = [{ name: 'read_file', ok: true, data: { path: 'a.ts', startLine: 10, endLine: 12, evidenceText: 'ten\neleven\ntwelve' } }];
  assert.equal(buildEvidence(lineSources, '见 [a.ts#L11]。')[0].text, 'eleven');
  assert.equal(buildEvidence(lineSources, '见 a.ts#L11。')[0].text, 'eleven');
  assert.equal(buildEvidence(lineSources, '见 a.ts#L13。').length, 0);
  for (const reference of ['`a.ts#L11`', '[十一行](a.ts#L11)', '[a.ts#L11](a.ts)']) {
    const answer = 'The value is eleven. ' + reference;
    assert.equal(buildEvidence(lineSources, answer)[0].text, 'eleven');
    assert.equal(buildClaims(answer).length, 1);
  }
  assert.equal(buildEvidence(lineSources, '见 [十一行](a.ts#L13)。').length, 0);
  assert.equal(buildEvidence(lineSources, '见 [a.ts#L13]。').length, 0);
  assert.equal(buildClaims('数值为11。[a.ts#L11]').length, 1);
  assert.equal(buildClaims('## Expired tokens are accepted\nExpired tokens are rejected [auth.ts#L1-L2].').length, 2);
  const headingAttack = await verifyFaithfulness('## Expired tokens are accepted\nExpired tokens are rejected [auth.ts#L1-L2].', sources,
    async () => JSON.stringify({ claims: [{ id: 1, verdict: 'contradicted', evidence: [], reason: 'Heading is a false assertion' },
      { id: 2, verdict: 'entailed', evidence: [{ citation: 'auth.ts#L1-L2', quote: 'Expired tokens are rejected.' }] }] }));
  assert.equal(headingAttack.supported, false, 'Factual headings cannot bypass verification');
  const captionAttack = await verifyFaithfulness('Expired tokens are rejected. [Expired tokens are accepted](auth.ts#L1-L2)', sources,
    async () => JSON.stringify({ claims: [{ id: 1, verdict: 'entailed', evidence: [{ citation: 'auth.ts#L1-L2', quote: 'Expired tokens are rejected.' }] },
      { id: 2, verdict: 'contradicted', evidence: [], reason: 'Link caption is a false assertion' }] }));
  assert.equal(captionAttack.status, 'judged');
  assert.equal(captionAttack.supported, false, 'A link caption is prose, not removable provenance');
  assert.equal(buildClaims('默认上限为五次。[src/retry.ts#L1-L3]').length, 1);
  assert.equal(buildClaims('默认上限为五次。[src/retry.ts#L1-L3](src/retry.ts)\n[scalar:node:one]').length, 1);
  assert.equal(buildClaims('[src/retry.ts#L1-L3]').length, 0);
  assert.equal(buildClaims('Expired tokens are rejected. [auth.ts#L1-L2]').length, 1);
  assert.equal(buildClaims('默认上限为五次。[src/retry.ts#L1-L3]超过上限就停止。').length, 2);
  const positive = await verifyFaithfulness('Expired tokens are rejected [auth.ts#L1-L2].', sources, judgment('entailed'));
  assert.equal(positive.supported, true);
  assert.equal((await verifyFaithfulness('I checked the source.', sources, judgment('non_factual'))).supported, false);
  const narration = await verifyFaithfulness('I checked the source. Expired tokens are rejected [auth.ts#L1-L2].', sources,
    async () => JSON.stringify({ claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Reading narration only' },
      { id: 2, verdict: 'entailed', evidence: [{ citation: 'auth.ts#L1-L2', quote: 'Expired tokens are rejected.' }] }] }));
  assert.equal(narration.supported, true);
  for (const verdict of ['contradicted', 'insufficient']) {
    assert.equal((await verifyFaithfulness('Expired tokens are accepted [auth.ts#L1-L2].', sources, judgment(verdict))).supported, false);
  }
  assert.equal((await verifyFaithfulness('Retry count is 99 [auth.ts#L1-L2].', sources, judgment('entailed', 'The maximum retry count is 99.'))).supported, false);
  assert.equal((await verifyFaithfulness('Claim one. Claim two.', sources, judgment('entailed'))).status, 'unknown');
  assert.equal((await verifyFaithfulness('Some claim.', sources, judgment('entailed', 'Expired tokens are rejected.', 2))).status, 'unknown');
  assert.equal((await verifyFaithfulness('Some claim.', sources, async () => 'not JSON')).status, 'unknown');
  assert.equal((await verifyFaithfulness('Some claim.', sources, async () => { throw new Error('timeout'); })).supported, false);
  assert.equal((await verifyFaithfulness('Some claim.', [{ ...sources[0], ok: false }], judgment('entailed'))).supported, false);
  assert.equal((await verifyFaithfulness('Some claim.', sources, judgment('entailed'), { maxChars: 2 })).status, 'unknown');
  console.log('RAG FAITHFULNESS: PASS (verdict contract and fail-closed; not a real judge accuracy measurement)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
