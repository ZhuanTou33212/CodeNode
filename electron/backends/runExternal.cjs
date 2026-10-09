'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backendFactory = require('./index.cjs');
const runStore = require('../runStore.cjs');
const diff = require('./workspaceDiff.cjs');
const goalScope = require('../goalScope.cjs');
const { CodeVerifier } = require('../codeVerification.cjs');
const { createStateMachine, toRunStatus } = require('../agentState.cjs');
const activeProjects = new Set();
function projectKey(root) { const key = path.resolve(root); return process.platform === 'win32' ? key.toLowerCase() : key; }
function sessionFromRun(root, id) {
  const events = runStore.readRun(root, id);
  const start = events.find(event => event.type === 'run_start');
  if (!require('../../config/agent.backends.json').acpBackends.includes(start?.backend)) return null;
  const session = [...events].reverse().find(event => event.type === 'backend_session');
  const finish = [...events].reverse().find(event => event.type === 'run_finish');
  return { start, session, finish };
}
function previousSession(root, sessionId,options={}) {
  if (!sessionId&&!options.conversationId) return null;
  for (const run of runStore.listRuns(root, 200)) {
    const record = sessionFromRun(root, run.runId);
    if (record && (record.start.planSessionId === sessionId||options.conversationId&&record.start.memoryConversationId===options.conversationId) && (options.epoch==null||record.start.backendEpoch===options.epoch) && (record.session?.threadId || record.session?.sessionId)) return record;
  }
  return null;
}
function resumePlan(root, id, activeIds) {
  const record = sessionFromRun(root, id);
  if (!record) return null;
  if (activeIds.has(runStore.normalizeRunId(id))) return { ok: false, error: '原外部 Agent 执行仍在运行' };
  if (!(record.session?.threadId || record.session?.sessionId)) return { ok: false, error: '缺少精确外部 Agent 会话记录，不能恢复原执行' };
  if (record.finish?.state === 'COMPLETED') return { ok: true, mode: 'complete', runId: id, prompt: record.start.prompt, reason: '原执行已完成' };
  return { ok: true, mode: 'review', requiresReview: true, runId: id, prompt: record.start.prompt,
    reason: '继续原 ' + record.start.backend + ' 会话；启动前查询原执行状态', warning: '请先检查现有文件差异。外部副作用不会由 CodeNode 自动重放或回滚。',
    unknownEffects: record.finish?.stopReason === 'backend_result_unknown' || !record.finish ? [{ tool: '外部 Agent 执行', effect: '原执行结果待核实' }] : [],
    pendingSteps: [], completedSteps: [], backend: record.start.backend };
}
async function runExternal(input, deps = {}) {
  const { projectRoot: root, requestId, sessionId, resumeRunId, resumeForce, settings, cfg, signal, onDelta, confirm } = input;
  if (!root || !fs.statSync(root).isDirectory()) return { ok: false, error: '外部 Agent 后端需要先选择项目工作目录' };
  const key = projectKey(root);
  if (activeProjects.has(key)) return { ok: false, error: '当前项目已有外部 Agent 执行，请等待结束' };
  if (input.forceCompact) return { ok: false, error: '该外部后端不支持 /compact' };
  const plan = resumeRunId ? resumePlan(root, resumeRunId, new Set()) : null;
  if (resumeRunId && !plan) return { ok: false, error: '不能把内置检查点恢复到外部 Agent 后端' };
  if (plan && (!plan.ok || plan.mode === 'complete')) return { ok: false, error: plan.error || plan.reason };
  if (plan?.requiresReview && resumeForce !== true) return { ok: false, needsReview: true, plan };
  const previous = resumeRunId ? sessionFromRun(root, resumeRunId) : previousSession(root, sessionId,{conversationId:input.memoryConversationId,epoch:input.backendEpoch});
  if (!resumeRunId && previous && (!previous.finish || previous.finish.stopReason === 'backend_result_unknown')) {
    return { ok: false, needsReview: true, plan: resumePlan(root, previous.start.runId, new Set()) };
  }
  const backendName = previous?.start?.backend || settings.backend;
  if(previous && previous.session?.protocol!=='acp')return {ok:false,error:'旧 app-server/SDK 会话不能跨协议恢复；请复核原 Run 后新建 ACP 会话',stopReason:'legacy_session_protocol'};
  const adapterSettings = previous?.session?.adapterSettings || settings;
  if (resumeRunId && previous?.start?.backend !== settings.backend && !previous?.session?.adapterSettings) return { ok: false, error: '恢复必须使用原 Agent 后端：' + String(previous?.start?.backend || 'unknown') };
  const backend = (deps.createBackend || backendFactory.createBackend)(backendName, adapterSettings, deps);
  const permissions = {owner:'acp-agent-runtime',transport:'acp',requestPolicy:adapterSettings.sandbox,osSandboxEnforcedByCodeNode:false};
  const runId = runStore.normalizeRunId(requestId);
  if (runStore.readRun(root, runId).length) return { ok: false, runId, error: '该请求编号已有执行记录，请查看原运行结果，避免重复执行' };
  const machine = createStateMachine({ onTransition: info => emit({ kind: 'state', state: info.to, previous: info.from, sequence: info.sequence, reason: info.reason }) });
  function emit(delta) {
    onDelta(delta);
    if (delta.kind === 'state') runStore.appendEvent(root, runId, 'run_state', delta);
    else if (!['content', 'reasoning', 'start'].includes(delta.kind)) {
      runStore.appendEvent(root, runId, delta.kind, delta);
      require('../eventBus.cjs').emit(root, { ...delta, runId, backend: backendName });
    }
  }
  activeProjects.add(key);
  try {
    input.onStart?.();
    if (!runStore.startRun(root, runId, { prompt: String(input.prompt || '').slice(0, 4000), backend: backendName,
      memoryConversationId:input.memoryConversationId||null,backendEpoch:resumeRunId?previous?.start?.backendEpoch||null:input.backendEpoch||null,
      model: adapterSettings.model || backendName, nodeId: input.nodeId || null, planSessionId: sessionId || null,
      resumedFrom: resumeRunId || null, cwd: path.resolve(root), permissions,
      goalId: input.goalId || null, goalTaskId: input.taskId || null, goalContextRevision: input.goalContextRevision || null,
      goalAcceptanceRevision: input.goalAcceptanceRevision || null, goalWriteScope: input.goalWriteScope || [],
      cost: 'unknown', hardBudget: false })) throw new Error('无法保存后端运行记录，执行未启动');
    require('../trellis/index.cjs').recordContext(root, runId, input.trellisSnapshot);
    emit({ kind: 'start' });
    emit({ kind: 'state', state: 'RUNNING', previous: null, sequence: 0 });
    const before = diff.capture(root);
    const contextFingerprint = crypto.createHash('sha256').update(JSON.stringify([...before.entries].sort())).digest('hex');
    runStore.appendEvent(root, runId, 'backend_context', { contextRevision: input.document?.root?.revision || 0, contextFingerprint, complete: before.complete });
    const port=require('./backendPort.cjs');port.assertBackendPort(backend);
    const unsubscribe=backend.subscribe(event=>{const delta=port.toAgentDelta(event);if(delta.kind==='state')return;if(delta.kind==='backend_approval')machine.go(delta.phase==='requested'?'WAITING_USER':'RUNNING',delta.phase);emit(delta);});
    let result;
    try{result = await backend.submit({ ...input, onDelta:undefined, backendSession: previous?.session,
      onSession: session => { if (!runStore.appendEvent(root, runId, 'backend_session', session)) throw new Error('无法持久化 ACP 会话，停止执行'); },
      confirm });}finally{unsubscribe();await backend.close();}
    const changes = diff.compare(before, diff.capture(root));
    const goalScopeViolations = goalScope.violations(changes.files, input.goalWriteScope);
    const goalScopeUnverified = Array.isArray(input.goalWriteScope) && input.goalWriteScope.length > 0 && !changes.complete;
    if (goalScopeUnverified) goalScopeViolations.push('[无法完整核对项目文件快照]');
    emit({ kind: 'backend_changes', changes });
    if (goalScopeViolations.length) emit({ kind: 'goal_scope_violation', files: goalScopeViolations });
    // Surface independently measured changes in the existing file-change UI.
    for (const file of changes.files) emit({ kind: 'file_change', fileChange: { path: file.path, action: file.kind, status: 'changed', source: 'workspace-fingerprint' } });
    const verifier = new CodeVerifier(root, cfg.editing, { allowCommands: true,
      policy: input.sandboxPolicy, run: deps.verifyRun });
    for (const file of changes.files) verifier.observe({ name: 'write_file', ok: true, data: { path: file.path } });
    if (result.state === 'COMPLETED' && !signal?.aborted) await verifier.flush(signal);
    const verification = verifier.freshness();
    if (verification) emit({ kind: 'code_verification', codeVerification: verification });
    let state = result.state || 'FAILED';
    if (state === 'COMPLETED' && goalScopeViolations.length) {
      state = 'FAILED'; result.error = goalScopeUnverified ? '项目文件快照不完整，无法核对 Task 写入范围；变更已保留，请审阅后重试' : 'Task 修改了声明写入范围之外的文件；变更已保留，请审阅后调整任务范围或回滚'; result.stopReason = goalScopeUnverified ? 'goal_scope_unverified' : 'goal_scope_violation';
    }
    const codeFilesChanged=changes.files.some(file=>/\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|cs|rb|php|vue|svelte|sql|sh|ps1|css|scss|html|yaml|yml|toml|ini)$/i.test(file.path));
    if(state==='COMPLETED'&&codeFilesChanged&&verification?.verified!==true){
      state='FAILED';result.error='文件已修改，但独立代码校验未通过或未能运行；请核对变更和验收条件后继续';result.stopReason='verification_unavailable';
    } else if (state === 'COMPLETED' && verifier.blocked()) {
      state = 'FAILED'; result.error = '文件已修改，但独立校验未通过；请检查校验记录后继续修正'; result.stopReason = 'verification_failed';
    }
    machine.go(state, result.stopReason || state);
    runStore.finishRun(root, runId, toRunStatus(state), { state, reply: result.content, usage: result.usage,
      stopReason: result.stopReason, error: result.error, backendErrorCode: result.backendErrorCode || null, backendErrorMethod: result.backendErrorMethod || null, backendErrorDetails: result.backendErrorDetails || null, backendStderr: result.backendStderr || null, backend: backendName, changes, goalScopeViolations, codeVerification: verification, cost: 'unknown' });
    return { ok: state === 'COMPLETED', runId, reply: result.content || '', reasoning: result.reasoning || '', toolCalls: result.toolCalls || [],
      usage: result.usage, state, error: result.error, aborted: result.aborted, backend: backendName, stopReason: result.stopReason,
      backendErrorCode: result.backendErrorCode, backendErrorMethod: result.backendErrorMethod, backendErrorDetails: result.backendErrorDetails, backendStderr: result.backendStderr,
      changes, goalScopeViolations, codeVerification: verification, costUnknown: true };
  } catch (error) {
    machine.go('FAILED', 'backend_result_unknown');
    runStore.finishRun(root, runId, 'error', { state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown', backend: backendName });
    return { ok: false, runId, state: 'FAILED', error: error.message, stopReason: 'backend_result_unknown' };
  } finally { activeProjects.delete(key); }
}
module.exports = { runExternal, resumePlan, sessionFromRun, previousSession, isProjectActive: root => root && activeProjects.has(projectKey(root)) };
