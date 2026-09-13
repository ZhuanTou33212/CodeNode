'use strict';
class RequestBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    this.reserved = 0;
  }
  reserve(amount) {
    if (!Number.isFinite(amount) || amount < 0 || this.used + this.reserved + amount > this.limit)
      throw Object.assign(new Error('请求前预算检查失败：额度不足'), { code: 'BUDGET_EXCEEDED' });
    this.reserved += amount;
    let settled = false;
    return (usage) => {
      if (settled) return;
      settled = true;
      this.reserved -= amount;
      // Missing usage or an uncertain failed request retains its full reservation.
      const actual = usage && Number(usage.total_tokens);
      this.used += Number.isFinite(actual) && actual >= 0 ? actual : amount;
    };
  }
}
async function withBudget(cfg, messages, tools, operation) {
  if (!cfg.requestBudget) return operation();
  // Conservative UTF-8 byte estimate plus per-message protocol allowance.
  const input = Buffer.byteLength(JSON.stringify({ messages, tools: tools || [] }), 'utf8') + messages.length * 32 + 256;
  const output = Number(cfg.maxTokens) || 8192;
  const attempts = Math.max(1, Math.min(5, Number(cfg.reliability?.maxAttempts) || 3));
  const settle = cfg.requestBudget.reserve((input + output) * attempts);
  try {
    const result = await operation();
    // Retries may already have incurred charges: account conservatively until
    // per-attempt usage is available.
    settle(attempts === 1 ? result.usage : null);
    return result;
  } catch (error) {
    settle(null);
    throw error;
  }
}
module.exports = { RequestBudget, withBudget };
