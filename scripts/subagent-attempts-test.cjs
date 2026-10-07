'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { SubagentManager, readTaskViews } = require('../electron/subagents.cjs');
const attempts = require('../electron/subagentAttempts.cjs');
const { SideEffectLedger, createGuard } = require('../electron/sideEffects.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { RequestBudget } = require('../electron/requestBudget.cjs');
const { CostLedger } = require('../electron/costLedger.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-attempts-'));

function fixture(name, runner, limits = {}) {
  const root = path.join(base, name); fs.mkdirSync(root);
  const model = new GraphModel({ root: { nodes: [], edges: [] } });
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
  const context = new AgentToolContext({ projectRoot: root, model, confirm: async () => true, audit: () => {}, sandbox: policy,
    mutateWorkbench: async fn => { fn(model); return true; }, sideEffectGuard: createGuard(new SideEffectLedger({ projectRoot: root, scopeRunId: name })) });
  const cfg = { apiBase: 'http://scripted.local/v1', apiKey: 'test', model: 'scripted-model', maxTokens: 1024, reasoningEffort: '',
    reliability: { maxAttempts: 1 }, compression: { enabled: false }, rag: { enabled: false }, editing: { autoVerify: false },
    tools: { toolsEnabled: true }, limits: { maxToolIterations: 8, maxTotalTokens: 1000000, progressEvery: 0 },
    requestBudget: new RequestBudget(1000000), costLedger: new CostLedger({ projectRoot: root, runId: name }),
    costSettings: { delegationGate: false, roleModels: {} },
    subagent: { maxTasksPerRun: 1, maxConcurrentTasks: 1, maxAttemptsPerTask: 3, maxAttemptsPerRun: 6, ...limits } };
  const registry = toolkit.buildDefaultRegistry();
  const manager = new SubagentManager({ cfg, registry, toolkit, runId: name, agent: { runAgentChat: runner, recordCost: agent.recordCost } });
  manager.register(registry);
  return { root, context, cfg, registry, manager };
}
const success = () => ({ content: '已完成并提供候选结果', toolCalls: [], usage: null });
async function retry(f, reason = '重新完成目标并校验') {
  const checked = await f.registry.execute('inspect_subagent_retry', { taskId: 'stable' }, f.context);
  assert.equal(checked.ok, true, checked.text);
  const plan = checked.data;
  return f.registry.execute('retry_subagent_task', { taskId: 'stable', expectedExecutionId: plan.executionId, planDigest: plan.planDigest || '', reason }, f.context);
}
async function realAttempts() {
  let calls = 0;
  let f;
  f = fixture('real', async options => {
    calls++;
    if (calls > 1) {
      assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'original\n', 'Preimage restored before the new model starts');
      assert.equal(fs.existsSync(path.join(f.root, 'scratch.txt')), false, 'Previous Attempt-created file removed');
    }
    const script = installScriptedModel([
      { toolCalls: calls === 1 ? [
        { name: 'write_file', args: { path: 'a.txt', content: 'dirty-v1\n' } },
        { name: 'write_file', args: { path: 'scratch.txt', content: 'scratch\n' } },
      ] : [{ name: 'write_file', args: { path: 'a.txt', content: 'verified-v' + calls + '\n' } }] },
      { content: '本次执行结束，等待主代理核验' },
    ], { loopLast: false });
    try {
      const result = await agent.runAgentChat(options);
      return calls === 1 ? { ...result, error: '模拟业务验收失败' } : result;
    } finally { script.restore(); }
  });
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'original\n');
  const initial = await f.registry.execute('delegate_task', { taskId: 'stable', role: 'builder', objective: '实现文件功能并检查结果' }, f.context);
  assert.equal(initial.ok, false);
  const used = f.cfg.requestBudget.used;
  assert.ok(used > 0);
  const firstId = initial.data.executionId;
  const firstPlan = f.manager.inspectRetry(f.context, { taskId: 'stable' });
  assert.equal(firstPlan.canRetry, true, firstPlan.error);
  assert.deepEqual(firstPlan.items.map(item => item.action), ['restore', 'delete']);
  f.cfg.resolveRoleModel = () => { throw Error('模型不可用'); };
  assert.equal(f.manager.inspectRetry(f.context, { taskId: 'stable' }).canRetry, false);
  delete f.cfg.resolveRoleModel;
  f.manager.tasks.get('stable').dependsOnTaskIds = ['missing-upstream'];
  assert.equal(f.manager.inspectRetry(f.context, { taskId: 'stable' }).canRetry, false);
  f.manager.tasks.get('stable').dependsOnTaskIds = [];
  const wrong = await f.manager.retry(f.context, { taskId: 'stable', expectedExecutionId: 'stale', planDigest: firstPlan.planDigest, reason: '旧请求' });
  assert.equal(wrong.ok, false); assert.equal(calls, 1);
  f.context.confirmHandler = async () => false;
  assert.equal((await retry(f)).ok, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'dirty-v1\n');
  assert.equal(calls, 1);
  f.context.confirmHandler = async () => true;
  const second = await retry(f);
  assert.equal(second.ok, true, second.text);
  assert.equal(second.data.taskId, 'stable'); assert.equal(second.data.attempt, 2);
  assert.notEqual(second.data.executionId, firstId);
  assert.equal(second.data.attempts.length, 2);
  assert.equal(second.data.attempts[0].status, 'failed');
  assert.equal(second.data.attempts[0].compensation.ok, true);
  assert.equal(second.data.attempts[0].sideEffects.files.length, 2);
  assert.equal(f.manager.startedTaskCount, 1);
  assert.equal(f.manager.startedAttemptCount, 2);
  assert.ok(f.cfg.requestBudget.used > used, 'Used request costs are not refunded by compensation');
  assert.equal((await f.manager.delegate(f.context, { taskId: 'quota-rejected', role: 'explorer', objective: '更多探查' })).ok, false);
  assert.ok(readTaskViews(f.root, 'real').tasks.some(task => task.taskId === 'stable'), 'Rejected calls cannot evict the retryable identity/history');
  const registry = toolkit.buildDefaultRegistry();
  const recovered = new SubagentManager({ cfg: { ...f.cfg }, registry, toolkit, runId: 'real', agent: f.manager.agent });
  recovered.register(registry);
  const third = await retry({ ...f, registry, manager: recovered });
  assert.equal(third.ok, true, third.text);
  assert.equal(third.data.attempt, 3); assert.equal(third.data.attempts.length, 3);
  assert.equal(recovered.startedTaskCount, 1); assert.equal(recovered.startedAttemptCount, 3);
  assert.equal(recovered.inspectRetry(f.context, { taskId: 'stable' }).canRetry, false);
  const stored = readTaskViews(f.root, 'real');
  assert.equal(stored.startedTaskCount, 1); assert.equal(stored.startedAttemptCount, 3);
  assert.equal(stored.tasks[0].attempts[0].executionId, firstId);
  assert.equal(stored.tasks[0].attempts[0].sideEffects.files.length, 2);
  assert.equal(new Set(f.cfg.costLedger.entries.filter(entry => entry.taskId === 'stable').map(entry => entry.executionId)).size, 3, 'Costs remain attributed to all three execution IDs');
  assert.equal(recovered.scheduler.active, 0);
  console.log('PASS real child tool loop: same task ID, independent Attempts, restore/delete, approval, history/restart, quota separation and no cost refund');
}

async function conflictsAndUnknown() {
  let calls = 0;
  const f = fixture('conflict', async ({ tools }) => {
    calls++;
    const token = await tools.context.beginSideEffect('write_file', { path: 'a.txt', content: 'dirty' });
    fs.writeFileSync(path.join(tools.context.projectRoot(), 'a.txt'), 'dirty');
    await tools.context.commitSideEffect(token, { ok: true });
    return { ...success(), error: '需要重新实现' };
  });
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'clean');
  await f.manager.delegate(f.context, { taskId: 'stable', role: 'builder', objective: '实现并验证' });
  const originalStat = fs.statSync(path.join(f.root, 'a.txt'));
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'other');
  fs.utimesSync(path.join(f.root, 'a.txt'), originalStat.atime, originalStat.mtime);
  assert.equal(f.manager.inspectRetry(f.context, { taskId: 'stable' }).canRetry, false, 'Same size/mtime does not hide a content conflict');
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'other');
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'dirty');
  f.context.confirmHandler = async () => { fs.writeFileSync(path.join(f.root, 'a.txt'), 'after'); return true; };
  const drift = await retry(f);
  assert.equal(drift.ok, false); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'after');
  for (const phase of ['committed', 'pending', 'unknown']) {
    const unknown = fixture('unknown-' + phase, async ({ tools }) => {
      const token = await tools.context.beginSideEffect('execute_shell', { cmd: 'external-operation' });
      if (phase === 'committed') await tools.context.commitSideEffect(token, { ok: true });
      if (phase === 'unknown') await tools.context.failSideEffect(token, { code: 'EFFECT_UNKNOWN' });
      return { ...success(), error: '失败且需核对外部副作用' };
    });
    await unknown.manager.delegate(unknown.context, { taskId: 'stable', role: 'builder', objective: '处理外部任务并验证' });
    assert.equal(unknown.manager.inspectRetry(unknown.context, { taskId: 'stable' }).canRetry, false);
    assert.equal((await retry(unknown)).ok, false);
    assert.equal(unknown.manager.startedAttemptCount, 1);
  }
  console.log('PASS content/approval drift preserves subsequent edits; external, pending and unknown effects block whole-task restart');
}

async function partialCompensation() {
  const root = path.join(base, 'partial'); fs.mkdirSync(root);
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(root, 'a.txt'), '');
  fs.writeFileSync(path.join(root, 'z.txt'), Buffer.from([0, 255, 1]));
  const journal = new attempts.AttemptJournal(root, 'stable', id);
  const guard = journal.wrap(null);
  for (const name of ['a.txt', 'z.txt']) {
    const token = await guard.begin('write_file', { path: name }, {});
    fs.writeFileSync(path.join(root, name), 'changed');
    await guard.commit(token, {});
  }
  const plan = attempts.planCompensation(root, id);
  assert.equal(plan.ok, true, plan.error);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to) === path.join(root, 'z.txt')) throw Error('模拟第二项写入失败'); return rename(from, to); };
  let result;
  try { result = attempts.compensate(root, id, plan.digest); } finally { fs.renameSync = rename; }
  assert.equal(result.ok, false); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '');
  const resume = attempts.planCompensation(root, id);
  assert.equal(resume.items[0].action, 'skip');
  assert.equal(attempts.compensate(root, id, resume.digest).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'z.txt')), Buffer.from([0, 255, 1]));
  const { file, data } = attempts.readJournal(root, id);
  data.files[0].path = '../outside.txt';
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(attempts.planCompensation(root, id).ok, false);
  console.log('PASS partial compensation is durable/resumable; empty/binary preimages preserved; out-of-root journal paths rejected');
}

async function capsAndCancellation() {
  const f = fixture('caps', async () => success(), { maxTasksPerRun: 3, maxAttemptsPerRun: 2 });
  assert.equal((await f.manager.delegate(f.context, { taskId: 'stable', role: 'explorer', objective: '探查模块并归纳' })).ok, true);
  assert.equal((await retry(f)).ok, true);
  const extra = await f.manager.delegate(f.context, { taskId: 'another', role: 'explorer', objective: '更多探查' });
  assert.equal(extra.ok, false); assert.equal(f.manager.startedTaskCount, 1); assert.equal(f.manager.startedAttemptCount, 2);
  let finish = () => {};
  let calls = 0;
  const busy = fixture('busy', async () => { calls++; await new Promise(resolve => { finish = () => resolve(null); }); return success(); });
  const pending = busy.manager.delegate(busy.context, { taskId: 'stable', role: 'builder', objective: '等待操作结算' });
  for (let n = 0; n < 100 && !calls; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(busy.manager.inspectRetry(busy.context, { taskId: 'stable' }).canRetry, false);
  await busy.registry.execute('cancel_subagent_task', { taskId: 'stable', reason: '用户取消' }, busy.context);
  assert.equal(busy.manager.scheduler.active, 1, 'Cancellation does not release a still-running Promise');
  assert.equal(busy.manager.inspectRetry(busy.context, { taskId: 'stable' }).canRetry, false);
  finish(); await pending;
  assert.equal(busy.manager.scheduler.active, 0); assert.equal(calls, 1);
  busy.context.confirmHandler = async () => false;
  assert.equal((await retry(busy)).ok, false, 'A cancelled task needs new approval even without files');
  assert.equal(calls, 1);
  console.log('PASS global attempt cap, no automatic retry, busy/cancelling restart guard and release only after execution exits');
}
async function worktreeRetry() {
  let calls = 0;
  let previousRoot = '';
  const f = fixture('isolated', async ({ tools }) => {
    calls++;
    const root = tools.context.projectRoot();
    if (calls === 1) previousRoot = root;
    else { assert.equal(root, previousRoot); assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original'); }
    const token = await tools.context.beginSideEffect('write_file', { path: 'a.txt', content: calls === 1 ? 'dirty' : 'fixed' });
    fs.writeFileSync(path.join(root, 'a.txt'), calls === 1 ? 'dirty' : 'fixed');
    await tools.context.commitSideEffect(token, { ok: true });
    return calls === 1 ? { ...success(), error: '隔离实现未验收' } : success();
  });
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'original');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.codenode/\n');
  const git = args => execFileSync('git', args, { cwd: f.root, stdio: 'pipe' });
  git(['init']); git(['config', 'user.name', 'Attempt Fixture']); git(['config', 'user.email', 'attempt@example.test']);
  git(['add', 'a.txt', '.gitignore']); git(['commit', '-m', 'initial fixture']);
  await f.manager.delegate(f.context, { taskId: 'stable', role: 'builder', objective: '实现隔离文件并验证', isolation: 'worktree' });
  const result = await retry(f);
  assert.equal(result.ok, true, result.text);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(previousRoot, 'a.txt'), 'utf8'), 'fixed');
  assert.equal(result.data.worktree.path, previousRoot);
  console.log('PASS worktree retry compensates and reuses the isolated tree; main workspace is unchanged');
}
(async () => {
  try { await realAttempts(); await conflictsAndUnknown(); await partialCompensation(); await capsAndCancellation(); await worktreeRetry(); console.log('SUBAGENT ATTEMPTS: PASS'); }
  finally {
    const resolved = path.resolve(base);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codenode-attempts-')) throw Error('Unexpected cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
