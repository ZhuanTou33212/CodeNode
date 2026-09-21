/**
 * 流式增量的纯逻辑（#21 后半条）。
 *
 * 后端会发 `truncated`（`electron/agent.cjs:2116,2461`）与 `stopped`（`:1898,2165,2246,2530`），
 * 而修复前 `sessionStore.streamDelta` 里**没有任何分支**接这两个 kind —— 它们被静默丢掉，
 * 于是「正在续写 / 已停止」在流式过程中不可见，用户点停止后几秒内像没生效。
 * 更糟的是：下次后端再加一个 kind，前端会**再次静默漂移**（同样的 bug 复发而无人发现）。
 *
 * 所以这里把「增量 → 气泡状态」的判断收成一个纯函数：
 *   - 认识全部 kind（含 truncated / stopped）；
 *   - **未知 kind 走兜底并 `console.warn`**，让漂移当场可见，而不是等用户发现界面不对。
 * 返回值里的 `recognized === false` 就是兜底信号（调用方据此打日志）。
 */

export interface StreamDeltaLike {
  kind?: string;
  text?: string;
  toolCalls?: unknown;
  /** kind==='stopped'：主进程给的停止原因 */
  reason?: string;
  /** kind==='truncated'：本轮输出撞到 max_tokens 的补充说明 */
  error?: string;
}

export interface AssistantBubbleLike {
  role?: string;
  content?: string;
  reasoning?: string;
  status?: string;
  tools?: { id?: string; name?: string; args?: unknown }[];
}

/** 由 streamDelta 自己处理（不走气泡）的 kind：压缩 / 超窗 / 合并 / 预算 / 已保存 */
export const CONTROL_DELTA_KINDS = [
  'compacted',
  'context_overflow',
  'subagent_merge',
  'max_tokens_capped',
  'saved',
  // 计划卡（update_plan）：计划是 run 级状态，写进 store 的独立字段，不改气泡
  'plan',
] as const;

/** 会直接改写最后一条 assistant 气泡的 kind */
export const BUBBLE_DELTA_KINDS = [
  'content',
  'reasoning',
  'content_reset',
  'tool',
  'tool_result',
  'truncated',
  'stopped',
] as const;

export interface StreamDeltaOutcome {
  /** 是否落在已知分支上；false = 未知 kind（已兜底，调用方应 console.warn） */
  recognized: boolean;
  /** 是否要写回 messages */
  changed: boolean;
  /** 文字类增量（content / reasoning）追加的文本 */
  appendText: string;
  /** 是否要把最后一条 assistant 的正文清空（流中途断线整轮重发） */
  resetContent: boolean;
  /** 新的气泡状态（truncated / stopped / failed / done）；undefined = 不改 */
  status?: 'truncated' | 'stopped' | 'failed' | 'done';
  /** 新追加的工具调用（tool / tool_result 的 payload 原样透传） */
  toolCalls?: unknown;
  /** 工具结果回填（与 tool 增量区分：结果里有 ok/data） */
  toolResult?: unknown;
}

/** 与后端 `runAgentStopReason` / stopDetail 对齐：主进程的停止原因也要在气泡上可见 */
export function statusForStopReason(reason: string | null | undefined): 'truncated' | 'stopped' | 'failed' | 'done' {
  const r = String(reason || '').toLowerCase();
  if (r.includes('length') || r.includes('truncat') || r.includes('max_token')) return 'truncated';
  if (r.includes('fail') || r.includes('error') || r.includes('overflow')) return 'failed';
  if (!r) return 'stopped';
  if (r.includes('abort') || r.includes('cancel') || r.includes('stop') || r.includes('interrupt') || r.includes('user')) {
    return 'stopped';
  }
  return 'stopped';
}

export function applyStreamDelta(
  last: AssistantBubbleLike | null | undefined,
  delta: StreamDeltaLike | null | undefined
): StreamDeltaOutcome {
  const base: StreamDeltaOutcome = { recognized: true, changed: false, appendText: '', resetContent: false };
  if (!delta || !delta.kind) return { ...base, recognized: false };
  if (last && last.role !== 'assistant') return base;

  switch (delta.kind) {
    case 'content':
      if (!delta.text) return base;
      return { ...base, changed: true, appendText: delta.text };
    case 'reasoning':
      if (!delta.text) return base;
      return { ...base, changed: true, appendText: delta.text };
    case 'content_reset':
      return { ...base, changed: true, resetContent: true };
    case 'tool':
      return { ...base, changed: true, toolCalls: delta.toolCalls };
    case 'tool_result':
      return { ...base, changed: true, toolResult: delta.toolCalls };
    // 撞 max_tokens 后主进程的补充说明：气泡上直接标「已截断」，不再让用户以为写完了。
    case 'truncated':
      return { ...base, changed: true, status: 'truncated' };
    // 用户点停止：气泡立刻变「已停止」，不再等 finally（那个窗口里界面看起来像没反应）。
    case 'stopped':
      return { ...base, changed: true, status: statusForStopReason(delta.reason) };
    default:
      return { ...base, recognized: false };
  }
}

/**
 * 未知 kind 的兜底：显式警告 + 返回可断言的标记。
 * 这不是「防御性编程」，而是让「后端新增 kind、前端静默丢弃」这一类漂移**当场可见**。
 */
export function warnUnknownDelta(kind: string | undefined): { warned: boolean; message: string } {
  const message =
    '未处理的 Agent 流式增量 kind=' + String(kind) +
    '（前端 streamDelta 没有对应分支，内容可能被静默丢弃；请补分支）';
  // eslint-disable-next-line no-console
  console.warn('[codenode] ' + message);
  return { warned: true, message };
}
