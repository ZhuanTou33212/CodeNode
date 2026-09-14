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

class RequestBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    this.reserved = 0;
  }
  reserve(amount) {
    if (!Number.isFinite(amount) || amount < 0 || this.used + this.reserved + amount > this.limit) {
      const fmt = (n) => Math.round(n).toLocaleString('en-US');
      throw Object.assign(
        new Error(
          `请求前预算检查失败：额度不足（本次需要约 ${fmt(amount)} tokens，` +
            `已用 ${fmt(this.used)}、预留 ${fmt(this.reserved)}，上限 ${fmt(this.limit)}；` +
            `可在 config/agent.properties 调大 agent.max_total_tokens 后重启）`,
        ),
        { code: 'BUDGET_EXCEEDED', need: amount, used: this.used, reserved: this.reserved, limit: this.limit },
      );
    }
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
    const actual = usage && Number(usage.total_tokens);
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

module.exports = { RequestBudget, withBudget, estimateInputTokens, collectImageUrls };
