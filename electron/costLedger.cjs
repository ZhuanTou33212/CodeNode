/**
 * costLedger.cjs —— 统一成本账本
 *
 * 解决审阅里的缺口：「token 预算缺少全任务统一记账；子代理、压缩调用、嵌入成本不可控」。
 *
 * 关键点：
 *   1. 一次 Run 内所有模型调用（主循环 / 结果压缩 / 子代理 / 嵌入）都写同一本账，
 *      kind 区分来源，runId 聚合到任务维度；
 *   2. 预算（requestBudget.cjs）负责「请求前预留」，本账本负责「回答后结算 + 可查询」，
 *      两者互补：预算是闸门，账本是度量；
 *   3. 无 usage 的响应按保守估值记账（标记 estimated=true），不会假装免费；
 *   4. 单价可配置（cost.price.<model>=输入单价,输出单价，单位：美元/百万 token），
 *      没配单价时只记 token、cost 为 null —— 不编造费用数字。
 *
 * 账本落盘：<projectRoot>/.codenode/metrics/cost.jsonl（按字节轮转，复用 runStore.appendJsonl）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const runStore = require('./runStore.cjs');

const MAX_IN_MEMORY = 5000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** 解析 cost.price.<model>=<inPerMillion>,<outPerMillion> */
function parsePrices(cfg) {
  const prices = {};
  for (const [key, value] of Object.entries(cfg || {})) {
    if (!key.startsWith('cost.price.')) continue;
    const model = key.slice('cost.price.'.length).trim();
    const parts = String(value || '')
      .split(',')
      .map((item) => Number(String(item).trim()));
    if (!model || parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    prices[model] = { in: parts[0], out: parts[1] };
  }
  return prices;
}

function tokenParts(usage) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? prompt + completion) || 0;
  return { prompt, completion, total };
}

function costOf(model, usage, prices) {
  const price = prices && prices[model];
  if (!price) return null;
  const { prompt, completion } = tokenParts(usage);
  return (prompt / 1e6) * price.in + (completion / 1e6) * price.out;
}

function emptyCounters() {
  return { requests: 0, errors: 0, retries: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, costKnown: true, estimated: 0, latencyMs: 0 };
}

function addCounters(target, entry, cost) {
  target.requests += 1;
  if (entry.ok === false) target.errors += 1;
  if (Number(entry.attempt) > 1) target.retries += Number(entry.attempt) - 1;
  target.promptTokens += entry.tokens.prompt;
  target.completionTokens += entry.tokens.completion;
  target.totalTokens += entry.tokens.total;
  if (cost == null) target.costKnown = false;
  else target.costUsd += cost;
  if (entry.estimated) target.estimated += 1;
  target.latencyMs += Number(entry.latencyMs) || 0;
  return target;
}

class CostLedger {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || null;
    this.runId = runStore.normalizeRunId(options.runId || 'unscoped');
    this.prices = options.prices || {};
    this.file = options.file || (this.projectRoot ? path.join(path.resolve(this.projectRoot), '.codenode', 'metrics', 'cost.jsonl') : null);
    this.maxBytes = Math.max(64 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    this.entries = [];
    this.totals = emptyCounters();
    this.byRun = new Map();
    this.byKind = {};
    this.startedAt = new Date().toISOString();
  }

  /**
   * 记一笔模型调用。
   * entry: { kind:'main'|'compression'|'subagent'|'embedding', model, usage, latencyMs, ok, attempt,
   *          estimated, runId, meta }
   */
  record(entry = {}) {
    const kind = String(entry.kind || 'main');
    const model = String(entry.model || 'unknown');
    const usage = entry.usage || null;
    const tokens = tokenParts(usage);
    const estimated = entry.estimated === true || !usage || tokens.total === 0;
    const record = {
      ts: new Date().toISOString(),
      runId: entry.runId ? runStore.normalizeRunId(entry.runId) : this.runId,
      kind,
      model,
      tokens,
      usage: usage || null,
      ok: entry.ok !== false,
      attempt: Number(entry.attempt) || 1,
      estimated,
      latencyMs: Number(entry.latencyMs) || 0,
      meta: entry.meta || null,
    };
    record.costUsd = costOf(model, usage, this.prices);
    this.entries.push(record);
    if (this.entries.length > MAX_IN_MEMORY) this.entries.splice(0, this.entries.length - MAX_IN_MEMORY);
    addCounters(this.totals, record, record.costUsd);
    const run = this.byRun.get(record.runId) || emptyCounters();
    addCounters(run, record, record.costUsd);
    this.byRun.set(record.runId, run);
    const kindCounters = this.byKind[kind] || emptyCounters();
    addCounters(kindCounters, record, record.costUsd);
    this.byKind[kind] = kindCounters;
    if (this.file) {
      try {
        runStore.appendJsonl(this.file, { type: 'cost', ...record }, this.maxBytes);
      } catch {}
    }
    return record;
  }

  summary(runId) {
    const key = runId ? runStore.normalizeRunId(runId) : this.runId;
    return this.byRun.get(key) || emptyCounters();
  }

  /** 当日（本地时区）聚合：内存账本 + 文件中的历史行（只读，不写）。 */
  today(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const counters = emptyCounters();
    const seen = new Set();
    const fromMemory = (entry) => {
      if (!String(entry.ts || '').startsWith(day)) return;
      seen.add(entry.ts + '|' + entry.kind + '|' + entry.model + '|' + entry.tokens.total);
      addCounters(counters, entry, entry.costUsd);
    };
    for (const entry of this.entries) fromMemory(entry);
    if (this.file && fs.existsSync(this.file)) {
      try {
        const lines = fs.readFileSync(this.file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue; // 容忍损坏行
          }
          if (entry.type !== 'cost' || !String(entry.ts || '').startsWith(day)) continue;
          const key = entry.ts + '|' + entry.kind + '|' + entry.model + '|' + (entry.tokens || {}).total;
          if (seen.has(key)) continue;
          seen.add(key);
          fromMemory(entry);
        }
      } catch {}
    }
    return counters;
  }

  snapshot(queueInfo) {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      run: this.summary(),
      today: this.today(),
      kinds: { ...this.byKind },
      priceModels: Object.keys(this.prices),
      queue: queueInfo || null,
      recent: this.entries.slice(-20),
    };
  }
}

module.exports = { CostLedger, parsePrices, costOf, tokenParts, emptyCounters };
