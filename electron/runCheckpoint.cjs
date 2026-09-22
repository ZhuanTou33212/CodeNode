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
    const written = runStore.appendJsonl(checkpointFile(projectRoot, runId), entry) ? entry : null;
    // S8：检查点也进统一事件流（回放时能看到「哪一步登记了意图、哪一步提交了」）
    if (written) {
      require('./eventBus.cjs').bridge(projectRoot, 'checkpoint', {
        runId: entry.runId || null,
        turnId: entry.turnId == null ? null : entry.turnId,
        toolCallId: entry.callId || null,
        type: entry.type || null,
        tool: entry.tool || null,
        ok: entry.ok === undefined ? null : entry.ok === true,
        effect: entry.effect || null,
      });
    }
    return written;
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

/** tool_call 的稳定调用 id：agent.assignCallIds 写在 `callId`，供应商原始值在 `id`；tool 消息的
 *  `tool_call_id` 用的是 callId —— 三处必须同一口径，否则修配对会修错。 */
function callIdOf(toolCall) {
  return String((toolCall && (toolCall.callId || toolCall.id)) || '');
}

/**
 * 修复 `tool_calls ↔ tool_call_id` 配对（纯函数，不改入参）。
 *
 * 为什么需要：检查点快照是按**位置**切片的（`slice(-MAX_CHECKPOINT_MESSAGES)`），
 * 切片边界不保证落在 assistant/tool 组边界上；而「达到工具调用上限」的中断路径还会在
 * `break` 之前写入「声明了 N 个 tool_calls、只回了 k 个」的残缺报文。两种形态都会被
 * `buildResumeMessages` 原样当作请求报文发出，OpenAI 兼容接口对孤立 tool 消息会返回 400
 * —— 表现就是「点续跑就报错，且看不出是检查点坏了」。
 *
 * 规则（与供应商的实际要求一致）：
 *   - 每条 `tool` 消息必须由**紧邻其前**的 assistant 块声明，否则丢弃（孤儿）；
 *   - 每条 assistant 声明的 tool_call 必须在同一块内被应答，否则从 tool_calls 里移除；
 *   - 移除后若 assistant 既无 tool_calls 又无正文，补一句占位说明（避免空消息被拒）。
 * @param {Array<any>} messages
 * @returns {Array<any>} 新的消息数组
 */
function repairToolPairing(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter((message) => message && message.role);
  const out = [];
  /** 当前打开的 assistant 配对块 */
  let open = null;

  const settle = () => {
    if (!open) return;
    const { at, calls, answered } = open;
    open = null;
    if (answered.size === calls.length) return;
    const kept = calls.filter((tc) => answered.has(callIdOf(tc)));
    const copy = { ...out[at] };
    if (kept.length) {
      copy.tool_calls = kept;
    } else {
      delete copy.tool_calls;
      if (!copy.content || !String(copy.content).trim()) {
        copy.content = '（上一轮的工具调用因中断未完成，已从续跑上下文丢弃）';
      }
    }
    out[at] = copy;
  };

  for (const message of list) {
    if (message.role === 'assistant') {
      settle();
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((tc) => callIdOf(tc)) : [];
      out.push(message);
      if (calls.length) open = { at: out.length - 1, calls, answered: new Set() };
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id ? String(message.tool_call_id) : '';
      // 孤儿：没有前驱 assistant，或前驱没声明这个 id
      if (!open || !id || !open.calls.some((tc) => callIdOf(tc) === id)) continue;
      open.answered.add(id);
      out.push(message);
      continue;
    }
    settle();
    out.push(message);
  }
  settle();
  return out;
}

/**
 * 配对是否合法（严格口径：tool 必须紧跟声明它的 assistant 块，且声明必须全部被应答）。
 * 供测试断言与运行期自检使用 —— 判据只看结构，不看模型自述。
 * @param {Array<any>} messages
 * @returns {boolean}
 */
function isToolPairingValid(messages) {
  let open = null;
  const flush = () => {
    if (open && open.answered.size !== open.declared.size) return false;
    open = null;
    return true;
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.role) return false;
    if (message.role === 'assistant') {
      if (!flush()) return false;
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      open = { declared: new Set(calls.map(callIdOf).filter(Boolean)), answered: new Set() };
      continue;
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id ? String(message.tool_call_id) : '';
      if (!open || !id || !open.declared.has(id)) return false;
      open.answered.add(id);
      continue;
    }
    if (!flush()) return false;
  }
  return flush();
}

/**
 * 保存对话快照：续跑时重建上下文用（裁剪 + 截断，只保留可恢复所需的最小信息）
 * @param {any} projectRoot
 * @param {string} runId
 * @param {Array<any>} messages
 * @param {{ reason?: string }} [options]
 */
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
      // `name` 也必须落盘：主循环 push 的 tool 消息带工具名，检查点快照若只留 4 个字段，
      // 续跑重建后 tool 消息就比生产少一个字段 —— 硬裁剪的占位符随即退化成「此处原本是**工具**的结果」。
      // 判据：scripts/fixture-shape-test.cjs 的 B 段（snapshot → planResume → buildResumeMessages 逐字段对齐）。
      name: message.name || undefined,
    }));
  // 先切片、再修配对：顺序反过来的话切片仍会切断配对（这正是原来漏掉的一步）
  const repaired = repairToolPairing(trimmed);
  return appendCheckpoint(projectRoot, runId, {
    type: 'messages',
    reason: reason || 'round',
    count: repaired.length,
    messages: repaired,
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
 * 续跑计划：失败分支只带 error，成功分支带上下面这些字段（字段含义见 planResume 实现）。
 * @typedef {Object} ResumePlan
 * @property {boolean} ok
 * @property {'complete'|'auto'|'review'|'unknown'} mode
 * @property {string} [error]
 * @property {string|null} [reason]
 * @property {boolean} [requiresReview]
 * @property {string|null} [warning]
 * @property {string} [runId]
 * @property {string} [status]
 * @property {string} [prompt]
 * @property {any} [model]
 * @property {any} [nodeId]
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {Array<any>} [completedSteps]
 * @property {Array<any>} [failedSteps]
 * @property {Array<any>} [pendingSteps]
 * @property {Array<any>} [skippedByLedger]
 * @property {Array<any>} [unknownEffects]
 * @property {Array<any>} [messages]
 * @property {number} [checkpointCount]
 * @property {number} [ledgerCommitted]
 */

/**
 * 生成续跑计划。
 * @param {any} projectRoot
 * @param {string} runId
 * @param {object} [options]
 *   activeIds: 仍在运行的 runId 集合（这些不该被判为中断）
 *   ledger:    SideEffectLedger（幂等账本），用于把「意图未提交但账本已提交」的写操作判为已完成
 * @returns {ResumePlan}
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
    // 只有写操作（effect==='write'）才可能被幂等账本「真的跳过」—— 执行期 begin() 的去重条件
    // 就是 phase==='committed' && effect==='write'。unknown 类即使已提交也不能进 skippable，
    // 否则会出现「文案说跳过、执行期照样重跑」的重复副作用。
    const committedInLedger =
      effect === 'write' && step.idemKey && ledgerReview.committed.some((item) => item.idemKey === step.idemKey);
    if (committedInLedger) {
      skippable.push({ tool: step.tool, idemKey: step.idemKey, reason: '幂等账本显示该写操作已提交，续跑时跳过' });
      continue;
    }
    if (effect === 'write') uncommittedWrites.push({ tool: step.tool, argsDigest: step.argsDigest, effect });
    else if (effect === 'unknown') unknownSteps.push({ tool: step.tool, argsDigest: step.argsDigest, effect });
  }
  // 已提交的 unknown 同样是「做了但结果不可知」（例如成功返回的 execute_shell）：
  // 不能因为 phase 是 committed 就放过 —— 那恰恰是最危险的一类（副作用可能已经生效）。
  const unknownFromLedger = ledgerReview.unknown;

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

/**
 * 构造续跑消息：用检查点里的对话快照 + 明确的续跑指令，不需要用户重述任务
 * @param {ResumePlan} plan
 * @param {{ systemPrompt?: string }} [options]
 */
function buildResumeMessages(plan, { systemPrompt } = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  // 防御：磁盘上可能已经有**旧版本**写入的坏检查点（没经过 saveMessages 的修复），
  // 读出来再修一次 —— 否则历史 Run 的「续跑」会一直报 400，而用户看不出是检查点坏了。
  const history = repairToolPairing(
    Array.isArray(plan.messages) ? plan.messages.filter((message) => message.role !== 'system') : []
  );
  for (const message of history) {
    const entry = { role: message.role, content: message.content || '' };
    if (message.tool_calls) entry.tool_calls = message.tool_calls;
    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    // 工具名必须一起带回来：主循环 push 的 tool 消息带 `name`，续跑重建时若丢掉，
    // 同一份历史在两条路径上形状不同 —— 硬裁剪的占位符会退化成「此处原本是**工具**的结果」，
    // 模型拿不到「该用哪个工具重取」。判据见 scripts/fixture-shape-test.cjs 的 B 段。
    if (message.name) entry.name = message.name;
    messages.push(entry);
  }
  const lines = [
    '【断点续跑】上一次执行被中断，请从中断处继续完成任务，不要从头重复已完成的工作。',
    '原始任务：' + String(plan.prompt || '').slice(0, 2000),
  ];
  const completedSteps = Array.isArray(plan.completedSteps) ? plan.completedSteps : [];
  if (completedSteps.length) {
    lines.push('已完成步骤（不要重复执行）：' + completedSteps.map((step) => step.tool).join('、'));
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
  repairToolPairing,
  isToolPairingValid,
  readCheckpoints,
  stepsOf,
  lastMessages,
  planResume,
  buildResumeMessages,
  clearCheckpoints,
  MAX_CHECKPOINT_MESSAGES,
};
