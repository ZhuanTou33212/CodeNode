'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backendFactory = require('./index.cjs');
const runStore = require('../runStore.cjs');
const diff = require('./workspaceDiff.cjs');
const { CodeVerifier } = require('../codeVerification.cjs');
const { createStateMachine, toRunStatus } = require('../agentState.cjs');
const activeProjects = new Set();
function projectKey(root) { const key = path.resolve(root); return process.platform === 'win32' ? key.toLowerCase() : key; }
function sessionFromRun(root, id) {
  const events = runStore.readRun(root, id);
  const start = events.find(event => event.type === 'run_start');
  if (start?.backend !== 'codex') return null;
  const session = [...events].reverse().find(event => event.type === 'backend_session');
  const finish = [...events].reverse().find(event => event.type === 'run_finish');
  return { start, session, finish };
}
function previousSession(root, sessionId) {
  if (!sessionId) return null;
  for (const run of runStore.listRuns(root, 200)) {
    const record = sessionFromRun(root, run.runId);
    if (record && record.start.planSessionId === sessionId && record.session?.threadId) return record;
  }
  return null;
}
function resumePlan(root, id, activeIds) {
  const record = sessionFromRun(root, id);
  if (!record) return null;
  if (activeIds.has(runStore.normalizeRunId(id))) return { ok: false, error: '原 Codex 执行仍在运行' };
  if (!record.session?.threadId) return { ok: false, error: '缺少精确 Codex 会话记录，不能恢复原执行' };
  if (record.finish?.state === 'COMPLETED') return { ok: true, mode: 'complete', runId: id, prompt: record.start.prompt, reason: '原执行已完成' };
  return { ok: true, mode: 'review', requiresReview: true, runId: id, prompt: record.start.prompt,
    reason: '继续原 Codex 会话；启动前查询原执行状态', warning: '请先检查现有文件差异。外部副作用不会由 CodeNode 自动重放或回滚。',
    unknownEffects: record.finish?.stopReason === 'backend_result_unknown' || !record.finish ? [{ tool: 'Codex 外部执行', effect: '原执行结果待核实' }] : [],
    pendingSteps: [], completedSteps: [], backend: 'codex' };
}
async function runExternal(input, deps = {}) {
  const { projectRoot: root, requestId, sessionId, resumeRunId, resumeForce, settings, cfg, signal, onDelta, confirm } = input;
  if (!root || !fs.statSync(root).isDirectory()) return { ok: false, error: 'Codex 后端需要先选择项目工作目录' };
  const key = projectKey(root);
  if (activeProjects.has(key)) return { ok: false, error: '当前项目已有 Codex 执行，请等待结束' };
  if (input.attachments?.length || input.forceCompact) return { ok: false, error: '首版 Codex 后端暂不支持图片附件与 /compact，请切换内置后端使用' };
  const plan = resumeRunId ? resumePlan(root, resumeRunId, new Set()) : null;
  if (resumeRunId && !plan) return { ok: false, error: '不能把内置检查点恢复到 Codex 后端' };
  if (plan && (!plan.ok || plan.mode === 'complete')) return { ok: false, error: plan.error || plan.reason };
  if (plan?.requiresReview && resumeForce !== true) return { ok: false, needsReview: true, plan };
  const previous = resumeRunId ? sessionFromRun(root, resumeRunId) : previousSession(root, sessionId);
  if (!resumeRunId && previous && (!previous.finish || previous.finish.stopReason === 'backend_result_unknown')) {
    return { ok: false, needsReview: true, plan: resumePlan(root, previous.start.runId, new Set()) };
  }
  const backend = (deps.createBackend || backendFactory.createBackend)('codex', settings);
  const runId = runStore.normalizeRunId(requestId);
  if (runStore.readRun(root, runId).length) return { ok: false, runId, error: '该请求编号已有执行记录，请查看原运行结果，避免重复执行' };
  const machine = createStateMachine({ onTransition: info => emit({ kind: 'state', state: info.to, previous: info.from, sequence: info.sequence, reason: info.reason }) });
  function emit(delta) {
    onDelta(delta);
    if (delta.kind === 'state') runStore.appendEvent(root, runId, 'run_state', delta);
    else if (!['content', 'reasoning', 'start'].includes(delta.kind)) {
      runStore.appendEvent(root, runId, delta.kind, delta);
      require('../eventBus.cjs').emit(root, { ...delta, runId, backend: 'codex' });
    }
  }
  activeProjects.add(key);
  try {
    if (!runStore.startRun(root, runId, { prompt: String(input.prompt || '').slice(0, 4000), backend: 'codex',
      model: settings.model || 'Codex 默认模型', nodeId: input.nodeId || null, planSessionId: sessionId || null,
      resumedFrom: resumeRunId || null, cwd: path.resolve(root), permissions: { sandbox: settings.sandbox, approvalPolicy: require('../../config/agent.backends.json').approvalPolicies[settings.sandbox] },
      cost: 'unknown', hardBudget: false })) throw new Error('无法保存后端运行记录，执行未启动');
    emit({ kind: 'start' });
    emit({ kind: 'state', state: 'RUNNING', previous: null, sequence: 0 });
    const before = diff.capture(root);
    const contextFingerprint = crypto.createHash('sha256').update(JSON.stringify([...before.entries].sort())).digest('hex');
    runStore.appendEvent(root, runId, 'backend_context', { contextRevision: input.document?.root?.revision || 0, contextFingerprint, complete: before.complete });
    const result = await backend.start({ ...input, backendSession: previous?.session,
      onSession: session => { if (!runStore.appendEvent(root, runId, 'backend_session', session)) throw new Error('无法持久化 Codex 会话，停止执行'); },
      onDelta: delta => {
        if (delta.kind === 'state') return;
        if (delta.kind === 'backend_approval') machine.go(delta.phase === 'requested' ? 'WAITING_USER' : 'RUNNING', delta.phase);
        emit(delta);
      }, confirm });
    const changes = diff.compare(before, diff.capture(root));
    emit({ kind: 'backend_changes', changes });
    // Surface independently measured changes in the existing file-change UI.
    for (const file of changes.files) emit({ kind: 'file_change', fileChange: { path: file.path, action: file.kind, status: 'changed', source: 'workspace-fingerprint' } });
    const verifier = new CodeVerifier(root, cfg.editing, { allowCommands: settings.sandbox === 'workspace-write',
      policy: input.sandboxPolicy, run: deps.verifyRun });
    for (const file of changes.files) verifier.observe({ name: 'write_file', ok: true, data: { path: file.path } });
    if (result.state === 'COMPLETED' && !signal?.aborted) await verifier.flush(signal);
    const verification = verifier.freshness();
    if (verification) emit({ kind: 'code_verification', codeVerification: verification });
    let state = result.state || 'FAILED';
    if (state === 'COMPLETED' && verifier.blocked()) {
      state = 'FAILED'; result.error = '文件已修改，但独立校验未通过；请检查校验记录后继续修正'; result.stopReason = 'verification_failed';
    }
    machine.go(state, result.stopReason || state);
    runStore.finishRun(root, runId, toRunStatus(state), { state, reply: result.content, usage: result.usage,
      stopReason: result.stopReason, error: result.error, backend: 'codex', changes, codeVerification: verification, cost: 'unknown' });
    return { ok: state === 'COMPLETED', runId, reply: result.content || '', reasoning: result.reasoning || '', toolCalls: result.toolCalls || [],
      usage: result.usage, state, error: result.error, aborted: result.aborted, backend: 'codex', stopReason: result.stopReason,
      changes, codeVerification: verification, costUnknown: true };
  } catch (error) {
    machine.go('FAILED', 'backend_result_unknown');
    runStore.finishRun(root, runId, 'error', { state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown', backend: 'codex' });
    return { ok: false, runId, state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' };
  } finally { activeProjects.delete(key); }
}
module.exports = { runExternal, resumePlan, sessionFromRun, isProjectActive: root => root && activeProjects.has(projectKey(root)) };
