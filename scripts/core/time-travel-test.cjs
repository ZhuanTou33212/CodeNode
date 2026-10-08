'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runStore = require("../../electron/runStore.cjs");
const checkpoints = require("../../electron/runCheckpoint.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-time-travel-'));
try {
  runStore.startRun(root, 'source-run', { prompt: 'original task', model: 'test-model' });
  checkpoints.saveMessages(root, 'source-run', [{ role: 'system', content: 'rules' }, { role: 'user', content: 'first request' }], {
    reason: 'round', controlState: { model: 'test-model', modelTaskType: 'main', compacted: 2, apiKey: 'must-not-persist' },
  });
  checkpoints.saveMessages(root, 'source-run', [{ role: 'system', content: 'rules' }, { role: 'user', content: 'second request' }], {
    reason: 'round', controlState: { model: 'other-model', modelTaskType: 'intent', contextTrims: 3 },
  });
  // Tool checkpoints may outnumber message snapshots; the UI must use the
  // dedicated message count when constructing its branch selector.
  checkpoints.recordIntent(root, 'source-run', { callId: 'tool-1', tool: 'read_file', argsDigest: 'x', effect: 'read', idemKey: null });
  const plan = checkpoints.planResume(root, 'source-run');
  assert.equal(plan.checkpointCount, 3);
  assert.equal(plan.messageCheckpointCount, 2);
  const branch = checkpoints.createTimeTravelBranch(root, 'source-run', 'branch-run', 0);
  assert.equal(branch.ok, true);
  assert.equal(branch.requiresReview, true);
  assert.equal(branch.messageCount, 2);
  assert.deepEqual(branch.controlState, { model: 'test-model', modelTaskType: 'main', compacted: 2 });
  assert.equal(runStore.readRun(root, 'source-run').filter((event) => event.type === 'run_start').length, 1);
  const branchEvents = runStore.readRun(root, 'branch-run');
  assert.equal(branchEvents.find((event) => event.type === 'run_start').parentRunId, 'source-run');
  assert.equal(branchEvents.some((event) => event.type === 'time_travel_branch'), true);
  const branchCheckpoint = checkpoints.readCheckpoints(root, 'branch-run').find((event) => event.type === 'messages');
  assert.deepEqual(branchCheckpoint.controlState, branch.controlState);
  assert.equal(JSON.stringify(branchCheckpoint).includes('must-not-persist'), false);
  const missing = checkpoints.createTimeTravelBranch(root, 'source-run', 'missing', 99);
  assert.equal(missing.ok, false);
  console.log('TIME TRAVEL: PASS — branch preservation, checkpoint selection, review requirement');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
