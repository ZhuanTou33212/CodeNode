/**
 * failures.cjs —— 工具失败的分类契约（S5，2026-09-16）
 *
 * 背景（审查 P1-4）：`AgentToolResult(ok, text, data)` 只有布尔结果，失败语义全靠各工具自己在
 * `data.code` 里临时塞。主循环拿到失败后只能回灌一句笼统的「上述工具调用失败…请修正参数后重试」，
 * 于是「参数写错了」「用户拒绝了」「超时了」「副作用结果未知」被同一句话打发 ——
 * 该重试的不敢重试、不该重试的反复重试（子代理重复委派、被拒的写操作再试一遍都是这么来的）。
 *
 * 本模块是 FailureCode 的**唯一来源**：
 *   - `FAILURE_SPECS`：码 → 类别 / 是否可重试 / 是否需要用户动作 / 给模型的指引；
 *   - `LEGACY_CODE_MAP`：项目里已经在用的 `data.code`（如 `WORKBENCH_WRITE_DENIED`、
 *     `PATH_OUT_OF_ROOT`、`BUDGET_EXCEEDED`）到 FailureCode 的**显式**归一 —— 不靠猜文本；
 *   - `classifyFailure()`：把一次失败结果归类（认不出来的码 → `FATAL_FAILURE` 且标 `known:false`，
 *     按最保守处理，绝不假装认识）；
 *   - `planNudges()` / `buildFailureNudge()`：按类别分派提示，并给「同一个 toolCallId」设提示上限。
 */
'use strict';

/** FailureCode 码表（审查第 4 节草案，本文件是唯一来源） */
const FAILURE_CODES = Object.freeze({
  ARG_INVALID_JSON: 'ARG_INVALID_JSON',
  ARG_SCHEMA: 'ARG_SCHEMA',
  ARG_SEMANTIC: 'ARG_SEMANTIC',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  FATAL_FAILURE: 'FATAL_FAILURE',
  EFFECT_UNKNOWN: 'EFFECT_UNKNOWN',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
});

/** 类别 → 中文标签（提示文案与 trace 共用） */
const CATEGORY_LABELS = Object.freeze({
  argument: '参数',
  permission: '权限',
  cancel: '取消',
  timeout: '超时',
  transient: '瞬时故障',
  fatal: '不可重试',
  effect: '副作用未知',
  system: '程序错误',
});

/** 类别 → 给模型的处理指引（提示文案用；与 system prompt 第 5 条「失败分类处理」口径一致） */
const CATEGORY_GUIDES = Object.freeze({
  argument: '按原因修正参数后重试，同一调用不要用同一份参数。',
  permission: '不要原样重试：改成不需要该权限的做法，或明确告诉用户你需要他批准什么。',
  cancel: '这条路径已被取消，不要再发起同一操作。',
  timeout: '缩小范围（更少的行 / 更小的目录 / 更短的命令），长任务改后台 + poll_job 轮询。',
  transient: '可以原样重试一次；仍失败就换方式，不要连续重试。',
  fatal: '不要原样重试：先分析原因，换工具或换思路。',
  effect: '副作用结果未知：先用只读工具核对真实状态，再决定是否重做，禁止盲目重放。',
  system: '这是程序内部错误：如实告诉用户，不要重试同一调用。',
});

/**
 * 码 → 契约。
 * retryable：**同一调用原样重试**是否有意义；userActionRequired：是否必须有人（用户/主代理）介入。
 */
const FAILURE_SPECS = Object.freeze({
  ARG_INVALID_JSON: { category: 'argument', retryable: true, userActionRequired: false, hint: '参数不是完整 JSON（常见于 max_tokens 截断或引号转义错误）：用更短的参数重写；长内容先写文件再用路径引用。' },
  ARG_SCHEMA: { category: 'argument', retryable: true, userActionRequired: false, hint: '参数不符合工具 schema：按错误里指出的字段/类型修正后重试。' },
  ARG_SEMANTIC: { category: 'argument', retryable: true, userActionRequired: false, hint: '参数语义不对（路径/节点/文件不存在、越界等）：先用只读工具核对外界真实状态再重试。' },
  PERMISSION_DENIED: { category: 'permission', retryable: false, userActionRequired: true, hint: '权限不足或被只读上下文挡住：不要原样重试，换只读方式，或交给主代理 / 请用户批准。' },
  APPROVAL_REQUIRED: { category: 'permission', retryable: false, userActionRequired: true, hint: '该操作需要用户确认，但当前没有确认通道：先说明你要做什么并等用户批准。' },
  APPROVAL_DENIED: { category: 'permission', retryable: false, userActionRequired: true, hint: '用户拒绝了这次操作：不要重复请求，改方案或直接问用户期望怎么做。' },
  CANCELLED: { category: 'cancel', retryable: false, userActionRequired: false, hint: '操作已被取消。' },
  TIMEOUT: { category: 'timeout', retryable: true, userActionRequired: false, hint: '超时：缩小范围或改成后台任务轮询，不要原样再等一次。' },
  RETRYABLE_FAILURE: { category: 'transient', retryable: true, userActionRequired: false, hint: '瞬时故障（网络抖动 / 限流）：可以重试一次。' },
  FATAL_FAILURE: { category: 'fatal', retryable: false, userActionRequired: false, hint: '不可重试的失败：先看原因再决定，别重复同一调用。' },
  EFFECT_UNKNOWN: { category: 'effect', retryable: false, userActionRequired: true, hint: '副作用结果未知（可能已经生效）：先用只读工具核对真实状态，禁止盲目重放。' },
  SYSTEM_ERROR: { category: 'system', retryable: false, userActionRequired: false, hint: '程序内部错误：报告给用户，不要重试同一调用。' },
});

/**
 * 项目里已经在用的 `data.code` → FailureCode 的显式归一（可带 override 覆盖 retryable/提示）。
 * 只登记**确实存在**的码；没登记的一律走 `known:false` 的保守路径，不做文本猜测。
 */
const LEGACY_CODE_MAP = Object.freeze({
  INVALID_TOOL_ARGUMENTS: { code: 'ARG_SCHEMA' },
  ARG_INVALID_JSON: { code: 'ARG_INVALID_JSON' },
  PERMISSION_DENIED: { code: 'PERMISSION_DENIED' },
  WORKBENCH_WRITE_DENIED: { code: 'PERMISSION_DENIED' },
  PATH_OUT_OF_ROOT: { code: 'ARG_SEMANTIC', hint: '路径越过项目边界：改用项目内的相对路径；这不是重试能解决的。' },
  APPROVAL_REQUIRED: { code: 'APPROVAL_REQUIRED' },
  APPROVAL_DENIED: { code: 'APPROVAL_DENIED' },
  CANCELLED: { code: 'CANCELLED' },
  TIMEOUT: { code: 'TIMEOUT' },
  BUDGET_EXCEEDED: { code: 'FATAL_FAILURE', userActionRequired: true, hint: '本轮 token 预算已用尽：停止继续调用模型，如实告诉用户（可在 config/agent.properties 调大 agent.max_total_tokens 后重跑）。' },
  SANDBOX_UNAVAILABLE: { code: 'FATAL_FAILURE', hint: '执行隔离不可用：不要反复重试，告诉用户或改用不需要隔离的方式。' },
});

const DEFAULT_NUDGE_MAX_PER_CALL = 2;
const NUDGE_MAX_PER_CALL = DEFAULT_NUDGE_MAX_PER_CALL;

/** 是否是我们认识的 FailureCode */
function isKnownFailureCode(code) {
  const value = String(code == null ? '' : code).trim();
  return !!(value && Object.prototype.hasOwnProperty.call(FAILURE_SPECS, value));
}

/**
 * 把任意码归一成 FailureCode（认不出来返回 null，由调用方决定保守策略）。
 * @param {string} code
 * @returns {string|null}
 */
function normalizeFailureCode(code) {
  const value = String(code == null ? '' : code).trim();
  if (!value) return null;
  if (isKnownFailureCode(value)) return value;
  const mapped = LEGACY_CODE_MAP[value];
  return mapped ? mapped.code : null;
}

/**
 * 直接描述一个失败（供工具侧 `AgentToolResult.failure(code, message, extra)` 使用）。
 * @param {string} code
 * @param {string} message
 * @param {{retryable?: boolean, userActionRequired?: boolean, tool?: string, toolCallId?: string, attemptId?: string, detail?: any}} [extra]
 */
function describeFailure(code, message, extra) {
  const e = extra || {};
  const normalized = normalizeFailureCode(code) || FAILURE_CODES.FATAL_FAILURE;
  const mapped = LEGACY_CODE_MAP[String(code == null ? '' : code).trim()] || null;
  const spec = FAILURE_SPECS[normalized] || FAILURE_SPECS.FATAL_FAILURE;
  return {
    code: normalized,
    category: spec.category,
    message: String(message || spec.hint || '').slice(0, 800),
    hint: (mapped && mapped.hint) || spec.hint,
    retryable: e.retryable === undefined ? spec.retryable : e.retryable === true,
    userActionRequired: e.userActionRequired === undefined ? spec.userActionRequired : e.userActionRequired === true,
    known: isKnownFailureCode(code) || !!mapped,
    detail: e.detail || null,
    tool: e.tool || null,
    toolCallId: e.toolCallId || null,
    attemptId: e.attemptId || null,
  };
}

/**
 * 把一次失败的工具结果归类。
 * 优先级：结果自带的 `failure`（工具显式声明）> `data.failureCode` > `data.code`（归一表）
 *        > `data.timedOut` / `data.cancelled` 这类**结构化**信号 > 保守的 FATAL_FAILURE（known:false）。
 * @param {any} result AgentToolResult（或等价形状 { ok, text, data }）
 * @param {{tool?: string, toolCallId?: string, attemptId?: string}} [info]
 */
function classifyFailure(result, info) {
  const i = info || {};
  const existing = result && result.failure;
  if (existing && existing.code) {
    return {
      ...existing,
      tool: i.tool || existing.tool || null,
      toolCallId: i.toolCallId || existing.toolCallId || null,
      attemptId: i.attemptId || existing.attemptId || null,
    };
  }
  const data = (result && result.data) || {};
  const raw = String(data.failureCode || data.code || '').trim();
  const mapped = LEGACY_CODE_MAP[raw] || null;
  let code = mapped ? mapped.code : isKnownFailureCode(raw) ? raw : '';
  if (!code) {
    code = data.timedOut === true ? FAILURE_CODES.TIMEOUT : data.cancelled === true ? FAILURE_CODES.CANCELLED : FAILURE_CODES.FATAL_FAILURE;
  }
  const spec = FAILURE_SPECS[code] || FAILURE_SPECS.FATAL_FAILURE;
  const override = mapped || {};
  const toolCallId = i.toolCallId || null;
  return {
    code,
    category: spec.category,
    message: String((result && result.text) || '').slice(0, 800),
    hint: override.hint || spec.hint,
    retryable: override.retryable === undefined ? spec.retryable : override.retryable === true,
    userActionRequired: override.userActionRequired === undefined ? spec.userActionRequired : override.userActionRequired === true,
    known: isKnownFailureCode(raw) || !!mapped,
    legacyCode: raw || null,
    detail: null,
    tool: i.tool || null,
    toolCallId,
    attemptId: i.attemptId || (toolCallId ? toolCallId + '#1' : null),
  };
}

/**
 * 提示（nudge）配额：同一个 toolCallId 最多提示 maxPerCallId 次，避免「一句话反复灌」——
 * 超过上限的不再进上下文，只落 trace（由 MAX_TOOL_ITERATIONS 兜底）。
 * @param {Array<any>} failures
 * @param {Record<string, number>} counts 跨轮累计（调用方持有并复用同一对象）
 * @param {number} [maxPerCallId]
 */
function planNudges(failures, counts, maxPerCallId) {
  const limit = Math.max(1, Number(maxPerCallId) || DEFAULT_NUDGE_MAX_PER_CALL);
  const tally = counts || {};
  const emitted = [];
  const skipped = [];
  for (const failure of Array.isArray(failures) ? failures : []) {
    if (!failure) continue;
    const key = String(failure.toolCallId || failure.tool || 'unknown');
    const used = Number(tally[key]) || 0;
    if (used >= limit) {
      skipped.push({ ...failure, nudges: used, skipReason: '同一调用已提示 ' + used + ' 次（上限 ' + limit + '），不再灌提示' });
      continue;
    }
    tally[key] = used + 1;
    emitted.push({ ...failure, nudges: tally[key] });
  }
  return { emitted, skipped, counts: tally };
}

/**
 * 按失败类别生成一条分类化提示（没有可提示项时返回空串）。
 * @param {Array<any>} failures
 * @returns {string}
 */
function buildFailureNudge(failures) {
  const list = (Array.isArray(failures) ? failures : []).filter(Boolean);
  if (!list.length) return '';
  const lines = list.map((failure) => {
    const label = CATEGORY_LABELS[failure.category] || '未分类';
    const unknownNote = failure.known === false
      ? '（未登记的错误码' + (failure.legacyCode ? '：' + failure.legacyCode : '') + '，按最保守方式处理）'
      : '';
    const message = String(failure.message || '').replace(/\s+/g, ' ').slice(0, 200);
    const retryNote = failure.retryable === true ? '｜可重试' : '｜不可原样重试';
    return '- ' + (failure.tool || '工具') + ' [' + label + ' ' + failure.code + retryNote + ']' + unknownNote +
      (failure.hint ? '：' + failure.hint : message ? '：' + message : '');
  });
  const guides = [...new Set(list.map((failure) => CATEGORY_GUIDES[failure.category]).filter(Boolean))];
  return (
    '【系统提示】本轮有 ' + list.length + ' 次工具调用失败，按错误类别分别处理：\n' +
    lines.join('\n') +
    (guides.length ? '\n处理指引：\n' + guides.map((guide) => '- ' + guide).join('\n') : '') +
    '\n同一调用不要用同一份参数重复提交。'
  );
}

module.exports = {
  FAILURE_CODES,
  FAILURE_SPECS,
  CATEGORY_LABELS,
  CATEGORY_GUIDES,
  LEGACY_CODE_MAP,
  NUDGE_MAX_PER_CALL,
  isKnownFailureCode,
  normalizeFailureCode,
  describeFailure,
  classifyFailure,
  planNudges,
  buildFailureNudge,
};
