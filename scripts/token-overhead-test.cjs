#!/usr/bin/env node
/**
 * token-overhead-test.cjs —— 阶段 A（token 效率审计 P0-1/P0-3 + A1/A3/A4）的**回归判据**
 *
 * 锁住四件事（都不是「看起来对」，而是可复现的数字与逐字节判据）：
 *
 *   A. **基线**：与审计文档 §3.2 同一条装配路径（toolkit + SubagentManager.register +
 *      toOpenAiTools + buildSystemPrompt + compaction.estimateTokens）量 33 工具的固定输入。
 *   B. **裁剪后的面**：每个任务的工具数、schema token 与固定输入都有上界（棘轮：只能降不能悄悄涨）。
 *   C. **负向判据**：`agent.tool_profile=off` 时请求面与「没有这个功能」**逐字节一致** ——
 *      工具数组与提示词都逐字节比对（暴露全部工具 ≠ 已裁剪：两者提示词必须相同）。
 *   D. **规则与工具面同源**：规则点名的工具不在暴露面里时，那条规则必须一起收敛 ——
 *      否则模型会照着规则去调一个不存在的工具（真实故障，不只是浪费）。
 *
 * 另外锁：`discover_tools` 的取回语义（只增不减 / 找到后不再重复报隐藏）、`modelContent` 单份投影、
 * 记忆自动注入的预算与「有命中才注入」，以及 ipc 的接线（防「实现了但没接线」）。
 *
 * 判据落在**真实装配路径**上：数字来自实际 buildSystemPrompt + toOpenAiTools 的输出，
 * 请求体来自 scripts/lib/scripted-model.cjs 记录的真实 body（不是对内部变量的推断）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const compaction = require('../electron/compaction.cjs');
const profiles = require('../electron/tools/profiles.cjs');
const memoryStore = require('../electron/memory.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tokoverhead-'));
const soul = agent.parseSoul('');

/** 真实装配路径：与审计文档 §3.1 一致（含子代理工具；rag 开 = 33 工具那一条） */
function buildRegistry(rag) {
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: null,
    ragEnabled: !!rag,
    webSearchEnabled: false,
  });
  const mgr = new SubagentManager({ leases: null, agent, toolkit, cfg: {}, registry, runId: 'probe', onDelta: () => {} });
  mgr.register(registry);
  return registry;
}

/** 量一个任务的「每轮固定输入」：system（含工具引导）+ 该面的 tool schema */
function measureFace(decision, { canvas, prompt }) {
  const registry = buildRegistry(true);
  // 与 ipc 同序：裁剪生效时先注册取回入口（discover_tools 在 core 名单里），再定面
  if (decision.source !== 'off') toolkit.registerDiscoverTool(registry);
  registry.setExposure(profiles.namesForProfiles(decision.profiles, registry.listTools().map((t) => t.name)));
  const info = registry.schemaInfo();
  const guide = agent.buildToolGuide(registry.listTools().filter((t) => registry.isExposed(t.name)));
  const system = agent.buildSystemPrompt(soul, canvas ? '[{"id":"n1"}]' : '', guide, '', '', {
    prompt,
    canvasMode: canvas ? 'always' : 'auto',
    exposedTools: registry.toolExposure,
    toolFaceTrimmed: true,
  });
  return {
    registry,
    system,
    count: info.count,
    chars: info.chars,
    hash: info.hash,
    schemaTokens: compaction.estimateTokens([], info.tools),
    systemTokens: compaction.estimateTokens([{ role: 'system', content: system }]),
    fixed: compaction.estimateTokens([{ role: 'system', content: system }], info.tools),
  };
}

async function runTurn(registry, script) {
  const controller = new AbortController();
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => 'ok',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const stub = installScriptedModel(script, { loopLast: false });
  try {
    await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: '',
        model: 'scripted-model',
        maxTokens: 1024,
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: { registry, context },
      signal: controller.signal,
      timeoutMs: 20000,
    });
    return stub.seen || [];
  } finally {
    stub.restore();
  }
}

(async () => {
  // ============================ A. 基线 ============================
  console.log('== A. 基线（真实装配路径，33 工具） ==');
  const base = buildRegistry(true);
  const baseTools = base.toOpenAiTools();
  const baseSchemaTokens = compaction.estimateTokens([], baseTools);
  const baseGuide = agent.buildToolGuide(base.listTools());
  const basePure = agent.buildSystemPrompt(soul, '', baseGuide, '', '', { prompt: '把 add 改成加法', canvasMode: 'auto' });
  const baseCanvas = agent.buildSystemPrompt(soul, '[{"id":"n1"}]', baseGuide, '', '', { prompt: '画布上建一条链路', canvasMode: 'always' });
  const basePureFixed = compaction.estimateTokens([{ role: 'system', content: basePure }], baseTools);
  const baseCanvasFixed = compaction.estimateTokens([{ role: 'system', content: baseCanvas }], baseTools);
  console.log(
    '   基线：工具 ' + baseTools.length + '，schema ' + baseSchemaTokens + ' tokens/' + JSON.stringify(baseTools).length +
    ' 字符；固定输入 纯代码 ' + basePureFixed + ' / 画布 ' + baseCanvasFixed,
  );
  check('[A] 基线装配得到 33 个工具（rag + 子代理工具都在）', baseTools.length === 33, 'tools=' + baseTools.length);
  check('[A] 基线固定输入与审计文档 §3.2 同量级（9k~10k / 10k~11k）',
    basePureFixed > 9000 && basePureFixed < 10000 && baseCanvasFixed > 10000 && baseCanvasFixed < 11000,
    'pure=' + basePureFixed + ' canvas=' + baseCanvasFixed);

  // ============================ B. 裁剪后的面（棘轮） ============================
  console.log('\n== B. 按任务裁剪后的固定输入（棘轮：只允许降） ==');
  const codeFace = measureFace(profiles.resolveToolProfiles({ canvas: false, prompt: '把 add 改成加法' }), { canvas: false, prompt: '把 add 改成加法' });
  const canvasFace = measureFace(profiles.resolveToolProfiles({ canvas: true, prompt: '画布上建一条链路' }), { canvas: true, prompt: '画布上建一条链路' });
  const researchFace = measureFace(profiles.resolveToolProfiles({ canvas: false, prompt: '联网查一下这个库的用法' }), { canvas: false, prompt: '联网查一下这个库的用法' });
  const orchFace = measureFace(profiles.resolveToolProfiles({ canvas: false, prompt: '派几个子代理并行干活' }), { canvas: false, prompt: '派几个子代理并行干活' });

  const fmt = (name, face, baseFixed) =>
    '   ' + name.padEnd(6) + ' 工具 ' + String(face.count).padStart(2) + '，schema ' + String(face.schemaTokens).padStart(5) +
    '，固定输入 ' + String(face.fixed).padStart(5) + '（基线 ' + baseFixed + '，降 ' +
    (((baseFixed - face.fixed) / baseFixed) * 100).toFixed(1) + '%）';
  console.log(fmt('纯代码', codeFace, basePureFixed));
  console.log(fmt('画布', canvasFace, baseCanvasFixed));
  console.log(fmt('调研', researchFace, basePureFixed));
  console.log(fmt('编排', orchFace, basePureFixed));

  check('[B] 纯代码固定输入 ≤5,500 tokens（阶段 A 验收线）', codeFace.fixed <= 5500, 'fixed=' + codeFace.fixed);
  check('[B] 纯代码降幅 ≥40%', (basePureFixed - codeFace.fixed) / basePureFixed >= 0.4,
    '降幅=' + (((basePureFixed - codeFace.fixed) / basePureFixed) * 100).toFixed(1) + '%');
  /**
   * 画布那一档的上界**没有**达到审计文档的 6,000 估算：文档的画布 profile 是「core + 画布工具」，
   * 而 core 只留 8 个工具；本实现把 `retrieve_context` / `execute_shell` / `find_files` /
   * `list_directory` 等都留在常驻面（常驻运行规则直接点名它们，裁掉会让规则悬空），
   * 并且画布轮仍带 code 面（同因）。实测 8,723。要更激进可显式配 `agent.tool_profile=core,canvas`。
   * 这里的上界是**棘轮**：只允许随「有意新增能力」抬高，且必须在注释里写明理由。
   */
  check('[B] 画布固定输入 ≤9,000 tokens（文档估算的 6,000 未达，理由见本文件注释）', canvasFace.fixed <= 9000, 'fixed=' + canvasFace.fixed);
  check('[B] 调研 / 编排面固定输入 ≤7,000 tokens', researchFace.fixed <= 7000 && orchFace.fixed <= 7000,
    'research=' + researchFace.fixed + ' orch=' + orchFace.fixed);
  check('[B] 裁剪后的面都是基线的子集（不会凭空多出工具）',
    profiles.namesForProfiles(['core', 'code', 'canvas'], base.listTools().map((t) => t.name)).length <= baseTools.length);

  // ============================ C. 负向：off 逐字节一致 ============================
  console.log('\n== C. 负向判据：tool_profile=off（不触发时逐字节不变） ==');
  const allNames = base.listTools().map((t) => t.name);
  const offRegistry = buildRegistry(true);
  check('[C] 未裁剪时暴露面 = 全部注册工具（与旧行为逐字节一致）',
    offRegistry.toolExposure === null && JSON.stringify(offRegistry.toOpenAiTools()) === JSON.stringify(baseTools));
  check('[C] 未裁剪时 schemaInfo 与 toOpenAiTools 同一份内容（缓存口径不漂移）',
    offRegistry.schemaInfo().json === JSON.stringify(offRegistry.toOpenAiTools()));
  check('[C] 稳定口径：两次独立装配得到同一个 hash',
    buildRegistry(true).schemaInfo().hash === offRegistry.schemaInfo().hash,
    buildRegistry(true).schemaInfo().hash + ' vs ' + offRegistry.schemaInfo().hash);
  const pureNoTrim = agent.buildSystemPrompt(soul, '', baseGuide, '', '', { prompt: '把 add 改成加法', canvasMode: 'auto' });
  const pureAllExposed = agent.buildSystemPrompt(soul, '', baseGuide, '', '', {
    prompt: '把 add 改成加法',
    canvasMode: 'auto',
    exposedTools: allNames,
    toolFaceTrimmed: false,
  });
  check('[C] 暴露全部工具 ≠ 已裁剪：两者提示词**逐字节相同**', pureNoTrim === pureAllExposed,
    'len ' + pureNoTrim.length + ' vs ' + pureAllExposed.length);
  const canvasNoTrim = agent.buildSystemPrompt(soul, '[{"id":"n1"}]', baseGuide, '', '', { prompt: '画布上建一条链路', canvasMode: 'always' });
  const canvasAllExposed = agent.buildSystemPrompt(soul, '[{"id":"n1"}]', baseGuide, '', '', {
    prompt: '画布上建一条链路',
    canvasMode: 'always',
    exposedTools: allNames,
    toolFaceTrimmed: false,
  });
  check('[C] 画布任务同样逐字节相同', canvasNoTrim === canvasAllExposed, 'len ' + canvasNoTrim.length + ' vs ' + canvasAllExposed.length);
  check('[C] off 判定不下发裁剪（source=off、无 profile）',
    profiles.resolveToolProfiles({ mode: 'off' }).source === 'off' && profiles.resolveToolProfiles({ mode: 'off' }).profiles.length === 0);

  // ============================ D. 规则与工具面同源 ============================
  console.log('\n== D. 规则点名的工具不在面里 → 规则一起收敛 ==');
  const codeSystem = codeFace.system;
  check('[D] 纯代码面：点名 workbench_edit 的规则 2 / 6 / 19 已收敛',
    !codeSystem.includes('需要读取画布时调用 get_workbench_model') &&
    !codeSystem.includes('画布节点之间的连线表示执行顺序') &&
    !codeSystem.includes('大批量画布操作按「逻辑组」分批提交'),
    'len=' + codeSystem.length);
  check('[D] 纯代码面：规则 7 只摘掉画布那半句、保留 offset 分段续读建议',
    !codeSystem.includes('工作台节点（创建/编辑/连线）统一用 workbench_edit') && codeSystem.includes('大文件/大目录用 read_file 的 offset'));
  check('[D] 纯代码面：画布建模规则 14 退成占位', codeSystem.includes('【画布建模规则本次未注入】'));
  check('[D] 纯代码面：核心规则一条不少（读写文件 / 低敏感免问 / 读取策略）',
    codeSystem.includes('读写文件用 read_file / write_file / edit_file') &&
    codeSystem.includes('低敏感/只读操作') && codeSystem.includes('读取策略（泛读/精读分层'));
  check('[D] 纯代码面：追加了 discover_tools 那条（20）', codeSystem.includes('discover_tools 搜功能词'));
  check('[D] 画布面：画布规则 2 与建模规则 a–h 都在（工具在面里 → 规则一条不收敛）',
    canvasFace.system.includes('需要读取画布时调用 get_workbench_model') &&
    canvasFace.system.includes(agent.CANVAS_RULES.slice(0, 60)) &&
    canvasFace.system.includes('【画布建模规则本次未注入】') === false,
    'len=' + canvasFace.system.length);
  check('[D] 未裁剪时一条规则都不收敛、也不追加规则 20',
    !pureNoTrim.includes('discover_tools 搜功能词') && pureNoTrim.includes('需要读取画布时调用 get_workbench_model'));

  // ============================ E. 变异校验（用例有判别力） ============================
  console.log('\n== E. 变异校验：改坏输入，断言必须翻转 ==');
  {
    // 变异 1：给暴露面里塞回 workbench_edit → 「规则 2 已收敛」必须翻成「规则在」
    const exposedWithCanvas = [...allNames.filter((n) => profiles.PROFILE_TOOLS.core.includes(n) || profiles.PROFILE_TOOLS.code.includes(n)), 'workbench_edit'];
    const systemWithCanvas = agent.buildSystemPrompt(soul, '', baseGuide, '', '', {
      prompt: '把 add 改成加法', canvasMode: 'auto', exposedTools: exposedWithCanvas, toolFaceTrimmed: true,
    });
    check('[E] 变异：暴露面里塞回 workbench_edit → 规则 2 必须重新出现（收敛判据有判别力）',
      systemWithCanvas.includes('需要读取画布时调用 get_workbench_model') && !codeFace.system.includes('需要读取画布时调用 get_workbench_model'));

    // 变异 2：把工具面削到只剩一个工具 → discover_tools 的隐藏集必须完全不同（否则「找到隐藏工具」是假判据）
    const tiny = buildRegistry(true);
    toolkit.registerDiscoverTool(tiny);
    tiny.setExposure(['read_file', 'discover_tools']);
    const hiddenTiny = tiny.listTools().map((t) => t.name).filter((n) => !tiny.isExposed(n));
    check('[E] 变异：不同的暴露面得到不同的隐藏集（discover_tools 对着真实隐藏集工作）',
      hiddenTiny.length > 25 && hiddenTiny.includes('workbench_edit') && !profiles.namesForProfiles(['core', 'code'], allNames).includes('workbench_edit'));

    // 变异 3：profile 表本身 —— code 面必须真的比 core 面大（否则「分层」是空壳）
    const coreOnly = profiles.namesForProfiles(['core'], allNames);
    const codeNames = profiles.namesForProfiles(['core', 'code'], allNames);
    check('[E] 变异：code 面严格包含 core 面且更大（分层不是空壳）',
      codeNames.length > coreOnly.length && coreOnly.every((n) => codeNames.includes(n)),
      'core=' + coreOnly.length + ' code=' + codeNames.length);
  }

  // ============================ F. discover_tools 取回语义 ============================
  console.log('\n== F. discover_tools：把裁掉的能力找回来（只增不减） ==');
  {
    const registry = buildRegistry(true);
    toolkit.registerDiscoverTool(registry);
    const codeNames = profiles.namesForProfiles(['core', 'code'], registry.listTools().map((t) => t.name));
    registry.setExposure(codeNames);
    const before = registry.exposedNames().slice();
    check('[F] 未裁剪时不注册 discover_tools（off 请求体逐字节一致的保证）',
      !buildRegistry(true).contains('discover_tools'));
    check('[F] 裁剪生效时才注册 discover_tools', registry.contains('discover_tools'));
    check('[F] 裁剪后 workbench_edit 不在面里', !registry.isExposed('workbench_edit') && registry.contains('workbench_edit'));

    const ctx = new AgentToolContext({
      projectRoot: root,
      confirm: async () => true,
      audit: () => {},
      askUser: async () => 'ok',
      ragConfig: { enabled: false },
    });
    const hit = await registry.execute('discover_tools', { query: '画布节点' }, ctx);
    check('[F] 搜「画布节点」能启用画布面工具', hit.ok === true && registry.isExposed('workbench_edit'),
      JSON.stringify({ ok: hit.ok, enabled: hit.data && hit.data.enabled }));
    check('[F] 启用是**单调追加**：原有面一个不少', before.every((n) => registry.isExposed(n)) &&
      registry.exposedNames().length > before.length);
    check('[F] discover_tools 也走单份投影（不回灌重复的 data）',
      typeof hit.modelContent === 'string' && hit.modelContent === hit.text);

    const again = await registry.execute('discover_tools', { query: '画布节点' }, ctx);
    check('[F] 再搜同一批：已启用的不再重复报（隐藏集里没有了）',
      again.ok === true && !(again.data && again.data.enabled || []).includes('workbench_edit'),
      JSON.stringify(again.data && again.data.enabled));

    const miss = await registry.execute('discover_tools', { query: 'zzzz不存在的功能' }, ctx);
    check('[F] 一无所获时给出分组清单（可换词/说组名），不瞎猜',
      miss.ok === true && /core=|code=|canvas=/.test(String(miss.text)),
      String(miss.text).slice(0, 80));
  }

  // ============================ G. 真实请求体（脚本化模型） ============================
  console.log('\n== G. 真机请求体：裁剪真的改变了发出去的东西 ==');
  {
    const offReg = buildRegistry(true);
    const offSeen = await runTurn(offReg, [{ content: '直接回答' }]);
    const offBody = offSeen[0].body;
    const codeReg = buildRegistry(true);
    toolkit.registerDiscoverTool(codeReg);
    codeReg.setExposure(profiles.namesForProfiles(['core', 'code'], codeReg.listTools().map((t) => t.name)));
    const codeSeen = await runTurn(codeReg, [{ content: '直接回答' }]);
    const codeBody = codeSeen[0].body;
    const offTokens = compaction.estimateTokens(offBody.messages, offBody.tools);
    const codeTokens = compaction.estimateTokens(codeBody.messages, codeBody.tools);
    console.log('   发出体：未裁剪 tools=' + offBody.tools.length + ' 输入 ' + offTokens + ' tokens；' +
      '裁剪后 tools=' + codeBody.tools.length + ' 输入 ' + codeTokens + ' tokens');
    check('[G] 真实请求体里的工具数 = 裁剪后的面', codeBody.tools.length === codeFace.count, 'body=' + codeBody.tools.length + ' face=' + codeFace.count);
    check('[G] 真实请求体里确实没有 workbench_edit', !codeBody.tools.some((t) => t.function.name === 'workbench_edit'));
    check('[G] 未裁剪的请求体里仍然有全部工具（负向）', offBody.tools.length === 33);
    check('[G] 单轮输入 token 下降 ≥35%', (offTokens - codeTokens) / offTokens >= 0.35,
      ((offTokens - codeTokens) / offTokens * 100).toFixed(1) + '%');
  }

  // ============================ H. A4 记忆预算 ============================
  console.log('\n== H. 自动注入记忆：有命中才注入 + 预算 ==');
  {
    const entries = [
      { id: 'm1', key: 'sandbox', content: '沙箱限额：memory=512MB、cpu=1 核' },
      { id: 'm2', key: 'unrelated', content: '无关记录'.repeat(400) },
      { id: 'm3', key: 'style', content: '交付 UI 要有单一 accent 色' },
    ];
    const hitInj = memoryStore.buildMemoryInjection(entries, '沙箱限额怎么设', { limit: 5, maxEntryChars: 400, budgetTokens: 2000 });
    check('[H] 命中时正常注入且只带命中的条目', hitInj.text.includes('沙箱限额') && hitInj.count >= 1, JSON.stringify({ count: hitInj.count, tokens: hitInj.tokens }));
    const missInj = memoryStore.buildMemoryInjection(entries, 'zzzz完全不相关', { limit: 5, maxEntryChars: 400, budgetTokens: 2000 });
    check('[H] **无命中 → 注入为空**（不再回退最近 N 条，旧口径是固定税）', missInj.text === '' && missInj.tokens === 0);
    const recentInj = memoryStore.buildMemoryInjection(entries, 'zzzz完全不相关', { limit: 5, requireMatch: false });
    check('[H] 配 agent.memory_inject=recent 时保留旧行为（回退最近 N 条并如实标注）',
      recentInj.text.includes('最近保存的记忆'), String(recentInj.text).slice(0, 40));
    const capped = memoryStore.buildMemoryInjection(entries, '沙箱 单一 accent 无关记录', { limit: 5, maxEntryChars: 400, budgetTokens: 100000 });
    check('[H] 单条字符上限生效（400 字符 + 截断标注）', capped.truncated >= 1 && !capped.text.includes('无关记录'.repeat(200)),
      JSON.stringify({ truncated: capped.truncated, chars: capped.text.length }));
    const tight = memoryStore.buildMemoryInjection(entries, '沙箱 单一 accent', { limit: 5, maxEntryChars: 400, budgetTokens: 30 });
    check('[H] 整段 token 预算生效（超预算的条目被丢弃并如实标注）',
      tight.tokens <= 30 || tight.text === '', JSON.stringify({ tokens: tight.tokens, dropped: tight.dropped }));
    check('[H] 选择器旧语义**没动**（recall 工具与既有用例依赖它）：无命中仍返回最近 N 条 + matched=false',
      memoryStore.selectRelevant(entries, 'zzzz').matched === false && memoryStore.selectRelevant(entries, 'zzzz').entries.length === 3);
  }

  // ============================ I. 接线（防「实现了但没接线」） ============================
  console.log('\n== I. 接线静态断言 ==');
  {
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.cjs'), 'utf8');
    check('[I] ipc 真的定了工具面（setExposure + profiles.namesForProfiles）',
      /registry\.setExposure\(names\)/.test(ipcSrc) && /toolkit\.profiles\.namesForProfiles\(/.test(ipcSrc));
    check('[I] ipc 把暴露面传给了 buildSystemPrompt（规则同源）',
      /exposedTools:\s*registry\s*\?\s*registry\.toolExposure\s*:\s*null/.test(ipcSrc) && /toolFaceTrimmed:/.test(ipcSrc));
    check('[I] ipc 在裁剪时注册 discover_tools，且就在 filterByConfig **之前**（用户白名单照旧说了算）',
      /if \(cfg\.tools\.toolProfile !== 'off'\) toolkit\.registerDiscoverTool\(registry\);\s*toolkit\.filterByConfig\(registry/.test(ipcSrc));
    check('[I] ipc 把定面结果落 run 事件（含 hash / tokens）',
      /runStore\.appendEvent\(projectRoot, runId, 'tool_face'/.test(ipcSrc) && /hash: info\.hash/.test(ipcSrc) && /tokens: compactionLib\.estimateTokens/.test(ipcSrc));
    check('[I] ipc 用记忆注入预算（不再 limit:30 / limit:20 的裸切片）',
      /memoryStore\.buildMemoryInjection\(/.test(ipcSrc) && /userMemoryStore\.buildUserMemoryInjection\(/.test(ipcSrc) &&
      !/buildMemoryText\(memory\.entries, prompt, \{ limit: 30 \}\)/.test(ipcSrc));
    check('[I] 配置项与解析都在（agent.tool_profile / 记忆预算）',
      /agent\.tool_profile/.test(agentSrc) && /function parseMemoryConfig/.test(agentSrc) && /memory:\s*parseMemoryConfig\(cfg\)/.test(agentSrc));
    check('[I] 未裁剪时不注册 discover_tools（BUILTINS 里没有它）',
      !/discoverToolsTool/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'toolkit.cjs'), 'utf8').split('function registerDiscoverTool')[0]));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? 'TOKEN OVERHEAD TEST: PASS（工具面裁剪 + 单份投影 + 记忆预算，全部有判据）' : 'TOKEN OVERHEAD TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('TOKEN OVERHEAD TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
