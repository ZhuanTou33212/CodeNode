/**
 * multi-agent-integrity-test.cjs —— 多 Agent 信息完整性的 P2/P3/P4 落地判据
 *
 * 覆盖四块（全都能在离线环境确定性复现）：
 *   A. GraphModel **单调 revision**（信封 snapshot.revision 的真值来源，跨请求 round-trip）
 *   B. **接收侧核验**（verifyEnvelope）：产物哈希重算 / 画布快照重算 → valid / stale / invalid，
 *      以及 get_subagent_task 端到端拒收 + trust 降级 + audit 留痕
 *   C. **跨 Agent 资源租约**（P3「单一写者」）：原子申请、续期、TTL、按持有者隔离；
 *      registry.execute 层的闸门（同文件被占用 → RESOURCE_LOCKED；读/别的文件不受影响）
 *   D. **乐观并发写入**（P3 另一半）：write_file / edit_file 的 expectedSha256（含 'absent'），
 *      校验失败必须**不写盘**并返回 CONFLICT_STALE
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const envelopeLib = require('../electron/subagentEnvelope.cjs');
const { LeaseRegistry, resourceKeysFor } = require('../electron/tools/leases.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const failures = require('../electron/tools/failures.cjs');
const { sha256OfText } = require('../electron/tools/impl/shared.cjs');

let failuresCount = 0;
function check(label, fn) {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (error) {
    failuresCount++;
    console.log('FAIL  ' + label + ' :: ' + (error && error.message ? error.message : error));
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-mai-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function makeContext(over = {}) {
  const controller = new AbortController();
  const audits = [];
  const context = new AgentToolContext({
    projectRoot: root,
    model: over.model || new GraphModel({ root: { nodes: [], edges: [] } }),
    confirm: async () => true,
    audit: (line) => audits.push(String(line)),
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
    taskId: over.taskId || '',
    role: over.role || 'supervisor',
    ...(over.extra || {}),
  });
  return { context, audits, controller };
}

function registryFor(leases, over = {}) {
  const registry = toolkit.buildDefaultRegistryWithConfig({
    projectRoot: root,
    ragEnabled: false,
    leases,
    ...(over.config || {}),
  });
  return registry;
}

(async () => {
  // ================= A. GraphModel revision =================
  check('[A] revision 随变更单调递增，且写进文档供 round-trip', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    assert.strictEqual(model.revision, 0);
    const node = model.addNode('task', { label: 'a' }, 10, 20);
    assert.strictEqual(model.revision, 1);
    assert.strictEqual(model.doc.root.revision, 1, '必须写进文档（否则跨请求就丢了）');
    model.addEdge(node.id, 'other');
    model.removeNode(node);
    assert.strictEqual(model.revision, 3, '每次变更 +1');
    const roundTripped = new GraphModel(JSON.parse(JSON.stringify(model.doc)));
    assert.strictEqual(roundTripped.revision, 3, '新实例从文档接着数');
    assert.strictEqual(roundTripped.bumpRevision(), 4);
  });

  check('[A] 信封带的是**真 revision**（不再是 null）', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    model.addNode('task', { label: 'x' }, 0, 0);
    const built = envelopeLib.buildEnvelope({
      task: { taskId: 't1', runId: 'r1', role: 'builder', objective: 'o', status: 'done', summary: '结论', toolCalls: [] },
      projectRoot: root,
      model,
    });
    assert.strictEqual(built.envelope.snapshot.revision, 1, 'JSON: ' + JSON.stringify(built.envelope.snapshot));
    assert.strictEqual(built.violations.length, 0);
  });

  // ================= B. 接收侧核验 =================
  const artifact = path.join(root, 'artifact.txt');
  fs.writeFileSync(artifact, 'v1');

  check('[B] 什么都没变 → valid；产物哈希用的是同一口径', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const built = envelopeLib.buildEnvelope({
      task: {
        taskId: 't2', runId: 'r1', role: 'builder', objective: 'o', status: 'done', summary: '结论',
        toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'artifact.txt' }) }],
      },
      projectRoot: root,
      model,
    });
    // 交叉核对：信封里的哈希必须等于 shared.cjs（工具侧）的口径，否则两边永远对不上
    assert.strictEqual(built.envelope.evidence.files[0].sha256, sha256OfText('v1'), '哈希口径必须一致');
    const verdict = envelopeLib.verifyEnvelope(built.envelope, { projectRoot: root, model });
    assert.strictEqual(verdict.verdict, 'valid', JSON.stringify(verdict.reasons));
    assert.strictEqual(verdict.files[0].ok, true);
  });

  check('[B] 产物在报告后被改 → invalid（不得作为结论证据）', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const built = envelopeLib.buildEnvelope({
      task: {
        taskId: 't3', runId: 'r1', role: 'builder', objective: 'o', status: 'done', summary: '结论',
        toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'artifact.txt' }) }],
      },
      projectRoot: root,
      model,
    });
    fs.writeFileSync(artifact, '被别人改过了');
    const verdict = envelopeLib.verifyEnvelope(built.envelope, { projectRoot: root, model });
    assert.strictEqual(verdict.verdict, 'invalid');
    assert.ok(/不一致/.test(verdict.reasons.join(' ')), JSON.stringify(verdict.reasons));
    fs.writeFileSync(artifact, 'v1'); // 还原
  });

  check('[B] 只有画布变了 → stale（结论可能过期，但不是造假）', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const built = envelopeLib.buildEnvelope({
      task: {
        taskId: 't4', runId: 'r1', role: 'builder', objective: 'o', status: 'done', summary: '结论',
        toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'artifact.txt' }) }],
      },
      projectRoot: root,
      model,
    });
    model.addNode('task', { label: '报告之后又加了一个节点' }, 0, 0); // 世界变了
    const verdict = envelopeLib.verifyEnvelope(built.envelope, { projectRoot: root, model });
    assert.strictEqual(verdict.verdict, 'stale', JSON.stringify(verdict.reasons));
    assert.ok(/又变过/.test(verdict.reasons.join(' ')));
  });

  check('[B] 声称「改了但文件不存在」，后来文件出现了 → invalid', () => {
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const built = envelopeLib.buildEnvelope({
      task: {
        taskId: 't5', runId: 'r1', role: 'builder', objective: 'o', status: 'done', summary: '结论',
        toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'late.txt' }) }],
      },
      projectRoot: root,
      model,
    });
    assert.strictEqual(built.envelope.evidence.files[0].exists, false);
    fs.writeFileSync(path.join(root, 'late.txt'), '后来出现的');
    const verdict = envelopeLib.verifyEnvelope(built.envelope, { projectRoot: root, model });
    assert.strictEqual(verdict.verdict, 'invalid');
    assert.ok(/现在存在/.test(verdict.reasons.join(' ')), JSON.stringify(verdict.reasons));
  });

  // ---- get_subagent_task 端到端：产物被改 → 拒收 + trust 降级 + audit ----
  {
    const manager = new SubagentManager({
      agent: {
        runAgentChat: async () => ({
          content: '结论：写完了',
          toolCalls: [{ name: 'write_file', ok: true, args: JSON.stringify({ path: 'artifact.txt' }) }],
          usage: { total_tokens: 10 },
        }),
      },
      toolkit,
      cfg: { tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] }, rag: { enabled: false }, subagent: {} },
      registry: registryFor(null),
      runId: 'run-mai',
    });
    const parent = registryFor(null);
    manager.register(parent);
    const { context, audits } = makeContext();
    const done = await parent.execute('delegate_task', { role: 'builder', objective: '写文件' }, context);
    check('[B] 子代理正常交付时，信封里有真 revision 与产物哈希', () => {
      assert.strictEqual(done.ok, true, String(done.text).slice(0, 200));
      assert.strictEqual(done.data.envelope.snapshot.revision, 0, '空画布未变更 → revision 0');
      assert.ok(/^sha256:[0-9a-f]{64}$/.test(done.data.envelope.evidence.files[0].sha256));
    });
    const taskId = done.data.taskId;
    const fresh = await parent.execute('get_subagent_task', { taskId }, context);
    check('[B] 未改动时 get_subagent_task 给出 verification=valid（可采信）', () => {
      assert.strictEqual(fresh.ok, true);
      assert.strictEqual(fresh.data.verification.verdict, 'valid', JSON.stringify(fresh.data.verification));
    });
    fs.writeFileSync(artifact, '被第三方改过');
    const tampered = await parent.execute('get_subagent_task', { taskId }, context);
    check('[B] 产物被改后 get_subagent_task **拒收**（工具结果 error + 明确原因）', () => {
      assert.strictEqual(tampered.ok, false, '核验不通过必须拒收');
      assert.ok(/接收侧核验未通过/.test(String(tampered.text)), String(tampered.text).slice(0, 120));
      assert.ok(/不一致/.test(String(tampered.text)));
    });
    check('[B] 拒收时 trust 降级为 untrusted 并留 audit', () => {
      assert.strictEqual(tampered.data.envelope.trust, 'untrusted');
      assert.ok(String(tampered.data.envelope.verificationNote || '').length > 0, '必须带核验说明');
      assert.ok(audits.join('\n').includes('subagent_verification_failed'), 'audit 里要能查到');
    });
    fs.writeFileSync(artifact, 'v1');
  }

  // ================= C. 资源租约 =================
  check('[C] 租约：别人持有时拒绝、同一持有者续期、按持有者隔离', () => {
    const leases = new LeaseRegistry({ ttlMs: 1000 });
    const first = leases.acquire(['file:/tmp/a'], 'task-1', { role: 'builder' });
    assert.strictEqual(first.ok, true);
    const second = leases.acquire(['file:/tmp/a'], 'task-2', { role: 'builder' });
    assert.strictEqual(second.ok, false, '别的持有者必须被拒');
    assert.strictEqual(second.conflict.holder, 'task-1');
    assert.strictEqual(leases.acquire(['file:/tmp/a'], 'task-1').ok, true, '同一持有者重复申请 = 续期');
    assert.strictEqual(leases.acquire(['file:/tmp/b'], 'task-2').ok, true, '别的资源互不影响');
    assert.deepStrictEqual(leases.held('task-1'), ['file:/tmp/a']);
  });

  check('[C] 租约：多资源申请是**原子**的（一个被占 → 一个都不占）', () => {
    const leases = new LeaseRegistry();
    leases.acquire(['file:/tmp/x'], 'task-1');
    const batch = leases.acquire(['file:/tmp/y', 'file:/tmp/x'], 'task-2');
    assert.strictEqual(batch.ok, false);
    assert.deepStrictEqual(leases.held('task-2'), [], '不能留下一半占用（那就是死锁）');
    assert.strictEqual(leases.holder('file:/tmp/y'), null);
  });

  check('[C] 租约：释放只有持有者能放，TTL 到期自动回收', () => {
    let now = 1000;
    const leases = new LeaseRegistry({ ttlMs: 100, now: () => now });
    leases.acquire(['file:/tmp/z'], 'task-1');
    assert.strictEqual(leases.release(['file:/tmp/z'], 'task-9'), 0, '别人放不掉');
    assert.strictEqual(leases.holder('file:/tmp/z').holder, 'task-1');
    now += 101;
    assert.strictEqual(leases.holder('file:/tmp/z'), null, 'TTL 到期即失效（持有者崩了也不永久占住）');
    assert.strictEqual(leases.acquire(['file:/tmp/z'], 'task-2').ok, true);
    assert.strictEqual(leases.releaseAll('task-2'), 1);
  });

  check('[C] 资源键推导：写工具才有键，读工具没有；同一文件的不同写法归一到同一把锁', () => {
    const keys1 = resourceKeysFor('write_file', { path: 'a/b.txt' }, { projectRoot: root });
    assert.deepStrictEqual(keys1, resourceKeysFor('write_file', { filePath: path.join(root, 'a', 'b.txt') }, { projectRoot: root }), '相对/绝对路径必须归一到同一键');
    assert.deepStrictEqual(resourceKeysFor('read_file', { path: 'a/b.txt' }, { projectRoot: root }), [], '读不加锁');
    assert.deepStrictEqual(resourceKeysFor('workbench_edit', {}, { projectRoot: root }), ['resource:canvas']);
    const bulk = resourceKeysFor('bulk_edit', { edits: [{ path: 'a.txt' }, { path: 'a.txt' }] }, { projectRoot: root });
    assert.strictEqual(bulk.length, 1, '同一文件的重复出现只占一把锁');
  });

  // ---- registry.execute 层：闸门真的生效 ----
  {
    const leases = new LeaseRegistry();
    const registry = registryFor(leases);
    const a = makeContext({ taskId: 'sub-a', role: 'builder' });
    const b = makeContext({ taskId: 'sub-b', role: 'builder' });
    const writer = (ctx, file, content) => registry.execute('write_file', { path: file, content }, ctx.context);

    const first = await writer(a, 'shared.txt', 'A 写的');
    check('[C] 第一个写者拿到租约并写成功', () => {
      assert.strictEqual(first.ok, true, String(first.text));
      assert.ok(leases.holder('file:' + path.join(root, 'shared.txt').split(path.sep).join('/')));
    });

    const second = await writer(b, 'shared.txt', 'B 写的');
    check('[C] 第二个 Agent 写同一文件 → RESOURCE_LOCKED（可重试 + 说清谁持有）', () => {
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.failure.code, 'RESOURCE_LOCKED');
      assert.strictEqual(second.failure.retryable, true, '要能重试（等对方结束）');
      assert.ok(/sub-a/.test(String(second.text)), '必须说清谁持有：' + String(second.text).slice(0, 120));
      assert.strictEqual(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'A 写的', '被拒时不得改盘');
    });
    check('[C] RESOURCE_LOCKED 走的是失败码表（分类/nudge 都能用）', () => {
      const classified = failures.classifyFailure({ data: { failureCode: 'RESOURCE_LOCKED' }, text: '资源被占用' });
      assert.strictEqual(classified.code, 'RESOURCE_LOCKED');
      assert.strictEqual(classified.category, 'conflict');
      assert.ok(/写冲突/.test(failures.buildFailureNudge([classified])), '提示要带写冲突指引');
    });

    const otherFile = await writer(b, 'b-only.txt', 'B 自己的文件');
    check('[C] 不同文件的写不受影响（锁的是资源，不是全局串行）', () => {
      assert.strictEqual(otherFile.ok, true, String(otherFile.text));
    });

    const read = await registry.execute('read_file', { path: 'shared.txt' }, b.context);
    check('[C] 读不加锁：被占用时仍然读得到', () => {
      assert.strictEqual(read.ok, true);
      assert.ok(/A 写的/.test(String(read.text)), String(read.text).slice(0, 80));
    });

    leases.releaseAll('sub-a');
    const afterRelease = await writer(b, 'shared.txt', 'B 在 A 结束后写');
    check('[C] A 释放后 B 可以写（写的是最新内容，不是覆盖旧值）', () => {
      assert.strictEqual(afterRelease.ok, true, String(afterRelease.text));
      assert.strictEqual(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'B 在 A 结束后写');
    });
  }

  // ---- 子代理任务结束时自动释放租约 ----
  {
    const leases = new LeaseRegistry();
    /** 子代理运行**期间**它占了哪些锁（在 stub 里就地观测，防止判据空转） */
    let heldDuringRun = null;
    const manager = new SubagentManager({
      agent: {
        // 注意：stub 必须**真的执行一次写工具**（走 registry.execute）才会拿到租约 ——
        // 只回一个 toolCalls 列表是不占锁的，那样「任务结束释放」这条判据会空转（变异测试实测）
        runAgentChat: async ({ tools }) => {
          const res = await tools.registry.execute('write_file', { path: 'by-sub.txt', content: 'x' }, tools.context);
          heldDuringRun = leases.held(tools.context.taskId());
          return {
            content: res.ok ? '结论：写完了' : '结论：写失败：' + String(res.text),
            toolCalls: [{ name: 'write_file', ok: !!res.ok, args: JSON.stringify({ path: 'by-sub.txt' }) }],
            usage: { total_tokens: 5 },
          };
        },
      },
      toolkit,
      cfg: { tools: { toolsEnabled: true, toolsAllowed: [], toolsDeny: [] }, rag: { enabled: false }, subagent: {} },
      registry: registryFor(leases),
      runId: 'run-lease',
      leases,
    });
    const parent = registryFor(leases);
    manager.register(parent);
    const { context } = makeContext();
    await parent.execute('delegate_task', { role: 'builder', objective: '写文件' }, context);
    check('[C] 子代理运行期间确实持有租约（防判据空转）', () => {
      assert.ok(Array.isArray(heldDuringRun) && heldDuringRun.length === 1, 'stub 里观测到：' + JSON.stringify(heldDuringRun));
      assert.ok(leases.snapshot().counters.acquired >= 1, 'JSON: ' + JSON.stringify(leases.snapshot().counters));
    });
    check('[C] 子代理任务结束 → 它持有的租约全部释放', () => {
      assert.deepStrictEqual(leases.snapshot().held, [], 'JSON: ' + JSON.stringify(leases.snapshot()));
    });
  }

  // ================= D. 乐观并发写入 =================
  {
    const leases = new LeaseRegistry();
    const registry = registryFor(leases);
    const ctx = makeContext({ taskId: 'opc', role: 'builder' });
    const target = path.join(root, 'opc.txt');
    fs.writeFileSync(target, 'v1');
    const v1Hash = sha256OfText('v1');

    const stale = await registry.execute('write_file', { path: 'opc.txt', content: 'v2（基于旧版本）', expectedSha256: v1Hash }, ctx.context);
    check('[D] expectedSha256 对得上 → 写成功并回传新哈希（交接棒）', () => {
      assert.strictEqual(stale.ok, true, String(stale.text));
      assert.strictEqual(stale.data.sha256, sha256OfText('v2（基于旧版本）'));
    });

    const conflict = await registry.execute(
      'write_file',
      { path: 'opc.txt', content: 'v3（仍然基于 v1）', expectedSha256: v1Hash },
      ctx.context
    );
    check('[D] 期望值已过期 → CONFLICT_STALE，且**不写盘**', () => {
      assert.strictEqual(conflict.ok, false);
      assert.strictEqual(conflict.failure.code, 'CONFLICT_STALE');
      assert.strictEqual(conflict.failure.retryable, false, '不该原样重试，要先读回最新内容');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'v2（基于旧版本）', '失败必须不落盘');
    });

    const okay = await registry.execute('write_file', { path: 'opc.txt', content: 'v3（基于 v2）', expectedSha256: stale.data.sha256 }, ctx.context);
    check('[D] 用回传的新哈希重做 → 成功', () => {
      assert.strictEqual(okay.ok, true, String(okay.text));
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'v3（基于 v2）');
    });

    const absentFail = await registry.execute('write_file', { path: 'opc.txt', content: 'x', expectedSha256: 'absent' }, ctx.context);
    const absentOk = await registry.execute('write_file', { path: 'brand-new.txt', content: 'new', expectedSha256: 'absent' }, ctx.context);
    check('[D] expectedSha256="absent"：要求「不存在」，已存在则拒、不存在则建', () => {
      assert.strictEqual(absentFail.ok, false);
      assert.strictEqual(absentFail.failure.code, 'CONFLICT_STALE');
      assert.strictEqual(absentOk.ok, true, String(absentOk.text));
      assert.strictEqual(fs.readFileSync(path.join(root, 'brand-new.txt'), 'utf8'), 'new');
    });

    const editStale = await registry.execute(
      'edit_file',
      { path: 'opc.txt', oldText: 'v3', newText: 'v4', expectedSha256: v1Hash },
      ctx.context
    );
    check('[D] edit_file 同样支持 expectedSha256（校验失败不改盘）', () => {
      assert.strictEqual(editStale.ok, false);
      assert.strictEqual(editStale.failure.code, 'CONFLICT_STALE');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'v3（基于 v2）');
    });
    const editOk = await registry.execute(
      'edit_file',
      { path: 'opc.txt', oldText: 'v3', newText: 'v4', expectedSha256: okay.data.sha256 },
      ctx.context
    );
    check('[D] edit_file 期望值正确 → 改动成功并回传新哈希', () => {
      assert.strictEqual(editOk.ok, true, String(editOk.text));
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'v4（基于 v2）');
      assert.strictEqual(editOk.data.sha256, sha256OfText('v4（基于 v2）'));
    });
  }

  console.log(failuresCount === 0 ? 'MULTI-AGENT INTEGRITY TEST: PASS' : 'MULTI-AGENT INTEGRITY TEST: FAIL (' + failuresCount + ')');
  process.exitCode = failuresCount === 0 ? 0 : 1;
})().catch((error) => {
  console.error('MULTI-AGENT INTEGRITY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
