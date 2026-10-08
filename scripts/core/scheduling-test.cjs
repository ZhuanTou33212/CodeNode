'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-scheduling-'));
const previousHome = process.env.CODENODE_HOME;
process.env.CODENODE_HOME = path.join(root, 'home');
const settings = require("../../electron/schedulingSettings.cjs");
const { RequestQueue, modelQueue } = require("../../electron/requestQueue.cjs");
const { SubagentManager } = require("../../electron/subagents.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { GraphModel } = require("../../electron/tools/GraphModel.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const agent = require("../../electron/agent.cjs");
const { installScriptedModel } = require("../lib/scripted-model.cjs");

async function queueChecks() {
  const queue = new RequestQueue(3);
  const signal = new AbortController().signal;
  const releases = await Promise.all([queue.acquire(signal), queue.acquire(signal), queue.acquire(signal)]);
  let entered = false;
  const waiting = queue.acquire(signal).then(release => { entered = true; return release; });
  queue.setLimit(1);
  releases[0](); releases[0](); releases[1]();
  await Promise.resolve();
  assert.equal(entered, false, 'Shrinking waits for active requests to drain; release is idempotent');
  releases[2]();
  const release = await waiting;
  assert.equal(queue.stats().active, 1);
  const cancel = new AbortController();
  const cancelled = queue.acquire(cancel.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  cancel.abort(); await rejected;
  assert.equal(queue.stats().waiting, 0);
  const order = [];
  const a = queue.acquire(signal).then(done => { order.push('a'); return done; });
  const b = queue.acquire(signal).then(done => { order.push('b'); return done; });
  queue.setLimit(3);
  const next = await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(queue.stats().active, 3);
  release(); next.forEach(done => done());
  assert.equal(queue.stats().active, 0);
  assert.throws(() => queue.setLimit(0), /无效/);
  console.log('PASS queue limits apply safely when shrinking/expanding; FIFO and cancellation retained');
}

async function warningChecks() {
  const context = new AgentToolContext({ projectRoot: root, model: new GraphModel({ root: { nodes: [], edges: [] } }), confirm: async () => true, audit: () => {} });
  const cfg = { apiBase: 'http://scripted.local/v1', apiKey: 'test', model: 'scripted-model', maxTokens: 1024,
    reasoningEffort: '', reliability: { maxAttempts: 1 }, compression: { enabled: false }, rag: { enabled: false },
    tools: {}, limits: { maxToolIterations: 8, maxTotalTokens: 1000000, progressEvery: 0 },
    subagent: { maxTasksPerRun: 4, maxConcurrentTasks: 2, warningPercent: 75 } };
  const registry = toolkit.buildDefaultRegistryWithConfig({ toolsAllowed: [], toolsEnabled: true, ragEnabled: false });
  let childCalls = 0;
  const manager = new SubagentManager({ cfg, registry, toolkit, runId: 'warning-run', agent: {
    runAgentChat: async ({ cfg: child }) => {
      childCalls++;
      assert.equal(child.subagentBudgetState, null, 'Only supervisor gets convergence warnings');
      return childCalls === 1 ? { error: '模拟业务失败', content: '', toolCalls: [] } : { content: '探查完成', toolCalls: [] };
    },
  } });
  manager.register(registry);
  const stub = installScriptedModel([
    { toolCalls: [{ name: 'delegate_tasks', args: { tasks: [0, 1, 2].map(n => ({ taskId: 'initial-' + n, role: 'explorer', objective: '检索入口并分析模块关系' })) } }] },
    { toolCalls: [{ name: 'delegate_task', args: { taskId: 'final-check', role: 'verifier', objective: '核对最终结果和剩余问题' } }] },
    { content: '完成汇总；保留失败项。' },
  ], { loopLast: false });
  try {
    const result = await agent.runAgentChat({ cfg, messages: [{ role: 'system', content: '测试' }, { role: 'user', content: '完成分工任务并汇总' }], tools: { registry, context } });
    assert.ok(!result.error, result.error);
    const notes = stub.seen.map(request => request.messages.filter(message => typeof message.content === 'string' && message.content.startsWith(settings.BUDGET_NOTE_PREFIX)));
    assert.equal(notes[0].length, 0);
    assert.equal(notes[1].length, 1);
    assert.match(notes[1][0].content, /3\/4.*剩余 1/);
    assert.equal(notes[2].length, 1);
    assert.match(notes[2][0].content, /4\/4.*剩余 0/);
    assert.match(notes[2][0].content, /不再调用 delegate_task/);
    assert.equal(manager.startedTaskCount, 4, 'Started failed tasks still count');
    const blocked = await manager.delegate(context, { taskId: 'over-limit', role: 'explorer', objective: '不应启动' });
    assert.equal(blocked.ok, false);
    assert.equal(childCalls, 4);
    const recoveredCfg = { ...cfg };
    const recovered = new SubagentManager({ cfg: recoveredCfg, registry, toolkit, runId: 'warning-run' });
    assert.equal(recovered.cfg.subagentBudgetState(context).used, 4, 'Restart restores consumed quota before the first model request');
    assert.equal(recovered.startedTaskCount, 4);
    const messages = [{ role: 'user', content: settings.BUDGET_NOTE_PREFIX + '旧提示' }, { role: 'user', content: settings.BUDGET_NOTE_PREFIX + '重复提示' }];
    settings.updateBudgetNote(messages, manager.cfg.subagentBudgetState(context));
    assert.equal(messages.length, 1);
    messages.splice(0); // Compaction dropped the note.
    settings.updateBudgetNote(messages, manager.cfg.subagentBudgetState(context));
    assert.equal(messages.length, 1, 'The next request restores its current warning after compaction');
    console.log('PASS real Agent loop receives quota warnings at 75%, updates one note, counts failures, blocks excess and restores quota');
  } finally { stub.restore(); }
}

(async () => {
  try {
    assert.deepEqual(settings.readSettings(), require("../../config/ui.scheduling.json").defaults);
    assert.equal(settings.budgetState(17, 24).warning, false);
    assert.equal(settings.budgetState(18, 24).warning, true);
    assert.equal(settings.budgetState(18, 24).remaining, 6);
    assert.equal(settings.budgetState(2, 3).warning, false);
    assert.equal(settings.budgetState(1, 24, 75, 6, 8).warning, true, 'Attempt consumption has its own 75% warning');
    const saved = settings.writeSettings({ ...require("../../config/ui.scheduling.json").defaults, concurrency: 6, maxTasksPerRun: 30, maxBatchTasks: 8, warningPercent: 80 });
    const file = settings.settingsFile();
    const before = fs.readFileSync(file, 'utf8');
    const legacy = JSON.parse(before); delete legacy.settings.maxAttemptsPerTask; delete legacy.settings.maxAttemptsPerRun;
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(settings.readSettings().maxAttemptsPerTask, 3);
    assert.equal(settings.readSettings().maxAttemptsPerRun, 72);
    assert.equal(settings.readSettings().concurrency, saved.concurrency);
    fs.writeFileSync(file, before);
    assert.throws(() => settings.writeSettings({ ...saved, maxAttemptsPerTask: 0 }), /整数/);
    assert.throws(() => settings.writeSettings({ ...saved, concurrency: 9 }), /整数/);
    assert.throws(() => settings.writeSettings({ ...saved, warningPercent: '75' }), /整数/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const child = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./electron/agent.cjs").loadConfig(null).scheduling))'], { cwd: path.join(__dirname, "../.."), env: process.env, encoding: 'utf8' }));
    assert.deepEqual(child, saved, 'A new process reads the same persisted global settings');
    fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codenode/agent.properties'), 'agent.subagent.max_tasks_per_run=1\nagent.subagent.max_concurrent_tasks=1\n');
    const loaded = agent.loadConfig(root);
    assert.equal(loaded.subagent.maxConcurrentTasks, 6);
    assert.equal(modelQueue.stats().limit, 6);
    assert.equal(loaded.subagent.maxTasksPerRun, 30);
    assert.equal(loaded.subagent.warningPercent, 80);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => settings.writeSettings(saved), /原文件/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    fs.writeFileSync(file, before);
    console.log('PASS global persistence, new process, project isolation, linked limits, strict validation and corrupt-file preservation');
    await queueChecks();
    await warningChecks();
    console.log('SCHEDULING TEST: PASS');
  } finally {
    if (previousHome === undefined) delete process.env.CODENODE_HOME; else process.env.CODENODE_HOME = previousHome;
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codenode-scheduling-')) throw new Error('Unexpected cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
