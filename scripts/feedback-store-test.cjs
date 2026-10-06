'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const feedback = require('../electron/feedbackStore.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-feedback-'));
try {
  const first = feedback.add(root, { verdict: 'reject', content: '回答含 api-key=sk-secret-value', sessionId: 's1', tools: [{ name: 'read_file', ok: false, code: 'ARG_SCHEMA' }] });
  assert.equal(first.ok, true);
  const duplicate = feedback.add(root, { verdict: 'reject', content: '回答含 api-key=sk-secret-value', sessionId: 's1', tools: [{ name: 'read_file', ok: false, code: 'ARG_SCHEMA' }] });
  assert.equal(duplicate.duplicate, true);
  const accepted = feedback.add(root, { verdict: 'accept', content: '回答可用', sessionId: 's1' });
  assert.equal(accepted.ok, true);
  const records = feedback.read(root);
  assert.equal(records.records.length, 2);
  assert.ok(!JSON.stringify(records).includes('sk-secret-value'));
  const exported = feedback.exportDataset(root);
  assert.equal(exported.count, 2);
  assert.equal(exported.dataset[0].verdict, 'reject');
  const reviewed = feedback.review(root, first.record.id, '应当明确说明无法读取密钥');
  assert.equal(reviewed.ok, true);
  assert.equal(feedback.exportDataset(root, { reviewedOnly: true }).count, 1);
  assert.equal(feedback.add(root, { verdict: 'reject', content: '' }).ok, false);
  console.log('FEEDBACK STORE: PASS — dedupe, provenance, redaction, export and invalid input');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
