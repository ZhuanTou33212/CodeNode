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
/**
 * 纯文本的 token 估算（**唯一口径**：与 `estimateTokens` 完全同一套字符折算，只是不加每条消息的 +8 开销）。
 * 抽出来是因为成本归因（P2-2）要按**段落**分别估 token，若各写一套折算规则，两处数字迟早对不上。
 * @param {string} text
 * @returns {number}
 */
function textTokensRaw(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
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
  return cjk * 0.7 + other / 4;
}

/** 取整后的纯文本估算（对外口径） */
function estimateTextTokens(text) {
  return Math.round(textTokensRaw(text));
}

function estimateTokens(messages, tools) {
  let tokens = 0;
  // 与 estimateTextTokens 共用同一套字符折算（这里累加**不取整**的浮点值，最后统一取整 —— 与原实现数值一致）
  const add = (text) => {
    tokens += textTokensRaw(text);
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
 * 「最近无损操作尾部」（P1-4）：从历史**末尾**整组整组地取回最近的操作，直到预算用完。
 *
 * 为什么需要：压缩后的新历史原本只有 `[system, 人说过的话, 一个摘要]` —— 摘要一写，「刚才那次
 * 精确的 edit_file 到底改了什么」就没了。尾部就是把这个空白补上：最近若干轮**逐字**保留。
 *
 * 铁的规矩（原子性）：
 *   - 一个操作组 = `assistant(tool_calls)` + 紧随其后、`tool_call_id` 对得上的 `tool` 结果；
 *     **绝不从中间切断**（半个 tool_calls 或没有调用方的 tool 结果，供应商会直接 400）。
 *   - 孤儿 `tool` 消息（找不到配对的 assistant 调用）一律不要 —— 与其交一个坏消息，不如少给一条。
 *   - 单个操作组本身就超过预算时，**仍然保留它**（原子性优先于预算），并在返回值里如实标出。
 *
 * @param {Array<any>} messages
 * @param {{tokenBudget?: number, allowOversized?: boolean}} [options]
 *   tokenBudget   —— 尾部预算（0 = 不保留尾部）
 *   allowOversized —— 单个操作组超预算时是否仍整组保留（默认 true：最新操作逐字优先，见下）
 * @returns {{messages: Array<any>, tokens: number, groups: number, droppedGroups: number, firstKeptIndex: number, oversized: boolean}}
 */
function buildLosslessTail(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Number(options.tokenBudget) > 0 ? Number(options.tokenBudget) : 0;
  // 默认 true：**最新操作逐字优先**（真实场景里一个操作组经常就超过 8k~15k 的尾部预算，
  // 默认丢弃等于让这个能力在真实数据上几乎不生效）。压不下来时由压缩环节用**严格预算**重算一次，
  // 见 agent.cjs 的 `buildHistory(..., 严格)` —— 那里才是「必须真的压下来」的兜底。
  const allowOversized = options.allowOversized !== false;
  /** 切分成原子组（保持顺序） */
  const groups = [];
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (!msg || msg.role === 'system') continue;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const ids = new Set(msg.tool_calls.map((call) => call && call.id).filter(Boolean));
      const group = [msg];
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') {
        const id = list[j].tool_call_id;
        if (id && ids.has(id)) group.push(list[j]);
        // 配对不上的 tool 消息不进组（孤儿），它会在下面被整条丢弃
        j += 1;
      }
      groups.push({ messages: group, tokens: estimateTokens(group, null) });
      i = j - 1;
      continue;
    }
    if (msg.role === 'tool') continue; // 孤儿 tool 消息：没有调用方，不能单独成组
    groups.push({ messages: [msg], tokens: estimateTokens([msg], null) });
  }
  // 预算为 0 = 明确要求「不保留尾部」（旧行为），不要退化成「全都留」
  if (!(budget > 0)) return { messages: [], tokens: 0, groups: 0, droppedGroups: groups.length, firstKeptIndex: list.length, oversized: false };
  const picked = [];
  let tokens = 0;
  let droppedGroups = 0;
  let oversized = false;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g];
    /**
     * ① 单组**本身就超预算**：这个分支必须排在「累加超预算」之前，否则最新那组一超预算就被
     * 默默算进「累加」分支，规则说不清。两种取法都有代价，所以**做成显式选择**：
     *   - 默认（`allowOversized !== false`）：**整组保留**（原子性 + 最新操作逐字优先），并标记 `oversized`；
     *     若这让压缩后仍在线下不了，调用方会用严格预算重算一次（见 agent.cjs），所以不会卡在线上；
     *   - `allowOversized=false`：**不要这一组**，尾部到此为止（尊重预算的严格口径）。
     * 两种情况下都**不切开**这一组（不存在半个 tool_calls / 孤儿 tool 结果）。
     */
    if (group.tokens > budget) {
      oversized = true;
      if (allowOversized) {
        picked.unshift(group);
        tokens += group.tokens;
        droppedGroups = g;
      } else {
        droppedGroups = g + 1;
      }
      break;
    }
    // ② 预算用完就整组停（绝不为凑预算把一组切开）
    if (picked.length && tokens + group.tokens > budget) {
      droppedGroups = g + 1;
      break;
    }
    picked.unshift(group);
    tokens += group.tokens;
    droppedGroups = g;
  }
  const out = [];
  for (const group of picked) out.push(...group.messages);
  return {
    messages: out,
    tokens,
    groups: picked.length,
    droppedGroups,
    firstKeptIndex: picked.length ? list.indexOf(picked[0].messages[0]) : list.length,
    oversized,
  };
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
 * @param {{tokens: number, contextWindow: number, ratio: number, compressible?: number,
 *          inputLimit?: number, outputReserve?: number, buffer?: number}} input
 *   compressible = 压缩时会被丢掉的消息条数（助手长文 / 工具结果 / 机器注入提示）；
 *   为 0 表示「压了也没东西可丢」（只剩 system + 人的轮次），跳过以免白花一次模型调用。
 *   P1-4：`inputLimit` / `outputReserve` / `buffer` 参与统一触发公式（都为 0 时行为与旧版逐字一致）。
 * @returns {{needed: boolean, limit: number, reason: string}}
 */
function shouldCompact({ tokens, contextWindow, ratio, compressible = 1, inputLimit = 0, outputReserve = 0, buffer = 0 }) {
  const window = Number(contextWindow) || 0;
  const r = Number(ratio);
  if (!(window > 0) || !(r > 0)) return { needed: false, limit: 0, reason: 'no-window' };
  /**
   * P1-4：把「输入上限 / 输出预留 / 安全 buffer」统一进同一个公式（审计建议）：
   *     estimated >= min(inputLimit − buffer, contextLimit − max(outputReserve, buffer))
   * 三个新输入任何一个没配（= 0）时，公式里的那一项就退化成「不约束」→ limit 仍是原来的 `window × ratio`
   * （默认行为逐字不变；只有窗口小 / 输出预留大时公式才会真的更早触发）。
   */
  const safeBuffer = Math.max(0, Number(buffer) || 0);
  const reserve = Math.max(0, Number(outputReserve) || 0, safeBuffer);
  const byInput = Number(inputLimit) > 0 ? Number(inputLimit) - safeBuffer : Infinity;
  const limit = Math.max(1, Math.floor(Math.min(window * r, byInput, window - reserve)));
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
 *          keepTailTokens?: number, allowOversizedTail?: boolean,
 *          keepUserMaxChars?: number, keepUserTotalChars?: number}} [input]
 * @returns {{messages: Array<any>, keptUserTurns: number, tailGroups: number, tailTokens: number,
 *            tailDroppedGroups: number, tailOversized: boolean}}
 */
function buildCompactedHistory(input = {}) {
  const {
    systemMessage,
    messages,
    summary,
    keepUserTurns = true,
    keepUserMaxChars = 2000,
    keepUserTotalChars = 20000,
    /** P1-4：无损操作尾部的 token 预算（0 = 不保留尾部，保持旧行为） */
    keepTailTokens = 0,
    /** P1-4：单个操作组超过尾部预算时是否仍然整组保留（默认 false = 尊重预算，见 buildLosslessTail） */
    allowOversizedTail = false,
  } = input;
  const list = Array.isArray(messages) ? messages : [];
  /** 先算无损尾部：它的起点决定「人话」要保留到哪 —— 尾部里已经有最新的人话，别再保留一遍 */
  const tail = keepTailTokens > 0
    ? buildLosslessTail(list, { tokenBudget: keepTailTokens, allowOversized: allowOversizedTail })
    : { messages: [], tokens: 0, groups: 0, droppedGroups: 0, firstKeptIndex: list.length, oversized: false };
  const headEnd = Number.isFinite(tail.firstKeptIndex) ? tail.firstKeptIndex : list.length;
  const kept = [];
  if (keepUserTurns) {
    const humans = list.slice(0, headEnd).filter(
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
  out.push({ role: 'user', content: buildSummaryEnvelope(/** @type {string} */ (summary)) });
  /**
   * P1-4：无损操作尾部接在摘要**之后** —— 它是历史里最新、也最该逐字保留的部分
   * （摘要负责「很早以前」，尾部负责「刚刚」）。顺序与审计给的结构一致：
   *   [system] → [人说过的话] → [新摘要/检查点] → [最近无损操作组]
   */
  out.push(...tail.messages);
  return {
    messages: out,
    keptUserTurns: kept.length,
    tailGroups: tail.groups,
    tailTokens: tail.tokens,
    tailDroppedGroups: tail.droppedGroups,
    tailOversized: tail.oversized,
  };
}

module.exports = {
  buildLosslessTail,
  COMPACTION_PROMPT,
  MACHINE_USER_PREFIXES,
  isMachineInjectedUserMessage,
  estimateTokens,
  estimateTextTokens,
  buildSummaryEnvelope,
  shouldCompact,
  countCompressible,
  buildSummarizationMessages,
  buildCompactedHistory,
};
