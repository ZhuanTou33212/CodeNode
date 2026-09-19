/**
 * agent-request-shape-test.cjs —— 请求体里两个「应该能关掉的字段」+ 交互输入不进缓存
 *
 * 修的是 harness 审计里复现过的两条短板（`agent-harness-evaluation` 的短板表 P3/P2）：
 *
 *  A. `reasoning_effort` **无法关闭**：此前 `cfg.reasoning_effort || 'medium'`，配置留空也回落
 *     medium，更没有任何开关能让这个字段从请求体里消失 —— 对「不接受该字段的 OpenAI 兼容网关」
 *     来说每次请求都是 400。`stream_options.include_usage` 同样无条件下发。
 *     现在的口径：键不存在 → 出厂默认 medium；显式留空 / none / off / false / no / - / null /
 *     disabled → **字段不下发**；`agent.send_stream_options=false` → 不下发 stream_options。
 *
 *  B. `ask_user` 曾在只读缓存白名单里 → 同一个 run 内同样的问题问第二次时**直接复用旧答案**
 *     （用户根本看不到第二次提问）。它是交互输入，不是幂等读，必须退出白名单；
 *     同时锁住「其他只读工具照旧缓存」这个负向判据（别把缓存机制改坏）。
 *
 * 判据都落在**真实发出的请求体**上（scripts/lib/scripted-model.cjs 记录的 state.seen.body），
 * 不是对内部变量的推断。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const descriptorLib = require('../electron/tools/descriptor.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-reqshape-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'CONTENT-1\n');

const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

let asked = 0;
/** 最近一次 run 的请求快照（stub 在 run 结束就被 restore，必须先存下来） */
let lastSeen = [];

async function runTurn(script, cfgOverrides = {}) {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    // 每次被问到都给一个**不同**的答案：用于证明第二次提问真的问了用户（而不是复用旧答案）
    askUser: async () => {
      asked += 1;
      return '用户第 ' + asked + ' 次回答';
    },
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const stub = installScriptedModel(script, { loopLast: false });
  try {
    const result = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'k',
        model: 'scripted-model',
        maxTokens: 1024,
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
        ...cfgOverrides,
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: {
        registry: toolkit.buildDefaultRegistryWithConfig({
          projectRoot: root,
          ragEnabled: false,
          toolsAllowed: ['read_file', 'ask_user', 'list_directory'],
        }),
        context,
      },
      signal: controller.signal,
      timeoutMs: 20000,
    });
    lastSeen = stub.seen || [];
    return result;
  } finally {
    stub.restore();
  }
}

(async () => {
  // ============================ A. 推理强度 / stream_options ============================
  console.log('== A. reasoning_effort / stream_options 必须能关掉 ==');
  check('[A] 键不存在 → 出厂默认 medium（既有行为不变）', agent.parseReasoningEffort(undefined) === 'medium');
  check(
    '[A] 显式留空 / none / off / false / no / - / null / disabled → 关闭（null）',
    ['', '  ', 'none', 'NONE', 'off', 'false', 'no', '-', 'null', 'disabled'].every((v) => agent.parseReasoningEffort(v) === null)
  );
  check('[A] 其他值原样下发（大小写不动）', agent.parseReasoningEffort('high') === 'high' && agent.parseReasoningEffort('MINIMAL') === 'MINIMAL');

  const baseCfg = { model: 'm', maxTokens: 10, reasoningEffort: 'medium', sendStreamOptions: true };
  const bodyOn = agent.chatBody(baseCfg, [], { stream: true });
  check('[A] 默认：请求体里有 reasoning_effort 与 stream_options', bodyOn.reasoning_effort === 'medium' && bodyOn.stream_options && bodyOn.stream_options.include_usage === true, JSON.stringify(bodyOn));
  const bodyOff = agent.chatBody({ ...baseCfg, reasoningEffort: null, sendStreamOptions: false }, [], { stream: true });
  check('[A] 关闭后：两个字段都**不出现**（不是空值，是不发）', !('reasoning_effort' in bodyOff) && !('stream_options' in bodyOff), JSON.stringify(bodyOff));
  const bodyNonStream = agent.chatBody(baseCfg, [], { stream: false });
  check('[A] 非流式本来就没有 stream_options（未改坏）', !('stream_options' in bodyNonStream));

  // 配置文件口径：项目级 .codenode/agent.properties 覆盖
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cfg-'));
  fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
  const writeCfg = (text) => fs.writeFileSync(path.join(projDir, '.codenode', 'agent.properties'), text);
  writeCfg('reasoning_effort=\n');
  check('[A] 配置文件里留空 → 关闭', agent.loadConfig(projDir).reasoningEffort === null);
  writeCfg('reasoning_effort=none\n');
  check('[A] 配置文件里写 none → 关闭', agent.loadConfig(projDir).reasoningEffort === null);
  writeCfg('reasoning_effort=high\n');
  check('[A] 配置文件里写 high → high', agent.loadConfig(projDir).reasoningEffort === 'high');
  writeCfg('agent.send_stream_options=false\n');
  check('[A] agent.send_stream_options=false → 关掉 stream_options', agent.loadConfig(projDir).sendStreamOptions === false);
  writeCfg('');
  check('[A] 空配置文件 → 出厂默认（medium + 下发 stream_options）', agent.loadConfig(projDir).reasoningEffort === 'medium' && agent.loadConfig(projDir).sendStreamOptions === true);

  // 端到端：真实请求体
  await runTurn([{ content: '完成' }], { reasoningEffort: 'high' });
  check('[A] 端到端：真实请求体带 reasoning_effort=high 与 stream_options', lastSeen[0] && lastSeen[0].reasoningEffort === 'high' && lastSeen[0].hasStreamOptions === true, JSON.stringify(lastSeen[0] && { e: lastSeen[0].reasoningEffort, s: lastSeen[0].hasStreamOptions }));
  await runTurn([{ content: '完成' }], { reasoningEffort: null, sendStreamOptions: false });
  check('[A] 端到端：关闭后真实请求体里两个字段都消失', lastSeen[0] && lastSeen[0].reasoningEffort === null && lastSeen[0].hasStreamOptions === false, JSON.stringify(lastSeen[0] && { e: lastSeen[0].reasoningEffort, s: lastSeen[0].hasStreamOptions }));

  // ============================ B. ask_user 不进缓存 ============================
  console.log('== B. ask_user 是交互输入，不进只读缓存 ==');
  check('[B] ask_user 不在缓存白名单里', !descriptorLib.CACHEABLE_TOOLS.has('ask_user'), [...descriptorLib.CACHEABLE_TOOLS].join(','));
  check('[B] 但它仍是只读工具（只读角色不受影响）', descriptorLib.READ_ONLY_TOOLS.has('ask_user'));

  asked = 0;
  const askTwice = await runTurn([
    { toolCalls: [{ id: 'a1', name: 'ask_user', args: { question: '要覆盖旧文件吗？' } }] },
    { toolCalls: [{ id: 'a2', name: 'ask_user', args: { question: '要覆盖旧文件吗？' } }] },
    { content: '完成' },
  ]);
  const asks = (askTwice.toolCalls || []).filter((c) => c.name === 'ask_user');
  check('[B] 同一个问题问两次 → 用户被问两次（没有复用旧答案）', asked === 2 && asks.length === 2, 'asked=' + asked);
  check(
    '[B] 第二次拿到的是**新的**回答，不是第一次的缓存',
    String(asks[0] && asks[0].result).includes('第 1 次') && String(asks[1] && asks[1].result).includes('第 2 次'),
    JSON.stringify(asks.map((a) => a.result))
  );
  check('[B] 两次都没有被标成缓存命中（repeated 不为 true）', asks.every((a) => a.repeated !== true));

  // 负向：别的只读工具照旧复用（缓存机制不能被误伤）
  const readTwice = await runTurn([
    { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'r2', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { content: '完成' },
  ]);
  const reads = (readTwice.toolCalls || []).filter((c) => c.name === 'read_file');
  check('[B] 负向：同参 read_file 第二次仍命中缓存（只读之间的复用没被改坏）', reads[1] && reads[1].repeated === true, JSON.stringify(reads[1] && reads[1].result));

  console.log(failures === 0 ? 'AGENT REQUEST SHAPE TEST: PASS' : 'AGENT REQUEST SHAPE TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('AGENT REQUEST SHAPE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
