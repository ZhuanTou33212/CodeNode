'use strict';
/**
 * 请求前预算预留（防止单次运行把额度烧穿）。
 *
 * 估算规则（重要）：
 *   - 文本按 UTF-8 字节数估算（保守，偏大）；
 *   - **图片不能按字节算**：base64 是纯字节，一张 1MB 截图 ≈ 1.33M 字节，
 *     按字节当 token 会得出几百万 token，直接把 agent.max_total_tokens 顶爆，
 *     表现就是「请求前预算检查失败：额度不足」（代码节点带图对话必然触发）。
 *     图片改为按模型计费口径粗估（约 每 750 字节 ≈ 1 token），并设单张上限。
 *   - 输出按 max_tokens，重试按 reliability.maxAttempts 预留。
 */
/** 单张图片的估算 token 上限（避免极端大图把预算吃光） */
const MAX_IMAGE_TOKENS = 4096;
/** 图片字节 → 估算 token 的除数 */
const IMAGE_BYTES_PER_TOKEN = 750;

/** 从消息内容里挑出图片 data URL */
function collectImageUrls(messages) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === 'image_url' && part.image_url && part.image_url.url) out.push(String(part.image_url.url));
    }
  }
  return out;
}

function base64Bytes(dataUrl) {
  const m = /^data:[^;]+;base64,(.*)$/.exec(String(dataUrl || ''));
  if (!m) return String(dataUrl || '').length;
  const b64 = m[1].replace(/\s+/g, '');
  const pad = /=+$/.exec(b64)?.[0].length ?? 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * 估算一次请求的输入 token：
 * 文本部分按字节；图片部分按「字节/750、单张上限」折算，不按 base64 长度算。
 */
function estimateInputTokens(messages, tools) {
  const images = collectImageUrls(messages);
  // 估算体积时把图片 URL 换成占位符，避免 base64 被当成 token
  const stripped = (Array.isArray(messages) ? messages : []).map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((part) =>
        part && part.type === 'image_url'
          ? { type: 'image_url', image_url: { url: '[image]' } }
          : part,
      ),
    };
  });
  const textBytes = Buffer.byteLength(JSON.stringify({ messages: stripped, tools: tools || [] }), 'utf8');
  const imageTokens = images.reduce(
    (sum, url) => sum + Math.min(MAX_IMAGE_TOKENS, Math.ceil(base64Bytes(url) / IMAGE_BYTES_PER_TOKEN)),
    0,
  );
  return textBytes + imageTokens + (Array.isArray(messages) ? messages.length * 32 : 0) + 256;
}

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return NaN;
  if (usage.total_tokens != null) return Number(usage.total_tokens);
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input == null || output == null) return NaN;
  return Number(input) + Number(output);
}

class RequestBudget {
  /**
   * @param {number} limit
   * @param {{parent?: RequestBudget|null, scope?: string, retryLimit?: number}} [options]
   *   parent：父预算（S9 父子链）。子代理的独立配额仍受父总量约束，不绕过 run 上限。
   */
  constructor(limit, options) {
    const o = options || {};
    this.limit = limit;
    /** @type {RequestBudget|null} */
    this.parent = o.parent || null;
    /** 'run' | 'subagent'：仅用于错误提示与审计口径 */
    this.scope = o.scope || 'run';
    this.used = 0;
    this.reserved = 0;
    // Retry credits live at the run root. Child budgets delegate to their parent.
    this.retryLimit = Number.isFinite(Number(o.retryLimit)) ? Math.max(0, Math.floor(Number(o.retryLimit))) : null;
    this.retriesUsed = 0;
  }

  claimRetry() {
    if (this.parent) return this.parent.claimRetry();
    if (this.retryLimit == null) return null;
    if (this.retriesUsed >= this.retryLimit) {
      throw Object.assign(new Error('本次运行已达到模型请求重试上限（' + this.retryLimit + ' 次）'), {
        code: 'RETRY_BUDGET_EXCEEDED', retryable: false,
      });
    }
    this.retriesUsed += 1;
    return this.retriesUsed;
  }

  /** 本层配额是否不够（只看自己，不碰父） */
  wouldExceed(amount) {
    return !Number.isFinite(amount) || amount < 0 || this.used + this.reserved + amount > this.limit;
  }

  reserve(amount) {
    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    if (this.wouldExceed(amount)) {
      throw Object.assign(
        new Error(
          `请求前预算检查失败：额度不足（本次需要约 ${fmt(amount)} tokens，` +
            `已用 ${fmt(this.used)}、预留 ${fmt(this.reserved)}，上限 ${fmt(this.limit)}；` +
            (this.scope === 'subagent'
              ? '可在 config/agent.properties 调大 agent.subagent.max_total_tokens 后重启）'
              : '可在 config/agent.properties 调大 agent.max_total_tokens 后重启）'),
        ),
        {
          code: 'BUDGET_EXCEEDED',
          scope: this.scope,
          need: amount,
          used: this.used,
          reserved: this.reserved,
          limit: this.limit,
        },
      );
    }
    // 父预算先预留（可能因 run 总量不足而抛；此时本层还没预留，回滚是干净的）
    const parentSettle = this.parent ? this.parent.reserve(amount) : null;
    this.reserved += amount;
    let settled = false;
    return (usage) => {
      if (settled) return;
      settled = true;
      this.reserved -= amount;
      // Missing usage or an uncertain failed request retains its full reservation.
      const actual = usageTotal(usage);
      const usedAmount = Number.isFinite(actual) && actual >= 0 ? actual : amount;
      this.used += usedAmount;
      // 父按**实际**用量结算（不是按预留额）：两个维度都反映真实消耗，父总量依然守恒
      if (parentSettle) parentSettle({ total_tokens: usedAmount });
    };
  }
}

/**
 * 子代理的独立配额（S9）。
 *
 * 之前子代理直接用父 cfg，于是共用同一个 `RequestBudget`：一个子代理把额度刷穿，
 * 父 run 与其他子代理会被同一个 `BUDGET_EXCEEDED` 一起挡死，而且看不到是谁花的。
 * 现在每个子代理拿到自己的配额（`agent.subagent.max_total_tokens`），通过 parent 链
 * 把真实用量记进父 run 的总账：
 *   - 子代理超额 → 只有它自己失败，父与其他子代理继续；
 *   - 父 run 总量不足 → 仍然拦住（不绕过总预算）。
 * `limit <= 0` 或没有父预算时返回父预算本身（不设独立配额 = S9 之前的行为，保持兼容）。
 *
 * @param {RequestBudget|null} parent
 * @param {number} limit
 * @returns {RequestBudget|null}
 */
function createSubagentBudget(parent, limit) {
  const n = Number(limit);
  if (!parent || !Number.isFinite(n) || n <= 0) return parent;
  return new RequestBudget(n, { parent, scope: 'subagent' });
}

async function withBudget(cfg, messages, tools, operation, attemptsRef) {
  if (!cfg.requestBudget) return operation();
  const input = estimateInputTokens(messages, tools);
  const output = Number(cfg.maxTokens) || 8192;
  const maxAttempts = Math.max(1, Math.min(5, Number(cfg.reliability?.maxAttempts) || 3));
  // 预留按"最坏情况"（用满重试）保证不会被中途拒绝
  const settle = cfg.requestBudget.reserve((input + output) * maxAttempts);
  try {
    const result = await operation();
    const usage = result && result.usage;
    const actual = usageTotal(usage);
    if (Number.isFinite(actual) && actual >= 0) {
      // 有明确 usage：按实际结算；若真的重试过，服务端对失败的尝试也计了输入费，
      // 而 usage 只反映最后一次，按「实际重试次数」补偿这部分输入。
      const usedAttempts = Math.max(1, Number(attemptsRef && attemptsRef.count) || 1);
      const retryPenalty = usedAttempts > 1 ? input * (usedAttempts - 1) : 0;
      settle({ total_tokens: actual + retryPenalty });
    } else {
      // 拿不到 usage（断流/异常）：保守按全额预留结算
      settle(null);
    }
    return result;
  } catch (error) {
    settle(null);
    throw error;
  }
}

/**
 * Reserve and settle each actual HTTP attempt separately. A stream replay and
 * its inner HTTP retries share the same counter and the run-wide retry cap.
 * Unknown provider usage consumes the full reservation in the token budget,
 * while the cost ledger marks the visible estimate as billing-unknown.
 * @param {any} cfg
 * @param {any[]} messages
 * @param {any} tools
 * @param {() => Promise<any>} operation
 * @param {any} attemptsRef
 */
async function withAttemptBudget(cfg, messages, tools, operation, attemptsRef) {
  const ref = /** @type {any} */ (attemptsRef || { count: 0 });
  const input = estimateInputTokens(messages, tools);
  const output = Number(cfg && cfg.maxTokens) || 8192;
  const budget = cfg && cfg.requestBudget;
  /** @type {Set<Function>} */
  const pending = new Set();
  ref.beginAttempt = () => {
    if (Number.isFinite(Number(ref.maxAttempts)) && ref.count >= Number(ref.maxAttempts)) {
      throw Object.assign(new Error('本次模型调用已达到 HTTP 请求总次数上限（' + ref.maxAttempts + ' 次）'), {
        code: 'REQUEST_ATTEMPT_LIMIT', retryable: false,
      });
    }
    let settle = null;
    try {
      settle = budget ? budget.reserve(input + output) : null;
    } catch (error) {
      if (error && typeof error === 'object') error.retryable = false;
      throw error;
    }
    try {
      if (ref.count > 0 && budget && typeof budget.claimRetry === 'function') budget.claimRetry();
    } catch (error) {
      if (settle) settle({ total_tokens: 0 });
      if (error && typeof error === 'object') error.retryable = false;
      throw error;
    }
    const number = ++ref.count;
    let finished = false;
    /** @param {any} usage @param {{failed?: boolean, partialChars?: number}} [details] */
    const finish = (usage, details = {}) => {
      if (finished) return;
      finished = true;
      pending.delete(finish);
      const actual = usageTotal(usage);
      const known = Number.isFinite(actual) && actual >= 0;
      if (settle) settle(known ? { total_tokens: actual } : null);
      if ((details.failed || !usage) && cfg && cfg.costLedger && typeof cfg.costLedger.record === 'function') {
        const visibleOutput = Math.min(output, Math.ceil(Math.max(0, Number(details.partialChars) || 0) / 4));
        const estimate = known ? usage : {
          prompt_tokens: input,
          completion_tokens: visibleOutput,
          total_tokens: input + visibleOutput,
        };
        try {
          cfg.costLedger.record({
            kind: details.failed ? 'failed-attempt' : 'usage-unknown',
            model: cfg.model,
            usage: estimate,
            ok: details.failed !== true,
            estimated: !known,
            billingUnknown: !known,
            attempt: number,
            runId: cfg.costRunId,
            meta: {
              perAttempt: true,
              actor: cfg.costKind || 'main',
              partialChars: Math.max(0, Number(details.partialChars) || 0),
              reservedUpperBoundTokens: input + output,
            },
          });
        } catch {}
      }
    };
    pending.add(finish);
    return finish;
  };
  try {
    return await operation();
  } finally {
    for (const finish of [...pending]) finish(null, { failed: true });
    delete ref.beginAttempt;
  }
}

module.exports = { RequestBudget, createSubagentBudget, withBudget, withAttemptBudget, estimateInputTokens, collectImageUrls };
