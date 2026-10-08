'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memory = require("../../electron/memory.cjs");
const agent = require("../../electron/agent.cjs");
const memoryIntent = require("../../electron/memoryIntent.cjs");
const memoryPersistence = require("../../electron/memoryPersistence.cjs");
const promptContext = require("../../electron/promptContext.cjs");
const state = require("../../electron/sessionOverrideStore.cjs");
const approvalRules = require("../../electron/approvalRules.cjs");
const { AgentToolRegistry } = require("../../electron/tools/registry.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const memoryTool = require("../../electron/tools/impl/memoryTool.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-session-override-'));
  try {
    const projectEntries = [{ id: 'python-old', scope: 'project', kind: 'preference', key: 'python_version',
      value: 'Python 3.9', content: '本项目默认使用 Python 3.9', status: 'active', version: 1 }];
    const userEntries = [{ id: 'python-global', scope: 'user', kind: 'preference', key: 'python_version',
      value: 'Python 3.8', content: '用户默认使用 Python 3.8', status: 'active', version: 1 }];
    const input = (prompt, sessionOverrides = []) => ({ prompt, projectEntries, userEntries, sessionOverrides });
    const manySlots = Array.from({ length: 60 }, (_, index) => ({
      key: 'setting_' + index, kind: 'preference', content: '值 ' + index, status: 'active',
    })).concat(projectEntries);
    assert.ok(memoryIntent.knownSlots(manySlots, [], [], '调整 python_version').some((item) => item.key === 'python_version'),
      '候选槽位超限时仍保留与提问相关的槽位');
    const context = (prompt, sessionOverrides, memoryIntentResult) => promptContext.buildPromptContext({
      prompt, projectMemoryEntries: projectEntries, sessionOverrides, memoryIntent: memoryIntentResult,
      canvasSummary: '', skills: [],
      memoryConfig: { topK: 5, userTopK: 3, maxEntryChars: 400, budgetTokens: 2000, requireMatch: true },
      dynamicContextConfig: { totalTokens: 0, sections: [] },
      userMemoryStore: {
        readUserMemory: () => ({ ok: true, entries: userEntries }),
        buildUserMemoryInjection: (query, options) => memory.buildMemoryInjection(userEntries, query, { ...options, scope: 'user' }),
      },
      buildSkillsIndex: () => '', truncateCanvasSummary: () => ({ text: '' }), truncateSkillsIndex: () => ({ text: '' }),
    });

    const temporary = await memoryIntent.classify(input('这次用 Python 3.11 跑'), async () => JSON.stringify({
      changes: [{ action: 'temporary', kind: 'preference', key: 'python_version', value: 'Python 3.11', evidence: '这次用 Python 3.11' }],
    }));
    assert.equal(temporary.source, 'semantic');
    assert.equal(temporary.changes[0].override.value, 'Python 3.11');
    assert.equal(temporary.changes[0].override.lifetime, 'task', '这次的默认寿命是任务轮次');
    assert.equal(state.applyChanges(root, 'canvas-one', temporary.changes).ok, true);
    assert.equal(state.readSession(root, 'canvas-one').overrides[0].value, 'Python 3.11');
    assert.deepEqual(state.readSession(root, 'canvas-two').overrides, [], '不同会话不能共享临时覆盖');
    assert.equal(state.applyChanges(root, '__proto__', temporary.changes).code, 'SESSION_OVERRIDE_INVALID');

    const ordinary = await memoryIntent.classify(input('python_version：帮我加一个 requests 依赖',
      state.readSession(root, 'canvas-one').overrides), async () => '{"changes":[]}');
    assert.deepEqual(ordinary.changes, []);
    const nextTurn = context('python_version：帮我加一个 requests 依赖', state.readSession(root, 'canvas-one').overrides, ordinary);
    assert.equal(nextTurn.memoryText, '', '普通后续输入仍屏蔽项目旧值');
    assert.equal(nextTurn.userMemoryText, '', '同槽位用户旧值也被屏蔽');
    assert.match(nextTurn.sessionMemoryText, /Python 3\.11/, '新值在后续轮次进入系统上下文');
    const assembled = agent.buildSystemPrompt({ raw: '' }, '', [], nextTurn.memoryText, '', {
      prompt: '帮我加一个 requests 依赖', userMemoryText: nextTurn.userMemoryText,
      sessionMemoryText: nextTurn.sessionMemoryText,
    });
    assert.doesNotMatch(assembled, /Python 3\.9|Python 3\.8/, '最终 Prompt 不包含冲突的长期默认值');
    assert.match(assembled, /Python 3\.11/, '最终 Prompt 包含当前会话值');
    assert.equal(projectEntries[0].value, 'Python 3.9', '临时覆盖不修改长期记忆');
    let fastCalls = 0;
    const fastOrdinary = await memoryIntent.classify(input('加一个 requests 依赖',
      state.readSession(root, 'canvas-one').overrides), async () => { fastCalls += 1; return '{"changes":[]}'; });
    assert.equal(fastOrdinary.source, 'fast-none');
    assert.equal(fastCalls, 0, '纯普通输入不串行等待额外模型调用');
    for (const ordinaryTask of ['设计一个页面', '修改 src/app.ts 的错误']) {
      const verdict = await memoryIntent.classify(input(ordinaryTask,
        state.readSession(root, 'canvas-one').overrides), async () => {
        fastCalls += 1;
        return '{"changes":[]}';
      });
      assert.equal(verdict.source, 'fast-none', '普通设计/代码任务不触发配置分类：' + ordinaryTask);
    }
    assert.equal(fastCalls, 0);

    const reset = await memoryIntent.classify(input('取消这次 python_version 设置，恢复默认',
      state.readSession(root, 'canvas-one').overrides), async () => JSON.stringify({
      changes: [{ action: 'reset', kind: 'preference', key: 'python_version', evidence: '取消这次 python_version 设置，恢复默认' }],
    }));
    assert.equal(reset.changes[0].action, 'reset');
    assert.deepEqual(state.applyChanges(root, 'canvas-one', reset.changes).overrides, []);
    const restored = context('python_version', state.readSession(root, 'canvas-one').overrides, reset);
    assert.match(restored.memoryText, /Python 3\.9/, '重置后项目默认值恢复');
    assert.equal(restored.userMemoryText, '', '项目默认值仍覆盖用户默认值');

    state.applyChanges(root, 'canvas-one', temporary.changes);
    const resetAll = await memoryIntent.classify(input('恢复本会话所有默认设置',
      state.readSession(root, 'canvas-one').overrides), async () => JSON.stringify({
      changes: [{ action: 'reset', key: '*', evidence: '恢复本会话所有默认设置' }],
    }));
    assert.deepEqual(state.applyChanges(root, 'canvas-one', resetAll.changes).overrides, [], '整会话重置清空覆盖栈');

    state.applyChanges(root, 'canvas-one', temporary.changes);
    const permanent = await memoryIntent.classify(input('本项目以后默认用 Python 3.12',
      state.readSession(root, 'canvas-one').overrides), async () => JSON.stringify({
      changes: [{ action: 'permanent', kind: 'preference', key: 'python_version', value: 'Python 3.12', evidence: '本项目以后默认用 Python 3.12' }],
    }));
    assert.equal(permanent.persistentCandidates[0].scope, 'project');
    assert.equal(permanent.persistentCandidates[0].requiresRememberConfirmation, true);
    const pending = context('本项目以后默认用 Python 3.12',
      state.readSession(root, 'canvas-one').overrides, permanent);
    assert.equal(pending.memoryText, '', '确认前本轮也不能注入冲突旧值');
    assert.match(pending.sessionMemoryText, /Python 3\.12/);
    assert.equal(state.readSession(root, 'canvas-one').overrides[0].value, 'Python 3.11',
      '确认前不能提前清除既有会话覆盖');
    assert.equal(projectEntries[0].value, 'Python 3.9', '分类本身不能写长期记忆');
    const original = memory.addProjectMemory(root, { kind: 'preference', key: 'python_version',
      value: 'Python 3.9', content: '本项目默认使用 Python 3.9' });
    assert.equal(original.ok, true);
    const registry = new AgentToolRegistry();
    memoryTool.register(registry);
    const approved = await memoryPersistence.persistCandidates(permanent.persistentCandidates, {
      registry, context: new AgentToolContext({ projectRoot: root, confirm: async () => true }),
    });
    assert.equal(approved[0].status, 'saved', '明确永久改口经确认后写入长期库');
    assert.deepEqual(state.applyChanges(root, 'canvas-one', permanent.changes).overrides, [],
      '确认写入成功后才清除旧会话覆盖');
    assert.equal(memory.currentSlot(memory.readMemory(root).entries,
      { kind: 'preference', key: 'python_version' }, 'project').value, 'Python 3.12');
    assert.equal(memory.readMemory(root).historyEntries.length, 1, '旧长期版本成为历史');
    state.applyChanges(root, 'rejected-permanent', temporary.changes);
    const denied = await memoryPersistence.persistCandidates([{
      ...permanent.persistentCandidates[0], value: 'Python 3.13', content: '本项目以后默认用 Python 3.13',
    }], { registry, context: new AgentToolContext({ projectRoot: root, confirm: async () => false }) });
    assert.equal(denied[0].status, 'not_saved');
    assert.equal(memory.currentSlot(memory.readMemory(root).entries,
      { kind: 'preference', key: 'python_version' }, 'project').value, 'Python 3.12', '拒绝确认时不改长期库');
    assert.equal(state.readSession(root, 'rejected-permanent').overrides[0].value, 'Python 3.11',
      '永久写入被拒时原临时覆盖仍有效');

    const quoted = memoryIntent.parseModelOutput(JSON.stringify({ changes: [
      { action: 'temporary', kind: 'preference', key: 'python_version', value: 'Python 3.11', evidence: '这次用 Python 3.11' },
    ] }), input('请翻译“这次用 Python 3.11”'));
    assert.equal(quoted, null, '引文不能成为用户覆盖指令');
    const fallback = await memoryIntent.classify({
      prompt: '这次用 Python，顺便重构代码', projectEntries: [{ ...projectEntries[0], key: 'preferred_language', value: 'Go' }],
      userEntries: [], sessionOverrides: [],
    }, async () => { throw new Error('离线'); });
    assert.equal(fallback.source, 'rules', '语义模型失败时仍保留原有高置信规则');
    assert.equal(fallback.changes[0].action, 'temporary');

    const stableId = 'memory-stable';
    const first = state.beginTurn(root, stableId, 'req-1');
    assert.equal(first.turnSeq, 1);
    assert.equal(state.beginTurn(root, stableId, 'req-1').turnSeq, 1, '同一请求重试不能重复消耗寿命');
    assert.equal(state.applyChanges(root, stableId, temporary.changes, { turnSeq: first.turnSeq }).ok, true);
    for (let index = 2; index <= state.DEFAULT_TASK_TURNS + 1; index++) {
      assert.equal(state.beginTurn(root, stableId, 'req-' + index).overrides.length, 1);
    }
    const expired = state.beginTurn(root, stableId, 'req-expired');
    assert.equal(expired.overrides.length, 0, '任务级临时覆盖达到轮次上限后失效');
    assert.equal(expired.expiredSlots.length, 1);

    const sessionId = 'memory-entire-session';
    const sessionTurn = state.beginTurn(root, sessionId, 'session-1');
    state.applyChanges(root, sessionId, [{ action: 'temporary', override: {
      ...temporary.changes[0].override, lifetime: 'session',
    } }], { turnSeq: sessionTurn.turnSeq });
    for (let index = 2; index <= state.DEFAULT_TASK_TURNS + 3; index++) {
      state.beginTurn(root, sessionId, 'session-' + index);
    }
    assert.equal(state.readSession(root, sessionId).overrides.length, 1, '明确本会话覆盖不受任务轮次上限影响');

    const orderId = 'memory-concurrent-order';
    const older = state.beginTurn(root, orderId, 'older');
    const newer = state.beginTurn(root, orderId, 'newer');
    state.applyChanges(root, orderId, [{ action: 'temporary', override: {
      ...temporary.changes[0].override, value: 'Python 3.12',
    } }], { turnSeq: newer.turnSeq });
    const stale = state.applyChanges(root, orderId, temporary.changes, { turnSeq: older.turnSeq });
    assert.equal(stale.skippedSlots.length, 1, '较早请求迟到时不覆盖较晚输入');
    assert.equal(state.readSession(root, orderId).overrides[0].value, 'Python 3.12');

    const resetRaceId = 'memory-reset-race';
    const beforeReset = state.beginTurn(root, resetRaceId, 'before-reset');
    const afterReset = state.beginTurn(root, resetRaceId, 'after-reset');
    state.applyChanges(root, resetRaceId, [{ action: 'reset', all: true }], { turnSeq: afterReset.turnSeq });
    assert.equal(state.applyChanges(root, resetRaceId, temporary.changes,
      { turnSeq: beforeReset.turnSeq }).skippedSlots.length, 1, '迟到的旧覆盖不能复活已清空的栈');

    const taskResetId = 'memory-task-reset';
    const taskTurn = state.beginTurn(root, taskResetId, 'task-1');
    state.applyChanges(root, taskResetId, temporary.changes, { turnSeq: taskTurn.turnSeq });
    const taskShift = await memoryIntent.classify(input('现在开始新任务，写一首诗',
      state.readSession(root, taskResetId).overrides), async () => JSON.stringify({
      changes: [{ action: 'reset_task', key: '*', evidence: '现在开始新任务' }],
    }));
    assert.equal(taskShift.changes[0].action, 'reset_task');
    const shiftTurn = state.beginTurn(root, taskResetId, 'task-2');
    assert.equal(state.applyChanges(root, taskResetId, taskShift.changes,
      { turnSeq: shiftTurn.turnSeq }).overrides.length, 0, '明确换任务时立即清除任务级覆盖');
    const mixedId = 'memory-task-vs-session';
    const mixedFirst = state.beginTurn(root, mixedId, 'mixed-1');
    state.applyChanges(root, mixedId, [
      { action: 'temporary', override: { ...temporary.changes[0].override, lifetime: 'session' } },
      { action: 'temporary', override: { kind: 'preference', key: 'package_manager', value: 'pnpm', lifetime: 'task' } },
    ], { turnSeq: mixedFirst.turnSeq });
    const mixedSecond = state.beginTurn(root, mixedId, 'mixed-2');
    const mixedReset = state.applyChanges(root, mixedId, [{ action: 'reset_task' }], { turnSeq: mixedSecond.turnSeq });
    assert.deepEqual(mixedReset.overrides.map((entry) => entry.key), ['python_version'],
      '换任务只清任务级覆盖，明确本会话覆盖继续有效');
    const delayedId = 'memory-delayed-task';
    const delayedOld = state.beginTurn(root, delayedId, 'delayed-old');
    const delayedNew = state.beginTurn(root, delayedId, 'delayed-new');
    state.applyChanges(root, delayedId, [{ action: 'reset_task' }], { turnSeq: delayedNew.turnSeq });
    assert.equal(state.applyChanges(root, delayedId, temporary.changes,
      { turnSeq: delayedOld.turnSeq }).skippedSlots.length, 1,
    '较早的任务覆盖不能在换任务后迟到复活');

    const epochId = 'memory-manual-new-canvas';
    const epochFirst = state.beginTurn(root, epochId, 'epoch-1', { taskEpoch: 0 });
    state.applyChanges(root, epochId, [
      { action: 'temporary', override: temporary.changes[0].override },
      { action: 'temporary', override: { kind: 'preference', key: 'package_manager',
        value: 'pnpm', lifetime: 'session' } },
    ], { turnSeq: epochFirst.turnSeq });
    assert.deepEqual(state.readSession(root, epochId, { taskEpoch: 1 }).overrides.map((entry) => entry.key),
      ['package_manager'], '用户新建画布后，工作流只读上下文也不带旧任务覆盖');
    const epochSecond = state.beginTurn(root, epochId, 'epoch-2', { taskEpoch: 1 });
    assert.deepEqual(epochSecond.overrides.map((entry) => entry.key), ['package_manager'],
      '新任务首条用户消息清除任务覆盖并保留会话覆盖');
    assert.equal(state.applyChanges(root, epochId, temporary.changes,
      { turnSeq: epochFirst.turnSeq }).skippedSlots.length, 1,
    '旧任务迟到的分类结果不能跨手动任务边界复活');

    const turnOnly = memoryIntent.parseModelOutput(JSON.stringify({ changes: [
      { action: 'temporary', kind: 'preference', key: 'python_version', value: 'Python 3.11', evidence: '本轮用 Python 3.11' },
    ] }), input('本轮用 Python 3.11'));
    assert.equal(turnOnly.changes[0].override.lifetime, 'turn');
    const oneTurn = state.beginTurn(root, 'memory-one-turn', 'one-turn');
    assert.equal(state.applyChanges(root, 'memory-one-turn', turnOnly.changes,
      { turnSeq: oneTurn.turnSeq }).overrides.length, 0, '仅本轮要求不持久化');
    assert.equal(context('本轮用 Python 3.11', [], turnOnly).memoryText, '', '仅本轮要求仍屏蔽本轮长期旧值');
    const layeredId = 'memory-turn-over-session';
    const layerFirst = state.beginTurn(root, layeredId, 'layer-1');
    state.applyChanges(root, layeredId, [{ action: 'temporary', override: {
      ...temporary.changes[0].override, value: 'Python 3.10', lifetime: 'session',
    } }], { turnSeq: layerFirst.turnSeq });
    const layerSecond = state.beginTurn(root, layeredId, 'layer-2');
    state.applyChanges(root, layeredId, turnOnly.changes, { turnSeq: layerSecond.turnSeq });
    assert.equal(state.readSession(root, layeredId).overrides[0].value, 'Python 3.10',
      '仅本轮覆盖不能永久移除原会话覆盖');
    assert.match(context('本轮用 Python 3.11', state.readSession(root, layeredId).overrides,
      turnOnly).sessionMemoryText, /Python 3\.11/, '本轮值在组装时盖过会话值');
    assert.equal(state.beginTurn(root, layeredId, 'layer-3').overrides[0].value, 'Python 3.10',
      '下一轮恢复原会话覆盖');

    const timeoutEntry = [{ id: 'timeout-old', scope: 'project', kind: 'preference', key: 'timeout_seconds',
      value: '30秒', content: '请求超时默认30秒', status: 'active' }];
    let compoundCalls = 0;
    const compound = await memoryIntent.classify({ prompt: '把超时改成10秒，顺便重构这段代码',
      projectEntries: timeoutEntry, userEntries: [], sessionOverrides: [] }, async () => {
      compoundCalls += 1;
      return JSON.stringify({ changes: [{ action: 'temporary', kind: 'preference', key: 'timeout_seconds',
        value: '10秒', evidence: '把超时改成10秒' }] });
    });
    assert.equal(compoundCalls, 1, '复合配置修改进入语义慢路径');
    assert.equal(compound.changes[0].override.lifetime, 'turn', '没有明确寿命的配置修改只影响本轮');

    const legacyRoot = path.join(root, 'legacy-project');
    fs.mkdirSync(path.join(legacyRoot, '.codenode'), { recursive: true });
    fs.writeFileSync(state.storePath(legacyRoot), JSON.stringify({ version: 1, sessions: {
      legacy: { overrides: [{ scope: 'all', kind: 'preference', key: 'python_version', value: 'Python 3.10' }] },
    } }));
    assert.equal(state.beginTurn(legacyRoot, 'legacy', 'legacy-next').overrides[0].lifetime, 'session',
      '旧版状态文件无寿命字段时按原会话寿命兼容读取');

    const file = state.storePath(root);
    assert.equal(approvalRules.isProtectedWriteTarget(root, file), true, 'Agent 文件工具不能改写会话覆盖状态');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken');
    assert.equal(state.readSession(root, 'canvas-one').code, 'SESSION_OVERRIDES_CORRUPT');
    assert.equal(state.applyChanges(root, 'canvas-one', temporary.changes).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken', '损坏状态文件不能被静默覆盖');
    fs.writeFileSync(file, before);
    console.log('SESSION MEMORY OVERRIDE TEST: PASS');
  } finally {
    const target = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    if (path.dirname(target) !== temp || !path.basename(target).startsWith('codenode-session-override-')) {
      throw new Error('拒绝清理意外路径：' + target);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
