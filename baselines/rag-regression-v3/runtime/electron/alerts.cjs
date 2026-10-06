/**
 * alerts.cjs —— 生产告警（成本 / 可靠性 / 队列 / 隔离降级）
 *
 * 解决审阅缺口：「成本监控与生产告警」「可查询的运行指标与失败告警」。
 *
 * 设计：
 *   - 规则纯函数 evaluateAlertRules(snapshot, thresholds)：输入账本快照 + 指标，输出告警列表；
 *     id 稳定（rule + 维度），便于去重与冷却；
 *   - AlertDispatcher 负责去重、冷却、落盘（.codenode/metrics/alerts.jsonl）、回调（推给 UI）
 *     与可选 webhook（失败只记日志，不阻断主流程）；
 *   - 阈值来自 config/agent.properties（alerts.*），没配也有保守默认值；
 *   - 阈值语义均为「超过即告警」，severity: warn / critical。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runStore = require('./runStore.cjs');

const DEFAULT_THRESHOLDS = {
  runTokens: 200000,
  dailyTokens: 2000000,
  runCostUsd: 5,
  dailyCostUsd: 25,
  errorRatePct: 30,
  retryRatePct: 35,
  minRequestsForRate: 4,
  queueWaiting: 8,
  queueWaitMs: 30000,
  degradedSandbox: 1,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseThresholds(cfg) {
  const get = (key, fallback) => {
    const raw = cfg ? cfg['alerts.' + key] : undefined;
    return raw == null || raw === '' ? fallback : num(raw, fallback);
  };
  return {
    runTokens: get('run_tokens', DEFAULT_THRESHOLDS.runTokens),
    dailyTokens: get('daily_tokens', DEFAULT_THRESHOLDS.dailyTokens),
    runCostUsd: get('run_cost_usd', DEFAULT_THRESHOLDS.runCostUsd),
    dailyCostUsd: get('daily_cost_usd', DEFAULT_THRESHOLDS.dailyCostUsd),
    errorRatePct: get('error_rate_pct', DEFAULT_THRESHOLDS.errorRatePct),
    retryRatePct: get('retry_rate_pct', DEFAULT_THRESHOLDS.retryRatePct),
    minRequestsForRate: get('min_requests_for_rate', DEFAULT_THRESHOLDS.minRequestsForRate),
    queueWaiting: get('queue_waiting', DEFAULT_THRESHOLDS.queueWaiting),
    queueWaitMs: get('queue_wait_ms', DEFAULT_THRESHOLDS.queueWaitMs),
    degradedSandbox: get('degraded_sandbox', DEFAULT_THRESHOLDS.degradedSandbox),
  };
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

/**
 * 纯函数规则评估：给定账本快照与阈值，输出应当触发的告警。
 * snapshot: { run, today, queue:{waiting,waitMs}, degradedSandbox:boolean, retries }
 */
function evaluateAlertRules(snapshot = {}, thresholds = DEFAULT_THRESHOLDS) {
  const alerts = [];
  const run = snapshot.run || {};
  const today = snapshot.today || {};
  const push = (id, severity, message, value, threshold) => alerts.push({ id, severity, message, value, threshold });

  if (num(run.totalTokens, 0) > thresholds.runTokens) {
    push('run_tokens', 'warn', '本次任务 token 用量 ' + run.totalTokens + ' 超过阈值 ' + thresholds.runTokens, run.totalTokens, thresholds.runTokens);
  }
  if (num(today.totalTokens, 0) > thresholds.dailyTokens) {
    push('daily_tokens', 'warn', '今日 token 总量 ' + today.totalTokens + ' 超过阈值 ' + thresholds.dailyTokens, today.totalTokens, thresholds.dailyTokens);
  }
  if (today.costKnown !== false && num(today.costUsd, 0) > thresholds.dailyCostUsd) {
    push('daily_cost', 'critical', '今日模型成本 $' + num(today.costUsd, 0).toFixed(4) + ' 超过阈值 $' + thresholds.dailyCostUsd, today.costUsd, thresholds.dailyCostUsd);
  }
  if (run.costKnown !== false && num(run.costUsd, 0) > thresholds.runCostUsd) {
    push('run_cost', 'warn', '本次任务成本 $' + num(run.costUsd, 0).toFixed(4) + ' 超过阈值 $' + thresholds.runCostUsd, run.costUsd, thresholds.runCostUsd);
  }
  if (num(run.requests, 0) >= thresholds.minRequestsForRate) {
    const errorRate = rate(num(run.errors, 0), num(run.requests, 0));
    if (errorRate > thresholds.errorRatePct) {
      push('error_rate', 'critical', '本次任务模型请求失败率 ' + errorRate.toFixed(1) + '% 超过阈值 ' + thresholds.errorRatePct + '%', errorRate, thresholds.errorRatePct);
    }
    const retryRate = rate(num(run.retries, 0), num(run.requests, 0));
    if (retryRate > thresholds.retryRatePct) {
      push('retry_rate', 'warn', '重试比例 ' + retryRate.toFixed(1) + '% 超过阈值 ' + thresholds.retryRatePct + '%（可能是供应商不稳定或限流）', retryRate, thresholds.retryRatePct);
    }
  }
  const queue = snapshot.queue || {};
  if (num(queue.waiting, 0) > thresholds.queueWaiting) {
    push('queue_depth', 'warn', '模型请求排队 ' + queue.waiting + ' 个，超过阈值 ' + thresholds.queueWaiting, queue.waiting, thresholds.queueWaiting);
  }
  if (num(queue.maxWaitMs, 0) > thresholds.queueWaitMs) {
    push('queue_wait', 'warn', '模型请求最长等待 ' + queue.maxWaitMs + 'ms 超过阈值 ' + thresholds.queueWaitMs + 'ms', queue.maxWaitMs, thresholds.queueWaitMs);
  }
  if (snapshot.degradedSandbox === true) {
    push('sandbox_degraded', 'warn', '执行隔离处于降级状态：' + String(snapshot.degradedReason || '部分隔离项未生效'), 1, thresholds.degradedSandbox);
  }
  return alerts;
}

class AlertDispatcher {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || null;
    this.file = options.file || (this.projectRoot ? path.join(path.resolve(this.projectRoot), '.codenode', 'metrics', 'alerts.jsonl') : null);
    this.thresholds = options.thresholds || DEFAULT_THRESHOLDS;
    this.cooldownMs = num(options.cooldownMs, 5 * 60 * 1000);
    this.onAlert = options.onAlert || null;
    this.webhook = options.webhook || null;
    this.webhookTimeoutMs = num(options.webhookTimeoutMs, 5000);
    this.lastFired = new Map();
    this.history = [];
  }

  /** 评估并派发；返回本次真正新触发（未被冷却吞掉）的告警。 */
  async check(snapshot) {
    const now = Date.now();
    const candidates = evaluateAlertRules(snapshot, this.thresholds);
    const fired = [];
    for (const alert of candidates) {
      const last = this.lastFired.get(alert.id) || 0;
      if (now - last < this.cooldownMs) continue;
      this.lastFired.set(alert.id, now);
      const record = { ts: new Date().toISOString(), ...alert };
      this.history.push(record);
      if (this.history.length > 500) this.history.shift();
      this._persist(record);
      fired.push(record);
      if (typeof this.onAlert === 'function') {
        try { this.onAlert(record); } catch {}
      }
      if (this.webhook) await this._post(record);
    }
    return fired;
  }

  _persist(record) {
    if (!this.file) return;
    try {
      runStore.appendJsonl(this.file, { type: 'alert', ...record });
      // S8：告警也进统一流
      require('./eventBus.cjs').bridge(this.projectRoot, 'alert', {
        runId: record.runId || null,
        level: record.level || null,
        code: record.code || null,
        message: record.message || null,
      });
    } catch {}
  }

  /** webhook 失败只记录，不影响 Agent 主流程（告警不能变成新的故障点）。 */
  async _post(record) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.webhookTimeoutMs);
      try {
        await fetch(this.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      return true;
    } catch (error) {
      this.lastWebhookError = String((error && error.message) || error);
      return false;
    }
  }

  recent(limit = 20) {
    return this.history.slice(-limit);
  }
}

module.exports = { AlertDispatcher, evaluateAlertRules, parseThresholds, DEFAULT_THRESHOLDS, rate };
