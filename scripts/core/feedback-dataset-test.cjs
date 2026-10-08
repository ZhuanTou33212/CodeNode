'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require("../../electron/feedbackStore.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-feedback-dataset-'));
try {
  const candidate = store.add(root, { verdict: 'reject', content: 'bad answer', sessionId: 's1' });
  assert.equal(candidate.ok, true);
  const out = path.join(root, 'dataset.json');
  const before = spawnSync(process.execPath, ['scripts/eval/feedback-dataset.cjs', '--root=' + root, '--out=' + out], { cwd: path.join(__dirname, "../.."), encoding: 'utf8' });
  assert.equal(before.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).count, 0, 'unreviewed candidate must not enter default dataset');
  const reviewed = store.review(root, candidate.record.id, 'correct answer');
  assert.equal(reviewed.ok, true);
  const after = spawnSync(process.execPath, ['scripts/eval/feedback-dataset.cjs', '--root=' + root, '--out=' + out], { cwd: path.join(__dirname, "../.."), encoding: 'utf8' });
  assert.equal(after.status, 0);
  const dataset = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(dataset.count, 1);
  assert.equal(dataset.dataset[0].expectedOutput, 'correct answer');
  console.log('FEEDBACK DATASET: PASS — review gate, expected output and export');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
