/**
 * agent-resume-test.cjs —— 断点续跑 + 副作用幂等的真实回归
 *
 * 走的链路（不绕过 harness）：
 *   toolkit.buildDefaultRegistryWithConfig 装配真实工具 → agent.runAgentChat 真实工具循环
 *   → AgentToolContext 注入 runCheckpoint（检查点）+ sideEffects（幂等账本）
 *   → runCheckpoint.planResume / buildResumeMessages 生成续跑计划与续跑消息
 *   → 用 scripts/lib/scripted-model.cjs 替换 global.fetch 提供确定性的「模型」输出（离线、无 Key）
 *
 * 验证点：
 *   1. 中断后能从检查点判定「可自动续跑（auto）」而不是只标一个 interrupted
 *   2. 崩溃窗口（文件已写 + 账本已提交 + 检查点提交事件丢失）能靠幂等账本核对出来并跳过，不重复副作用
 *   3. 未提交的写操作 → 必须人工复核（review），不自动重放
 *   4. 结果未知的外部副作用（shell）→ 必须人工复核（review）
 *   5. 已完成 / 无检查点的 Run → complete / review（不假装能续跑）
 *   6. 续跑消息里带「已完成步骤」，模型能拿到恢复上下文（检查点里的对话快照）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const runStore = require('../electron/runStore.cjs');
const runCheckpoint = require('../electron/runCheckpoint.cjs');
const { SideEffectLedger, createGuard, digest, idempotencyKey } = require('../electron/sideEffects.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-resume-test-'));
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
fs.writeFileSync(path.join(root, 'note.txt'), 'hello resume\n');

let fetchStub = null;

function makeContext(runId, /** @type {{ scopeRunId?: string, onIntent?: Function, onCommit?: Function }} */ { scopeRunId, onIntent, onCommit } = {}) {
  const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: scopeRunId || runId });
  const guard = createGuard(ledger);
  const events = [];
  const context = new AgentToolContext({
    projectRoot: root,
    runId,
    confirm: async () => true,
    audit: (entry) => events.push({ kind: 'audit', entry: String(entry) }),
    sandbox: () => null,
    sideEffectGuard: {
      begin: async (tool, args) => {
        const result = await guard.begin(tool, args);
        if (onIntent) onIntent(tool, args, result);
        return result;
      },
      commit: async (token, info) => {
        const result = await guard.commit(token, info);
        if (onCommit) onCommit(token, info);
        return result;
      },
      fail: (token, error) => guard.fail(token, error),
    },
    checkpoint: (type, payload) => {
      if (type === 'messages') return runCheckpoint.saveMessages(root, runId, payload && payload.messages, { reason: payload && payload.reason });
      if (type === 'tool_intent') return runCheckpoint.recordIntent(root, runId, payload || {});
      if (type === 'tool_commit') return runCheckpoint.recordCommit(root, runId, payload || {});
      return null;
    },
    conversationHistory: () => [],
  });
  return { context, ledger, events };
}

function makeRegistry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file', 'write_file', 'edit_file', 'execute_shell'] });
}

function cfgFor() {
  return {
    apiBase: 'http://scripted.local/v1',
    apiKey: 'scripted',
    model: 'scripted-model',
    maxTokens: 2048,
    reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
    limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
    compression: { enabled: false },
    rag: { enabled: false },
    tools: {},
  };
}

async function runTurn(/** @type {{ runId: string, script: any, scopeRunId?: string, hooks?: any, signal?: AbortSignal, loopLast?: boolean }} */ { runId, script, scopeRunId, hooks, signal, loopLast }) {
  const { context, ledger } = makeContext(runId, { scopeRunId, ...(hooks || {}) });
  const registry = makeRegistry();
  fetchStub = installScriptedModel(script, { loopLast: loopLast !== false });
  try {
    const result = await agent.runAgentChat({
      cfg: cfgFor(),
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '请完成测试任务' },
      ],
      tools: { registry, context },
      signal,
      timeoutMs: 15000,
    });
    return { result, ledger };
  } finally {
    fetchStub.restore();
  }
}

(async () => {
  // ---------------------------------------------------------------- 场景 1：崩溃窗口的核对与跳过
  console.log('== 场景 1：写操作已提交但检查点丢失（崩溃窗口）→ 自动续跑 + 幂等跳过 ==');
  const runA = 'run-resume-a';
  runStore.startRun(root, runA, { prompt: '创建 a.txt 并读取 note.txt', model: 'scripted-model' });

  const scriptA = [
    { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'A' } }] },
    { toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'note.txt' } }] },
    { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'note.txt' } }] },
  ];
  const abort = new AbortController();
  let writeCommitted = false;
  const turnA = await runTurn({
    runId: runA,
    script: scriptA,
    signal: abort.signal,
    hooks: {
      onCommit: (token) => {
        if (token && token.tool === 'write_file') {
          writeCommitted = true;
          // 模拟真实崩溃窗口：文件已写入、账本已提交，随后进程立刻死掉
          // （注意：脚本化模型的循环只在微任务里推进，用 setTimeout 会饿死定时器，必须同步 abort）
          abort.abort();
        }
      },
    },
  });
  check('阶段1：写操作已实际发生（a.txt 存在）', fs.existsSync(path.join(root, 'a.txt')));
  check('阶段1：写操作在幂等账本中已提交', writeCommitted || turnA.ledger.review().committed.some((item) => item.tool === 'write_file'),
    JSON.stringify(turnA.ledger.review().committed.map((item) => item.tool)));
  check('阶段1：运行因中断结束（aborted）', turnA.result.aborted === true, JSON.stringify(turnA.result.error || ''));

  // 抹掉检查点里的 commit 事件：只保留 intent —— 复现「副作用已发生但本地提交记录丢失」
  const checkpointFile = runCheckpoint.checkpointFile(root, runA);
  const checkpointLines = fs.readFileSync(checkpointFile, 'utf8').split('\n').filter(Boolean);
  const withoutCommit = checkpointLines.filter((line) => {
    try {
      const entry = JSON.parse(line);
      return !(entry.type === 'tool_commit' && entry.tool === 'write_file');
    } catch {
      return true;
    }
  });
  fs.writeFileSync(checkpointFile, withoutCommit.join('\n') + '\n');

  const planA = runCheckpoint.planResume(root, runA, {
    ledger: new SideEffectLedger({ projectRoot: root, scopeRunId: runA }),
  });
  check('续跑计划判定为可自动续跑（auto）', planA.mode === 'auto', 'mode=' + planA.mode + ' reason=' + planA.reason);
  check('幂等账本核对出「写操作其实已完成」并列入跳过清单', (planA.skippedByLedger || []).some((item) => item.tool === 'write_file'),
    JSON.stringify(planA.skippedByLedger));
  check('被账本确认完成的写操作不会被当成人工作业拦截',
    (planA.pendingSteps || []).every((step) => step.effect !== 'write' || (planA.skippedByLedger || []).some((item) => item.idemKey === step.idemKey)),
    JSON.stringify(planA.pendingSteps));

  const resumeMessages = runCheckpoint.buildResumeMessages(planA, { systemPrompt: '测试用 system' });
  const resumePrompt = resumeMessages[resumeMessages.length - 1].content;
  check('续跑消息包含原始任务与「已完成/将跳过」提示', /断点续跑/.test(resumePrompt) && /原始任务/.test(resumePrompt) && /(已完成步骤|已由幂等账本确认完成)/.test(resumePrompt), resumePrompt.slice(0, 140).replace(/\n/g, ' | '));
  check('续跑消息基于检查点重建了对话（system + 续跑指令）', resumeMessages[0].role === 'system' && resumeMessages.length >= 2,
    'messages=' + resumeMessages.length);

  // 续跑：模型又发起同样的 write_file（真实模型常见行为）→ 必须被幂等去重跳过
  const scriptB = [
    { toolCalls: [{ id: 'r1', name: 'write_file', args: { path: 'a.txt', content: 'A' } }] },
    { content: '续跑完成：a.txt 已存在，note.txt 已读取。' },
  ];
  const runB = 'run-resume-b';
  runStore.startRun(root, runB, { prompt: planA.prompt, model: 'scripted-model', resumedFrom: runA });
  const turnB = await runTurn({ runId: runB, scopeRunId: runA, script: scriptB });
  const dedupRecord = (turnB.result.toolCalls || []).find((call) => call.name === 'write_file');
  check('续跑时重复的写操作被幂等去重（未二次执行）', !!dedupRecord && /幂等去重/.test(String(dedupRecord.result || '')),
    JSON.stringify((dedupRecord && dedupRecord.result || '').slice(0, 80)));
  check('续跑未产生第二次副作用（无 a.txt.bak 备份、内容未被覆盖）',
    !fs.existsSync(path.join(root, 'a.txt.bak')) && fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'A',
    'bak=' + fs.existsSync(path.join(root, 'a.txt.bak')));
  const marked = runStore.markRetry(root, runA, runB);
  check('原 Run 可被标记为已被取代（superseded）', runStore.summarizeRun(runStore.readRun(root, runA)).status === 'superseded',
    'markRetry=' + JSON.stringify(marked));

  // ---- 场景 1b：中断发生在只读步骤执行中（intent 已记、commit 未落）→ 仍可自动续跑 ----
  console.log('\n== 场景 1b：中断在只读步骤中 → 自动续跑（只读可安全重放） ==');
  const runRead = 'run-resume-read';
  runStore.startRun(root, runRead, { prompt: '读取 note.txt 并总结', model: 'scripted-model' });
  runCheckpoint.recordIntent(root, runRead, { callId: 'z1', tool: 'read_file', argsDigest: digest({ path: 'note.txt' }), effect: 'read', idemKey: idempotencyKey(runRead, 'read_file', { path: 'note.txt' }) });
  const planRead = runCheckpoint.planResume(root, runRead, { ledger: new SideEffectLedger({ projectRoot: root, scopeRunId: runRead }) });
  check('只有未完成的只读步骤 → 判为可自动续跑', planRead.mode === 'auto', 'mode=' + planRead.mode + ' reason=' + planRead.reason);
  check('未完成的只读步骤进入待办清单', (planRead.pendingSteps || []).some((step) => step.tool === 'read_file' && step.effect === 'read'), JSON.stringify(planRead.pendingSteps));
  check('自动续跑不会被误判为需要人工复核', planRead.requiresReview !== true);

  // ---------------------------------------------------------------- 场景 2：未提交的写操作 → review
  console.log('\n== 场景 2：写操作未提交 → 必须人工复核（不自动重放） ==');
  const runC = 'run-resume-c';
  runStore.startRun(root, runC, { prompt: '写入 b.txt', model: 'scripted-model' });
  runCheckpoint.recordIntent(root, runC, { callId: 'x1', tool: 'write_file', argsDigest: digest({ path: 'b.txt' }), effect: 'write', idemKey: idempotencyKey(runC, 'write_file', { path: 'b.txt', content: 'B' }) });
  const planC = runCheckpoint.planResume(root, runC, { ledger: new SideEffectLedger({ projectRoot: root, scopeRunId: runC }) });
  check('未提交写操作 → review', planC.mode === 'review' && planC.requiresReview === true, 'mode=' + planC.mode + ' reason=' + planC.reason);

  // ---------------------------------------------------------------- 场景 3：未知外部副作用 → review
  console.log('\n== 场景 3：shell 等结果未知的副作用 → 必须人工核对 ==');
  const runD = 'run-resume-d';
  runStore.startRun(root, runD, { prompt: '跑一条命令', model: 'scripted-model' });
  runCheckpoint.recordIntent(root, runD, { callId: 'y1', tool: 'execute_shell', argsDigest: digest('echo hi'), effect: 'unknown', idemKey: idempotencyKey(runD, 'execute_shell', { command: 'echo hi' }) });
  const planD = runCheckpoint.planResume(root, runD, { ledger: new SideEffectLedger({ projectRoot: root, scopeRunId: runD }) });
  check('未知副作用 → review 且提示人工核对', planD.mode === 'review' && /shell|未知/.test(String(planD.reason) + String(planD.warning)),
    'mode=' + planD.mode + ' reason=' + planD.reason);
  check('review 计划明确不含自动重放承诺', /不会自动重放|人工核对/.test(String(planD.warning)), String(planD.warning).slice(0, 80));

  // ---------------------------------------------------------------- 场景 4：已完成 / 无检查点
  console.log('\n== 场景 4：已完成 / 无检查点 ==');
  const runE = 'run-resume-e';
  runStore.startRun(root, runE, { prompt: '已完成任务', model: 'scripted-model' });
  runStatelessMarkComplete(root, runE);
  const planE = runCheckpoint.planResume(root, runE, {});
  check('已完成的 Run → complete（不需要续跑）', planE.mode === 'complete', 'mode=' + planE.mode);

  const runF = 'run-resume-f';
  runStore.startRun(root, runF, { prompt: '旧版本遗留 Run', model: 'scripted-model' });
  const planF = runCheckpoint.planResume(root, runF, {});
  check('没有检查点的历史 Run → review（不假装能续跑）', planF.mode === 'review' && /检查点/.test(String(planF.reason)),
    'mode=' + planF.mode + ' reason=' + planF.reason);

  // ---------------------------------------------------------------- 场景 5：幂等账本自身可靠性
  console.log('\n== 场景 5：幂等账本可靠性 ==');
  const ledgerG = new SideEffectLedger({ projectRoot: root, scopeRunId: 'run-ledger-g' });
  const first = ledgerG.begin('write_file', { path: 'g.txt', content: '1' });
  check('首次写操作不被跳过', first.skip === false);
  ledgerG.commit(first, { ok: true, result: 'written' });
  const second = ledgerG.begin('write_file', { path: 'g.txt', content: '1' });
  check('相同参数再次写操作被跳过（幂等）', second.skip === true);
  const other = ledgerG.begin('write_file', { path: 'g.txt', content: '2' });
  check('不同参数视为不同副作用（不误跳过）', other.skip === false);
  const reloaded = new SideEffectLedger({ projectRoot: root, scopeRunId: 'run-ledger-g' });
  check('账本落盘后可重新加载（崩溃重启仍能去重）', reloaded.begin('write_file', { path: 'g.txt', content: '1' }).skip === true);
  const readAgain = ledgerG.begin('read_file', { path: 'g.txt' });
  check('只读工具永不被去重跳过（可安全重放）', readAgain.skip === false);

  // 清理
  cleanup(root);
  console.log('\n== 结论：' + (failures === 0 ? '全部通过' : failures + ' 项失败') + ' ==');
  if (failures) process.exit(1);
})().catch((error) => {
  console.error('agent-resume-test 异常：', error && error.stack ? error.stack : error);
  if (fetchStub) fetchStub.restore();
  process.exit(1);
});

function runStatelessMarkComplete(projectRoot, runId) {
  runStore.finishRun(projectRoot, runId, 'completed', { toolCount: 0 });
}

function cleanup(dir) {
  const walk = (target) => {
    let items = [];
    try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(target, item.name);
      if (item.isDirectory()) walk(full);
      else try { fs.unlinkSync(full); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
  };
  walk(dir);
}
