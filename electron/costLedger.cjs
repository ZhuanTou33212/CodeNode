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

/**
 * 解析 cost.price.<model>=<inPerMillion>,<outPerMillion>[,<cachedInPerMillion>]
 *
 * 第 3 段是**缓存命中输入的单价**（第 3 项缺陷）：供应商对「命中的前缀缓存」收得比普通输入
 * 便宜得多（DeepSeek 命中价约为未命中的 1/10，OpenAI 约 1/2），而账本此前只按 input/output
 * 两个总价目乘全量 prompt —— 命中率一高，成本就被系统性高估（进而让成本告警与额度判断失真）。
 * 不配第 3 段时行为与旧版逐字相同（按全量 prompt 计价），只是精度标注为 single-rate。
 */
function parsePrices(cfg) {
  const prices = {};
  for (const [key, value] of Object.entries(cfg || {})) {
    if (!key.startsWith('cost.price.')) continue;
    const model = key.slice('cost.price.'.length).trim();
    const parts = String(value || '')
      .split(',')
      .map((item) => Number(String(item).trim()));
    if (!model || parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    const price = { in: parts[0], out: parts[1] };
    if (parts.length >= 3 && Number.isFinite(parts[2])) price.cachedIn = parts[2];
    prices[model] = price;
  }
  return prices;
}

function tokenParts(usage) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? prompt + completion) || 0;
  // 服务端「前缀缓存」的命中/未命中（S9）：这两项以前被直接丢掉，于是「缓存命中率」根本无法测量
  // （用户反馈的正是「那一次工具结果压缩的缓存命中率非常低」）。口径：
  //   DeepSeek → prompt_cache_hit_tokens / prompt_cache_miss_tokens
  //   OpenAI   → prompt_tokens_details.cached_tokens（miss 用 prompt - cached 推）
  const details = u.prompt_tokens_details || u.prompt_cache || {};
  const hitRaw = u.prompt_cache_hit_tokens ?? details.cached_tokens ?? details.hit_tokens;
  const cached = Number.isFinite(Number(hitRaw)) ? Math.max(0, Number(hitRaw)) : 0;
  const missRaw = u.prompt_cache_miss_tokens ?? details.miss_tokens;
  const miss = Number.isFinite(Number(missRaw)) ? Math.max(0, Number(missRaw)) : Math.max(0, prompt - cached);
  // reasoning token：供应商通常已把它算进 completion（DeepSeek 如此），这里**只单独记录供观测**，
  // 绝不再加一遍 —— 重复计价比不记更糟。
  const reasoningRaw = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens != null)
    ? u.completion_tokens_details.reasoning_tokens
    : u.reasoning_tokens;
  const reasoning = Number.isFinite(Number(reasoningRaw)) ? Math.max(0, Number(reasoningRaw)) : null;
  return { prompt, completion, total, cached, miss, reasoning };
}

/** 缓存命中率：命中 /（命中 + 未命中）；没有数据时为 null —— 不编造。 */
function withCacheRate(counters) {
  const hit = Number(counters.promptCachedTokens) || 0;
  const miss = Number(counters.promptMissTokens) || 0;
  const denom = hit + miss;
  return { ...counters, promptCacheHitRate: denom > 0 ? Number((hit / denom).toFixed(4)) : null };
}

/**
 * 计费。
 *   - 配了 cachedIn（第 3 段）：按「未命中输入 × in + 命中输入 × cachedIn + 输出 × out」计价，
 *     数据缺失（cached 为 0）时退化成全量按 in 计 —— 与旧版一致，不会凭空变便宜。
 *   - 没配 cachedIn：沿用旧口径（全量 prompt × in），精度标注为 single-rate。
 */
function costOf(model, usage, prices) {
  const price = prices && prices[model];
  if (!price) return null;
  const { prompt, completion, cached, miss } = tokenParts(usage);
  if (Number.isFinite(price.cachedIn)) {
    const missTokens = Number.isFinite(miss) ? Math.min(miss, prompt) : prompt;
    return (missTokens / 1e6) * price.in + (cached / 1e6) * price.cachedIn + (completion / 1e6) * price.out;
  }
  return (prompt / 1e6) * price.in + (completion / 1e6) * price.out;
}

/** 计价精度：账本对外必须说清「这是估算还是命中感知的计费」（第 3 项的结论要求） */
function pricePrecision(prices) {
  const models = Object.keys(prices || {});
  if (!models.length) return 'unknown';
  return models.every((model) => Number.isFinite(prices[model].cachedIn)) ? 'cached-aware' : 'single-rate';
}

function emptyCounters() {
  return { requests: 0, errors: 0, retries: 0, promptTokens: 0, completionTokens: 0, promptCachedTokens: 0, promptMissTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0, costKnown: true, estimated: 0, latencyMs: 0 };
}

function addCounters(target, entry, cost) {
  target.requests += 1;
  if (entry.ok === false) target.errors += 1;
  if (Number(entry.attempt) > 1) target.retries += Number(entry.attempt) - 1;
  target.promptTokens += entry.tokens.prompt;
  target.completionTokens += entry.tokens.completion;
  target.promptCachedTokens += Number(entry.tokens.cached) || 0;
  target.promptMissTokens += Number(entry.tokens.miss) || 0;
  // reasoning 是 completion 的子集（供应商口径），只做观测统计，不进 costUsd 的算式
  target.reasoningTokens += Number(entry.tokens.reasoning) || 0;
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
        // S8：成本事件也进统一流（按 run 回放时能看到这轮花了多少、缓存命中多少）
        require('./eventBus.cjs').bridge(this.projectRoot, 'cost', {
          runId: record.runId || null,
          call: record.kind || null,
          model: record.model || null,
          costUsd: record.costUsd,
          tokens: record.usage || null,
        });
      } catch {}
    }
    return record;
  }

  summary(runId) {
    const key = runId ? runStore.normalizeRunId(runId) : this.runId;
    return withCacheRate(this.byRun.get(key) || emptyCounters());
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
    return withCacheRate(counters);
  }

  snapshot(queueInfo) {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      run: this.summary(),
      today: this.today(),
      kinds: { ...this.byKind },
      priceModels: Object.keys(this.prices),
      // 计价精度（第 3 项）：single-rate = 命中价未配置，成本是按全量输入估的；cached-aware = 命中/未命中分价
      pricePrecision: pricePrecision(this.prices),
      queue: queueInfo || null,
      recent: this.entries.slice(-20),
    };
  }
}

module.exports = { CostLedger, parsePrices, costOf, pricePrecision, tokenParts, emptyCounters, withCacheRate };
