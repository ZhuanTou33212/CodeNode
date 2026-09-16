/**
 * fsRunner.cjs —— 主线程侧：把文件遍历任务丢进 worker 跑，并处理取消 / 降级
 *
 * 与 `fsWorker.cjs`（worker 入口）成对。三条语义必须分清：
 *
 * | 结果 | 含义 | 调用方该怎么办 |
 * |---|---|---|
 * | `ok:true, mode:'worker'` | 正常在 worker 里跑完 | 直接用结果 |
 * | `ok:false, cancelled:true` | 用户点了「停止」→ **terminate 掉 worker**（含同步 fs 中途） | 返回 `code=CANCELLED` + 如实说明结果不完整 |
 * | `ok:true, mode:'sync-fallback'` | worker 起不来 / 崩了 → **在主线程同步跑完**（会阻塞界面） | 照常交付，但必须 `audit` + 在结果里留痕 |
 *
 * 降级是**有意为之的 fail-safe**：worker 不可用（打包漏配 asarUnpack、平台限制）时工具不能
 * 直接变成不可用。但降级必须**显式留痕**，不能悄悄退回旧的阻塞行为 —— 否则「已搬到 worker」
 * 就成了纸面结论。`mode:'sync'`（配置关掉 worker）是显式选择，不算降级。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const fsCore = require('./fsCore.cjs');

const WORKER_FILE = 'fsWorker.cjs';

/**
 * worker 入口的真实文件路径。
 *
 * 打包后代码在 `app.asar` 里，而 worker_threads 需要**真实文件系统**上的入口 ——
 * electron-builder 的 `asarUnpack` 会把这两个文件额外解包到 `app.asar.unpacked/`，
 * 所以这里把路径重写到 unpacked 目录。开发模式（无 asar）原样返回。
 */
function workerFilePath(baseDir) {
  const direct = path.join(baseDir || __dirname, WORKER_FILE);
  if (!direct.includes('app.asar')) return direct;
  return direct.replace(/(app\.asar)(?!\.unpacked)/, '$1.unpacked');
}

/** 结构化克隆不支持函数：下发给 worker 的 payload 要剥掉 shouldStop 之类的回调 */
function clonablePayload(payload) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (typeof value === 'function') continue;
    out[key] = value;
  }
  return out;
}

/**
 * 在 worker 线程里跑一个任务。
 * @param {string} task
 * @param {any} payload
 * @param {{ signal?: AbortSignal|null, onProgress?: (count: number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<{ok: boolean, result?: any, cancelled?: boolean, timedOut?: boolean, reason?: string, progress: number}>}
 */
function runInWorker(task, payload, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(workerFilePath());
    } catch (e) {
      resolve({ ok: false, reason: 'worker 启动失败：' + String((e && e.message) || e), progress: 0 });
      return;
    }
    let progress = 0;
    let settled = false;
    let timer = null;
    const signal = opts.signal || null;

    /** @param {any} outcome */
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      // terminate 是立即生效的终止请求：即使 worker 正卡在一次同步 fs 调用里也会被杀掉
      try {
        worker.terminate();
      } catch {}
      resolve(Object.assign({ progress }, outcome));
    };
    const onAbort = () => finish({ ok: false, cancelled: true });

    worker.on('message', (msg) => {
      const m = msg || {};
      if (m.type === 'progress') {
        const count = Number(m.count);
        if (Number.isFinite(count)) {
          progress = count;
          if (typeof opts.onProgress === 'function') opts.onProgress(count);
        }
        return;
      }
      if (m.type === 'done') {
        finish({ ok: true, result: m.result });
        return;
      }
      if (m.type === 'error') finish({ ok: false, reason: String(m.error || 'worker 任务失败') });
    });
    worker.on('error', (e) => finish({ ok: false, reason: 'worker 异常：' + String((e && e.message) || e) }));
    worker.on('exit', (code) => {
      // 正常路径下 finish 已经 resolve 过（settled 拦掉）。非 0 退出码 = worker 崩了 → 交给降级。
      if (code !== 0) finish({ ok: false, reason: 'worker 异常退出（code=' + code + '）' });
    });

    if (signal) {
      if (signal.aborted) {
        finish({ ok: false, cancelled: true });
        return;
      }
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = Number(opts.timeoutMs) || 0;
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    }
    worker.postMessage({ task, payload: clonablePayload(payload) });
  });
}

/**
 * 跑一个文件任务（worker 优先，失败显式降级到主线程同步执行）。
 *
 * @param {string} task 任务名（白名单校验见 fsCore.FS_TASKS；未知任务直接抛错，不静默）
 * @param {any} payload 可含函数（shouldStop 供同步路径用）；下发 worker 前会被剥掉
 * @param {{ enabled?: boolean, signal?: AbortSignal|null, onProgress?: (count: number) => void, timeoutMs?: number }} [options]
 *   enabled=false 表示显式走同步（配置 `tools.fs_worker=false`），不算降级
 * @returns {Promise<{ok: boolean, result?: any, cancelled?: boolean, timedOut?: boolean, mode: string, fallbackReason?: string, progress: number, elapsedMs: number}>}
 */
async function runFsTask(task, payload, options) {
  const opts = options || {};
  const startedAt = Date.now();
  if (!fsCore.FS_TASKS.includes(String(task))) {
    throw new Error('未知文件任务：' + String(task));
  }
  if (opts.enabled === false) {
    const result = fsCore.runTaskSync(task, payload);
    // 同步路径的取消发生在「循环检查点」里（signal 已 aborted → shouldStop 立即返回 true）——
    // 必须把 result 里的 cancelled 提升到 outcome 层，否则调用方会把**半份结果当完整结果**交付。
    const cancelled = !!(result && result.cancelled);
    return { ok: !cancelled, result, cancelled, mode: 'sync', progress: progressOf(result), elapsedMs: Date.now() - startedAt };
  }
  const outcome = await runInWorker(task, payload, opts);
  if (outcome.ok) return Object.assign(outcome, { mode: 'worker', elapsedMs: Date.now() - startedAt });
  // 取消 / 超时是「用户意图」或「上限」，不是 worker 故障 —— 不降级（降级会把已取消的任务又跑一遍）
  if (outcome.cancelled || outcome.timedOut) {
    return Object.assign(outcome, { mode: 'worker', elapsedMs: Date.now() - startedAt });
  }
  // worker 起不来 / 崩了 → 主线程同步跑完（会阻塞界面），并把原因带回去让调用方审计与留痕
  const result = fsCore.runTaskSync(task, payload);
  const cancelled = !!(result && result.cancelled);
  return {
    ok: !cancelled,
    result,
    cancelled,
    mode: 'sync-fallback',
    fallbackReason: outcome.reason || 'worker 不可用',
    progress: progressOf(result) || outcome.progress,
    elapsedMs: Date.now() - startedAt,
  };
}

/** 同步结果里的「已处理条目数」，用于取消时如实回报 partial */
function progressOf(result) {
  const r = result || {};
  if (Number.isFinite(r.scanned)) return Number(r.scanned);
  if (Array.isArray(r.files)) return r.files.length;
  if (Array.isArray(r.matches)) return r.matches.length;
  return 0;
}

/** worker 入口文件是否存在（排障 / 用例用） */
function workerAvailable() {
  try {
    return fs.existsSync(workerFilePath());
  } catch {
    return false;
  }
}

/**
 * 从工具上下文读「是否启用 worker 线程」（缺省启用）。
 * 工具用它构造 `runFsTask` 的 `enabled`：上下文没实现该方法（老的结构化测试桩）时**默认启用**，
 * 与生产装配一致 —— 否则用例会在另一条代码路径上跑，结论不可迁移。
 * @param {any} context
 */
function fsWorkerEnabled(context) {
  try {
    if (context && typeof context.fsWorkerEnabled === 'function') return context.fsWorkerEnabled() !== false;
  } catch {}
  return true;
}

module.exports = { runFsTask, runInWorker, workerFilePath, workerAvailable, clonablePayload, fsWorkerEnabled };
