'use strict';
const assert = require('node:assert/strict');
const { summarize } = require('./rag-agent-task-summary.cjs');
const dataset = { cases: [{ id: 'S', type: 'single', expectedAnswerable: true },
  { id: 'X', type: 'cross-file', expectedAnswerable: true }, { id: 'N', type: 'negative', expectedAnswerable: false }] };
const row = (id, type, expected, success) => ({ id, type, expected, success, evidenceComplete: expected,
  grounding: { status: 'valid', semantic: { supported: true } },
  grade: { answersQuestion: true, allRequiredFacts: true, inventedImplementation: false } });
const report = { datasetHash: 'hash', rows: [row('S', 'single', true, true), row('X', 'cross-file', true, false)] };
let summary = summarize(report, dataset, 'hash');
assert.equal(summary.completeDatasetRun, false);
assert.deepEqual(summary.missingIds, ['N']);
assert.equal(summary.groups['cross-file'].completed, 1);
assert.equal(summary.groups.negative.successRate, null);
report.rows.push({ ...row('N', 'negative', false, false), error: 'timeout', grade: null });
report['finishedAt'] = '2026-10-05';
summary = summarize(report, dataset, 'hash');
assert.equal(summary.completeDatasetRun, true);
assert.equal(summary.successRate, 1 / 3);
assert.equal(summary.groups.negative.errors, 1);
assert.equal(summary.groups.negative.graderFailures, 1);
assert.throws(() => summarize({ ...report, rows: [...report.rows, report.rows[0]] }, dataset, 'hash'), /duplicate/);
assert.throws(() => summarize(report, dataset, 'wrong'), /hash/);
console.log('AGENT TASK SUMMARY: PASS (incomplete runs, cross-file stratum, errors, duplicates, hash binding)');
