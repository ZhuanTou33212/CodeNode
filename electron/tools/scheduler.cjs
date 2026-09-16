/**
 * scheduler.cjs —— ToolScheduler（S6，2026-09-16）
 *
 * 审查第 6 节 S6：只读并行（默认并发 2–4，可配）+ `withTimeout` + 取消贯穿 + 事件带
 * `turnId`/`toolCallId`/`attemptId`。
 *
 * 本实现的取舍（**默认关闭 → 行为与串行执行逐字节等价**）：
 *   - 并行只作用于「工具执行」这一步，且只对**只读**调用生效。写操作（`mutatesWorkspace`）、
 *     需要确认的动作、参数不完整的调用一律留给主循环按原顺序串行执行 —— 副作用顺序语义不变。
 *   - `prime()` **只启动、不等待**：主循环随后仍按原顺序 `await` 各自的 promise，
 *     因此 record / messages / 幂等账本 / 检查点的顺序与串行执行时完全一致。
 *     （这也是不采用「先并行执行完再统一回填」的原因：那会打乱副作用结算的时序。）
 *   - 取消贯穿：每个预启动的执行都拿到「父 signal → 子 controller」链，父 abort 时立刻收到 abort；
 *     未被 `await` 的结果由 `withTimeout` 统一 catch 成失败结果，不会成为 unhandled rejection。
 *   - 超时：用 descriptor 声明的 `timeoutMs`（与注册表契约超时同一个值）计时，到点即失败
 *     （`code=TIMEOUT`，接 S5 的码表）并主动 abort 底层执行。
 */
'use strict';

const { AgentToolResult } = require('./result.cjs');

/** 默认并发（审查建议 2–4；取 3） */
const DEFAULT_CONCURRENCY = 3;
/** 并发上限（超过这个数对本地工具没有收益，只会放大资源争用） */
const MAX_CONCURRENCY = 8;

/** 归一并发数（非法值回落默认） */
function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
}

/**
 * 把父 signal 的 abort 转发到子 controller（取消贯穿）。
 * @param {any} parent
 * @param {AbortController|null} controller
 * @returns {any} 子 signal（没有 controller 时原样返回父 signal）
 */
function linkAbort(parent, controller) {
  if (!controller) return parent || null;
  const child = controller.signal;
  if (!parent) return child;
  if (parent.aborted) {
    try {
      controller.abort();
    } catch {}
    return child;
  }
  try {
    parent.addEventListener('abort', () => {
      try {
        controller.abort();
      } catch {}
    }, { once: true });
  } catch {}
  return child;
}

/** 异常 → 失败结果（超时 TIMEOUT / 取消 CANCELLED / 其它 SYSTEM_ERROR，接 S5 的码表） */
function resultFromError(error, info) {
  const i = info || {};
  const err = /** @type {any} */ (error);
  const aborted = !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
  const code = err && err.code === 'TIMEOUT' ? 'TIMEOUT' : aborted ? 'CANCELLED' : 'SYSTEM_ERROR';
  const message = err && err.message ? String(err.message) : String(error || '工具执行失败');
  return AgentToolResult.failure(code, message, { tool: i.tool || null, toolCallId: i.toolCallId || null, scheduler: true });
}

/**
 * 统一超时包装：到点即返回失败结果（`code=TIMEOUT`），并触发 `onTimeout`（用于 abort 底层执行）。
 * 注意：定时器**不能 unref** —— unref 之后进程可能在没有其它活跃句柄时提前退出、超时永不触发
 * （S9 的总时长预算踩过同一个坑）。`timeoutMs<=0` 表示不加限制。
 * @param {() => Promise<any>} run
 * @param {number} timeoutMs
 * @param {{tool?: string, toolCallId?: string, signal?: any, onTimeout?: Function, rethrow?: boolean}} [options]
 */
async function withTimeout(run, timeoutMs, options) {
  const o = options || {};
  const limit = Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 0;
  if (!limit) {
    try {
      return await run();
    } catch (error) {
      if (o.rethrow) throw error;
      return resultFromError(error, o);
    }
  }
  let timer = null;
  const timeoutError = /** @type {any} */ (new Error('工具执行超时（' + limit + 'ms）：' + (o.tool || 'tool')));
  timeoutError.code = 'TIMEOUT';
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (typeof o.onTimeout === 'function') {
        try {
          o.onTimeout();
        } catch {}
      }
      reject(timeoutError);
    }, limit);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), guard]);
  } catch (error) {
    if (o.rethrow) throw error;
    return resultFromError(error, o);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ToolScheduler {
  /**
   * @param {{enabled?: boolean, concurrency?: number}} [options]
   */
  constructor(options) {
    const o = options || {};
    /** 默认关闭：关闭时 `prime()` 直接返回空计划，主循环行为与串行执行完全一致 */
    this.enabled = o.enabled === true;
    this.concurrency = clampConcurrency(o.concurrency);
  }

  /**
   * 预启动这一轮里可安全并行的**只读**调用。只启动、不等待。
   * @param {Array<{callId: string, name: string, argsText?: string, argsValid?: boolean}>} items
   * @param {{signal?: any, turnId?: any, budget?: number, descriptorOf?: Function, execute?: Function, isMalformed?: Function, trace?: Function}} deps
   * @returns {{promises: Map<string, Promise<any>>, planned: Array<any>, concurrency: number, enabled: boolean}}
   */
  prime(items, deps) {
    const d = deps || {};
    /** @type {Map<string, Promise<any>>} */
    const promises = new Map();
    const planned = [];
    if (!this.enabled || typeof d.execute !== 'function') {
      return { promises, planned, concurrency: this.concurrency, enabled: this.enabled };
    }
    const list = Array.isArray(items) ? items : [];
    const descriptorOf = typeof d.descriptorOf === 'function' ? d.descriptorOf : () => null;
    const isReadOnly = (item) => {
      const descriptor = descriptorOf(item && item.name);
      return !!(descriptor && descriptor.readOnly === true && descriptor.mutatesWorkspace !== true);
    };
    // 第一趟（保守规则）：只要这一轮里存在「非只读」或「需要确认」的调用，**整轮串行** ——
    // 写操作必须独占：只读若与写并发，可能读到「写了一半」的状态（缓存/工作区都会失真）。
    const blocking = list.filter((item) => !isReadOnly(item) || !!((descriptorOf(item && item.name) || {}).requiresConfirmation));
    if (blocking.length) {
      for (const item of list) {
        planned.push({
          callId: String((item && item.callId) || ''),
          name: item && item.name,
          started: false,
          reason: '本轮存在写操作/需确认的调用 → 整轮串行（保证写操作独占）',
        });
      }
      return { promises, planned, concurrency: this.concurrency, enabled: true };
    }
    const budget = Number.isFinite(Number(d.budget)) ? Math.max(0, Number(d.budget)) : Infinity;
    let started = 0;
    for (const item of list) {
      const callId = item && item.callId ? String(item.callId) : '';
      const base = { callId, name: item && item.name, started: false };
      if (!callId) {
        planned.push(Object.assign(base, { reason: '缺少 callId（无法对应执行结果）' }));
        continue;
      }
      if (started >= budget) {
        planned.push(Object.assign(base, { reason: '本轮调用额度已用完（留给主循环串行处理）' }));
        continue;
      }
      const descriptor = descriptorOf(item && item.name);
      if (typeof d.isMalformed === 'function' && d.isMalformed(item)) {
        planned.push(Object.assign(base, { reason: '参数不完整：拒绝执行' }));
        continue;
      }
      if (started >= this.concurrency) {
        planned.push(Object.assign(base, { reason: '超出并发上限 ' + this.concurrency + '（留给主循环按序执行）' }));
        continue;
      }
      started += 1;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const childSignal = linkAbort(d.signal, controller);
      const limit = descriptor.timeoutMs == null ? 0 : descriptor.timeoutMs;
      const promise = withTimeout(
        () => d.execute(item, { turnId: d.turnId, toolCallId: callId, attemptId: callId + '#1', signal: childSignal, scheduler: 'parallel-readonly' }),
        limit,
        { tool: item.name, toolCallId: callId, signal: childSignal, onTimeout: () => controller && controller.abort() },
      );
      promises.set(callId, promise);
      planned.push(Object.assign(base, { started: true, reason: '只读并行', parallel: true, timeoutMs: limit }));
    }
    if (typeof d.trace === 'function' && planned.some((p) => p.started)) {
      d.trace({
        kind: 'scheduler_parallel',
        turnId: d.turnId == null ? null : d.turnId,
        concurrency: this.concurrency,
        // 事件带 turnId / toolCallId / attemptId（S6 验收项）
        started: planned.filter((p) => p.started).map((p) => ({ name: p.name, toolCallId: p.callId, attemptId: p.callId + '#1' })),
        serial: planned.filter((p) => !p.started).map((p) => ({ name: p.name, toolCallId: p.callId, reason: p.reason })),
      });
    }
    return { promises, planned, concurrency: this.concurrency, enabled: true };
  }
}

module.exports = {
  ToolScheduler,
  withTimeout,
  linkAbort,
  resultFromError,
  clampConcurrency,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
};
