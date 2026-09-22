#!/usr/bin/env node
/**
 * cost-attribution-test.cjs —— P2-2（成本按层归因）的回归判据
 *
 * 要回答的问题（审计原话）：账本按 kind 分账已经很好，但缺**主请求内部构成** —— 没有这层归因，
 * 很容易出现「总 token 降了，但不知道是任务更短还是 harness 真变轻」的假优化。
 *
 * 判据分两层：
 *   A/B  纯函数层：层归属、守恒、fail-safe（未登记段落算动态）、第一个变化的区段、投影归一化；
 *   C    端到端：**真实 runAgentChat + 真账本**（脚本化模型），断言账本那笔主调用上真的挂着归因，
 *        且工具投影的 raw/model 是实测出来的（不是对内部变量的推断）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compaction = require('../electron/compaction.cjs');
const costAttribution = require('../electron/costAttribution.cjs');
const costLedger = require('../electron/costLedger.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const descriptorLib = require('../electron/tools/descriptor.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

const { CostLedger } = costLedger;

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-costattr-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });

// ============================ A. 层归属与守恒 ============================
console.log('== A. 层归属（system 段落 / 历史角色 / schema / 附件）==');
{
  const soul = { raw: '灵魂：演示项目。' };
  const guide = agent.buildToolGuide([{ name: 'read_file', description: '读取文件' }]);
  const system = agent.buildSystemPrompt(soul, '[{"id":"n1"}]', guide, '记忆：入口是 npm run verify', 'my-skill: 先 Y', {
    prompt: '画布上建一条链路',
    canvasMode: 'always',
    userMemoryText: '用户偏好：中文',
  });
  const sections = agent.splitPromptSections(system);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: '把 add 改成加法' },
    { role: 'assistant', content: '好的', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', name: 'read_file', tool_call_id: 'c1', content: '文件内容'.repeat(50) },
    { role: 'user', content: costAttribution.RAG_USER_PREFIX + '命中 3 条来源…' },
    { role: 'user', content: [{ type: 'text', text: '看看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ];
  const projection = new Map([
    ['search_files', { calls: 2, rawTokens: 3000, modelTokens: 1200 }],
    ['execute_shell', { calls: 1, rawTokens: 500, modelTokens: 500 }],
  ]);
  const attr = costAttribution.attribute({
    sections,
    messages,
    toolSchemaTokens: 4321,
    toolProjection: projection,
    cachedTokens: 100,
    missTokens: 900,
    cacheMiss: true,
  });

  check('[A] 层的加总 = total（守恒）',
    Object.values(attr.layers).reduce((a, b) => a + b, 0) === attr.total,
    JSON.stringify(attr.layers) + ' total=' + attr.total);
  check('[A] 稳定段（回复约束/运行规则/soul）落在 system_static',
    attr.layers.system_static > 0 && Object.entries(attr.bySection)
      .filter(([id]) => ['reply-rules', 'runtime-rules', 'soul'].includes(id))
      .every(([id, v]) => v.layer === 'system_static'),
    JSON.stringify(Object.entries(attr.bySection).map(([id, v]) => id + ':' + v.layer)));
  check('[A] 【可用工具】引导段与真实 schema 一起算 tool_schema，且两者分别报出（不藏钱）',
    attr.toolSchema.guideTokens > 0 && attr.toolSchema.schemaTokens === 4321 &&
    attr.layers.tool_schema === attr.toolSchema.guideTokens + 4321,
    JSON.stringify(attr.toolSchema));
  check('[A] 项目记忆 / 用户记忆都算 memory 层', attr.bySection.memory.layer === 'memory' && attr.bySection['user-memory'].layer === 'memory');
  check('[A] 画布即时状态单列 project_state（不是悄悄并进 system_static）',
    attr.bySection.canvas.layer === 'project_state' && attr.layers.project_state > 0);
  check('[A] 任务规则算 system_dynamic（按面变化的东西不进「稳定前缀」的账）',
    attr.bySection['task-rules'].layer === 'system_dynamic');
  check('[A] 历史按角色分账：user / assistant / tool 各自 > 0',
    attr.layers.history_user > 0 && attr.layers.history_assistant > 0 && attr.layers.tool_result > 0,
    JSON.stringify({ u: attr.layers.history_user, a: attr.layers.history_assistant, t: attr.layers.tool_result }));
  check('[A] 图片按张折算进 attachment（与 estimateTokens / requestBudget 同口径 1100）',
    attr.layers.attachment === costAttribution.IMAGE_TOKENS, String(attr.layers.attachment));
  check('[A] RAG 注入（机器 user 消息）单列 rag 层，不混进 history_user',
    attr.layers.rag > 0 && attr.layers.rag < attr.layers.history_user + attr.layers.rag);
  /**
   * 「不重复计」的正确比法：把 `messages` 里那条 system 交给 estimateTokens（它会按一条消息算 +8 开销），
   * 与「按段落算出来的 stable + dynamic」比 —— 量级一致（差别只在每条消息的 +8 与逐段取整）。**不含**
   * 上面注入的 schemaTokens（那份不在 system 文本里）。
   */
  const systemOnly = compaction.estimateTokens([{ role: 'system', content: system }], null);
  const bySectionTotal = attr.layers.system_static + attr.layers.system_dynamic + attr.toolSchema.guideTokens;
  /**
   * 容差取 ±5%：差别只来自「按段取整（每段 <1 token）+ 段间分隔符 + 每条消息 +8 开销」这类零头。
   * 这条判据防的是**把 system 重复计一遍**（那会差近 2 倍），不是去卡零头。
   */
  check('[A] system 按段落计一次就够（与「当成一条 system 消息」的估算同量级，±5%）',
    bySectionTotal <= systemOnly * 1.05 && bySectionTotal >= systemOnly * 0.95,
    'bySection=' + bySectionTotal + ' estimateTokens=' + systemOnly);
  check('[A] 守恒：层的加总 = total（与上面那条同一份数据再核一次）',
    attr.total === Object.values(attr.layers).reduce((a, b) => a + b, 0));
  check('[A] 缓存字段是 usage 的镜像（不自己算）', attr.cache.miss === true && attr.cache.cachedTokens === 100 && attr.cache.missTokens === 900);
  check('[A] 未登记的段落算 system_dynamic（fail-safe：不确定的东西绝不进稳定账）', (() => {
    const a2 = costAttribution.attribute({ sections: [{ id: 'brand-new-section', text: 'x'.repeat(100), stable: true }], messages: [] });
    return a2.layers.system_dynamic > 0 && a2.layers.system_static === 0;
  })());
}

// ============================ B. 第一个变化的区段 + 投影归一化 ============================
console.log('\n== B. 第一个变化的区段 / 工具投影 ==');
{
  const mk = (mem) => agent.splitPromptSections(agent.buildSystemPrompt(
    { raw: '灵魂' }, '[{"id":"n1"}]', agent.buildToolGuide([{ name: 'read_file', description: '读' }]),
    mem, 'sk: 先 Y', { prompt: '把 add 改成加法', canvasMode: 'always', userMemoryText: '偏好：中文' },
  ));
  const base = mk('记忆 A');
  check('[B] 首轮（没有上一次）→ null（不编造）', costAttribution.firstChangedSection(null, base) === null);
  check('[B] 完全没变 → null', costAttribution.firstChangedSection(base, mk('记忆 A')) === null);
  check('[B] 只改记忆 → 报出 memory（而不是笼统「变了」）',
    costAttribution.firstChangedSection(base, mk('记忆 B')) === 'memory',
    String(costAttribution.firstChangedSection(base, mk('记忆 B'))));
  const soulChanged = agent.splitPromptSections(agent.buildSystemPrompt(
    { raw: '换了个灵魂' }, '[{"id":"n1"}]', agent.buildToolGuide([{ name: 'read_file', description: '读' }]),
    '记忆 A', 'sk: 先 Y', { prompt: '把 add 改成加法', canvasMode: 'always', userMemoryText: '偏好：中文' },
  ));
  check('[B] 改稳定段（soul）→ 报出 soul（说明它真的按顺序找第一个变化点）',
    costAttribution.firstChangedSection(base, soulChanged) === 'soul',
    String(costAttribution.firstChangedSection(base, soulChanged)));
  check('[B] 段落消失也算变化（不是只比共有段）',
    costAttribution.firstChangedSection(base, base.filter((s) => s.id !== 'user-memory')) === 'user-memory');
  check('[B] cacheMiss=false 时不报 firstChangedSection（避免噪音）',
    costAttribution.attribute({ sections: base, messages: [], cacheMiss: false, previousSections: mk('记忆 B') }).cache.firstChangedSection === null);

  const p = costAttribution.normalizeProjection(new Map([
    ['search_files', { calls: 2, rawTokens: 3000, modelTokens: 1200 }],
    ['read_file', { calls: 1, rawTokens: 100, modelTokens: 100 }],
  ]));
  check('[B] 投影归一化：raw → model 的节省额与比例可读',
    p.rawTokens === 3100 && p.modelTokens === 1300 && p.savedTokens === 1800 && Math.abs(p.projectionRate - 0.5806) < 0.001,
    JSON.stringify({ raw: p.rawTokens, model: p.modelTokens, saved: p.savedTokens, rate: p.projectionRate }));
  check('[B] 按工具分组（哪类工具最该做确定性裁剪一目了然）',
    p.byTool.search_files.savedTokens === 1800 && p.byTool.read_file.savedTokens === 0 && p.calls === 3);
  check('[B] 空累加器不炸、比例是 null（不编造 0% 或 100%）',
    costAttribution.normalizeProjection(null).projectionRate === null);
}

// ============================ D. 辅助调用面板（阶段 B 第 4 条） ============================
console.log('\n== D. 辅助调用面板：请求数 / 输入 / 输出 / 净节省 ==');
{
  const records = [
    { ts: 't1', runId: 'r1', kind: 'intent', model: 'm', tokens: { prompt: 1200, completion: 40, total: 1240 }, costUsd: 0.0001 },
    { ts: 't2', runId: 'r1', kind: 'intent', model: 'm', tokens: { prompt: 1300, completion: 45, total: 1345 }, costUsd: 0.0001 },
    { ts: 't3', runId: 'r1', kind: 'compression', model: 'm', tokens: { prompt: 26000, completion: 300, total: 26300 }, costUsd: 0.003 },
    // 同一 run 的主请求会**逐轮**带累计压缩账：这里故意放两份（第 2 份更大），验证按 run 取最后一次、不逐轮相加
    { ts: 't4', runId: 'r1', kind: 'main', model: 'm', tokens: { prompt: 100, completion: 10, total: 110 }, meta: { attribution: { compression: { calls: 1, savedTokens: 30048, netTokensSaved: 63844, netTokensImmediate: 3748 } } } },
    { ts: 't5', runId: 'r1', kind: 'main', model: 'm', tokens: { prompt: 200, completion: 20, total: 220 }, meta: { attribution: { compression: { calls: 2, savedTokens: 60096, netTokensSaved: 127688, netTokensImmediate: 7496 } } } },
  ];
  const sum = costAttribution.summarizeAuxiliary(records);
  check('[D] intent 请求数 / 输入 / 输出 汇总正确',
    sum.intent.requests === 2 && sum.intent.inputTokens === 2500 && sum.intent.outputTokens === 85,
    JSON.stringify(sum.intent));
  check('[D] compression 请求数 / 输入 / 输出 汇总正确',
    sum.compression.requests === 1 && sum.compression.inputTokens === 26000 && sum.compression.outputTokens === 300,
    JSON.stringify(sum.compression));
  check('[D] 净节省**按 run 取最后一次累计值**（不逐轮相加 —— 相加会翻好几倍）',
    sum.compression.netTokensSaved === 127688 && sum.compression.savedTokens === 60096 && sum.compression.calls === 2,
    JSON.stringify({ net: sum.compression.netTokensSaved, saved: sum.compression.savedTokens, calls: sum.compression.calls }));
  check('[D] 空输入不炸、全 0（不编造）',
    costAttribution.summarizeAuxiliary([]).intent.requests === 0 && costAttribution.summarizeAuxiliary(null).compression.netTokensSaved === 0);
  check('[D] 接线：agent:metrics 真的带上面板数据，且账本能读全部记录',
    /auxiliary: costAttributionLib\.summarizeAuxiliary\(ledger\.records\(\)\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'metrics.cjs'), 'utf8'),
    ) &&
      /records\(\) \{/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'costLedger.cjs'), 'utf8')));
}

// ============================ C. 端到端：真 run + 真账本 ============================
(async () => {
  console.log('\n== C. 端到端：账本上的主调用真的挂着归因 ==');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);
  fs.writeFileSync(path.join(root, 'work', 'many.txt'), Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ALPHA').join('\n') + '\n');

  const ledger = new CostLedger({ projectRoot: root, runId: 'run-cost-attr' });
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    toolsAllowed: ['read_file', 'search_files'],
  });
  const stub = installScriptedModel(
    [
      { toolCalls: [{ name: 'search_files', args: { pattern: 'ALPHA', path: 'work' } }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920, prompt_cache_miss_tokens: 900, prompt_cache_hit_tokens: 0 } },
      { content: '完成', usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200 } },
    ],
    { loopLast: false },
  );
  let result = null;
  try {
    result = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: 'test-key-not-real',
        model: 'scripted-model',
        maxTokens: 1024,
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
        costLedger: ledger,
        costRunId: 'run-cost-attr',
      },
      messages: [
        { role: 'system', content: '测试用 system：这里没有段落标题，归因也要能跑（不抛错）' },
        { role: 'user', content: '在 work 里找 ALPHA' },
      ],
      tools: { registry, context },
      signal: controller.signal,
      timeoutMs: 20000,
    });
  } finally {
    stub.restore();
  }

  const mains = ledger.entries.filter((e) => e.kind === 'main');
  check('[C] 真实 run 结束（有两轮主调用）', !!result && mains.length === 2, 'mains=' + mains.length);
  const attributed = mains.filter((e) => e.meta && e.meta.attribution);
  check('[C] **每一笔主调用都挂着按层归因**（不是只在某一轮）', attributed.length === mains.length, 'attributed=' + attributed.length);
  const first = attributed[0] && attributed[0].meta.attribution;
  check('[C] 归因里的层加总 = total 且都是正数', first && Object.values(first.layers).reduce((a, b) => a + b, 0) === first.total && first.total > 0,
    first ? 'total=' + first.total : 'missing');
  /**
   * 工具投影与 tool_result 必须看**第 2 轮**：第 1 轮的主调用发生在工具执行**之前**，
   * 那时当然还没有工具结果（第一版断言就错在这里 —— 是断言错了，不是代码错了）。
   */
  const second = attributed[1] && attributed[1].meta.attribution;
  check('[C] 工具投影是实测出来的：search_files 的 raw > model（P0-2 的投影真的发生在这一层）',
    second && second.toolProjection.byTool.search_files && second.toolProjection.byTool.search_files.rawTokens > second.toolProjection.byTool.search_files.modelTokens,
    second ? JSON.stringify(second.toolProjection.byTool) : 'missing');
  check('[C] 工具结果层（tool_result）在下一轮被单独计出（不是混进 history）',
    second && second.layers.tool_result > 0, second ? String(second.layers.tool_result) : 'missing');
  check('[C] 第 1 轮还没有工具结果 → tool_result 为 0（时间顺序正确，不是凭空有值）',
    first && first.layers.tool_result === 0, first ? String(first.layers.tool_result) : 'missing');
  check('[C] 供应商报的缓存命中/未命中被镜像进来',
    first && first.cache.cachedTokens === 0 && first.cache.missTokens === 900,
    first ? JSON.stringify(first.cache) : 'missing');
  check('[C] 第一轮报 miss 且**提示词没变** → firstChangedSection 为 null（不编造区段）',
    first && first.cache.miss === true && first.cache.firstChangedSection === null,
    first ? JSON.stringify(first.cache) : 'missing');
  check('[C] 第二轮命中缓存（cached=1000）→ miss=false', second && second.cache.miss === false && second.cache.cachedTokens === 1000,
    second ? JSON.stringify(second.cache) : 'missing');
  check('[C] 无段落标题的 system（首轮那种）也不会让归因抛错、更不会记 null',
    first && first.bySection && typeof first.bySection === 'object');
  console.log('\n' + (failures === 0 ? 'COST ATTRIBUTION TEST: PASS（按层归因 + 第一个变化区段 + 投影 raw→model）' : 'COST ATTRIBUTION TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('COST ATTRIBUTION TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
