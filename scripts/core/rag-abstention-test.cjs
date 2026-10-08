'use strict';
const assert = require('node:assert/strict');
const { verifyFaithfulness, evidenceKey } = require("../../electron/rag/faithfulness.cjs");
const { semanticRejected } = require("../../electron/rag/abstention.cjs");
const nonFactual = { claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Scope limitation' }] };
const safe = { disposition: 'evidence_limited_abstention', sourceSufficiency: 'insufficient',
  hasProjectAssertion: false, addressesQuestion: true, reason: 'No readable implementation evidence' };
async function run(verdict, answer = '现有证据不足以说明自动下载流程。') {
  let calls = 0;
  const result = await verifyFaithfulness(answer, [], async () => JSON.stringify(++calls === 1 ? nonFactual : verdict),
    { question: '首次启动如何自动下载模型？' });
  return { result, calls };
}
async function main() {
  const { result, calls } = await run(safe);
  assert.equal(calls, 2); assert.equal(result.status, 'abstained');
  assert.equal(result.supported, false); assert.equal(semanticRejected(result), false);
  for (const changed of [{ ...safe, disposition: 'off_topic', addressesQuestion: false },
    { ...safe, disposition: 'unnecessary_abstention', sourceSufficiency: 'sufficient' },
    { ...safe, hasProjectAssertion: true }, { ...safe, sourceSufficiency: 'unknown' }]) {
    assert.equal(semanticRejected((await run(changed)).result), true);
  }
  assert.equal(semanticRejected((await run({ ...safe, addressesQuestion: 'yes' })).result), true);
  let factualCalls = 0;
  const unsafe = await verifyFaithfulness('项目从不下载模型。', [], async () => {
    factualCalls++; return JSON.stringify({ claims: [{ id: 1, verdict: 'insufficient', evidence: [], reason: 'No absence proof' }] });
  }, { question: '首次启动如何自动下载模型？' });
  assert.equal(factualCalls, 1); assert.equal(semanticRejected(unsafe), true);
  assert.equal(semanticRejected({ status: 'unknown', supported: false, safeForDelivery: true }), true);
  assert.notEqual(evidenceKey('无法确认。', [], '问题一'), evidenceKey('无法确认。', [], '问题二'));
  console.log('ABSTENTION: PASS (bounded refusal, no false fact pass, off-topic, unnecessary refusal, schema, question binding)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
