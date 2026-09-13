'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../electron/runStore.cjs');
const { redact } = require('../electron/redaction.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-log-test-'));
try {
  const file = path.join(root, 'bounded.jsonl');
  store.appendJsonl(file, { type: 'run_start', runId: 'a' }, 400);
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(store.appendJsonl(file, { message: '字'.repeat(20), i }, 400), true);
    assert.ok(fs.statSync(file).size <= 400);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).type, 'run_start');
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); };
  try { assert.strictEqual(store.appendJsonl(file, { message: 'x'.repeat(350) }, 400), false); }
  finally { fs.renameSync = rename; }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  store.startRun(root, 'running', { prompt: 'api_key=synthetic-private' });
  const runFile = path.join(root, '.codenode/runs/running.jsonl');
  fs.appendFileSync(runFile, '{"partial":');
  assert.strictEqual(store.readRun(root, 'running').length, 1);
  assert.strictEqual(store.recoverInterrupted(root, new Set(['running'])).length, 0);
  assert.strictEqual(store.recoverInterrupted(root).length, 1);
  assert.strictEqual(store.recoverInterrupted(root).length, 0);
  const plan = store.resumePlan(root, 'running');
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.requiresReview, true);
  assert.match(plan.warning, /不会自动重放/);
  assert.ok(!fs.readFileSync(runFile, 'utf8').includes('synthetic-private'));
  const clean = redact({ total_tokens: 42, prompt_tokens: 20, apiKey: 'synthetic',
    args: '{"password":"synthetic-password"}' });
  assert.strictEqual(clean.total_tokens, 42);
  assert.strictEqual(clean.prompt_tokens, 20);
  assert.ok(!JSON.stringify(clean).includes('synthetic'));
  console.log('RUN STORE RELIABILITY: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
