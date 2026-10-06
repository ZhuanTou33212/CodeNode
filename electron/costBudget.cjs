'use strict';

// Integer nanodollars keep concurrent reservations from drifting at the limit.
// This is a guard against configured prices, not a claim about provider billing.
const SCALE = 1e9;
const MAX_LIMIT_USD = 1000000;

function budgetError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, retryable: false, ...details });
}

function parseCostLimit(raw) {
  if (raw == null || String(raw).trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_LIMIT_USD || (value > 0 && value < 0.000001)) {
    throw budgetError('COST_CONFIG_INVALID', 'agent.max_cost_usd 必须是 0（关闭）或 0.000001 至 1000000 之间的美元金额');
  }
  return value;
}

function parseImageTokenBounds(properties = {}) {
  const bounds = Object.create(null);
  for (const [key, raw] of Object.entries(properties)) {
    if (!key.startsWith('cost.image_input_tokens.')) continue;
    const model = key.slice('cost.image_input_tokens.'.length).trim();
    const value = Number(raw);
    if (!model || !Number.isSafeInteger(value) || value <= 0 || value > 4000000) {
      throw budgetError('COST_CONFIG_INVALID', '图片费用上界必须是绑定实际模型的正整数 Token 数（最多 4000000）');
    }
    bounds[model] = value;
  }
  return bounds;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function priceFor(model, prices) {
  const price = prices && prices[model];
  if (!price || count(price.in) == null || count(price.out) == null ||
      (price.cachedIn != null && count(price.cachedIn) == null)) {
    throw budgetError('COST_PRICE_MISSING', '已启用费用硬上限，但模型 ' + model + ' 缺少有效单价；请配置 cost.price.' + model, { model });
  }
  return price;
}

function units(input, output, price) {
  const amount = Math.ceil((input * price.in + output * price.out) * 1000);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw budgetError('COST_CONFIG_INVALID', '费用预留超出可安全计算的范围');
  }
  return amount;
}

function actualUnits(usage, price, reserved) {
  if (!usage || usage.estimated === true) return reserved;
  const input = count(usage.prompt_tokens ?? usage.input_tokens);
  const output = count(usage.completion_tokens ?? usage.output_tokens);
  if (input != null && output != null) {
    const cached = count(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) || 0;
    const cachedInput = Math.min(input, cached);
    const ordinaryInput = input - cachedInput;
    const cachePrice = price.cachedIn == null ? price.in : price.cachedIn;
    const total = count(usage.total_tokens);
    const unattributed = total == null ? 0 : Math.max(0, total - input - output);
    // Some protocols report reasoning tokens only in total_tokens. Never free
    // their reservation merely because the input/output split omitted them.
    return units(ordinaryInput, output, price) + units(cachedInput, 0, { in: cachePrice, out: 0 }) +
      units(unattributed, 0, { in: Math.max(price.in, price.out, cachePrice), out: 0 });
  }
  const total = count(usage.total_tokens);
  // A total-only usage frame cannot establish the input/output split.
  return total == null ? reserved : units(total, 0, { in: Math.max(price.in, price.out, price.cachedIn || 0), out: 0 });
}

class CostBudget {
  constructor(options = {}) {
    this.limitUsd = parseCostLimit(options.limitUsd);
    this.limit = Math.floor(this.limitUsd * SCALE);
    this.prices = options.prices || {};
    this.used = 0;
    this.reserved = 0;
    this.uncertainRequests = 0;
  }

  snapshot() {
    return { enabled: this.limit > 0, limitUsd: this.limitUsd, usedUsd: this.used / SCALE,
      reservedUsd: this.reserved / SCALE, uncertainRequests: this.uncertainRequests };
  }

  _reserve(amount) {
    if (this.used + this.reserved + amount > this.limit) {
      throw budgetError('COST_BUDGET_EXCEEDED', '本次运行的费用额度不足，已在模型请求发出前停止。', {
        ...this.snapshot(), neededUsd: amount / SCALE,
      });
    }
    this.reserved += amount;
    let settled = false;
    return (actual, uncertain) => {
      if (settled) return;
      settled = true;
      this.reserved -= amount;
      this.used += actual;
      if (uncertain) this.uncertainRequests += 1;
    };
  }

  reserveTokens(model, input, output, prices) {
    if (!this.limit) return (_usage, _options = {}) => {};
    if (count(input) == null || count(output) == null) throw budgetError('COST_CONFIG_INVALID', '费用预算的 Token 估算无效');
    const price = priceFor(String(model || ''), prices || this.prices);
    const upper = units(input, output, { in: Math.max(price.in, price.cachedIn || 0), out: price.out });
    const settle = this._reserve(upper);
    return (usage, options = {}) => {
      if (options.notSent === true) return settle(0, false);
      let actual = upper;
      try { actual = actualUnits(usage, price, upper); } catch { /* retain the reservation on malformed usage */ }
      const uncertain = !usage || usage.estimated === true ||
        (count(usage.prompt_tokens ?? usage.input_tokens) == null || count(usage.completion_tokens ?? usage.output_tokens) == null) ||
        Number(usage.total_tokens) > Number(usage.prompt_tokens ?? usage.input_tokens) + Number(usage.completion_tokens ?? usage.output_tokens);
      settle(actual, uncertain);
    };
  }

  reserveFixed(amountUsd) {
    if (!this.limit) return () => {};
    const amount = Number(amountUsd);
    if (amountUsd == null || !Number.isFinite(amount) || amount < 0) {
      throw budgetError('COST_PRICE_MISSING', '费用硬上限已启用，重排请求需要显式配置每次请求的费用上界 rag.rerank_max_cost_usd');
    }
    const cost = Math.ceil(amount * SCALE);
    if (!Number.isSafeInteger(cost)) throw budgetError('COST_CONFIG_INVALID', '重排请求费用上界无效');
    const settle = this._reserve(cost);
    return (notSent = false) => settle(notSent ? 0 : cost, !notSent);
  }
}

module.exports = { CostBudget, parseCostLimit, parseImageTokenBounds, priceFor };
