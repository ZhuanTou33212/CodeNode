#!/usr/bin/env node
/**
 * approval-token-test.cjs —— S7「capability 权限模型 + ApprovalService 令牌」用例（2026-09-16）
 *
 * 判据分两层：
 *   A–F 服务层：令牌签发/消费/过期/scope/能力/调用绑定/无通道/用户拒绝/撤销；
 *   G–K 集成层：注册表真实执行 —— 声明是否强制、**模型自填 confirmed 无效**、批准才执行、
 *        拒绝即不执行（APPROVAL_DENIED）、`tools.confirm_writes=false` 能整体关闭。
 *
 * 核心不变量（本阶段的安全底线）：**审批只能由服务端签发令牌，模型在参数里怎么填都不算数。**
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const approvalLib = require('../electron/tools/approval.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

const ok = (label) => console.log('  ✓ ' + label);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // ---- A. 签发 → 校验 → 单次消费 ----
  const svc = approvalLib.createApprovalService({ confirm: async () => true, ttlMs: 60000, runId: 'run-a' });
  const token = await svc.request({ capability: 'workspace.write', level: 'WRITE', what: 'workbench_edit', scope: ['workspace.write:src/*'], toolCallId: 'call_1' });
  assert.ok(token && token.id, '批准后必须签发令牌');
  assert.ok(token.expiresAt, '令牌必须带有效期');
  assert.strictEqual(token.toolCallId, 'call_1', '令牌必须绑定 toolCallId');
  const first = svc.verify(token, { capability: 'workspace.write', scope: ['workspace.write:src/a.ts'], toolCallId: 'call_1' });
  assert.strictEqual(first.valid, true, '首次校验应通过（通配 scope 覆盖子路径）');
  const second = svc.verify(token, { capability: 'workspace.write', scope: ['workspace.write:src/a.ts'], toolCallId: 'call_1' });
  assert.strictEqual(second.valid, false);
  assert.strictEqual(second.reason, 'ALREADY_CONSUMED', '一次批准只够一次调用');
  ok('A 令牌签发/绑定/单次消费');

  // ---- B. 过期 ----
  const shortSvc = approvalLib.createApprovalService({ confirm: async () => true, ttlMs: 1 });
  const shortToken = await shortSvc.request({ capability: 'x', what: 'y', scope: [] });
  await sleep(5);
  const expired = shortSvc.verify(shortToken, {});
  assert.strictEqual(expired.valid, false);
  assert.strictEqual(expired.reason, 'EXPIRED', '过期令牌必须被拒');
  ok('B 过期令牌被拒（EXPIRED）');

  // ---- C. 能力 / scope / 调用绑定 ----
  const svc2 = approvalLib.createApprovalService({ confirm: async () => true });
  const t2 = await svc2.request({ capability: 'workspace.write', what: 'w', scope: ['workspace.write:src/*'], toolCallId: 'call_a' });
  assert.strictEqual(svc2.verify(t2, { capability: 'project.save', scope: ['workspace.write:src/a.ts'] }).reason, 'CAPABILITY_MISMATCH');
  assert.strictEqual(svc2.verify(t2, { capability: 'workspace.write', scope: ['workspace.write:docs/readme.md'] }).reason, 'SCOPE_MISMATCH');
  assert.strictEqual(svc2.verify(t2, { capability: 'workspace.write', scope: ['workspace.write:src/a.ts'], toolCallId: 'call_b' }).reason, 'TOOL_CALL_MISMATCH');
  assert.strictEqual(svc2.verify('apv_not_exists', {}).reason, 'UNKNOWN_TOKEN', '伪造令牌必须被拒');
  ok('C 能力/scope/调用绑定逐项校验（含伪造令牌）');

  // ---- D/E. 无通道 / 用户拒绝 / 抛异常 ----
  const noChannel = approvalLib.createApprovalService({ confirm: null });
  assert.strictEqual(noChannel.available(), false, '没有 confirm 通道时 available() 为 false');
  assert.strictEqual(await noChannel.request({ what: 'x', scope: [] }), null, '没有通道不得签发令牌');
  const denied = approvalLib.createApprovalService({ confirm: async () => false });
  assert.strictEqual(await denied.request({ what: 'x', scope: [] }), null, '用户拒绝不得签发令牌');
  const boom = approvalLib.createApprovalService({ confirm: async () => { throw new Error('桥断了'); } });
  assert.strictEqual(await boom.request({ what: 'x', scope: [] }), null, '确认通道抛异常也不得签发令牌');
  ok('D/E 无通道 / 用户拒绝 / 通道异常都不签发令牌');

  // ---- F. 撤销 ----
  const svc3 = approvalLib.createApprovalService({ confirm: async () => true });
  const t3 = await svc3.request({ what: 'a', scope: [] });
  const t4 = await svc3.request({ what: 'b', scope: [] });
  assert.strictEqual(svc3.pending().length, 2);
  assert.strictEqual(svc3.revoke(t3.id), true);
  assert.strictEqual(svc3.verify(t3, {}).reason, 'UNKNOWN_TOKEN', '已撤销令牌必须失效');
  assert.strictEqual(svc3.revokeAll(), 1, 'revokeAll 返回撤销数量');
  assert.strictEqual(svc3.verify(t4, {}).reason, 'UNKNOWN_TOKEN');
  ok('F 撤销与批量撤销');

  // ============ 集成层 ============
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-approval-'));
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);

  // ---- G. 声明层：确认类写工具都声明了确认且真的强制 ----
  const declRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
  // 注意：create_nodes 已不在 BUILTINS 里（画布写入口统一到 workbench_edit），所以按**实际注册**的工具断言；
  // 它的模块里同样加了 declareContract，将来若重新注册就自带审批。
  const declared = ['save_project', 'workbench_edit', 'create_nodes', 'ui_control'].filter((name) => declRegistry.descriptorOf(name));
  assert.ok(declared.length >= 3, '至少三个确认类写工具在注册表里（实际 ' + declared.join(',') + '）');
  for (const name of declared) {
    const descriptor = declRegistry.descriptorOf(name);
    assert.strictEqual(descriptor.requiresConfirmation, 'WRITE', name + ' 必须声明 requiresConfirmation=WRITE');
    assert.strictEqual(descriptor.confirmationEnforced, true, name + ' 的确认必须真的强制（confirmationEnforced）');
  }
  ok('G 确认类写工具声明并强制了确认（' + declared.join(' / ') + '）');

  // ---- H. 模型自填 confirmed 无效（参数被剥离，审批照走） ----
  /** @type {any} */
  let sawArgs = null;
  function makeRegistry(confirmHandler) {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: [] });
    registry.registerDescriptor(
      {
        name: 'guarded_write',
        version: '1',
        description: '测试替身：需要审批的写工具',
        // 故意**不设** additionalProperties:false —— 用来说明「即使 schema 宽松，自填也不会被采信」
        inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
        readOnly: false,
        mutatesWorkspace: true,
        requiresConfirmation: 'WRITE',
        requiredCapability: 'workspace.write',
        timeoutMs: 0,
        cachePolicy: { mode: 'none' },
        retryPolicy: { maxAttempts: 1, backoff: 'none', retryOn: [] },
        concurrencyPolicy: { parallelSafe: false },
        roleAllowlist: null,
      },
      async (context, args) => {
        sawArgs = args;
        return AgentToolResult.ok('已写入 ' + String(args.target || ''), { target: args.target || null });
      },
    );
    return { registry, context: new AgentToolContext({ projectRoot: root, confirm: confirmHandler, audit: () => {}, runId: 'run-g' }) };
  }

  // H1：没有审批通道时，模型自填 confirmed 也换不来执行
  {
    const { registry, context } = makeRegistry(null);
    const result = await registry.execute('guarded_write', { target: 'a.txt', confirmed: true, approved: true }, context);
    assert.strictEqual(result.ok, false, '自填 confirmed 不能让工具直接执行');
    assert.strictEqual(result.data.code, 'APPROVAL_REQUIRED', '应报没有审批通道');
    assert.strictEqual(sawArgs, null, '工具体一次都不能被调用');
  }
  // H2：有通道且用户批准 → 执行成功，且工具收到的参数里**没有**自填字段
  {
    const { registry, context } = makeRegistry(async () => true);
    const result = await registry.execute('guarded_write', { target: 'b.txt', confirmed: true, approvalToken: 'apv_fake' }, context);
    assert.strictEqual(result.ok, true, '批准后应正常执行');
    assert.ok(sawArgs && !Object.prototype.hasOwnProperty.call(sawArgs, 'confirmed'), '自填 confirmed 必须被剥离');
    assert.ok(!Object.prototype.hasOwnProperty.call(sawArgs, 'approvalToken'), '自填 approvalToken 必须被剥离');
    assert.strictEqual(sawArgs.target, 'b.txt', '正常参数必须保留');
    ok('H 模型自填审批字段一律无效（无通道则拒绝；批准后也被剥离后才执行）');
  }
  // H3：用户拒绝 → 不执行 + APPROVAL_DENIED
  {
    const registry = makeRegistry(async () => false).registry;
    sawArgs = null;
    const result = await registry.execute('guarded_write', { target: 'c.txt' }, new AgentToolContext({ projectRoot: root, confirm: async () => false, audit: () => {}, runId: 'run-g' }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.data.code, 'APPROVAL_DENIED');
    assert.strictEqual(sawArgs, null, '拒绝后工具体不得执行');
    ok('H3 用户拒绝 → 工具不执行（APPROVAL_DENIED）');
  }
  // H4：令牌单次有效 —— 同一 toolCallId 连续两次执行，第二次拿不到新令牌（批准一次只够一次）
  {
    let approvals = 0;
    const { registry, context } = makeRegistry(async () => { approvals += 1; return true; });
    const first = await registry.execute('guarded_write', { target: 'd.txt' }, context, { turnId: 0, toolCallId: 'call_once' });
    const second = await registry.execute('guarded_write', { target: 'd.txt' }, context, { turnId: 0, toolCallId: 'call_once' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(approvals, 2, '每次执行都要各自获批一次（令牌不跨调用复用）');
    assert.strictEqual(context.approval().pending().length, 0, '执行后不得留下未消费的令牌');
    ok('H4 每次执行各自获批、令牌不残留');
  }

  // H5：令牌校验失败（即便用户点了批准）→ 拒绝执行。用桩把 verify 换成「范围不匹配」，
  // 验证注册表真的是拿**校验结论**说话，而不是「用户批了就放行」。
  {
    const { registry, context } = makeRegistry(async () => true);
    const service = context.approval();
    const originalVerify = service.verify.bind(service);
    service.verify = () => ({ valid: false, reason: 'SCOPE_MISMATCH' });
    sawArgs = null;
    const result = await registry.execute('guarded_write', { target: 'f.txt' }, context, { turnId: 0, toolCallId: 'call_verify' });
    service.verify = originalVerify;
    assert.strictEqual(result.ok, false, '令牌校验失败必须拒绝执行');
    assert.strictEqual(result.data.code, 'APPROVAL_DENIED');
    assert.ok(String(result.text).includes('SCOPE_MISMATCH'), '失败原因要如实带出来（便于归因）');
    assert.strictEqual(sawArgs, null, '令牌无效时工具体不得执行');
    ok('H5 令牌校验失败 → 拒绝执行（不因「用户已批准」就放行）');
  }

  // ---- I. 配置开关：tools.confirm_writes=false 整体关闭 ----
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: [], toolsConfirmWrites: false });
    let ran = false;
    registry.registerDescriptor(
      {
        name: 'guarded_write2',
        version: '1',
        description: '测试替身 2',
        inputSchema: { type: 'object', properties: {} },
        readOnly: false,
        mutatesWorkspace: true,
        requiresConfirmation: 'WRITE',
        requiredCapability: 'workspace.write',
        timeoutMs: 0,
        cachePolicy: { mode: 'none' },
        retryPolicy: { maxAttempts: 1, backoff: 'none', retryOn: [] },
        concurrencyPolicy: { parallelSafe: false },
        roleAllowlist: null,
      },
      async () => {
        ran = true;
        return AgentToolResult.ok('wrote');
      },
    );
    assert.strictEqual(registry.confirmWrites, false, '配置必须下发到注册表');
    const result = await registry.execute('guarded_write2', {}, new AgentToolContext({ projectRoot: root, audit: () => {}, runId: 'run-i' }));
    assert.strictEqual(result.ok, true, '关闭确认后即使没有审批通道也应执行');
    assert.strictEqual(ran, true);
    ok('I tools.confirm_writes=false 可整体关闭（声明仍在，强制可关）');
  }

  // ---- J. 主循环层：脚本化模型跑真实工具循环 ----
  async function runTurn(script, confirmHandler, extraToolsCfg) {
    const controller = new AbortController();
    sawArgs = null;
    const context = new AgentToolContext({
      projectRoot: root,
      confirm: confirmHandler,
      audit: () => {},
      askUser: async () => '',
      ragConfig: { enabled: false },
      sandbox: policy,
      signal: controller.signal,
      runId: 'run-j',
    });
    const { registry } = makeRegistry(confirmHandler);
    const stub = installScriptedModel(script, { loopLast: false });
    try {
      const result = await agent.runAgentChat({
        cfg: {
          apiBase: 'http://scripted.local/v1',
          apiKey: '',
          model: 'scripted-model',
          maxTokens: 2048,
          reasoningEffort: '',
          reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
          limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
          compression: { enabled: false },
          rag: { enabled: false },
          tools: extraToolsCfg || {},
        },
        messages: [{ role: 'system', content: '测试用 system' }, { role: 'user', content: '请完成测试任务' }],
        tools: { registry, context },
        signal: controller.signal,
        onDelta: () => {},
      });
      return { result, seen: stub.seen };
    } finally {
      stub.restore();
    }
  }

  const script = [
    { toolCalls: [{ name: 'guarded_write', args: { target: 'e.txt' }, id: 'call_j' }], finishReason: 'tool_calls' },
    { content: '完成。', finishReason: 'stop' },
  ];
  const approved = await runTurn(script, async () => true);
  assert.strictEqual(sawArgs && sawArgs.target, 'e.txt', '批准路径必须真的执行工具');
  const deniedTurn = await runTurn(script, async () => false);
  const toolMessage = deniedTurn.seen[1].messages.find((m) => m.role === 'tool');
  assert.ok(/未批准|跳过/.test(String(toolMessage.content)), '拒绝路径必须把「未批准」如实回灌');
  const nudge = deniedTurn.seen.slice(1).flatMap((req) => req.messages).find((m) => m.role === 'user' && String(m.content).includes('【系统提示】'));
  assert.ok(nudge, '拒绝后必须有失败提示（接 S5 的分类化提示）');
  assert.ok(String(nudge.content).includes('权限'), '审批拒绝必须归到权限类（劝退原样重试）');
  ok('J 主循环：批准才执行、拒绝即不执行并归到权限类提示');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('approval token ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
