/**
 * stream-accumulator-test.cjs —— SSE 分片累加器（纯函数单测）
 *
 * 这段逻辑原来内联在 agent.cjs 的流式循环里，用 `acc.name += …` / `acc.args += …` 拼字符串，
 * 既测不了也表达不了真实存在的分片形态。本用例覆盖 2026-09-15 审查列出的全部风险：
 * 重复 name/args 分片、累积分片、index 缺失/漂移/复用、id 分片、finish_reason、
 * 坏 JSON（截断）、多调用交错、末尾无换行。
 */
'use strict';

const {
  createAccumulator,
  applySseText,
  finalize,
  isCompositeJsonComplete,
  isJsonComplete,
} = require('../electron/streamAccumulator.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** 把一组 SSE 帧拼成文本（默认每帧 \n\n 结尾） */
function sse(frames) {
  return frames.map((f) => (typeof f === 'string' ? f : 'data: ' + JSON.stringify(f) + '\n\n')).join('');
}
function deltaFrame(toolCalls, extra) {
  return Object.assign({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] }, extra || {});
}
function callChunk(index, id, name, args) {
  const fn = {};
  if (name !== undefined) fn.name = name;
  if (args !== undefined) fn.arguments = args;
  const tc = { index };
  if (id !== undefined) tc.id = id;
  tc.function = fn;
  return tc;
}

function run(frames) {
  const state = createAccumulator();
  const events = applySseText(state, sse(frames));
  return { state, events, result: finalize(state) };
}

// ---- (1) 单帧完整调用 ----
{
  const { result, events } = run([
    deltaFrame([callChunk(0, 'call_a', 'read_file', '{"path":"a.txt"}')]),
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 42 } },
    'data: [DONE]\n\n',
  ]);
  check('单帧完整调用：解析出 1 个调用且参数合法',
    result.toolCalls.length === 1 && result.toolCalls[0].name === 'read_file' &&
    result.toolCalls[0].args === '{"path":"a.txt"}' && result.toolCalls[0].argsValid === true,
    JSON.stringify(result.toolCalls));
  check('单帧完整调用：id / finish_reason / usage / done 都被采集',
    result.toolCalls[0].id === 'call_a' && result.finishReason === 'tool_calls' &&
    result.usage.total_tokens === 42 && result.done === true,
    JSON.stringify({ id: result.toolCalls[0].id, finishReason: result.finishReason, usage: result.usage, done: result.done }));
  check('单帧完整调用：无异常', result.anomalies.length === 0, JSON.stringify(result.anomalies));
  check('事件顺序：tool 事件在 finish_reason 之前',
    events.findIndex((e) => e.kind === 'tool') < events.findIndex((e) => e.kind === 'finish_reason'),
    JSON.stringify(events.map((e) => e.kind)));
}

// ---- (2) 增量分片（name 与 args 跨帧） ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_b', 'search', '{"pat')]),
    deltaFrame([callChunk(0, undefined, '_files', 'tern":"TODO"}')]),
  ]);
  check('增分片：name 与 args 正确拼接', result.toolCalls[0].name === 'search_files' &&
    result.toolCalls[0].args === '{"pattern":"TODO"}' && result.toolCalls[0].argsValid === true,
    JSON.stringify(result.toolCalls));
}

// ---- (3) 重复下发整段 name（旧实现会拼成 read_fileread_file） ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_c', 'read_file', '{"path":"a.txt"}')]),
    deltaFrame([callChunk(0, 'call_c', 'read_file', '{"path":"a.txt"}')]),
  ]);
  check('重复 name 分片：不会拼成 read_fileread_file', result.toolCalls[0].name === 'read_file', result.toolCalls[0].name);
  check('重复 name 分片：记为 anomaly 供观测', result.anomalies.some((a) => a.type === 'duplicate-name-chunk'), JSON.stringify(result.anomalies));
}

// ---- (4) 累积下发 name / args（第二次发的是「到目前为止的全部内容」） ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_d', 'read_file', '{"path":"a.txt"}')]),
    deltaFrame([callChunk(0, 'call_d', 'read_file', '{"path":"a.txt","maxLines":5}')]),
  ]);
  check('累积 name + 累积 args：取更完整的那份，得到合法 JSON',
    result.toolCalls[0].name === 'read_file' && result.toolCalls[0].args === '{"path":"a.txt","maxLines":5}' &&
    result.toolCalls[0].argsValid === true, JSON.stringify(result.toolCalls));
  check('累积形态被记为 anomaly（cumulative-args-chunk 或 args-resend-detected）',
    result.anomalies.some((a) => a.type === 'cumulative-args-chunk' || a.type === 'args-resend-detected'),
    JSON.stringify(result.anomalies));
}

// ---- (4b) 前缀累积：第一帧是残缺 JSON，第二帧把它补完 ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_d2', 'write_file', '{"path":"a.txt","max')]),
    deltaFrame([callChunk(0, 'call_d2', undefined, '{"path":"a.txt","maxLines":5}')]),
  ]);
  check('前缀累积：残缺 → 完整的补完判定为 cumulative-args-chunk',
    result.toolCalls[0].args === '{"path":"a.txt","maxLines":5}' && result.toolCalls[0].argsValid === true &&
    result.anomalies.some((a) => a.type === 'cumulative-args-chunk'), JSON.stringify({ args: result.toolCalls[0].args, anomalies: result.anomalies }));
}

// ---- (5) 参数被重发（拼接后非法、单独合法）→ 替换而不是拼接 ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_e', 'write_file', '{"path":"a.txt","content":"X"}')]),
    deltaFrame([callChunk(0, 'call_e', undefined, '{"path":"a.txt","content":"X"}')]),
  ]);
  check('整段重发 args：替换而非拼接（不会变成 {".."}{".."}）',
    result.toolCalls[0].args === '{"path":"a.txt","content":"X"}' && result.toolCalls[0].argsValid === true,
    result.toolCalls[0].args);
}

// ---- (6) 同一帧两个调用 + 交错分片 ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_f0', 'read_file', '{"path":"a'), callChunk(1, 'call_f1', 'read_file', '{"path":"b')]),
    deltaFrame([callChunk(1, undefined, undefined, '.txt"}')]),
    deltaFrame([callChunk(0, undefined, undefined, '.txt"}')]),
  ]);
  check('多调用交错：两个槽各自独立、顺序稳定',
    result.toolCalls.length === 2 && result.toolCalls[0].args === '{"path":"a.txt"}' && result.toolCalls[1].args === '{"path":"b.txt"}' &&
    result.toolCalls[0].id === 'call_f0' && result.toolCalls[1].id === 'call_f1',
    JSON.stringify(result.toolCalls));
}

// ---- (7) index 缺失：续到上一个槽，而不是新开一个 0 号槽 ----
{
  const { result } = run([
    deltaFrame([callChunk(2, 'call_g', 'read', '{"path":"a')]),
    deltaFrame([{ id: undefined, function: { arguments: '.txt"}' } }]), // 完全没有 index
  ]);
  check('index 缺失：延续上一个调用（不新建槽）',
    result.toolCalls.length === 1 && result.toolCalls[0].args === '{"path":"a.txt"}' && result.toolCalls[0].index === 2,
    JSON.stringify(result.toolCalls));
  check('index 缺失：记为 anomaly（missing-index-chunk）', result.anomalies.some((a) => a.type === 'missing-index-chunk'), JSON.stringify(result.anomalies));
}

// ---- (8) index 被复用给另一个调用（id 变了）→ 必须分成两个槽，不能串数据 ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_h1', 'read_file', '{"path":"a.txt"}')]),
    deltaFrame([callChunk(0, 'call_h2', 'read_file', '{"path":"b.txt"}')]),
  ]);
  check('index 复用：拆成两个调用，id/参数不串', result.toolCalls.length === 2 &&
    result.toolCalls[0].id === 'call_h1' && result.toolCalls[0].args === '{"path":"a.txt"}' &&
    result.toolCalls[1].id === 'call_h2' && result.toolCalls[1].args === '{"path":"b.txt"}',
    JSON.stringify(result.toolCalls));
  check('index 复用：记为 anomaly（index-reuse）', result.anomalies.some((a) => a.type === 'index-reuse'), JSON.stringify(result.anomalies));
}

// ---- (9) id 分片下发 / 累积 ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_', 'read_file', '{"path":"a.txt"}')]),
    deltaFrame([callChunk(0, 'call_i-full', undefined, undefined)]),
  ]);
  check('id 累积下发：取更完整的那份', result.toolCalls[0].id === 'call_i-full', result.toolCalls[0].id);
}

// ---- (10) finish_reason：采集 + 异常变化记录 ----
{
  const { result } = run([
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ]);
  check('finish_reason：保留最后一个取值', result.finishReason === 'length', String(result.finishReason));
  check('finish_reason：中途变化记为 anomaly', result.anomalies.some((a) => a.type === 'finish-reason-changed'), JSON.stringify(result.anomalies));
}

// ---- (11) 被截断的参数 → argsValid=false（调用方据此拒绝执行） ----
{
  const { result } = run([
    deltaFrame([callChunk(0, 'call_j', 'write_file', '{"path":"a.txt","content":"很长的内容还没写完')]),
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ]);
  check('截断参数：argsValid=false 且 finishReason=length', result.toolCalls[0].argsValid === false && result.finishReason === 'length',
    JSON.stringify({ argsValid: result.toolCalls[0].argsValid, finishReason: result.finishReason }));
  check('isJsonComplete：空串视为「无参数」（合法）', isJsonComplete('') === true && isJsonComplete('{}') === true && isJsonComplete('{"a"') === false);
}

// ---- (12) 坏数据不抛异常：非 JSON 行 / 无 choices / 空 delta ----
{
  const { result } = run([
    'data: { this is not json\n\n',
    'data:\n\n',
    ': 注释行\n\n',
    { id: 'req-1', choices: [] },
    { choices: [{ index: 0, delta: {} }] },
    { choices: [{ index: 0, delta: { content: 'hi' } }] },
  ]);
  check('坏数据：解析失败记为 anomaly 但不抛异常', result.anomalies.some((a) => a.type === 'unparsable-data-line'), JSON.stringify(result.anomalies));
  check('坏数据：正常内容仍然收上去', result.content === 'hi', JSON.stringify(result.content));
}

// ---- (13) 末尾无换行：残行必须被收尾处理（否则丢掉最后一帧工具调用） ----
{
  const state = createAccumulator();
  applySseText(state, 'data: ' + JSON.stringify(deltaFrame([callChunk(0, 'call_k', 'read_file', '{"path":"a.txt"}')])));
  const before = finalize(state);
  check('末尾无换行：收尾时把残行吃掉，工具调用不丢', before.toolCalls.length === 1 && before.toolCalls[0].name === 'read_file',
    JSON.stringify(before.toolCalls));
}

// ---- (14) 流内联错误对象 ----
{
  const { result } = run([{ error: { message: 'rate limited', type: 'server_error' } }]);
  check('流内联 error：记为 anomaly（供调用方决定重试）', result.anomalies.some((a) => a.type === 'in-stream-error'), JSON.stringify(result.anomalies));
}

// ---- (15) 真实 DeepSeek 分片形态：裸标量分片不得替换累积参数（2026-09-16 实测故障的最小复现）----
// 真机会把 args 切得非常碎（每个小片段一帧），其中「数字」会单独成一帧：
//   {"path": "…", "maxLines":   ← 累积到这儿，下一帧只有 "40"
// 修复前：isJsonComplete('40') === true → 判定为「供应商重发的完整参数」→ args 被替换成 '40'，
// 再拼上 '}' 得到 '40}'，argsValid=false，工具调用被拒（MALFORMED ARGS）→ 反复重试直到迭代上限。
{
  const fragments = ['{', '"', 'path', '"', ': ', '"', 'a.txt', '"', ', ', '"', 'maxLines', '"', ': ', '40', '}'];
  const frames = fragments.map((frag, i) =>
    deltaFrame([callChunk(0, i === 0 ? 'call_num' : undefined, i === 0 ? 'read_file' : undefined, frag)])
  );
  const { result } = run(frames);
  const call = result.toolCalls[0];
  check('真实分片：数字片段单独到达时 args 仍拼成完整对象', call && call.args === '{"path": "a.txt", "maxLines": 40}', call && JSON.stringify(call.args));
  check('真实分片：argsValid=true（不会被当成残缺参数拒掉）', call && call.argsValid === true, call && String(call.argsValid));
  check('真实分片：不产生「累积替换」误判异常', !result.anomalies.some((a) => a.type === 'cumulative-args-chunk' || a.type === 'args-resend-detected'), JSON.stringify(result.anomalies));
}
// 其它裸标量分片（true / null / 字符串）同样不得替换累积参数。
{
  const cases = [
    { value: 'true', expected: '{"flag": true}' },
    { value: 'null', expected: '{"flag": null}' },
    { value: '"x"', expected: '{"flag": "x"}' },
  ];
  for (const c of cases) {
    const frames = ['{"flag": ', c.value, '}'].map((frag, i) => deltaFrame([callChunk(0, i === 0 ? 'c' + i : undefined, i === 0 ? 't' : undefined, frag)]));
    const { result } = run(frames);
    const call = result.toolCalls[0];
    check('标量分片 ' + c.value + '：不作替换、正常拼接', call && call.args === c.expected && call.argsValid === true, call && JSON.stringify(call.args));
  }
}
// (16) 反向保护：供应商真的重发「完整对象」时仍要替换（修复不得把既有语义改坏）。
{
  const frames = ['{"a": ', '{"a":1}'].map((frag, i) => deltaFrame([callChunk(0, i === 0 ? 'r1' : undefined, i === 0 ? 't' : undefined, frag)]));
  const { result } = run(frames);
  const call = result.toolCalls[0];
  check('完整对象重发：仍按替换处理（不拼成 {"a": {"a":1}）', call && call.args === '{"a":1}', call && JSON.stringify(call.args));
}
// (17) 判据本身：完整对象/数组 vs 裸标量。
{
  check('isCompositeJsonComplete：对象/数组为真、裸标量/残缺为假', isCompositeJsonComplete('{"a":1}') === true && isCompositeJsonComplete('[1,2]') === true && isCompositeJsonComplete('40') === false && isCompositeJsonComplete('true') === false && isCompositeJsonComplete('null') === false && isCompositeJsonComplete('"x"') === false && isCompositeJsonComplete('{"a":') === false && isCompositeJsonComplete('') === false);
  check('isJsonComplete 保持原语义（标量也算完整 JSON，空串合法）', isJsonComplete('40') === true && isJsonComplete('') === true && isJsonComplete('{"a":') === false);
}

console.log(failures === 0 ? 'STREAM ACCUMULATOR TEST: PASS' : 'STREAM ACCUMULATOR TEST: FAIL (' + failures + ')');
process.exitCode = failures === 0 ? 0 : 1;
