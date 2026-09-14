/**
 * runCheckpoint.cjs —— 可续跑状态机（真正的断点续跑）
 *
 * 解决审阅缺口：「事件记录不等于崩溃续跑」「把状态标成 interrupted 仅能识别未完成记录，不能恢复任务」。
 *
 * 与 runStore 的分工：
 *   runStore   = 运行事件流（审计视角，给人看）
 *   runCheckpoint = 执行检查点（恢复视角，给机器用）：
 *       - 每一步工具调用的 intent / commit / fail（含参数摘要、副作用类别、幂等键）
 *       - 最近的对话消息快照（重建续跑上下文，不必重新问用户）
 *   sideEffects   = 幂等账本（副作用是否真的发生过）
 *
 * 续跑分类（planResume）：
 *   complete       已完成，无需续跑
 *   auto           可自动续跑：待办步骤只有只读，或写步骤在幂等账本里已提交（跳过即可）
 *   review         必须人工复核：存在「结果未知」的外部副作用（shell 等）或未提交的写操作
 *   unknown        无法判断（缺检查点、缺少 run_start 等）→ 一律按 review 处理
 *
 * 原则：宁可要求人工确认，也不盲目重放未知副作用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runStore = require('./runStore.cjs');
const { classify, SideEffectLedger } = require('./sideEffects.cjs');

const MAX_CHECKPOINT_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6000;

function checkpointFile(projectRoot, runId) {
  const safe = runStore.normalizeRunId(runId);
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.checkpoints.jsonl');
}

function appendCheckpoint(projectRoot, runId, record) {
  if (!projectRoot) return null;
  const entry = { ts: new Date().toISOString(), runId: runStore.normalizeRunId(runId), ...(record || {}) };
  try {
    return runStore.appendJsonl(checkpointFile(projectRoot, runId), entry) ? entry : null;
  } catch {
    return null;
  }
}

/** 工具执行前：登记意图（参数摘要 + 副作用类别 + 幂等键） */
function recordIntent(projectRoot, runId, { callId, tool, argsDigest, effect, idemKey }) {
  return appendCheckpoint(projectRoot, runId, {
    type: 'tool_intent',
    callId: callId || null,
    tool: String(tool || ''),
    argsDigest: argsDigest || null,
    effect: effect || classify(tool),
    idemKey: idemKey || null,
  });
}

/** 工具执行后：提交结果摘要（ok / 错误 / 结果摘要，不存正文，避免日志膨胀） */
function recordCommit(projectRoot, runId, { callId, tool, ok, resultDigest, error, elapsedMs, idemKey, effect }) {
  return appendCheckpoint(projectRoot, runId, {
    type: 'tool_commit',
    callId: callId || null,
    tool: String(tool || ''),
    idemKey: idemKey || null,
    effect: effect || null,
    ok: ok !== false,
    resultDigest: resultDigest || null,
    error: error ? String(error).slice(0, 400) : null,
    elapsedMs: Number(elapsedMs) || 0,
  });
}

/** 保存对话快照：续跑时重建上下文用（裁剪 + 截断，只保留可恢复所需的最小信息） */
function saveMessages(projectRoot, runId, messages, { reason } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const trimmed = list
    .filter((message) => message && message.role)
    .slice(-MAX_CHECKPOINT_MESSAGES)
    .map((message) => ({
      role: String(message.role),
      content: String(message.content == null ? '' : message.content).slice(0, MAX_MESSAGE_CHARS),
      tool_calls: message.tool_calls || undefined,
      tool_call_id: message.tool_call_id || undefined,
    }));
  return appendCheckpoint(projectRoot, runId, {
    type: 'messages',
    reason: reason || 'round',
    count: trimmed.length,
    messages: trimmed,
  });
}

function readCheckpoints(projectRoot, runId) {
  const file = checkpointFile(projectRoot, runId);
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** 从检查点事件流归约出「每一步的状态」 */
function stepsOf(checkpoints) {
  const steps = new Map();
  for (const entry of checkpoints) {
    if (entry.type === 'tool_intent') {
      const key = entry.idemKey || entry.callId || entry.tool + ':' + (entry.argsDigest || '');
      const current = steps.get(key) || { key, tool: entry.tool, effect: entry.effect, idemKey: entry.idemKey || null, intents: 0 };
      current.intents += 1;
      current.intentAt = entry.ts;
      current.argsDigest = entry.argsDigest || current.argsDigest || null;
      steps.set(key, current);
    } else if (entry.type === 'tool_commit') {
      const key = entry.idemKey || entry.callId || entry.tool + ':' + (entry.argsDigest || '');
      const current = steps.get(key) || { key, tool: entry.tool, effect: classify(entry.tool), intents: 1 };
      current.committed = entry.ok !== false;
      current.failed = entry.ok === false;
      current.error = entry.error || null;
      current.commitAt = entry.ts;
      current.elapsedMs = entry.elapsedMs || 0;
      steps.set(key, current);
    }
  }
  return [...steps.values()];
}

function lastMessages(checkpoints) {
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    if (checkpoints[i].type === 'messages' && Array.isArray(checkpoints[i].messages)) return checkpoints[i].messages;
  }
  return [];
}

/**
 * 生成续跑计划。
 * @param {object} options
 *   activeIds: 仍在运行的 runId 集合（这些不该被判为中断）
 *   ledger:    SideEffectLedger（幂等账本），用于把「意图未提交但账本已提交」的写操作判为已完成
 */
function planResume(projectRoot, runId, options = {}) {
  const events = runStore.readRun(projectRoot, runId);
  const summary = runStore.summarizeRun(events);
  if (!summary.runId) return { ok: false, mode: 'unknown', error: 'Run 不存在' };
  const start = events.find((event) => event.type === 'run_start') || {};
  const checkpoints = readCheckpoints(projectRoot, runId);
  const steps = stepsOf(checkpoints);
  const ledger = options.ledger || (projectRoot ? new SideEffectLedger({ projectRoot, scopeRunId: summary.runId }) : null);
  const ledgerReview = ledger ? ledger.review() : { committed: [], pending: [], unknown: [] };

  const isActive = options.activeIds instanceof Set ? options.activeIds.has(summary.runId) : false;
  const status = isActive ? 'running' : summary.status;

  const pendingSteps = steps.filter((step) => !step.committed && !step.failed);
  const uncommittedWrites = [];
  const unknownSteps = [];
  const skippable = [];
  for (const step of pendingSteps) {
    const effect = step.effect || classify(step.tool);
    const committedInLedger = step.idemKey && ledgerReview.committed.some((item) => item.idemKey === step.idemKey);
    if (committedInLedger) {
      skippable.push({ tool: step.tool, idemKey: step.idemKey, reason: '幂等账本显示该写操作已提交，续跑时跳过' });
      continue;
    }
    if (effect === 'write') uncommittedWrites.push({ tool: step.tool, argsDigest: step.argsDigest, effect });
    else if (effect === 'unknown') unknownSteps.push({ tool: step.tool, argsDigest: step.argsDigest, effect });
  }
  const unknownFromLedger = ledgerReview.unknown.filter((item) => item.phase !== 'committed');

  const base = {
    ok: true,
    runId: summary.runId,
    status,
    prompt: String(start.prompt || ''),
    model: start.model || null,
    nodeId: start.nodeId || null,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    completedSteps: steps.filter((step) => step.committed).map((step) => ({ tool: step.tool, idemKey: step.idemKey, at: step.commitAt || null })),
    failedSteps: steps.filter((step) => step.failed).map((step) => ({ tool: step.tool, error: step.error, at: step.commitAt || null })),
    pendingSteps: pendingSteps.map((step) => ({ tool: step.tool, effect: step.effect || classify(step.tool), idemKey: step.idemKey || null })),
    skippedByLedger: skippable,
    unknownEffects: [...unknownSteps, ...unknownFromLedger],
    messages: lastMessages(checkpoints),
    checkpointCount: checkpoints.length,
    ledgerCommitted: ledgerReview.committed.length,
    warning: null,
    reason: null,
  };

  if (status === 'completed') {
    return { ...base, mode: 'complete', reason: 'Run 已正常完成，无需续跑' };
  }
  if (status === 'cancelled') {
    return { ...base, mode: 'review', reason: '该 Run 由用户主动停止，自动续跑前需要你确认', requiresReview: true };
  }
  if (status === 'running' && isActive) {
    return { ...base, mode: 'complete', reason: '该 Run 仍在运行中' };
  }
  if (!checkpoints.length) {
    return { ...base, mode: 'review', requiresReview: true, reason: '没有可用检查点（可能来自旧版本或被清理），无法判断副作用状态', warning: '缺少检查点：只能人工确认后重新发起，不能自动续跑。' };
  }
  if (unknownSteps.length || unknownFromLedger.length) {
    return {
      ...base,
      mode: 'review',
      requiresReview: true,
      reason: '存在结果未知的外部副作用：' + [...new Set(base.unknownEffects.map((item) => item.tool))].join('、'),
      warning: '这些步骤（如 shell 命令）无法从本地状态判断是否已生效，必须人工核对后再继续，系统不会自动重放。',
    };
  }
  if (uncommittedWrites.length) {
    return {
      ...base,
      mode: 'review',
      requiresReview: true,
      reason: '存在未提交的写操作：' + [...new Set(uncommittedWrites.map((item) => item.tool))].join('、'),
      warning: '崩溃发生在写操作提交之前，文件可能只写入了一半，请核对后再继续。',
    };
  }
  return {
    ...base,
    mode: 'auto',
    reason: skippable.length
      ? '待办步骤均为只读，且 ' + skippable.length + ' 个写操作已在幂等账本中提交（续跑时跳过）'
      : '待办步骤均为只读，可安全自动续跑',
  };
}

/** 构造续跑消息：用检查点里的对话快照 + 明确的续跑指令，不需要用户重述任务 */
function buildResumeMessages(plan, { systemPrompt } = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  const history = Array.isArray(plan.messages) ? plan.messages.filter((message) => message.role !== 'system') : [];
  for (const message of history) {
    const entry = { role: message.role, content: message.content || '' };
    if (message.tool_calls) entry.tool_calls = message.tool_calls;
    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    messages.push(entry);
  }
  const lines = [
    '【断点续跑】上一次执行被中断，请从中断处继续完成任务，不要从头重复已完成的工作。',
    '原始任务：' + String(plan.prompt || '').slice(0, 2000),
  ];
  if (plan.completedSteps.length) {
    lines.push('已完成步骤（不要重复执行）：' + plan.completedSteps.map((step) => step.tool).join('、'));
  }
  if (plan.skippedByLedger && plan.skippedByLedger.length) {
    lines.push('已由幂等账本确认完成、本次会被自动跳过的写操作：' + plan.skippedByLedger.map((step) => step.tool).join('、'));
  }
  const skippedKeys = new Set((plan.skippedByLedger || []).map((item) => item.idemKey).filter(Boolean));
  const pendingOnly = (plan.pendingSteps || []).filter((step) => !(step.idemKey && skippedKeys.has(step.idemKey)));
  if (pendingOnly.length) {
    lines.push('中断时未完成的步骤（按需继续）：' + pendingOnly.map((step) => step.tool).join('、'));
  }
  if (plan.failedSteps && plan.failedSteps.length) {
    lines.push('中断前失败的步骤（分析原因后重试或换方式）：' + plan.failedSteps.map((step) => step.tool).join('、'));
  }
  lines.push('若任务其实已经完成，请直接给出最终结论，不要再调用工具。');
  messages.push({ role: 'user', content: lines.join('\n') });
  return messages;
}

function clearCheckpoints(projectRoot, runId) {
  const file = checkpointFile(projectRoot, runId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  checkpointFile,
  appendCheckpoint,
  recordIntent,
  recordCommit,
  saveMessages,
  readCheckpoints,
  stepsOf,
  lastMessages,
  planResume,
  buildResumeMessages,
  clearCheckpoints,
  MAX_CHECKPOINT_MESSAGES,
};
