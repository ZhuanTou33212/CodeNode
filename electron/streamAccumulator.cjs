/**
 * streamAccumulator.cjs —— SSE 增量累加器（把「分片 → 完整 tool_calls」的解析从 agent 主循环里独立出来）
 *
 * 为什么单独成模块：原来这段逻辑内联在 `agent.cjs: chatCompletionStreamInternal` 里，用
 * `acc.name += …` / `acc.args += …` 直接拼字符串，既无法单测，也无法表达下面这些真实存在的分片形态：
 *
 *   1. 供应商重复下发整段 name（`"read_file"` 连发两次）→ 拼成 `read_fileread_file`（未知工具）；
 *   2. 供应商**累积**下发 name/arguments（第二次发的是「到目前为止的全部内容」而不是增量）
 *      → 直接拼接得到非法 JSON；
 *   3. 重复下发同一段 arguments（重试/补发的分片）→ JSON 重复；
 *   4. `index` 缺失或漂移（OpenAI 用 index 区分同轮多个调用；有些实现只在首个分片给 index，
 *      有的同一 index 复用给下一个调用）；
 *   5. id 分片下发 / 重复下发；
 *   6. `finish_reason` 从不被读取 → `length`（被 max_tokens 截断）的工具调用会被当成正常调用**照常执行**，
 *      参数是半截 JSON，解析成 `{}` 后仍然执行（写操作最危险）；
 *   7. 同一分片里有多个调用、多个调用的分片交错到达。
 *
 * 设计：纯函数 + 显式状态对象，不碰网络、不碰全局、不抛异常（坏数据记为 anomaly）。
 *   const state = createAccumulator();
 *   applySseText(state, chunkText) → 事件数组（content / reasoning / tool / usage / finish_reason / stream_done）
 *   finalize(state) → { content, reasoning, toolCalls, usage, finishReason, anomalies }
 * 每个 toolCall 形如 { id, name, args, index, argsValid }：argsValid=false 表示参数不是完整 JSON
 * （调用方应据此**拒绝执行**，而不是拿 `{}` 去执行）。
 */
'use strict';

/** 参数是否已是完整 JSON（空串视为「无参数」，合法） */
function isJsonComplete(text) {
  const raw = String(text == null ? '' : text);
  if (raw.trim() === '') return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function createAccumulator() {
  return {
    content: '',
    reasoning: '',
    usage: null,
    usageChunks: 0,
    finishReason: null,
    finishReasonCount: 0,
    done: false,
    buffer: '',
    lineCount: 0,
    /** 已见过的调用槽：按首次出现顺序；key 为 index（复用 index 时用 index#n） */
    slots: [],
    byKey: new Map(),
    lastIndex: null,
    anomalies: [],
  };
}

function noteAnomaly(state, type, detail) {
  state.anomalies.push({ type, detail: detail == null ? '' : String(detail).slice(0, 200) });
}

function slotView(slot) {
  return { id: slot.id, name: slot.name, args: slot.args, index: slot.index, argsValid: isJsonComplete(slot.args) };
}

function toolSnapshot(state) {
  return state.slots.map(slotView);
}

/** name 分片合并：兼容「增量」「累积重发」「整段重复」三种形态 */
function mergeName(state, slot, incoming) {
  const text = String(incoming || '');
  if (!text) return;
  if (!slot.name) {
    slot.name = text;
    return;
  }
  if (text === slot.name) {
    noteAnomaly(state, 'duplicate-name-chunk', text);
    return;
  }
  if (text.startsWith(slot.name)) {
    noteAnomaly(state, 'cumulative-name-chunk', text);
    slot.name = text;
    return;
  }
  if (slot.name.endsWith(text)) {
    noteAnomaly(state, 'duplicate-name-fragment', text);
    return;
  }
  slot.name += text;
}

/** arguments 分片合并：兼容「增量」「累积重发」「整段重复」三种形态 */
function mergeArgs(state, slot, incoming) {
  const text = String(incoming || '');
  if (!text) return;
  if (!slot.args) {
    slot.args = text;
    return;
  }
  if (text === slot.args) {
    noteAnomaly(state, 'duplicate-args-chunk', text.length);
    return;
  }
  if (text.startsWith(slot.args)) {
    noteAnomaly(state, 'cumulative-args-chunk', text.length);
    slot.args = text;
    return;
  }
  // 当前是残缺 JSON、而本分片自身完整 → 供应商在「补完」这段参数（累积语义），直接取更完整的那份
  if (isJsonComplete(text) && !isJsonComplete(slot.args)) {
    noteAnomaly(state, 'cumulative-args-chunk', text.length);
    slot.args = text;
    return;
  }
  // 关键判据：拼接后不是合法 JSON，而本分片自身是合法 JSON → 供应商在重发「完整参数」，
  // 用它替换而不是拼接（否则会得到 `{"a":1}{"a":1}` 这种永不闭合的坏 JSON）。
  if (!isJsonComplete(slot.args + text) && isJsonComplete(text)) {
    noteAnomaly(state, 'args-resend-detected', text.length);
    slot.args = text;
    return;
  }
  slot.args += text;
}

function mergeId(state, slot, incoming) {
  const text = String(incoming == null ? '' : incoming);
  if (!text) return;
  if (!slot.id) {
    slot.id = text;
    return;
  }
  if (text === slot.id) {
    noteAnomaly(state, 'duplicate-id-chunk', text);
    return;
  }
  if (text.startsWith(slot.id)) {
    slot.id = text; // 累积下发
    return;
  }
  if (slot.id.startsWith(text)) {
    noteAnomaly(state, 'duplicate-id-fragment', text);
    return;
  }
  noteAnomaly(state, 'id-conflict', slot.id + ' -> ' + text);
}

/** 取（或新建）分片要写入的调用槽；处理 index 缺失、index 漂移与 index 复用 */
function resolveSlot(state, rawIndex, rawId) {
  const hasIndex = rawIndex != null && Number.isFinite(Number(rawIndex));
  const index = hasIndex ? Number(rawIndex) : (state.lastIndex == null ? 0 : state.lastIndex);
  if (!hasIndex && state.lastIndex != null) noteAnomaly(state, 'missing-index-chunk', index);
  state.lastIndex = index;

  const key = String(index);
  let slot = state.byKey.get(key);
  const incomingId = String(rawId == null ? '' : rawId);
  if (slot && incomingId && slot.id && incomingId !== slot.id && !incomingId.startsWith(slot.id) && !slot.id.startsWith(incomingId)) {
    // 同一 index 被复用于另一个调用：不能再往老槽里写（否则两个调用的 id/name/args 会串在一起）
    noteAnomaly(state, 'index-reuse', index + ' ' + slot.id + ' -> ' + incomingId);
    const reuseKey = key + '#' + state.slots.length;
    slot = { key: reuseKey, index, id: '', name: '', args: '' };
    state.slots.push(slot);
    state.byKey.set(key, slot);
    state.byKey.set(reuseKey, slot);
    return slot;
  }
  if (!slot) {
    slot = { key, index, id: '', name: '', args: '' };
    state.slots.push(slot);
    state.byKey.set(key, slot);
  }
  return slot;
}

/** 处理一行 SSE（`data: {...}` / `data: [DONE]`）；返回事件（可为 null） */
function consumeLine(state, line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return null;
  if (!text.startsWith('data:')) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') {
    state.done = true;
    return { kind: 'stream_done' };
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    noteAnomaly(state, 'unparsable-data-line', payload);
    return null;
  }
  if (parsed && parsed.error) {
    // 流里内联的错误对象（部分供应商在 200 流里报错）：交给调用方决定重试
    noteAnomaly(state, 'in-stream-error', JSON.stringify(parsed.error).slice(0, 160));
  }
  const events = [];
  if (parsed && parsed.usage) {
    state.usage = parsed.usage;
    state.usageChunks += 1;
    events.push({ kind: 'usage', usage: parsed.usage });
  }
  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  if (!choice) return events.length ? events : null;

  const finish = choice.finish_reason != null ? choice.finish_reason : (choice.delta && choice.delta.finish_reason);
  if (finish != null) {
    if (state.finishReason != null && state.finishReason !== finish) {
      noteAnomaly(state, 'finish-reason-changed', state.finishReason + ' -> ' + finish);
    }
    state.finishReason = finish;
    state.finishReasonCount += 1;
    events.push({ kind: 'finish_reason', finishReason: finish });
  }

  const delta = choice.delta;
  if (!delta) return events.length ? events : null;
  if (delta.reasoning_content) {
    state.reasoning += delta.reasoning_content;
    events.push({ kind: 'reasoning', text: delta.reasoning_content });
  }
  if (delta.content) {
    state.content += delta.content;
    events.push({ kind: 'content', text: delta.content });
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
    for (const tc of delta.tool_calls) {
      if (!tc) continue;
      const slot = resolveSlot(state, tc.index, tc.id);
      mergeId(state, slot, tc.id);
      const fn = tc.function;
      if (fn) {
        mergeName(state, slot, fn.name);
        mergeArgs(state, slot, fn.arguments);
      }
    }
    events.push({ kind: 'tool', toolCalls: toolSnapshot(state) });
  }
  return events.length ? events : null;
}

/**
 * 喂入一段网络分片文本，返回事件数组（有序）。未以换行结尾的残行留在 state.buffer 里，
 * 由后续分片或收尾时的 `applySseText(state, '\n')` 补齐 —— 供应商省略末尾换行时不能丢最后一帧。
 */
function applySseText(state, text) {
  state.buffer += String(text == null ? '' : text);
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() || '';
  const events = [];
  for (const line of lines) {
    state.lineCount += 1;
    const produced = consumeLine(state, line);
    if (!produced) continue;
    if (Array.isArray(produced)) events.push(...produced);
    else events.push(produced);
  }
  return events;
}

/** 收尾：把残行补处理掉，返回完整结果 */
function finalize(state) {
  if (state.buffer.trim()) {
    const leftover = state.buffer;
    state.buffer = '';
    state.lineCount += 1;
    // 事件不再回传（调用方在读网络分片时已把事件转成 onEvent）；consumeLine 会就地更新状态，
    // 因此残行里的最后一帧工具调用不会丢。
    consumeLine(state, leftover);
  }
  return {
    content: state.content,
    reasoning: state.reasoning,
    toolCalls: toolSnapshot(state),
    usage: state.usage,
    finishReason: state.finishReason,
    anomalies: state.anomalies.slice(),
    done: state.done,
  };
}

module.exports = {
  createAccumulator,
  applySseText,
  consumeLine,
  finalize,
  isJsonComplete,
  toolSnapshot,
};
