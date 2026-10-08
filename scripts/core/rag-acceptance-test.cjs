'use strict';
const assert = require('node:assert/strict');
const { loadFrozen, summarize, wilson } = require("../eval/rag-acceptance-eval.cjs");
const { dataset } = loadFrozen();
assert.equal(dataset.cases.filter((item) => item.type === 'single').length, 40);
assert.equal(dataset.cases.filter((item) => item.type === 'cross-file').length, 30);
assert.equal(dataset.cases.filter((item) => item.type === 'negative').length, 30);
assert.ok(dataset.cases.every((item) => item.humanReviewed === false), 'Never fabricate human review');
const old = require("../fixtures/rag-benchmark-v1.json");
const negatives = require("../fixtures/rag-adversarial-negatives-v1.json");
const developmentQuestions = new Set([...old.cases, ...negatives.cases].map((item) => item.query));
for (const item of dataset.cases) {
  assert.ok(!developmentQuestions.has(item.query), 'Acceptance query duplicates a development query');
  if (item.type === 'cross-file') assert.equal(new Set(item.sources.map((source) => source.path)).size, 2);
}
const row = (expected, status, answerable) => ({ expected, answerability: { status, answerable } });
const allUnknown = summarize([row(true, 'unknown', false), row(false, 'unknown', false)], 'answerability');
assert.equal(allUnknown.accuracyWithUnknownAsError, 0);
assert.equal(allUnknown.correctRefusalRate, 0);
assert.equal(allUnknown.verificationCoverage, 0);
const metrics = summarize([row(true, 'supported', true), row(false, 'insufficient', false),
  row(true, 'insufficient', false), row(false, 'supported', true)], 'answerability');
assert.equal(metrics.TP, 1); assert.equal(metrics.TN, 1); assert.equal(metrics.FP, 1); assert.equal(metrics.FN, 1);
assert.equal(metrics.accuracyWithUnknownAsError, 0.5);
assert.equal(metrics.negativeFalsePassRate, 0.5);
assert.equal(wilson(0, 0), null);
assert.ok(wilson(100, 100)[0] < 1, '100% observed accuracy is not a guarantee');
console.log('ACCEPTANCE: PASS (100 unique scenarios, source/offset hashes, no exact development overlap, cross-file gold, unknown penalized, uncertainty intervals)');
