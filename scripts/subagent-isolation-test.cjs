#!/usr/bin/env node
/**
 * subagent-isolation-test.cjs —— S9「子代理隔离与成本契约」用例（2026-09-16）
 *
 * 锁住 S9 的每一条修复，失败即红：
 *   A. 角色契约单一来源（含 canvas 的角色提示；enum 与角色目录一致）
 *   B. 只读门按「角色显式授予的能力」判定（白名单里有写工具但没能力 → 拒绝；verifier 的 shell 保留）
 *   C. scan_project 在只读上下文不再谎报「已写入工作台」
 *   D. 子代理独立预算的父子链（子超额不影响父；父总量依然守恒）
 *   E. 总时长参数语义（秒 → 毫秒 + 上下限钳制）
 *   F. 结果合并契约（字段头 / 截断 / 变更文件 / 失败不诱导原样重试）
 *   G. stage 回写不再静默失败（节点不存在 / 类型不符都给 stageWarning）
 *   H. 幂等账本的行为者归因（谁提交的、谁在重复）
 *   I. 压缩内容级缓存（同内容只压一次 + 键稳定性 + LRU 上限 + 落盘复用）
 *   J. 配置接线（agent.subagent.* / agent.compression.* 有默认值）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const roles = require('../electron/tools/roles.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { SubagentManager, clampTotalTimeout } = require('../electron/subagents.cjs');
const { SideEffectLedger, createGuard } = require('../electron/sideEffects.cjs');
const { RequestBudget, createSubagentBudget } = require('../electron/requestBudget.cjs');
const compressionCache = require('../electron/compressionCache.cjs');
const agent = require('../electron/agent.cjs');

const ok = (label) => console.log('  ✓ ' + label);

(async () => {
  // ---- A. 角色契约单一来源 ----
  for (const name of roles.ROLE_NAMES) {
    assert.ok(roles.rolePrompt(name).length > 10, '角色 ' + name + ' 缺少角色提示');
    const reg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: name });
    assert.deepStrictEqual(
      reg.listTools().map((t) => t.name).sort(),
      roles.roleTools(name).slice().sort(),
      '角色 ' + name + ' 的注册表白名单与角色契约不一致',
    );
    assert.deepStrictEqual(
      [...reg.roleCapabilities].sort(),
      roles.roleCapabilities(name).slice().sort(),
      '角色 ' + name + ' 的能力集没有写到注册表（只读门会失效）',
    );
  }
  assert.ok(roles.rolePrompt('canvas').length > 10, 'canvas 必须有角色提示（旧版静默丢失）');
  const supervisorReg = new AgentToolRegistry();
  new SubagentManager({}).register(supervisorReg);
  const delegateSpec = supervisorReg.listTools().find((s) => s.name === 'delegate_task');
  assert.deepStrictEqual(delegateSpec.inputSchema.properties.role.enum, roles.ROLE_NAMES);
  ok('A 角色契约单一来源（' + roles.ROLE_NAMES.join('/') + '，含 canvas 提示与 enum 一致）');

  // ---- B. 只读门按角色能力判定 ----
  const explorerReg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' });
  explorerReg.register('scout_writer', '测试用写工具（未登记 → 合成契约按可写 + shell.execute）', { type: 'object' }, async () =>
    AgentToolResult.ok('wrote'),
  );
  explorerReg.allowedTools.add('scout_writer');
  const roFactoryContext = new AgentToolContext({ projectRoot: process.cwd(), readOnly: true, role: 'explorer', runId: 'run-ro' });
  const denied = await explorerReg.execute('scout_writer', {}, roFactoryContext);
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.data.code, 'PERMISSION_DENIED');

  const verifierReg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'verifier' });
  verifierReg.register('scout_runner', '测试用执行工具', { type: 'object' }, async () => AgentToolResult.ok('ran'));
  verifierReg.allowedTools.add('scout_runner');
  const roVerifierContext = new AgentToolContext({ projectRoot: process.cwd(), readOnly: true, role: 'verifier', runId: 'run-ro2' });
  const allowed = await verifierReg.execute('scout_runner', {}, roVerifierContext);
  assert.strictEqual(allowed.ok, true, '角色契约显式授予能力（verifier 的 shell.execute）时必须放行');
  assert.ok(verifierReg.contains('execute_shell'), 'verifier 必须保留 execute_shell');
  ok('B 只读门按角色能力判定（白名单不足以越权；verifier 的 shell 保留）');

  // ---- C. scan_project 不再谎报 ----
  const scanReg = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, ragEnabled: true, role: 'explorer' });
  const roScanContext = new AgentToolContext({ projectRoot: process.cwd(), readOnly: true, role: 'explorer', runId: 'run-scan' });
  const scan = await scanReg.execute('scan_project', { applyToWorkbench: true, path: 'electron/tools' }, roScanContext);
  assert.strictEqual(scan.ok, false, '只读上下文里 applyToWorkbench 必须如实失败');
  assert.strictEqual(scan.data.code, 'WORKBENCH_WRITE_DENIED');
  assert.strictEqual(scan.data.appliedToWorkbench, false);
  assert.ok(String(scan.text).includes('画布未写入'));
  // 反向也要钉住：有画布 mutator 时必须真的写入并如实报告，否则「不再谎报」会退化成「永远失败」
  const writeModel = new GraphModel({ root: { nodes: [], edges: [] } });
  const rwContext = new AgentToolContext({
    projectRoot: process.cwd(),
    model: writeModel,
    mutateWorkbench: async (fn) => {
      fn(writeModel);
      return true;
    },
    audit: () => {},
    runId: 'run-scan-rw',
  });
  const scanApplied = await scanReg.execute('scan_project', { applyToWorkbench: true, path: 'electron/tools' }, rwContext);
  assert.strictEqual(scanApplied.ok, true, '有写权限时必须成功');
  assert.strictEqual(scanApplied.data.appliedToWorkbench, true);
  assert.ok(writeModel.nodes().length > 0, '画布上必须真的建出节点');

  ok('C scan_project 只读上下文不再谎报「已写入工作台」');

  // ---- D. 独立预算的父子链 ----
  const parentBudget = new RequestBudget(1000);
  const childBudget = createSubagentBudget(parentBudget, 300);
  assert.notStrictEqual(childBudget, parentBudget);
  assert.strictEqual(childBudget.parent, parentBudget);
  childBudget.reserve(200)({ total_tokens: 150 });
  assert.strictEqual(childBudget.used, 150);
  assert.strictEqual(parentBudget.used, 150, '子代理用量必须记进父账（总量守恒）');
  assert.throws(
    () => childBudget.reserve(200),
    (/** @type {any} */ error) => error.code === 'BUDGET_EXCEEDED' && error.scope === 'subagent',
    '子代理超出自己的配额必须只拒绝它自己',
  );
  parentBudget.reserve(400)({ total_tokens: 400 });
  assert.strictEqual(parentBudget.used, 550, '子代理超额后父 run 仍可继续使用自己的剩余额度');
  assert.strictEqual(createSubagentBudget(parentBudget, 0), parentBudget, '配额 0 = 不设独立配额，沿用父预算');
  ok('D 子代理独立预算父子链（子超额只影响自己，父总量守恒）');

  // ---- E. 总时长参数语义 ----
  assert.strictEqual(clampTotalTimeout(undefined, 600), 600000);
  assert.strictEqual(clampTotalTimeout(30, 600), 30000);
  assert.strictEqual(clampTotalTimeout(1, 600), 10000, '小于下限要钳制（防秒超时）');
  assert.strictEqual(clampTotalTimeout(99999, 600), 3600000, '大于上限要钳制');
  ok('E timeoutSeconds 是任务总时长（秒 → 毫秒 + 钳制）');

  // ---- F/G. 结果契约 + 画布痕迹 ----
  const model = new GraphModel({
    root: {
      nodes: [
        { id: 'stage-1', type: 'stage', position: { x: 0, y: 0 }, data: { label: '探查', status: 'pending' } },
        { id: 'task-2', type: 'task', position: { x: 0, y: 80 }, data: { label: '任务' } },
      ],
      edges: [],
    },
  });
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: process.cwd(),
    model,
    confirm: async () => true,
    mutateWorkbench: async (fn) => {
      fn(model);
      return true;
    },
    audit: () => {},
    signal: controller.signal,
  });
  const supervisor = toolkit.buildDefaultRegistry();
  const longText = '结论：写完了\n' + 'x'.repeat(20000);
  const manager = new SubagentManager({
    agent: {
      runAgentChat: async () => ({
        content: longText,
        toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'a/b.txt', content: 'x' }) }],
        usage: { total_tokens: 123 },
      }),
    },
    toolkit,
    cfg: {
      tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] },
      rag: { enabled: true },
      subagent: { resultMaxChars: 500, totalTimeoutSeconds: 600 },
    },
    registry: supervisor,
    runId: 'run-test',
  });
  manager.register(supervisor);
  const done = await supervisor.execute('delegate_task', { role: 'builder', objective: '写文件', stageNodeId: 'stage-1' }, context);
  assert.strictEqual(done.ok, true);
  assert.ok(String(done.text).startsWith('[子代理结果] taskId='), '结果必须有固定字段头');
  assert.ok(String(done.text).includes('已截断'), '超长结果必须截断');
  assert.ok(String(done.text).length < 1200, '截断后才进主上下文（不是 20000 字符全灌进去）');
  assert.deepStrictEqual(done.data.contract.changedFiles, ['a/b.txt'], '变更文件要结构化回传');
  assert.strictEqual(done.data.contract.acceptanceJudgement, 'manual', '验收结论不自动编造');
  assert.strictEqual(done.data.contract.totalTimeoutMs, 600000);
  assert.strictEqual(model.byId('stage-1').data.status, 'done');
  assert.strictEqual(model.byId('stage-1').data.result_summary.startsWith('[子代理结果]'), true);
  ok('F 结果合并契约（字段头/截断/变更文件/结构化 contract）');

  const missing = await supervisor.execute('delegate_task', { role: 'explorer', objective: '探查', stageNodeId: 'missing' }, context);
  assert.strictEqual(missing.ok, true);
  assert.ok(String(missing.data.stageWarning).includes('stage 节点不存在'));
  const wrongType = await supervisor.execute('delegate_task', { role: 'explorer', objective: '探查', stageNodeId: 'task-2' }, context);
  assert.ok(String(wrongType.data.stageWarning).includes('不是 stage'));
  ok('G stage 回写不再静默（节点缺失/类型不符都有 stageWarning）');

  const failReg = toolkit.buildDefaultRegistry();
  const failManager = new SubagentManager({
    agent: { runAgentChat: async () => ({ content: '', error: '已达到本轮 Agent token 预算（250000）' }) },
    toolkit,
    cfg: { tools: { toolsEnabled: true }, rag: { enabled: true }, subagent: {} },
    registry: failReg,
    runId: 'run-fail',
  });
  failManager.register(failReg);
  const failed = await failReg.execute('delegate_task', { role: 'explorer', objective: '探查' }, context);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.data.status, 'failed');
  assert.ok(String(failed.text).includes('请勿用相同 objective 原样重试'), '失败结果必须劝退原样重试');
  ok('F2 子代理失败如实失败且不诱导原样重试');

  // ---- H. 幂等账本的行为者归因 ----
  const tmpLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-side-ledger-'));
  const ledger = new SideEffectLedger({ projectRoot: tmpLedgerDir, scopeRunId: 'run-1', file: path.join(tmpLedgerDir, 'ledger.json') });
  const first = ledger.begin('write_file', { path: 'a.txt', content: '1' }, { taskId: 'task-a', role: 'builder' });
  assert.strictEqual(first.skip, false);
  assert.strictEqual(first.actor, 'task-a(builder)');
  ledger.commit(first, { ok: true, result: 'ok' });
  const second = ledger.begin('write_file', { path: 'a.txt', content: '1' }, { taskId: 'task-b', role: 'builder' });
  assert.strictEqual(second.skip, true);
  assert.ok(second.reason.includes('task-a(builder)'), '去重文案要说是谁提交的');
  assert.ok(second.reason.includes('task-b(builder)'), '去重文案要说是谁在重复');
  assert.strictEqual(ledger.review().committed[0].actor, 'task-a(builder)');
  const supervisorWrite = ledger.begin('write_file', { path: 'b.txt', content: '2' }, {});
  assert.strictEqual(supervisorWrite.actor, 'supervisor');
  // H2 上下文真的把行为者传给了账本：context → guard 这条线此前没有任何用例覆盖，
  //    变异「beginSideEffect 不传 actor」时全绿 —— 由变异测试当场抓出的盲区。
  const guardLedger = new SideEffectLedger({
    projectRoot: tmpLedgerDir,
    scopeRunId: 'run-2',
    file: path.join(tmpLedgerDir, 'ledger-ctx.json'),
  });
  const guardContext = new AgentToolContext({
    projectRoot: process.cwd(),
    runId: 'run-2',
    taskId: 'task-ctx',
    role: 'builder',
    sideEffectGuard: createGuard(guardLedger),
  });
  const ctxGuard = await guardContext.beginSideEffect('write_file', { path: 'c.txt', content: '3' });
  assert.strictEqual(ctxGuard.skip, false);
  assert.strictEqual(ctxGuard.actor, 'task-ctx(builder)', 'context 必须把 taskId/role 作为行为者传给账本');
  fs.rmSync(tmpLedgerDir, { recursive: true, force: true });
  ok('H 幂等账本可归因（谁提交 / 谁在重复 / 主代理 = supervisor）');

  // ---- I. 压缩内容级缓存 ----
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-cc-'));
  const cacheFile = path.join(cacheDir, 'compression-cache.json');
  const key = compressionCache.compressionKey('scan_project', 1500, 'a big tool result');
  assert.strictEqual(key, compressionCache.compressionKey('scan_project', 1500, 'a big tool result'), '同输入必须同键');
  assert.notStrictEqual(key, compressionCache.compressionKey('scan_project', 800, 'a big tool result'));
  assert.notStrictEqual(key, compressionCache.compressionKey('read_file', 1500, 'a big tool result'));
  const c1 = new compressionCache.CompressionCache({ file: cacheFile, maxEntries: 3 });
  assert.strictEqual(c1.get(key), null);
  c1.set(key, '摘要-1', 'scan_project');
  assert.strictEqual(c1.get(key), '摘要-1');
  assert.strictEqual(c1.stats().hits, 1);
  const reread = new compressionCache.CompressionCache({ file: cacheFile });
  assert.strictEqual(reread.get(key), '摘要-1', '缓存要能跨 run 复用（落盘）');
  {
    const tiny = new compressionCache.CompressionCache({ file: null, maxEntries: 2 });
    tiny.set('k1', 'v1');
    tiny.set('k2', 'v2');
    tiny.set('k3', 'v3');
    assert.strictEqual(tiny.stats().entries, 2, 'LRU 上限要生效');
    assert.strictEqual(tiny.get('k1'), null, '最旧的条目要被淘汰');
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
  compressionCache.resetCompressionCaches();
  ok('I 压缩内容级缓存（键稳定 / 命中统计 / LRU / 落盘复用）');

  // ---- J. 配置接线 + 缓存命中的可测量性 ----
  const costLedger = require('../electron/costLedger.cjs');
  const deepseekUsage = costLedger.tokenParts({
    prompt_tokens: 1000,
    completion_tokens: 10,
    total_tokens: 1010,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  });
  assert.strictEqual(deepseekUsage.cached, 800, 'DeepSeek 的命中 token 不能再被丢掉');
  assert.strictEqual(deepseekUsage.miss, 200);
  const openaiUsage = costLedger.tokenParts({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } });
  assert.strictEqual(openaiUsage.cached, 400, 'OpenAI 的 cached_tokens 口径也要认');
  assert.strictEqual(openaiUsage.miss, 100);
  const emptyRate = costLedger.withCacheRate(costLedger.emptyCounters());
  assert.strictEqual(emptyRate.promptCacheHitRate, null, '没有数据时不编造命中率');
  const hitRate = costLedger.withCacheRate({ ...costLedger.emptyCounters(), promptCachedTokens: 750, promptMissTokens: 250 });
  assert.strictEqual(hitRate.promptCacheHitRate, 0.75);

  const defaults = agent.parseSubagentConfig({});
  assert.strictEqual(defaults.maxTotalTokens, 0);
  assert.strictEqual(defaults.totalTimeoutSeconds, 600);
  assert.strictEqual(defaults.resultMaxChars, 8000);
  const compressionDefaults = agent.loadConfig(process.cwd()).compression;
  assert.strictEqual(typeof compressionDefaults.cache, 'boolean');
  assert.strictEqual(compressionDefaults.reasoning, false, '压缩默认关思考链');
  assert.strictEqual(typeof compressionDefaults.model, 'string');
  ok('J 配置接线（agent.subagent.* 默认值 + 压缩默认关 reasoning + 缓存命中 token 可测量）');

  console.log('subagent isolation & compression cost contract ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
