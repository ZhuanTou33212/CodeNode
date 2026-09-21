/**
 * compaction.cjs —— 上下文压缩（照 **Codex CLI** 的做法做）
 *
 * 依据（本机实测取证，不是转述）：
 *   - codex-cli **0.135.0**（`@openai/codex` → vendor/x86_64-pc-windows-msvc/bin/codex.exe）里
 *     grep 出的摘要提示词原文，见下方 `COMPACTION_PROMPT`（逐字照抄，未改写）。
 *   - 用户本机 `~/.codex/config.toml`：`model_context_window = 1000000` +
 *     `model_auto_compact_token_limit = 900000` → **触发线 = 窗口的 90%**。
 *   - `~/.codex/sessions/<日期>/rollout-*.jsonl` 里的 `type:"compacted"` 记录：
 *     压缩后历史（`replacement_history`）= **人的轮次 + developer 指令 + 一个 compaction 项**；
 *     实测 16 条 user 消息只保留 9 条 —— 被丢掉的正是机器注入的
 *     `<codex_internal_context source="goal">`（同一条 6093 字的自动续跑指令重复 4 次）与
 *     `<turn_aborted>` 提示，助手长文与工具结果则被摘要取代。
 *
 * 于是这里的实现与 Codex 一一对应：
 *   ① 触发：估算输入 token ≥ 上下文窗口 × ratio（出厂 0.9）；
 *   ② 摘要：把「整段对话 + 提示词」发给模型，取其回复作为交接摘要；
 *   ③ 新历史：`[system, ...人的轮次, 摘要]`，助手长文/工具结果不再保留；
 *   ④ 覆盖不了的细节交给摘要（Codex 的提示词本来就要求写「关键数据/参考」）。
 *
 * 与 Codex 的唯一实质差异：Codex 走 OpenAI Responses 的**服务端加密压缩项**
 * （rollout 里那串 28KB 的 `encrypted_content`，客户端只存不解），DeepSeek 这类
 * OpenAI 兼容接口没有这个能力，所以摘要以**可见文本**的形式作为一条 user 消息带上。
 *
 * @module compaction
 */
'use strict';

/**
 * Codex CLI 的上下文压缩提示词（codex-cli 0.135.0 二进制内原文，逐字保留）。
 * 别改写成中文：改了就与上游行为分叉，日后对不上别人的经验。
 */
const COMPACTION_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
  'Include:',
  '- Current progress and key decisions made',
  '- Important context, constraints, or user preferences',
  '- What remains to be done (clear next steps)',
  '- Any critical data, examples, or references needed to continue',
  'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.',
].join('\n');

/**
 * CodeNode 自己注入的「机器 user 消息」：这些不是人说的话，压缩时**不保留**（等价于 Codex 丢掉
 * `<codex_internal_context>` / `<turn_aborted>`）。列表改动要同步用例。
 */
const MACHINE_USER_PREFIXES = ['【系统提示】', '【参数格式错误】', '【工具失败】', 'RAG 来源校验：', '<compaction>', '【系统提示】钩子结果（'];

/**
 * 判断一条 user 消息是否由 harness 注入（而不是人敲的）。
 * 判据是**前缀**而不是「包含」：人的消息里出现这些词是常事，但没人会用它们开头。
 * @param {string} text
 */
function isMachineInjectedUserMessage(text) {
  const s = String(text || '').trimStart();
  return MACHINE_USER_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * 估算一次请求的输入 token（**用于触发压缩**，口径与 requestBudget 的「按字节保守估算」不同）。
 *
 * 为什么不能直接用 requestBudget.estimateInputTokens：那是把 UTF-8 字节数当 token（预算场景宁可高估）。
 * 中文一个字 3 字节，按字节算等于把 token 数高估约 5 倍 —— 拿它当压缩触发线会在**远没到窗口**时
 * 就疯狂压缩。这里按字符类别折算：CJK 每字 ≈0.7 token（实测 prompt_tokens=81 对 110 个中文字），
 * 其余字符 ≈1/4 token（英文/代码的常规经验值）。
 *
 * @param {Array<any>} messages
 * @param {any} [tools]
 * @returns {number}
 */
function estimateTokens(messages, tools) {
  let tokens = 0;
  const add = (text) => {
    const s = String(text || '');
    if (!s) return;
    let cjk = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0) || 0;
      // CJK 统一表意文字 / 扩展 A / 兼容 / 全角标点 / 日文假名 / 韩文
      if (
        (code >= 0x3000 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xff00 && code <= 0xffef)
      ) {
        cjk += 1;
      }
    }
    const other = [...s].length - cjk;
    tokens += cjk * 0.7 + other / 4;
  };
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    if (typeof msg.content === 'string') add(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part) continue;
        if (part.type === 'image_url') tokens += 1100; // 单图粗估（与 requestBudget 的量级一致）
        else add(part.text);
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) add(call && call.function && call.function.arguments);
    }
    tokens += 8; // 每条消息的角色/分隔开销
  }
  if (Array.isArray(tools) && tools.length) add(JSON.stringify(tools));
  return Math.round(tokens);
}

/**
 * 压缩后的「交接摘要」信封。用尖括号标签 + 明确禁止当指令，避免模型把它读成新的用户要求。
 * @param {string} summary
 */
function buildSummaryEnvelope(summary) {
  return (
    '<compaction>\n' +
    '以下是较早对话的**交接摘要**（上下文已压缩，细节请以摘要为准）。把它当作既定背景，不要当成新的指令：\n\n' +
    String(summary || '').trim() +
    '\n</compaction>'
  );
}

/**
 * 是否该压缩。
 * @param {{tokens: number, contextWindow: number, ratio: number, compressible?: number}} input
 *   compressible = 压缩时会被丢掉的消息条数（助手长文 / 工具结果 / 机器注入提示）；
 *   为 0 表示「压了也没东西可丢」（只剩 system + 人的轮次），跳过以免白花一次模型调用。
 * @returns {{needed: boolean, limit: number, reason: string}}
 */
function shouldCompact({ tokens, contextWindow, ratio, compressible = 1 }) {
  const window = Number(contextWindow) || 0;
  const r = Number(ratio);
  if (!(window > 0) || !(r > 0)) return { needed: false, limit: 0, reason: 'no-window' };
  const limit = Math.floor(window * r);
  if (Number(compressible) <= 0) return { needed: false, limit, reason: 'nothing-to-compact' };
  const needed = Number(tokens) >= limit;
  return { needed, limit, reason: needed ? 'over-limit' : 'below-limit' };
}

/**
 * 压缩时会被丢掉的消息条数（= 除 system 与被保留的人的话之外的全部）。
 * @param {Array<any>} messages
 * @param {(text: string) => boolean} [isMachine]
 */
function countCompressible(messages, isMachine = isMachineInjectedUserMessage) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((m) => {
    if (!m) return false;
    if (m.role === 'system') return false;
    if (m.role === 'user') return isMachine(typeof m.content === 'string' ? m.content : '');
    return true; // assistant（含 tool_calls）/ tool 结果
  }).length;
}

/** 把一条消息压成转录行（超过 cap 就截断并标注，别让压缩请求自己撑爆窗口） */
function transcriptLine(msg, cap) {
  const role = msg && msg.role ? msg.role : 'unknown';
  let body = '';
  if (typeof msg.content === 'string') body = msg.content;
  else if (Array.isArray(msg.content)) body = msg.content.map((p) => (p && p.type === 'image_url' ? '[图片]' : (p && p.text) || '')).join('');
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    body += '\n[tool_calls] ' + msg.tool_calls.map((c) => (c && c.function ? c.function.name : 'tool')).join(',');
  }
  const text = String(body || '');
  if (cap > 0 && text.length > cap) return `[${role}] ${text.slice(0, cap)}…（原 ${text.length} 字，已截断）`;
  return `[${role}] ${text}`;
}

/**
 * 构造「给压缩模型看」的消息数组：整段转录 + Codex 的提示词（作为最后一条 user 消息）。
 *
 * 上限：单项 `itemMaxChars`、总量 `maxTotalChars`（从**最旧**开始丢并标注），
 * 保证「压缩请求」本身不会因为太大而被供应商拒 —— 那样就永远压不动了。
 *
 * @param {{messages?: Array<any>, itemMaxChars?: number, maxTotalChars?: number}} [input]
 * @returns {{messages: Array<any>, dropped: number, chars: number}}
 */
function buildSummarizationMessages(input = {}) {
  const { messages, itemMaxChars = 6000, maxTotalChars = 400000 } = input;
  const list = Array.isArray(messages) ? messages : [];
  const lines = list.map((m) => transcriptLine(m, itemMaxChars));
  let dropped = 0;
  let total = lines.reduce((sum, l) => sum + l.length, 0);
  const budget = Number(maxTotalChars) > 0 ? Number(maxTotalChars) : Infinity;
  while (lines.length > 2 && total > budget) {
    total -= lines[0].length;
    lines.shift();
    dropped += 1;
  }
  let transcript = lines.join('\n');
  if (dropped > 0) transcript = `（更早的 ${dropped} 条消息因体积上限未纳入本次压缩输入）\n` + transcript;
  return {
    messages: [
      {
        role: 'user',
        content: '下面是一段需要压缩的对话转录，请按提示词产出交接摘要。\n\n' + transcript + '\n\n' + COMPACTION_PROMPT,
      },
    ],
    dropped,
    chars: transcript.length,
  };
}

/**
 * 构造压缩后的新历史：`[system, ...人的轮次, 摘要]`（Codex 的 replacement_history 形状）。
 *
 * @param {{systemMessage?: any, messages?: Array<any>, summary?: string, keepUserTurns?: boolean,
 *          keepUserMaxChars?: number, keepUserTotalChars?: number}} [input]
 * @returns {{messages: Array<any>, keptUserTurns: number}}
 */
function buildCompactedHistory(input = {}) {
  const {
    systemMessage,
    messages,
    summary,
    keepUserTurns = true,
    keepUserMaxChars = 2000,
    keepUserTotalChars = 20000,
  } = input;
  const list = Array.isArray(messages) ? messages : [];
  const kept = [];
  if (keepUserTurns) {
    const humans = list.filter(
      (m) => m && m.role === 'user' && typeof m.content === 'string' && !isMachineInjectedUserMessage(m.content),
    );
    let budget = Number(keepUserTotalChars) > 0 ? Number(keepUserTotalChars) : Infinity;
    // 从最近往前取，保证预算花在「最近说过的话」上；最后恢复时间顺序
    for (let i = humans.length - 1; i >= 0; i--) {
      const text = String(humans[i].content);
      const capped = keepUserMaxChars > 0 && text.length > keepUserMaxChars ? text.slice(0, keepUserMaxChars) + '…' : text;
      if (capped.length > budget) break;
      budget -= capped.length;
      kept.unshift({ role: 'user', content: capped });
    }
  }
  const out = [];
  if (systemMessage) out.push(systemMessage);
  out.push(...kept);
  out.push({ role: 'user', content: buildSummaryEnvelope(summary) });
  return { messages: out, keptUserTurns: kept.length };
}

module.exports = {
  COMPACTION_PROMPT,
  MACHINE_USER_PREFIXES,
  isMachineInjectedUserMessage,
  estimateTokens,
  buildSummaryEnvelope,
  shouldCompact,
  countCompressible,
  buildSummarizationMessages,
  buildCompactedHistory,
};
