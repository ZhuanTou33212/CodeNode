'use strict';
const assert = require('node:assert/strict');
const { assessAnswerability } = require('../electron/rag/answerability.cjs');
const { parseObject, judgeJson } = require('../electron/rag/judgeJson.cjs');
const protocol = require('../electron/modelProtocol.cjs');
const sources = [{ citation: 'limit.ts#L1-L2', excerpt: 'export const limit = 5;\nreturn value >= limit;' }];
const quote = [{ citation: sources[0].citation, quote: 'export const limit = 5;' }];
function scripted(plan, verdicts) {
  let count = 0;
  return async () => JSON.stringify(++count === 1 ? { facts: plan } : { facts: verdicts });
}
async function main() {
  const core = { id: 1, requirement: '限制值', importance: 'core', questionSpan: '限制值' };
  const extra = { id: 2, requirement: '日志实现', importance: 'supplemental', questionSpan: '' };
  const supported = { id: 1, verdict: 'supported', evidence: quote };
  const missing = { id: 2, verdict: 'missing', evidence: [] };
  const qualified = await assessAnswerability('限制值是多少？', sources, scripted([core, extra], [supported, missing]));
  assert.equal(qualified.answerable, true); assert.equal(qualified.status, 'qualified');
  assert.equal(qualified.answerScope, 'core_only'); assert.equal(qualified.missingFacts.length, 1);
  const explicit = { ...extra, questionSpan: '日志' };
  assert.equal((await assessAnswerability('限制值和日志如何实现？', sources, scripted([core, explicit], [supported, missing]))).answerable, false);
  const notCore = await assessAnswerability('限制值是多少？', sources, scripted([core, extra], [
    { id: 1, verdict: 'missing', evidence: [] }, { id: 2, verdict: 'supported', evidence: quote },
  ]));
  assert.equal(notCore.answerable, false);
  assert.deepEqual(parseObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseObject('{"ok":true} trailing text'));
  let calls = 0;
  assert.equal((await judgeJson(async () => ++calls === 1 ? '{' : '{"ok":true}', [], () => {})).ok, true);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(judgeJson(async () => { calls++; return '{'; }, [], () => {}));
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(judgeJson(async () => { calls++; throw Object.assign(new Error('Budget exceeded'), { code: 'COST_LIMIT' }); }, [], () => {}));
  assert.equal(calls, 1, 'Do not retry budget or network failures as format errors');
  const cfg = { apiBase: 'https://api.deepseek.com', apiKey: 'test', model: 'test', maxTokens: 512 };
  assert.deepEqual(protocol.buildRequest({ ...cfg, jsonOutput: true }, [{ role: 'user', content: 'JSON' }]).body.response_format, { type: 'json_object' });
  assert.equal(protocol.buildRequest(cfg, [{ role: 'user', content: 'JSON' }]).body.response_format, undefined);
  console.log('CORE SUFFICIENCY: PASS (core versus supplemental, explicit demands, scoped answer, JSON repair bounds, budget failure, opt-in JSON protocol)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
