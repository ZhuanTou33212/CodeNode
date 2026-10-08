'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const goal = require('../../electron/goalStore.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-goal-store-'));
try {
  fs.writeFileSync(path.join(root, 'source.txt'), 'baseline\n');
  assert.throws(() => goal.createGoal(root, { title: 'No acceptance' }), /必需验收条件/);

  const created = goal.createGoal(root, { title: 'Release quality', criteria: ['tests pass'], maxTokens: 500 });
  assert.throws(() => goal.updateGoal(root, created.id, { criteria: [] }), /必需验收条件/);
  const criterionId = created.criteria[0].id;
  const first = goal.createTask(root, created.id, { title: 'Implement', criteriaIds: [criterionId], writeScope: ['src'] });
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'run');
  const admission = goal.admit(root, created.id, first.id, 'run-failed');
  assert.equal(admission.status, 'running');
  assert.throws(() => goal.admit(root, created.id, first.id, 'duplicate'), /已有活动 Run/);
  goal.settle(root, 'run-failed', { status: 'failed', usage: { total_tokens: 20 } });
  assert.equal(goal.read(root).goals[0].budget.usedTokens, 20);
  assert.equal(goal.read(root).goals[0].tasks[0].status, 'failed');

  assert.throws(() => goal.updateTask(root, created.id, first.id, { status: 'completed' }), /缺少当前有效的验收证据/);
  const second = goal.createTask(root, created.id, { title: 'Verify', criteriaIds: [criterionId], dependsOn: [first.id] });
  assert.equal(goal.canRun(root, created.id, second.id).decision, 'idle', 'dependencies block downstream work');
  assert.throws(() => goal.updateTask(root, created.id, first.id, { dependsOn: [second.id] }), /循环/);
  assert.throws(() => goal.createTask(root, created.id, { title: 'Escape', writeScope: ['../outside'] }), /项目相对路径/);

  const waitTask = goal.createTask(root, created.id, { title: 'Wait' });
  goal.updateTask(root, created.id, waitTask.id, { waitCondition: { kind: 'external_status', description: 'service online', expected: 'ready' } });
  assert.equal(goal.canRun(root, created.id, waitTask.id).decision, 'wait');
  const observation = { id: 'gateway-revision-4', source: 'monitor', status: 'ready', revision: '4', matched: true };
  const observed = goal.observeWait(root, created.id, waitTask.id, observation);
  assert.equal(observed.matched, true);
  assert.deepEqual(goal.observeWait(root, created.id, waitTask.id, observation), observed, 'wait observations are idempotent by stable ID');
  assert.equal(goal.read(root).goals[0].tasks.find(t => t.id === waitTask.id).status, 'ready');

  goal.addDecision(root, created.id, { question: 'Choose deployment', options: ['A', 'B'], taskIds: [first.id] });
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'needs-user');
  const decision = goal.read(root).decisions[0];
  goal.resolveDecision(root, decision.id, 'A', 'approved');
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'run');

  goal.addContext(root, created.id, 'rules', { content: 'Use the existing test runner.' });
  goal.addContext(root, created.id, 'confirmedExperience', { content: 'unconfirmed', confirmed: false });
  goal.addContext(root, created.id, 'confirmedExperience', { content: 'confirmed', confirmed: true });
  const implementContext = goal.contextForRole(root, created.id, first.id, 'implement');
  assert.equal(implementContext.task.id, first.id);
  assert.deepEqual(implementContext.context.confirmedExperience.map(x => x.content), ['confirmed']);
  assert.equal(goal.contextForRole(root, created.id, first.id, 'verify').context.confirmedExperience, undefined);

  goal.admit(root, created.id, first.id, 'run-completed');
  goal.settle(root, 'run-completed', { status: 'completed', usage: { total_tokens: 30 } });
  assert.equal(goal.read(root).goals[0].tasks.find(t => t.id === first.id).status, 'blocked', 'execution completion is not acceptance');
  assert.throws(() => goal.updateGoal(root, created.id, { status: 'completed' }), /尚未满足完成条件/);
  const evidence = goal.recordEvidence(root, created.id, { taskId: first.id, criterionId, runId: 'verify-1', check: 'npm test', status: 'passed', result: 'exit code 0' });
  assert.equal(evidence.status, 'passed');
  assert.equal(goal.read(root).goals[0].tasks.find(t => t.id === first.id).status, 'completed');
  assert.equal(goal.audit(root, created.id).qualified, false, 'uncompleted required Tasks and evidence remain blocking');

  goal.updateGoal(root, created.id, { criteria: [{ id: criterionId, text: 'tests and lint pass' }] });
  assert.equal(goal.audit(root, created.id).evidence.find(e => e.id === evidence.id).freshness.valid, false, 'criteria revision invalidates prior evidence');

  fs.appendFileSync(path.join(root, 'source.txt'), 'changed after evidence\n');
  const stale = goal.audit(root, created.id);
  assert.equal(stale.evidence.find(e => e.id === evidence.id).freshness.valid, false);
  assert.throws(() => goal.updateGoal(root, created.id, { status: 'completed' }), /尚未满足完成条件/);
  assert.equal(goal.canRun(root, created.id).decision, 'run', 'stale evidence reopens eligible work');

  const paused = goal.updateGoal(root, created.id, { status: 'paused' });
  assert.equal(paused.status, 'paused');
  assert.equal(goal.canRun(root, created.id).decision, 'stopped');
  console.log('GOAL STORE: PASS (acceptance criteria, atomic admission, dependency/wait/decision gates, role context, evidence freshness, budgets, no execution-as-acceptance)');
} finally {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-goal-store-')) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
