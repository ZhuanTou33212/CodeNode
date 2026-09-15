/**
 * runtime-gate.cjs —— 运行时生产门槛（可执行断言，不是「源码里出现过某个字符串」）
 *
 * 与 production-gate.cjs 的分工：后者验证 Electron 安全基线与既有运行记录能力；
 * 本文件验证 2026-09-14 这轮补齐的三块运行时能力是否真的接线可用：
 *   1. 执行隔离（sandbox.cjs）：后端可用 + strict 语义为 fail-closed + 边界说明可生成
 *   2. 断点续跑与副作用幂等（runCheckpoint.cjs / sideEffects.cjs）：auto/review 判定 + 去重
 *   3. 成本账本与告警（costLedger.cjs / alerts.cjs）：记账、计价、阈值触发、落盘
 *
 * 任何一项失败 → 非 0 退出，CI 与本地门禁同样生效。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const runStore = require('../electron/runStore.cjs');
const runCheckpoint = require('../electron/runCheckpoint.cjs');
const { SideEffectLedger, createGuard, digest, idempotencyKey } = require('../electron/sideEffects.cjs');
const { CostLedger, parsePrices, costOf } = require('../electron/costLedger.cjs');
const { AlertDispatcher, evaluateAlertRules, parseThresholds } = require('../electron/alerts.cjs');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function cleanup(dir) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) cleanup(full);
    else try { fs.unlinkSync(full); } catch {}
  }
  try { fs.rmdirSync(dir); } catch {}
}

async function main() {
  // 0. 模块必须真的接进主进程（避免「写了模块但没接线」的假完成）。
  //    "主进程源码"含 electron/ipc/*.cjs —— 按域拆模块之后只看 main.cjs 会把已迁移误报成未接线。
  const mainSource = require('./lib/main-process-source.cjs').readMainProcessSource();
  for (const pattern of [/sandbox\.resolvePolicy/, /new CostLedger\(/, /new SideEffectLedger\(/, /runCheckpoint\.planResume/, /agent:metrics/, /AlertDispatcher/]) {
    assert.ok(pattern.test(mainSource), '主进程未接线：' + pattern);
  }
  // 拆出的每个 IPC 模块都必须被 main.cjs 真正 require+register（拆模块 ≠ 接线）。
  // 这条是有教训的：把 agent:chat 那一大块搬走时，连带删掉了夹在中间的 models/metrics register 调用，
  // 只按"源码里出现过通道名"的检查看不出来。
  const mainOnly = read('electron/main.cjs');
  const ipcDir = path.join(__dirname, '..', 'electron', 'ipc');
  for (const name of fs.readdirSync(ipcDir).sort()) {
    if (!name.endsWith('.cjs')) continue;
    assert.ok(mainOnly.includes(`require('./ipc/${name}')`), `IPC 模块未被 main.cjs 接线：electron/ipc/${name}`);
  }
  const shellTool = read('electron/tools/impl/executeShellTool.cjs');
  assert.ok(/sandbox\.guardedSpawn/.test(shellTool), 'execute_shell 未接入执行隔离层');
  const extensions = read('electron/tools/extensions.cjs');
  assert.ok(/sandbox\.guardedSpawn/.test(extensions) && /sandbox\.guardedMcpSpawn/.test(extensions), '扩展/MCP 未接入执行隔离层');
  const agentSource = read('electron/agent.cjs');
  assert.ok(/beginSideEffect/.test(agentSource) && /recordCost/.test(agentSource), 'Agent 工具循环未接入幂等/成本');

  const cfg = agent.loadConfig(path.join(__dirname, '..'));
  assert.ok(cfg.sandbox && typeof cfg.sandbox.mode === 'string', 'sandbox 配置未解析');
  assert.ok(['off', 'best-effort', 'strict'].includes(cfg.sandbox.mode), 'sandbox.mode 非法：' + cfg.sandbox.mode);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-runtime-gate-'));
  try {
    // ---- 1. 执行隔离 ----
    const caps = sandbox.capabilities({ cacheDir: path.join(temp, 'sandbox') });
    assert.ok(caps && caps.backend, '隔离能力探测失败');
    if (process.platform === 'win32') assert.strictEqual(caps.backend, 'windows-job', 'Windows Job Object 后端不可用：' + caps.detail);
    const strictPolicy = sandbox.resolvePolicy({ mode: 'strict', requireFilesystem: true }, { projectRoot: temp, capabilities: caps });
    if (!caps.isolation.filesystem) {
      assert.ok(strictPolicy.unsatisfied.includes('filesystem'), 'strict 模式未把缺失的文件系统隔离标记为不满足');
      let failClosed = false;
      try {
        sandbox.guardedSpawn({ file: process.execPath, args: ['-e', '0'], cwd: temp, env: process.env }, { policy: strictPolicy });
      } catch (error) {
        failClosed = error && error.code === 'SANDBOX_UNAVAILABLE';
      }
      assert.ok(failClosed, 'strict 模式在隔离能力不足时必须拒绝执行（fail-closed）');
    }
    const bestEffort = sandbox.resolvePolicy({ mode: 'best-effort' }, { projectRoot: temp, capabilities: caps });
    assert.ok(sandbox.describe(bestEffort).includes('后端='), '隔离边界说明不可用');
    assert.ok(sandbox.withinWriteRoots(path.join(temp, 'inside.txt'), { writeRoots: [path.resolve(temp)] }), '可写根内路径被误拒');
    assert.strictEqual(sandbox.withinWriteRoots(path.join(os.homedir(), 'nope-gate.txt'), { writeRoots: [path.resolve(temp)] }), false, '可写根外路径未被拒绝');

    // ---- 2. 断点续跑 + 幂等 ----
    runStore.startRun(temp, 'gate-resume', { prompt: 'gate', model: 'test' });
    runCheckpoint.recordIntent(temp, 'gate-resume', {
      callId: 'c1', tool: 'execute_shell', argsDigest: digest('echo 1'), effect: 'unknown',
      idemKey: idempotencyKey('gate-resume', 'execute_shell', 'echo 1'),
    });
    const reviewPlan = runCheckpoint.planResume(temp, 'gate-resume', { ledger: new SideEffectLedger({ projectRoot: temp, scopeRunId: 'gate-resume' }) });
    assert.strictEqual(reviewPlan.mode, 'review', '结果未知的副作用必须判为人工复核，实际：' + reviewPlan.mode);
    assert.ok(reviewPlan.requiresReview === true, 'review 计划未标记需要复核');

    // 幂等场景同样必须先建 Run 记录：planResume 以 run_start 为前置，缺记录会（正确地）判为 unknown
    runStore.startRun(temp, 'gate-idem', { prompt: 'gate-idem', model: 'test' });
    const ledger = new SideEffectLedger({ projectRoot: temp, scopeRunId: 'gate-idem' });
    const guard = createGuard(ledger);
    const first = guard.begin('write_file', { path: 'x.txt', content: '1' });
    assert.strictEqual(first.skip, false, '首次写操作不应被跳过');
    guard.commit(first, { ok: true, result: 'ok' });
    assert.strictEqual(guard.begin('write_file', { path: 'x.txt', content: '1' }).skip, true, '幂等账本未去重');
    assert.strictEqual(guard.begin('write_file', { path: 'x.txt', content: '2' }).skip, false, '不同参数被误判为同一副作用');
    runCheckpoint.recordIntent(temp, 'gate-idem', {
      callId: 'c2', tool: 'write_file', argsDigest: digest({ path: 'x.txt', content: '1' }), effect: 'write',
      idemKey: idempotencyKey('gate-idem', 'write_file', { path: 'x.txt', content: '1' }),
    });
    const autoPlan = runCheckpoint.planResume(temp, 'gate-idem', { ledger });
    assert.strictEqual(autoPlan.mode, 'auto', '已提交写操作应可自动续跑（并跳过），实际：' + autoPlan.mode);
    assert.ok(autoPlan.skippedByLedger.length >= 1, '未产出幂等跳过清单');
    const resumeMessages = runCheckpoint.buildResumeMessages(autoPlan, { systemPrompt: 'sys' });
    assert.ok(resumeMessages[resumeMessages.length - 1].content.includes('断点续跑'), '续跑消息未生成');

    // ---- 3. 成本账本 + 告警 ----
    const prices = parsePrices({ 'cost.price.gate-model': '1,1' });
    assert.ok(prices['gate-model'], '单价解析失败');
    assert.ok(Math.abs(costOf('gate-model', { prompt_tokens: 1000000, completion_tokens: 0 }, prices) - 1) < 1e-9, '成本计算错误');
    const costLedger = new CostLedger({ projectRoot: temp, runId: 'gate-cost', prices });
    costLedger.record({ kind: 'main', model: 'gate-model', usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });
    costLedger.record({ kind: 'subagent', model: 'gate-model', usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 } });
    costLedger.record({ kind: 'embedding', model: 'unknown-model', usage: null, estimated: true });
    const summary = costLedger.summary('gate-cost');
    assert.strictEqual(summary.requests, 3, '统一账本未累计全部模型调用');
    assert.strictEqual(summary.totalTokens, 3000, 'token 累计错误：' + summary.totalTokens);
    assert.ok(Math.abs(summary.costUsd - 0.003) < 1e-9, '成本累计错误：' + summary.costUsd);
    assert.strictEqual(summary.costKnown, false, '未配置单价的调用应把 costKnown 置为 false（不编造费用）');

    const thresholds = parseThresholds({ 'alerts.run_tokens': '1000' });
    const alerts = evaluateAlertRules({ run: summary, today: summary, queue: {} }, thresholds);
    assert.ok(alerts.some((alert) => alert.id === 'run_tokens'), 'token 阈值告警未触发');
    const dispatcher = new AlertDispatcher({ projectRoot: temp, thresholds, cooldownMs: 1000 });
    const fired = await dispatcher.check({ run: summary, today: summary, queue: { waiting: 0, maxWaitMs: 0 } });
    assert.ok(Array.isArray(fired));
    assert.ok(fs.existsSync(path.join(temp, '.codenode', 'metrics', 'alerts.jsonl')), '告警未落盘');
    assert.ok(fs.existsSync(path.join(temp, '.codenode', 'metrics', 'cost.jsonl')), '成本账本未落盘');

    console.log('PRODUCTION GATE (runtime): PASS');
    console.log('  · 执行隔离后端: ' + caps.backend + ' ' + JSON.stringify(caps.isolation));
    console.log('  · 断点续跑: review/auto 判定正常，幂等账本去重正常');
    console.log('  · 成本账本: tokens=' + summary.totalTokens + ' cost=$' + summary.costUsd + '（含未计价模型时 costKnown=false）');
  } finally {
    cleanup(temp);
  }
}

main().catch((error) => {
  console.error('PRODUCTION GATE (runtime): FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
