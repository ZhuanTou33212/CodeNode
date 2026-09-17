/**
 * truncation-safety-test.cjs —— 被截断的输出（finish_reason=length）必须安全处理（真实工具循环）
 *
 * 审查发现（P1-2）：主循环从不读 `finish_reason`，因此
 *   ① 被 max_tokens 截断的工具调用（args 是半截 JSON）会**照常执行**——`parseToolArgs` 把它解析成 `{}`，
 *      于是一个写操作（workbench_edit / write_file / edit_file）会在「没有参数」的情况下真的执行；
 *   ② 被截断的回答会被当成完整最终答案交付，用户拿到半句话却没有任何标注。
 *
 * 现在的行为：① 参数不是完整 JSON → **拒绝执行**并把错误回灌给模型（code=ARG_INVALID_JSON）；
 * ② 回答被截断且无工具调用 → 补问（最多 2 次，且把已输出的部分作为 assistant 消息带回去），
 *    次数用尽后如实标注 `stopReason='length_truncated'`。
 *
 * 判据落在真实终态：spy 工具的执行计数（② 由真实请求体断言），不看中间变量。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trunc-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

/** 注册一个「一旦被执行就会被计数」的工具：参数不完整时它必须 0 次执行 */
let spyRuns = 0;
function makeRegistry() {
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['read_file', 'write_file'],
  });
  // 注意：schema 里**故意不写 required** —— 这样「参数被截断 → parseToolArgs 得到 {} → schema 校验通过」
  // 就真的会把工具执行起来（如果只靠 registry 的 required 校验兜底，这条用例就被 schema 挡住了，
  // 测不出「截断参数必须拒绝执行」这个性质本身）。
  registry.register(
    'must_not_run',
    '测试替身：参数不完整时绝不能被调用',
    { type: 'object', properties: { path: { type: 'string' } } },
    async () => {
      spyRuns += 1;
      return AgentToolResult.ok('被调用了');
    }
  );
  return registry;
}

function cfg() {
  return {
    apiBase: 'http://scripted.local/v1',
    apiKey: 'scripted',
    model: 'scripted-model',
    maxTokens: 2048,
    reasoningEffort: '',
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
    limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
    compression: { enabled: false },
    rag: { enabled: false },
    tools: {},
  };
}

async function runTurn(script) {
  return runTurnWithCfg({}, script);
}

/**
 * 同 runTurn，但可覆盖 reliability（用于锁定 agent.truncation_nudges 这类新配置项），
 * 并收集 `truncated` 增量 —— 「界面有没有被通知到」也是判据的一部分。
 */
async function runTurnWithCfg(reliabilityOverride, script) {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const turnCfg = cfg();
  turnCfg.reliability = { ...turnCfg.reliability, ...reliabilityOverride };
  const truncatedDeltas = [];
  const stub = installScriptedModel(script, { loopLast: false });
  try {
    const result = await agent.runAgentChat({
      cfg: turnCfg,
      messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '请完成测试任务' }],
      tools: { registry: makeRegistry(), context },
      signal: controller.signal,
      onDelta: (d) => {
        if (d && d.kind === 'truncated') truncatedDeltas.push(d);
      },
    });
    return { result, seen: stub.seen, calls: stub.calls, truncatedDeltas };
  } finally {
    stub.restore();
  }
}

(async () => {
  // ---- (1) 被截断的工具参数必须被拒绝执行 ----
  spyRuns = 0;
  const truncatedArgs = '{"path":"a.tx'; // 半截 JSON（模拟 max_tokens 截断）
  const first = await runTurn([
    { toolCalls: [{ name: 'must_not_run', args: truncatedArgs, id: 'call_trunc' }], finishReason: 'length' },
    { content: '改用更短的参数重试。', finishReason: 'stop' },
  ]);
  check('[截断参数] 工具一次都没有被执行（不会被 {} 空参调用）', spyRuns === 0, 'spyRuns=' + spyRuns);
  const reported = (first.result.toolCalls || []).find((t) => t.name === 'must_not_run');
  check('[截断参数] 工具调用记录为失败且带 ARG_INVALID_JSON',
    !!reported && reported.ok === false && reported.data && reported.data.code === 'ARG_INVALID_JSON',
    JSON.stringify(reported && { ok: reported.ok, code: reported.data && reported.data.code }));
  check('[截断参数] 结果里带上 finish_reason=length（便于归因是截断而非模型写错）',
    !!reported && reported.data.finishReason === 'length', JSON.stringify(reported && reported.data));

  const second = first.seen[1];
  check('[截断参数] 模型被追问了第二轮（错误回灌而不是静默丢弃）', !!second, 'seen=' + first.seen.length);
  const toolMessage = second ? second.messages.find((m) => m.role === 'tool') : null;
  check('[截断参数] 回灌文本说明「未执行」并要求重写参数',
    !!toolMessage && /未执行/.test(String(toolMessage.content)) && /JSON/.test(String(toolMessage.content)),
    toolMessage ? String(toolMessage.content).slice(0, 90) : '(无 tool 消息)');
  const assistantMessage = second ? second.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) : null;
  check('[截断参数] tool_call_id 仍与 assistant 声明的 id 配对（截断路径不破坏协议一致性）',
    !!assistantMessage && !!toolMessage && assistantMessage.tool_calls[0].id === toolMessage.tool_call_id,
    JSON.stringify({ declared: assistantMessage && assistantMessage.tool_calls[0].id, responded: toolMessage && toolMessage.tool_call_id }));

  // ---- (2) 合法参数照常执行（别把正常调用一起关掉） ----
  spyRuns = 0;
  const okTurn = await runTurn([
    { toolCalls: [{ name: 'must_not_run', args: { path: 'a.txt' }, id: 'call_ok' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ]);
  check('[合法参数] 正常执行成功（未过度修复）',
    spyRuns === 1 && (okTurn.result.toolCalls || []).every((t) => t.ok === true),
    JSON.stringify({ spyRuns, toolCalls: (okTurn.result.toolCalls || []).map((t) => t.ok) }));

  // ---- (3) 被截断的回答：补问「接着写」，补问上限可配，且最终如实标注 ----
  const longText = '很长的回答……'.repeat(50);
  // 出厂 agent.truncation_nudges=4：连截 4 次各补问一次，第 5 轮才自然收尾
  const truncating = await runTurn([
    { content: longText, finishReason: 'length' },
    { content: longText, finishReason: 'length' },
    { content: longText, finishReason: 'length' },
    { content: longText, finishReason: 'length' },
    { content: '（收尾）', finishReason: 'stop' },
  ]);
  check('[截断回答] 补问 4 次（共 5 轮请求：1 次原始 + 4 次补问）', truncating.calls === 5, 'calls=' + truncating.calls);
  const nudgeMessages = truncating.seen.slice(1).filter((req) => req.messages.some((m) => m.role === 'user' && /截断/.test(String(m.content))));
  check('[截断回答] 补问消息里说明「被长度上限截断」', nudgeMessages.length === 4, 'nudgeReqs=' + nudgeMessages.length);
  const nudgeText = String(
    (truncating.seen[1].messages.find((m) => m.role === 'user' && /截断/.test(String(m.content))) || {}).content || '',
  );
  check('[截断回答] 补问要求「从断点接着写」（不能被要求拆短 = 主动丢信息）',
    /接着写/.test(nudgeText) && !/拆短/.test(nudgeText), nudgeText.slice(0, 60));
  const carried = truncating.seen[1] && truncating.seen[1].messages.some((m) => m.role === 'assistant' && String(m.content).includes('很长的回答'));
  check('[截断回答] 已输出的部分作为 assistant 消息带回（不重复生成同一段）', !!carried);
  const joined = String(truncating.result.content || '');
  check('[截断回答] 每段都交付出去（接着写 = 拼接，不丢信息）',
    joined.split(longText).length - 1 === 4 && joined.includes('（收尾）'),
    JSON.stringify({ segments: joined.split(longText).length - 1, len: joined.length, stopReason: truncating.result.stopReason }));
  check('[截断回答] 自然收尾时不带 length_truncated 标记',
    truncating.result.stopReason === undefined, String(truncating.result.stopReason));

  // ---- (3b) 补问次数用尽仍然截断 → 如实标注（次数由 agent.truncation_nudges 控制） ----
  const exhausted = await runTurnWithCfg({ truncationNudges: 1 }, [
    { content: longText, finishReason: 'length' },
    { content: longText, finishReason: 'length' },
  ]);
  check('[补问用尽] 只补问 1 次（配置生效，不是写死 2/4）', exhausted.calls === 2, 'calls=' + exhausted.calls);
  check('[补问用尽] 如实标注 stopReason=length_truncated',
    exhausted.result.stopReason === 'length_truncated', String(exhausted.result.stopReason));
  check('[补问用尽] 用尽时通知界面「不再继续写」', exhausted.truncatedDeltas.some((d) => d.continuing === false),
    JSON.stringify(exhausted.truncatedDeltas));

  // ---- (4) 正常结束不应被误标 ----
  const normal = await runTurn([{ content: '一切正常。', finishReason: 'stop' }]);
  check('[正常结束] 不带 length_truncated 标记且 finishReason=stop',
    normal.result.stopReason === undefined && normal.result.finishReason === 'stop',
    JSON.stringify({ stopReason: normal.result.stopReason, finishReason: normal.result.finishReason }));

  // ---- (5) 出厂配置口径：这些值决定「回答会不会被砍半」，必须锁住 ----
  const rel = agent.parseReliabilityConfig({});
  check('[出厂口径] 单轮总时长 600s（不再是写死的 180s）', rel.turnTimeoutMs === 600000, String(rel.turnTimeoutMs));
  check('[出厂口径] 停滞超时 120s（有数据就重置）', rel.streamIdleTimeoutMs === 120000, String(rel.streamIdleTimeoutMs));
  check('[出厂口径] 流中断重发 2 次（0 = 旧行为：半截 + 报错）', rel.streamMaxAttempts === 2, String(rel.streamMaxAttempts));
  check('[出厂口径] 截断补问 4 次', rel.truncationNudges === 4, String(rel.truncationNudges));
  const sample = fs.readFileSync(path.join(__dirname, '..', 'config', 'agent.properties.example'), 'utf8');
  const maxTokens = Number((/^max_tokens=(\d+)/m.exec(sample) || [])[1]);
  check('[出厂口径] 配置样例的 max_tokens 足够（≥16384，思考链与正文共用这笔额度）',
    Number.isFinite(maxTokens) && maxTokens >= 16384, String(maxTokens));

  console.log(failures === 0 ? 'TRUNCATION SAFETY TEST: PASS' : 'TRUNCATION SAFETY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('TRUNCATION SAFETY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
