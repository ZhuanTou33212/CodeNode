/**
 * scripted-model.cjs —— 离线确定性「脚本化模型」
 *
 * 用途：在无网络、无 API Key 的情况下驱动真实的 runAgentChat 工具循环
 * （agent.cjs 通过全局 fetch 调用 OpenAI 兼容接口，这里替换 global.fetch 返回受控 SSE 流）。
 *
 * 脚本格式：数组，每一项是「一轮」模型输出：
 *   { content?: '文本', toolCalls?: [{ name, args }] , usage?: {...} }
 * 超出脚本长度后按循环策略重复（loopLast=true 时重复最后一项），用于制造「模型停不下来」的场景。
 */
'use strict';

function sseChunk(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

function buildStream(turn) {
  const chunks = [];
  if (turn.reasoning) {
    chunks.push(sseChunk({ choices: [{ index: 0, delta: { reasoning_content: turn.reasoning } }] }));
  }
  if (turn.content) {
    chunks.push(sseChunk({ choices: [{ index: 0, delta: { content: turn.content } }] }));
  }
  if (Array.isArray(turn.toolCalls) && turn.toolCalls.length) {
    turn.toolCalls.forEach((call, index) => {
      const toolCall = {
        index,
        type: 'function',
        function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {}) },
      };
      // id 语义：不传 → 默认 'call_<index>'（真实供应商的常态）；传 '' → 原样发空 id；
      // 传 omitId:true → 整个 id 字段都不出现。后两种用来复现「供应商不给 id」的兼容性缺陷。
      if (call.omitId !== true) toolCall.id = call.id === undefined ? 'call_' + index : call.id;
      chunks.push(
        sseChunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [toolCall],
              },
            },
          ],
        })
      );
    });
  }
  chunks.push(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason || 'stop' }], usage: turn.usage || { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }));
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

/**
 * 安装脚本化模型。
 * @returns {{ calls: number, seen: Array<any>, restore: Function, state: any }}
 */
function installScriptedModel(script, options = {}) {
  const originalFetch = global.fetch;
  const state = { calls: 0, seen: [], script, loopLast: options.loopLast !== false };
  // @ts-expect-error 评测用脚本化 fetch 只实现被测代码用到的字段，不是完整 Response
  global.fetch = async (url, init) => {
    state.calls += 1;
    let body = {};
    try {
      body = JSON.parse(String((init && init.body) || '{}'));
    } catch {}
    // 记录请求体的关键字段：用例除了 messages 还要断言 max_tokens（超窗收缩）、tools 等
    state.seen.push({
      url: String(url),
      messages: body.messages || [],
      maxTokens: body.max_tokens,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      model: body.model,
    });
    const index = state.calls - 1;
    const turn = script[index] || (state.loopLast ? script[script.length - 1] : { content: '（脚本已用尽）' });
    if (typeof options.onTurn === 'function') options.onTurn(turn, state.calls, body);
    // 失败响应（httpStatus）：用于验证「供应商 400/超窗」这类路径 —— 之前的 stub 只会成功，
    // 任何错误分支都没法离线复现（要么真连网，要么测不到）。
    if (turn && Number(turn.httpStatus) >= 400) {
      const errBody =
        typeof turn.body === 'string' ? turn.body : JSON.stringify(turn.body || { error: { message: 'scripted error', type: 'invalid_request_error' } });
      return {
        ok: false,
        status: Number(turn.httpStatus),
        headers: { get: () => null },
        text: async () => errBody,
        json: async () => JSON.parse(errBody),
        body: null,
      };
    }
    const stream = buildStream(turn || { content: '' });
    const encoder = new TextEncoder();
    // 非流式消费（chatCompletion：压缩/摘要这类内部调用）走 json()：必须给一个**合法**的
    // OpenAI 兼容响应体。此前它只是 `JSON.parse(stream)`（拿 SSE 文本当 JSON 解析）——
    // 任何人用 chatCompletion 都会被这个 stub 骗成「JSON 解析失败」，把生产代码的失败归因搞错。
    const messageBody = {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: turn && turn.content !== undefined ? turn.content : '',
            ...(Array.isArray(turn && turn.toolCalls) && turn.toolCalls.length
              ? {
                  tool_calls: turn.toolCalls.map((call, i) => ({
                    id: call.id === undefined ? 'call_' + i : call.id,
                    type: 'function',
                    function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {}) },
                  })),
                }
              : {}),
            ...(turn && turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
          },
          finish_reason: (turn && turn.finishReason) || 'stop',
        },
      ],
      usage: (turn && turn.usage) || { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => stream,
      json: async () => messageBody,
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: encoder.encode(stream) };
            },
          };
        },
      },
    };
  };
  return {
    get calls() {
      return state.calls;
    },
    get seen() {
      return state.seen;
    },
    state,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

module.exports = { installScriptedModel, buildStream, sseChunk };
