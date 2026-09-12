'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const agent = require('../electron/agent.cjs');
const modelStore = require('../electron/modelStore.cjs');
const runStore = require('../electron/runStore.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function main() {
  const mainSource = read('electron/main.cjs');
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.match(mainSource, /sandbox:\s*true/);
  assert.match(mainSource, /maxConcurrentRuns/);
  assert.match(mainSource, /runStore\.startRun/);
  assert.match(mainSource, /runStore\.finishRun/);

  const cfg = agent.loadConfig(path.join(__dirname, '..'));
  assert.ok(cfg.limits.maxConcurrentRuns >= 1);
  assert.ok(cfg.limits.maxTotalTokens >= 10000);
  assert.strictEqual(toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' }).contains('execute_shell'), false);
  assert.strictEqual(modelStore.toPublicModel({ id: 'x', apiKey: 'secret' }).apiKey, '');
  assert.strictEqual(modelStore.toPublicModel({ id: 'x', apiKey: 'secret' }).apiKeySet, true);

  const temp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codenode-production-gate-'));
  try {
    runStore.startRun(temp, 'gate-run', { model: 'test' });
    runStore.finishRun(temp, 'gate-run', 'completed');
    assert.strictEqual(runStore.summarizeRun(runStore.readRun(temp, 'gate-run')).status, 'completed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('PRODUCTION GATE: PASS');
}

try {
  main();
} catch (error) {
  console.error('PRODUCTION GATE: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
