/**
 * grounding-gate-test.cjs —— 来源校验门 warn|enforce（S10）
 *
 * 缺口（审查 §3 P1 / §6 S10）：`validateRagGrounding` 的结果只作为独立 delta 上报
 * （界面一个徽标），**不构成交付门槛** —— 回答里有本轮根本没读到过的引用（路径未见、
 * 行号越界），照样原样交付给用户。
 *
 * 修法：`agent.grounding.mode = warn`（默认，行为与之前逐字一致）| `enforce`
 * （引用不可信不允许直接交付：先让模型订正 max_retries 次，仍不达标则如实上报
 * `groundingBlocked`，且**不把校验提示拼进交付正文**）。
 *
 * 判据：
 *   A. 配置解析默认与闸门（非法值回落 warn）
 *   B. warn（默认）下：伪造引用照旧交付，只是多一条 grounding delta（行为不变）
 *   C. enforce 下：伪造引用被拦 → 模型收到订正提示并重写 → 重写合格后正常交付
 *   D. enforce 且订正后仍不合格：`groundingBlocked=true` + 独立事件，交付内容不被污染
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const eventBus = require('../electron/eventBus.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-grounding-'));

/**
 * 跑一次真实工具循环。
 * retrieve_context 用**测试替身**覆盖（离线环境没有嵌入服务）：返回一份固定的文件型来源，
 * 这样「检索到了可用来源」这个前提成立，来源校验才会真的生效。
 */
async function run(options) {
  const projectRoot = options.projectRoot;
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'alpha\nbeta\n', 'utf8');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot, userDataDir: projectRoot });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot,
    ragEnabled: true,
    toolsAllowed: ['retrieve_context', 'read_file'],
  });
  registry.register(
    'retrieve_context',
    '假检索（测试替身）：固定返回一份文件型来源 a.txt#L1-L2',
    { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async () => AgentToolResult.ok('命中 1 处来源（a.txt#L1-L2）', { sources: [{ citation: 'a.txt#L1-L2', score: 0.9, excerpt: 'alpha\nbeta',
      sourceSha256: 'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(projectRoot, 'a.txt'))).digest('hex') }] }),
  );
  const context = new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  const cfg = {
    apiBase: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    model: 'scripted',
    maxTokens: 512,
    costRunId: options.runId,
    tools: {},
    limits: {},
    compression: { enabled: false },
    reliability: { maxAttempts: 1, retryBaseMs: 10, retryMaxMs: 20 },
    grounding: options.grounding,
  };
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: options.question || '总结一下' }];
  for (const content of options.userNotes || []) messages.push({ role: 'user', content });
  const deltas = [];
  const stub = installScriptedModel(options.script, { loopLast: false });
  if (options.changeDuringJudge) {
    const scriptedFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (String(body.messages?.[0]?.content || '').includes('source-grounded fact checker')) {
        const file = path.join(projectRoot, 'a.txt'), stat = fs.statSync(file);
        fs.writeFileSync(file, 'gamma\nbeta\n'); fs.utimesSync(file, stat.atime, stat.mtime);
      }
      return scriptedFetch(url, init);
    };
  }
  let out;
  try {
    out = await agent.runAgentChat({ cfg, messages, tools: { registry, context }, onDelta: (d) => deltas.push(d) });
  } finally {
    stub.restore();
  }
  return { out, messages, modelCalls: stub.calls, deltas, projectRoot };
}

const RETRIEVE = { toolCalls: [{ name: 'retrieve_context', args: { query: 'alpha' } }] };
const FORGED = { content: '结论：alpha 是首行 [fake.txt#L9-L9]。' };
const HONEST = { content: '结论：alpha 是首行 [a.txt#L1-L2]。' };

(async () => {
  // ======================= A. 配置 =======================
  {
    const d = agent.parseGroundingConfig({});
    check('A1 默认 mode=warn（不改变既有行为）', d.mode === 'warn' && d.maxRetries === 1, JSON.stringify(d));
    check('A2 非法值回落 warn（不因为拼错配置就把门打开）',
      agent.parseGroundingConfig({ 'agent.grounding.mode': 'ENFORCE!' }).mode === 'warn');
    check('A3 enforce 可配置且重试次数被钳制',
      agent.parseGroundingConfig({ 'agent.grounding.mode': 'enforce', 'agent.grounding.max_retries': '9' }).maxRetries === 3);
    check('A4 semantic_mode 默认关闭且只接受 warn/enforce', agent.parseGroundingConfig({}).semanticMode === 'off' && agent.parseGroundingConfig({ 'agent.grounding.semantic_mode': 'enforce' }).semanticMode === 'enforce');
  }

  // ======================= B. warn（默认）：只上报，不拦 =======================
  {
    const { out, modelCalls, deltas } = await run({
      projectRoot: path.join(root, 'warn'),
      runId: 'run-grounding-warn',
      grounding: { mode: 'warn', maxRetries: 1 },
      script: [RETRIEVE, FORGED],
    });
    check('B1 warn 下不插入订正轮（模型只被调用 2 次）', modelCalls === 2, String(modelCalls));
    check('B2 warn 下伪造引用照旧交付（status=invalid 但不拦截）',
      /fake\.txt#L9-L9/.test(out.content) && out.grounding.status === 'invalid' && !out.groundingBlocked,
      JSON.stringify({ status: out.grounding.status, blocked: out.groundingBlocked }));
    check('B3 warn 下仍上报 grounding 事件（原有行为保留）',
      deltas.some((d) => d.kind === 'grounding'), JSON.stringify(deltas.filter((d) => d.kind === 'grounding').map((d) => d.grounding.status)));
  }

  // ======================= C. enforce：拦下 → 订正 → 合格交付 =======================
  {
    const { out, modelCalls, messages, projectRoot } = await run({
      projectRoot: path.join(root, 'enforce-fix'),
      runId: 'run-grounding-fix',
      userNotes: [agent.buildProgressNote({ iteration: 4, maxIterations: 12, toolCallsUsed: 3, toolCallBudget: 30 })],
      grounding: { mode: 'enforce', maxRetries: 1 },
      script: [RETRIEVE, FORGED, HONEST],
    });
    check('C1 enforce 下插入了一轮订正（模型被调用 3 次）', modelCalls === 3, String(modelCalls));
    check('C1b retry retains the actual user task rather than replacing it with the judge report',
      messages.some((m) => m.role === 'user' && String(m.content).includes('【任务回顾】') && String(m.content).includes('总结一下')));
    check('C2 订正提示确实进了上下文（且只说给模型听）',
      messages.some((m) => m.role === 'user' && /没有来源|编造引用/.test(String(m.content))),
      JSON.stringify(messages.filter((m) => m.role === 'user').map((m) => String(m.content).slice(0, 40))));
    check('C3 重写合格后正常交付（status=valid，未被拦）',
      out.grounding.status === 'valid' && !out.groundingBlocked && /a\.txt#L1-L2/.test(out.content),
      JSON.stringify({ status: out.grounding.status, blocked: out.groundingBlocked, content: String(out.content).slice(0, 60) }));
    check('C4 事件流里留下 grounding_retry（可按 run 回放这次拦截）',
      eventBus.readEvents(projectRoot).some((e) => e.kind === 'grounding_retry' && e.runId === 'run-grounding-fix'),
      JSON.stringify(eventBus.readEvents(projectRoot).map((e) => e.kind)));
    check('C5 校验提示没有被拼进交付内容',
      !/【系统提示】/.test(String(out.content)), String(out.content).slice(0, 80));
  }

  // ======================= D. enforce 且订正后仍不合格 =======================
  {
    const { out, deltas, projectRoot } = await run({
      projectRoot: path.join(root, 'enforce-block'),
      runId: 'run-grounding-block',
      grounding: { mode: 'enforce', maxRetries: 1 },
      script: [RETRIEVE, FORGED, FORGED],
    });
    check('D1 订正用尽仍不合格 → groundingBlocked=true（如实上报，不静默放过）',
      out.groundingBlocked === true && out.grounding.status === 'invalid',
      JSON.stringify({ blocked: out.groundingBlocked, status: out.grounding.status }));
    check('D1b failed draft is quarantined from public content and the stream', out.rejectedContent === FORGED.content &&
      !out.content.includes('fake.txt') && !deltas.some((delta) => delta.kind === 'content' && String(delta.text).includes('fake.txt')));
    check('D2 独立的 grounding_blocked 事件', deltas.some((d) => d.kind === 'grounding_blocked'), JSON.stringify(deltas.map((d) => d.kind)));
    check('D3 状态机终态仍是 COMPLETED（拦截不等于执行失败）', out.state === 'COMPLETED', String(out.state));
    check('D4 turn_end 事件里带上 grounding（可按 run 复查这次交付是否达标）',
      eventBus.readEvents(projectRoot).some((e) => e.kind === 'turn_end' && e.grounding && e.grounding.status === 'invalid'),
      JSON.stringify(eventBus.readEvents(projectRoot).map((e) => e.kind)));
  }

  // ======================= E. max_retries=0：不订正，直接如实标记 =======================
  {
    const { out, modelCalls } = await run({
      projectRoot: path.join(root, 'enforce-zero'),
      runId: 'run-grounding-zero',
      grounding: { mode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, FORGED],
    });
    check('E1 max_retries=0 时不插订正轮，直接标记 blocked', modelCalls === 2 && out.groundingBlocked === true, JSON.stringify({ calls: modelCalls, blocked: out.groundingBlocked }));
  }

  {
    const { out, modelCalls } = await run({
      projectRoot: path.join(root, 'semantic-enforce'), runId: 'semantic-enforce',
      grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, HONEST, { content: JSON.stringify({ claims: [{ id: 1, verdict: 'insufficient', evidence: [], reason: 'Not supported' }] }) },
        { content: JSON.stringify({ claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Scope-only candidate' }] }) },
        { content: JSON.stringify({ disposition: 'unnecessary_abstention', sourceSufficiency: 'sufficient', hasProjectAssertion: false, addressesQuestion: true, reason: 'Alpha and beta can be summarized' }) }],
    });
    check('F1 semantic enforce blocks failed claims and refuses an unnecessary fallback', modelCalls === 5 && out.groundingBlocked === true && out.grounding.semantic.status === 'judged');
  }
  {
    const { out, modelCalls } = await run({
      projectRoot: path.join(root, 'semantic-supported'), runId: 'semantic-supported',
      grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, HONEST, { content: JSON.stringify({ claims: [{ id: 1, verdict: 'entailed', evidence: [{ citation: 'a.txt#L1-L2', quote: 'alpha' }], reason: 'Direct evidence' }] }) }],
    });
    check('F2 supported claims pass without duplicate judge requests', modelCalls === 3 && !out.groundingBlocked && out.grounding.semantic.supported === true);
  }
  {
    const { out } = await run({
      projectRoot: path.join(root, 'changed-during-judge'), runId: 'changed-during-judge', changeDuringJudge: true,
      grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, HONEST, { content: JSON.stringify({ claims: [{ id: 1, verdict: 'entailed', evidence: [{ citation: 'a.txt#L1-L2', quote: 'alpha' }] }] }) }],
    });
    check('G1 same-stat external edit during judge is caught before final delivery', out.groundingBlocked === true && out.grounding.versionCheck?.status === 'stale');
  }
  {
    const { out, modelCalls, deltas } = await run({
      projectRoot: path.join(root, 'deep-read-final'), runId: 'deep-read-final',
      grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [{ ...RETRIEVE, content: 'I will inspect the source.' },
        { content: 'Let me read the exact lines.', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
        HONEST, { content: JSON.stringify({ claims: [{ id: 1, verdict: 'entailed', evidence: [{ citation: 'a.txt#L1-L2', quote: 'alpha' }] }] }) }],
    });
    check('H1 retrieve then actual read_file delivers only checked final answer',
      modelCalls === 4 && out.content === HONEST.content && !out.groundingBlocked &&
      out.toolCalls.some((call) => call.name === 'read_file' && call.ok));
    check('H2 stream clears tool narration without deleting tool audit',
      deltas.filter((delta) => delta.kind === 'content_reset' && delta.reason === 'tool_round_settled').length === 2 && out.toolCalls.length === 2);
  }
  {
    const { out } = await run({
      projectRoot: path.join(root, 'deep-read-wrong'), runId: 'deep-read-wrong',
      grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [{ ...RETRIEVE, content: 'I will inspect the source.' },
        { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
        { content: 'gamma is the first line [a.txt#L1-L2].' },
        { content: JSON.stringify({ claims: [{ id: 1, verdict: 'contradicted', evidence: [], reason: 'First line is alpha' }] }) }],
    });
    check('H3 deep reading does not waive fact verification for incorrect final answer', out.groundingBlocked === true);
  }
  {
    const limited = '已检查的证据不足以说明自动下载模型的流程。';
    const { out, modelCalls, deltas } = await run({ projectRoot: path.join(root, 'bounded-abstention'), runId: 'bounded-abstention',
      question: '首次启动如何自动下载模型？', grounding: { mode: 'enforce', semanticMode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, { content: limited },
        { content: JSON.stringify({ claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Evidence scope only' }] }) },
        { content: JSON.stringify({ disposition: 'evidence_limited_abstention', sourceSufficiency: 'insufficient', hasProjectAssertion: false, addressesQuestion: true, reason: 'Sources do not show the requested procedure' }) }],
    });
    check('I1 bounded refusal passes without pretending facts were verified', modelCalls === 4 && out.content === limited &&
      !out.groundingBlocked && out.grounding.semantic.status === 'abstained' && out.grounding.semantic.supported === false);
    check('I2 strict mode publishes only the final accepted text', deltas.filter((delta) => delta.kind === 'content').length === 1);
  }
  {
    const invented = '项目已经实现了自动下载模型的流程。';
    const { out, modelCalls, deltas } = await run({ projectRoot: path.join(root, 'scoped-fallback'), runId: 'scoped-fallback',
      question: '首次启动如何自动下载模型？', grounding: { mode: 'warn', semanticMode: 'enforce', maxRetries: 0 },
      script: [RETRIEVE, { content: invented },
        { content: JSON.stringify({ claims: [{ id: 1, verdict: 'insufficient', evidence: [], reason: 'No procedure evidence' }] }) },
        { content: JSON.stringify({ claims: [{ id: 1, verdict: 'non_factual', evidence: [], reason: 'Scope-only candidate' }] }) },
        { content: JSON.stringify({ disposition: 'evidence_limited_abstention', sourceSufficiency: 'insufficient', hasProjectAssertion: false, addressesQuestion: true, reason: 'Requested procedure unavailable' }) }],
    });
    check('J1 verified scoped fallback replaces invented facts even with citation mode warn', modelCalls === 5 &&
      !out.groundingBlocked && out.grounding.semantic.status === 'abstained' && out.rejectedContent === invented && !out.content.includes('已经实现'));
    check('J2 invented original is never streamed in semantic enforce mode', !deltas.some((delta) => delta.kind === 'content' && String(delta.text).includes('已经实现')));
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log('GROUNDING GATE TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('GROUNDING GATE TEST: ERROR', e);
  process.exit(1);
});
