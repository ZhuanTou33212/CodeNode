/**
 * eventBus.cjs —— 统一运行事件总线（S8）
 *
 * 问题：一次运行的事件散在五套并行文件里 —— `runs/<runId>.jsonl`（run 级状态）、
 * `.codenode/tools_trace.jsonl`（工具调用）、`checkpoints.jsonl`、`side-effects.json`、
 * `audit.jsonl`。其中 `tools_trace.jsonl` 的每条只有 `{ts, iter, name …}`，**没有
 * runId / turnId / toolCallId / attemptId** —— 于是「按 run 回放这一轮到底发生了什么」
 * 无法做到：多轮、多个 run、父子代理的记录混在一条流里，分不清归属。
 *
 * 做法：新增一个**统一形状**的事件流 `.codenode/events.jsonl`，每条事件都带
 *   `{v, ts, kind, runId, turnId, toolCallId, attemptId, ...payload}`
 * 旧文件继续写（只读兼容一个版本周期），回放走 `scripts/event-replay.cjs`。
 *
 * 幂等/失败语义：写入失败**不抛异常**（事件流是旁路，不能拖垮工具循环），返回 null
 * 并复用 runStore.appendJsonl 的落盘策略（原子替换、坏行容忍、字节上限）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runStore = require('./runStore.cjs');

const SCHEMA_VERSION = 1;
const EVENTS_FILE = 'events.jsonl';

/**
 * 事件文件的绝对路径。
 * @param {string} projectRoot
 */
function eventsPath(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', EVENTS_FILE);
}

/**
 * 统一形状：标识字段置顶且一律字符串化（回放时不用再猜类型），其余字段原样透传。
 * 缺 `kind` 的事件直接丢弃 —— 没有类型的事件在回放里没有意义。
 * @param {any} event
 */
function normalizeEvent(event) {
  const e = event || {};
  const kind = String(e.kind || '').trim();
  if (!kind) return null;
  /** @type {Record<string, any>} */
  const record = {
    v: SCHEMA_VERSION,
    ts: typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString(),
    kind,
    runId: e.runId == null ? null : String(e.runId),
    turnId: e.turnId == null ? null : String(e.turnId),
    toolCallId: e.toolCallId == null ? null : String(e.toolCallId),
    attemptId: e.attemptId == null ? null : String(e.attemptId),
  };
  for (const [key, value] of Object.entries(e)) {
    if (key in record) continue;
    record[key] = value;
  }
  return record;
}

/**
 * 追加一条事件。返回写入的（归一化后的）事件；写失败返回 null（事件流是旁路）。
 * @param {string} projectRoot
 * @param {any} event
 */
function emit(projectRoot, event) {
  if (!projectRoot) return null;
  const record = normalizeEvent(event);
  if (!record) return null;
  try {
    return runStore.appendJsonl(eventsPath(projectRoot), record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * 读回全部事件（按写入顺序）。坏行 / 非 JSON 行被跳过，缺 kind 的行也跳过。
 * @param {string} projectRoot
 * @returns {any[]}
 */
function readEvents(projectRoot) {
  /** @type {any[]} */
  const events = [];
  let text = '';
  try {
    text = fs.readFileSync(eventsPath(projectRoot), 'utf8');
  } catch {
    return events;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && obj.kind) events.push(obj);
    } catch {
      // 坏行（断电 / 半写）不影响其余事件 —— 与 runStore 的策略一致
    }
  }
  return events;
}

/**
 * 按 run / 事件类型回放。
 * @param {string} projectRoot
 * @param {{ runId?: string, kinds?: string[] }} [options]
 * @returns {{ total: number, runs: Array<{ runId: string, count: number, first: string|null, last: string|null, kinds: string[], events: any[] }> }}
 */
function replay(projectRoot, options) {
  const opts = options || {};
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds.map(String)) : null;
  const runId = opts.runId ? String(opts.runId) : null;
  const events = readEvents(projectRoot).filter(
    (e) => (!runId || e.runId === runId) && (!kinds || kinds.has(String(e.kind))),
  );
  /** @type {Map<string, any[]>} */
  const byRun = new Map();
  for (const e of events) {
    const key = e.runId || '(no-run)';
    const list = byRun.get(key);
    if (list) list.push(e);
    else byRun.set(key, [e]);
  }
  const runs = [...byRun.entries()].map(([id, list]) => ({
    runId: id,
    count: list.length,
    first: list.length ? list[0].ts : null,
    last: list.length ? list[list.length - 1].ts : null,
    kinds: [...new Set(list.map((e) => String(e.kind)))],
    events: list,
  }));
  return { total: events.length, runs };
}

/**
 * 人类可读的一行摘要（CLI 与文档共用）。
 * @param {any} event
 */
function formatEvent(event) {
  const e = event || {};
  const parts = [String(e.ts || '').replace('T', ' ').replace('Z', '')];
  parts.push(String(e.kind || '?').padEnd(16));
  if (e.runId) parts.push('run=' + e.runId);
  if (e.turnId != null) parts.push('turn=' + e.turnId);
  if (e.toolCallId) parts.push('call=' + e.toolCallId);
  if (e.name || e.tool) parts.push(String(e.name || e.tool));
  if (e.ok !== undefined) parts.push('ok=' + e.ok);
  if (e.elapsedMs !== undefined) parts.push(String(e.elapsedMs) + 'ms');
  if (e.reason) parts.push('reason=' + e.reason);
  return parts.filter(Boolean).join(' ');
}

/**
 * S8 双写桥：把「旧日志的一条记录」同时投递到统一事件流。**永不抛** ——
 * 事件流是旁路，任何失败都必须吞掉，不能拖垮工具循环 / 检查点 / 账本。
 * @param {string} projectRoot
 * @param {string} kind
 * @param {any} payload
 */
function bridge(projectRoot, kind, payload) {
  try {
    return emit(projectRoot, Object.assign({ kind }, payload || {}));
  } catch {
    return null;
  }
}

/**
 * 回放摘要：把一串事件压成「这次运行到底发生了什么」的事实清单（只统计实际写进事件的字段，
 * 不补、不猜）。CLI 的 `--summary` 与 UI 都可用。
 * @param {any[]} events
 */
function summarize(events) {
  const list = Array.isArray(events) ? events : [];
  /** @type {Record<string, number>} */
  const kinds = {};
  /** @type {Record<string, {calls: number, failures: number}>} */
  const tools = {};
  /** @type {Record<string, number>} */
  const failureCodes = {};
  const approvals = { issued: 0, denied: 0, rejected: 0, consumed: 0 };
  const runs = new Set();
  let costUsd = 0;
  let tokens = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let first = null;
  let last = null;
  for (const event of list) {
    if (!event) continue;
    const kind = String(event.kind || '?');
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (event.runId) runs.add(String(event.runId));
    if (event.ts) {
      if (!first || event.ts < first) first = event.ts;
      if (!last || event.ts > last) last = event.ts;
    }
    if (kind === 'tool') {
      const name = String(event.name || event.tool || '?');
      const slot = tools[name] || { calls: 0, failures: 0 };
      slot.calls += 1;
      toolCalls += 1;
      if (event.ok === false) {
        slot.failures += 1;
        toolFailures += 1;
      }
      tools[name] = slot;
    } else if (kind === 'failure_taxonomy') {
      for (const item of Array.isArray(event.nudged) ? event.nudged : []) {
        const code = String((item && item.code) || 'UNKNOWN');
        failureCodes[code] = (failureCodes[code] || 0) + 1;
      }
    } else if (kind === 'approval') {
      const phase = String(event.event || '');
      if (phase === 'approval_issued') approvals.issued += 1;
      else if (phase === 'approval_denied') approvals.denied += 1;
      else if (phase === 'approval_rejected') approvals.rejected += 1;
      else if (phase === 'approval_consumed') approvals.consumed += 1;
    } else if (kind === 'cost') {
      const usd = Number(event.costUsd);
      if (Number.isFinite(usd)) costUsd += usd;
      const usage = event.tokens || {};
      const total = Number(usage.total != null ? usage.total : usage.total_tokens);
      if (Number.isFinite(total)) tokens += total;
    }
  }
  return {
    total: list.length,
    runs: [...runs],
    span: { first, last },
    kinds,
    tools,
    toolCalls,
    toolFailures,
    failureCodes,
    approvals,
    costUsd: Number(costUsd.toFixed(6)),
    tokens,
  };
}

/**
 * UI / IPC 一次成形的回放载荷：时间线（截断到 limit）+ 摘要 + 事件文件位置。
 * 时间线只回**最近** limit 条（界面里看的是「刚刚发生了什么」）。
 * @param {string} projectRoot
 * @param {{ runId?: string|null, kinds?: string[]|null, limit?: number }} [options]
 */
function replayPayload(projectRoot, options) {
  const opts = options || {};
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
  const report = replay(projectRoot, { runId: opts.runId || null, kinds: opts.kinds || undefined });
  const all = report.runs.flatMap((run) => run.events);
  return {
    ok: true,
    file: eventsPath(projectRoot),
    total: report.total,
    runs: report.runs.map((run) => ({
      runId: run.runId,
      count: run.count,
      first: run.first,
      last: run.last,
      kinds: run.kinds,
    })),
    events: limit > 0 ? all.slice(-limit) : all,
    summary: summarize(all),
  };
}

module.exports = {
  SCHEMA_VERSION,
  EVENTS_FILE,
  eventsPath,
  normalizeEvent,
  emit,
  readEvents,
  replay,
  replayPayload,
  summarize,
  bridge,
  formatEvent,
};
