/**
 * real-model-pr-test.cjs —— 「真机回归挂 PR」门禁（增量审查 §4.1）
 *
 * 问题：真机评测此前**只在手动 release 模式**跑，而 11 个任务里只有 5 个标了 realModel。
 * 后果：`electron/**` 的改动要等到发布前才第一次见真机 —— 而历史上至少两类缺陷
 * （真实流把参数切碎成 24 帧、上下文窗口口径）**只在真机暴露、离线永远全绿**。
 *
 * 判定（全部离线确定性，除 D 段用一个本机 HTTP mock 走真实网络路径）：
 *   A. 任务声明完整性：每个任务都必须**显式**声明 `realModel` 布尔；真机下被跳过的任务必须给出
 *      **具体**的 `modelSkipReason`（不许用模板糊过去）；真机可跑任务数必须 ≥ 声明下限。
 *   B. `--subset=pr` 体检：id 都存在、都是 realModel、都声明了便宜化 modelBudget；
 *      子集里不得含 injection 类任务（那类判据要求「模型愿意照做」，真机会退化成测模型）。
 *   C. CI 接线：`production-gate.yml` 里 `model-eval-pr` 必须 (a) needs credentials、
 *      (b) 只在 `mode == 'gate' && has_key == 'true'` 时运行、(c) 走 `--subset=pr --require-model`；
 *      且 credentials 真的把 has_key 作为 output 暴露出来。
 *   D. 可运行性：无 Key 时 `--mode=model --require-model` 必须**非 0 退出**（fail-closed，不许假绿）；
 *      指向本机 mock OpenAI 服务器时，真机管线（真 HTTP + 真预算判定 + 真报告）必须跑通且任务判 pass。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tasksModule = require('./agent-eval-tasks.cjs');
const TASKS = tasksModule.tasks;
/** @type {Record<string, string[]>} */
const SUBSETS = /** @type {any} */ (tasksModule).modelSubsets || {};

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const GENERIC_SKIP = '该任务依赖脚本化模型（确定性注入/预算/取消/崩溃），真实模型模式不适用';
const MIN_REAL_MODEL_TASKS = 9;
const prSubset = SUBSETS.pr || [];

try {
  // ============================ A. 任务声明完整性 ============================
  console.log('== A. 每个任务的 realModel 声明与跳过理由 ==');
  const noFlag = TASKS.filter((t) => typeof t.realModel !== 'boolean').map((t) => t.id);
  check('[A] 每个任务都显式声明 realModel 布尔（不许 undefined → 真机下悄悄跳过）', noFlag.length === 0, noFlag.join(', ') || 'ok');

  const realModelTasks = TASKS.filter((t) => t.realModel === true);
  check('[A] 真机可跑任务数 ≥ ' + MIN_REAL_MODEL_TASKS + '（本次把 4 个原先跳过的改成真机可跑）', realModelTasks.length >= MIN_REAL_MODEL_TASKS, 'count=' + realModelTasks.length + ' / ' + TASKS.length);

  const skippedInModel = TASKS.filter((t) => t.realModel !== true);
  const weakReason = skippedInModel.filter((t) => {
    const reason = String(t.modelSkipReason || '').trim();
    return reason.length < 20 || reason === GENERIC_SKIP;
  });
  check(
    '[A] 真机下被跳过的任务都给出**具体**理由（非空、非模板、≥20 字）',
    weakReason.length === 0,
    weakReason.map((t) => t.id + '=' + JSON.stringify(String(t.modelSkipReason || '').slice(0, 30))).join(' | ') || 'skipped=' + skippedInModel.map((t) => t.id).join(',')
  );
  check(
    '[A] 跳过的任务必须带 modelSkipReason 字段（而不是靠通用兜底）',
    skippedInModel.every((t) => typeof t.modelSkipReason === 'string' && t.modelSkipReason.trim().length > 0),
    skippedInModel.map((t) => t.id).join(',')
  );

  const newlyReal = ['long-context-compression', 'crash-recovery-run-events', 'budget-token-cap', 'iteration-cap-stop'];
  const notReal = newlyReal.filter((id) => !realModelTasks.some((t) => t.id === id));
  check('[A] 4 个「可执行」的跳过任务已改为真机可跑', notReal.length === 0, notReal.join(', ') || newlyReal.join(', '));
  const stillScripted = TASKS.filter((t) => t.modelSkipReason).map((t) => t.id);
  check('[A] 保留下来的脚本化任务只有这 2 个（注入对抗 / 硬上限 100 次调用）', stillScripted.join(',') === 'injection-contained-by-harness,budget-tool-call-cap', stillScripted.join(','));

  // ============================ B. --subset=pr 体检 ============================
  console.log('\n== B. PR 便宜子集（--subset=pr）体检 ==');
  check('[B] pr 子集存在且 1 ≤ 数量 ≤ 3', prSubset.length >= 1 && prSubset.length <= 3, JSON.stringify(prSubset));
  const unknownIds = prSubset.filter((id) => !TASKS.some((t) => t.id === id));
  check('[B] 子集里的 id 都存在', unknownIds.length === 0, unknownIds.join(', ') || 'ok');
  const subsetTasks = prSubset.map((id) => TASKS.find((t) => t.id === id)).filter(Boolean);
  const notRealSubset = subsetTasks.filter((t) => t.realModel !== true).map((t) => t.id);
  check('[B] 子集里每个任务都是真机可跑（realModel:true）', notRealSubset.length === 0, notRealSubset.join(', ') || 'ok');
  const noBudget = subsetTasks.filter((t) => !t.modelBudget || !t.modelBudget.timeoutMs).map((t) => t.id);
  check('[B] 子集任务都声明了便宜化 modelBudget（含 timeoutMs，防挂）', noBudget.length === 0, noBudget.join(', ') || 'ok');
  const injectionInSubset = subsetTasks.filter((t) => t.category === 'injection').map((t) => t.id);
  check('[B] 子集里不含 injection 类任务（那类判据要求模型「愿意照做」，真机会退化成测模型）', injectionInSubset.length === 0, injectionInSubset.join(', ') || 'ok');
  /**
   * 真机实测教训（2026-09-20）：子集里放过一个「判据依赖模型措辞」的任务（compressed-ratio /
   * context-bounded），真机 5 次里红 3 次、每次红的判据还不一样 —— 这种红分不清是 harness 坏了
   * 还是模型啰嗦，等于把噪声引进入口门禁。所以把「判据类型」也列入入选标准：
   * 只看**世界状态**（文件字节 / 工具返回 / Run 事件 / 退出码 / 供应商 usage），不看模型怎么说话。
   */
  const PROSE_SENSITIVE_CHECKS = new Set(['compressed-ratio', 'context-bounded', 'citation-source', 'grounding-status']);
  const proseSensitive = [];
  for (const task of subsetTasks) {
    for (const check of task.checks || []) {
      if (PROSE_SENSITIVE_CHECKS.has(check.type)) proseSensitive.push(task.id + ':' + check.type);
    }
  }
  check('[B] 子集任务不使用「依赖模型措辞」的判据（压缩比 / 上下文长度 / 引用状态）', proseSensitive.length === 0, proseSensitive.join(', ') || 'ok');

  // ============================ B2. 真机判据微调的护栏 ============================
  console.log('\n== B2. modelCheckOverrides：只许放宽步数，实质判据永不放宽 ==');
  const limits = require('../scripts/lib/eval-limits.cjs');
  const sampleTask = {
    checks: [
      { type: 'steps-at-most', max: 4 },
      // 注意：这里刻意带上 `max: 1` —— 不带数值上限的判据本来就无法被 override 改动，
      // 那样写会让「白名单」这条断言失去判别力（变异加白名单也照样绿，实测踩到）。
      { type: 'compressed', tool: 'read_file', max: 1 },
    ],
    modelCheckOverrides: { 'steps-at-most': { max: 6 }, compressed: { max: 99 } },
  };
  const offlineChecks = limits.effectiveChecks(sampleTask, 'offline');
  const modelChecks = limits.effectiveChecks(sampleTask, 'model');
  check('[B2] 离线判据完全不受 modelCheckOverrides 影响（仍按原 max=4 判）', offlineChecks.find((c) => c.type === 'steps-at-most').max === 4);
  check('[B2] 真机下步数上限按声明放宽到 6', modelChecks.find((c) => c.type === 'steps-at-most').max === 6);
  check('[B2] 实质判据（compressed）即使被写进 modelCheckOverrides 也不放宽', modelChecks.find((c) => c.type === 'compressed').max === 1, JSON.stringify(modelChecks.find((c) => c.type === 'compressed')));
  check('[B2] 只许放宽、不许更严（声明更小 → 忽略）', limits.effectiveChecks({ checks: [{ type: 'steps-at-most', max: 4 }], modelCheckOverrides: { 'steps-at-most': { max: 2 } } }, 'model')[0].max === 4);
  check('[B2] 放宽幅度硬上限 2 倍（声明 100 → 封顶 8）', limits.effectiveChecks({ checks: [{ type: 'steps-at-most', max: 4 }], modelCheckOverrides: { 'steps-at-most': { max: 100 } } }, 'model')[0].max === 8);
  check('[B2] modelChecks（整套判据）只在真机模式生效', (() => {
    const task = { checks: [{ type: 'steps-at-most', max: 4 }], modelChecks: [{ type: 'steps-at-most', max: 9 }] };
    return limits.effectiveChecks(task, 'offline')[0].max === 4 && limits.effectiveChecks(task, 'model')[0].max === 9;
  })());
  // 死配置：任务里声明了 modelCheckOverrides 的键，但 checks 里没有这个类型 → 判红（不许静默留着）
  const dead = [];
  for (const task of TASKS) {
    if (!task.modelCheckOverrides) continue;
    const types = new Set((task.checks || []).map((c) => c.type));
    for (const key of Object.keys(task.modelCheckOverrides)) {
      if (!types.has(key)) dead.push(task.id + ':' + key);
    }
  }
  check('[B2] 没有「死配置」（override 的键必须存在于该任务的 checks 里）', dead.length === 0, dead.join(','));
  const overriddenTasks = TASKS.filter((t) => t.modelCheckOverrides).map((t) => t.id + '→' + Object.keys(t.modelCheckOverrides).join('/'));
  check('[B2] 有真机判据微调的任务都如实登记（便于复核）', overriddenTasks.length >= 1, overriddenTasks.join(' | '));

  // ============================ C. CI 接线 ============================
  console.log('\n== C. CI 接线（production-gate.yml + package.json） ==');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'production-gate.yml'), 'utf8').replace(/\r\n/g, '\n');
  /** @type {Record<string, string>} */
  const jobs = wf.split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/).reduce((acc, chunk) => {
    const m = chunk.match(/^ {2}([A-Za-z0-9_-]+):\n/);
    if (m) acc[m[1]] = chunk;
    return acc;
  }, {});
  check('[C] workflow 里存在 model-eval-pr job（真机回归挂在 PR 上）', Boolean(jobs['model-eval-pr']), Object.keys(jobs).join(','));
  const prJob = jobs['model-eval-pr'] || '';
  check('[C] model-eval-pr 依赖凭据前置校验（needs: credentials）', /needs:\s*credentials/.test(prJob));
  check(
    '[C] model-eval-pr 仅在「gate 模式 + 已配 Key」时运行（fork PR 无 secrets → 不出现，属预期）',
    /mode == 'gate'/.test(prJob) && /has_key == 'true'/.test(prJob),
    (prJob.match(/if:.*/) || [''])[0].slice(0, 120)
  );
  check('[C] model-eval-pr 跑的是便宜子集脚本', /test:eval:model:pr/.test(prJob));
  check('[C] credentials job 把 has_key 暴露为 output', /outputs:[\s\S]{0,200}has_key:\s*\$\{\{\s*steps\.key\.outputs\.has_key\s*\}\}/.test(String(jobs.credentials || '')));
  check('[C] credentials 里真的有产出 has_key 的步骤', /id:\s*key[\s\S]{0,400}has_key=true/.test(String(jobs.credentials || '')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const prScript = String((pkg.scripts || {})['test:eval:model:pr'] || '');
  check('[C] npm run test:eval:model:pr = --mode=model --subset=pr --require-model', /--mode=model/.test(prScript) && /--subset=pr/.test(prScript) && /--require-model/.test(prScript), prScript);
  const releaseScript = String((pkg.scripts || {})['test:eval:model'] || '');
  check('[C] 发布模式仍然跑全量真机任务（未被改成子集）', /--mode=model/.test(releaseScript) && /--require-model/.test(releaseScript) && !/--subset=/.test(releaseScript), releaseScript);

  // ============================ D. 可运行性（fail-closed + 真 HTTP 管线） ============================
  console.log('\n== D. 可运行性：无 Key fail-closed / 指向本机 mock 服务器跑通真机管线 ==');
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-eval-pr-'));
  const baseEnv = { ...process.env };
  delete baseEnv.CODENODE_EVAL_API_KEY;
  delete baseEnv.CODENODE_E2E_API_KEY;
  delete baseEnv.CODENODE_EVAL_BASE_URL;
  delete baseEnv.CODENODE_EVAL_MODEL;

  const noKey = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'agent-eval.cjs'), '--mode=model', '--subset=pr', '--require-model', '--report-dir=' + reportDir],
    { cwd: ROOT, encoding: 'utf8', env: baseEnv, timeout: 120000 }
  );
  check(
    '[D] 无 Key 时 --mode=model --subset=pr --require-model 以非 0 退出（fail-closed，不许假绿）',
    noKey.status !== 0,
    'exit=' + String(noKey.status) + ' stdout=' + String(noKey.stdout || '').slice(-160).replace(/\n/g, ' ')
  );
  const noKeyReports = fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
  const noKeyReport = noKeyReports.map((f) => path.join(reportDir, f)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))[0];
  check('[D] 无 Key 的报告里全部任务标 skipped 且 exitCode 非 0（报告与进程一致，不允许报告看起来是绿的）', Boolean(noKeyReport) && noKeyReport.tasks.every((t) => t.status === 'skipped') && noKeyReport.exitCode !== 0, JSON.stringify({ exitCode: noKeyReport && noKeyReport.exitCode, statuses: noKeyReport && noKeyReport.tasks.map((t) => t.status) }));
  check('[D] 无 Key 的报告里子集任务就是 --subset=pr 那 3 个（子集解析真的生效）', Boolean(noKeyReport) && noKeyReport.tasks.map((t) => t.id).sort().join(',') === prSubset.slice().sort().join(','), noKeyReport && noKeyReport.tasks.map((t) => t.id).join(','));

  // 真机管线（真实 HTTP + 真实 SSE + 真实预算判定 + 真实报告落盘）：用**独立进程**的 mock OpenAI 兼容服务器。
  // 注意不能用同进程 server —— 下面的 spawnSync 会阻塞事件循环，server 根本 accept 不到连接
  // （实测踩到：服务器 0 请求、客户端 60s 超时；见 scripts/lib/mock-openai-server.cjs 头注释）。
  const { startMockOpenAI } = require('./lib/mock-openai-server.cjs');
  const modelReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-eval-mock-'));

  startMockOpenAI({ totalTokens: 500 }).then(async (mock) => {
    const env = {
      ...baseEnv,
      CODENODE_EVAL_API_KEY: 'mock-key-for-pipeline-test',
      CODENODE_EVAL_BASE_URL: 'http://127.0.0.1:' + mock.port,
      CODENODE_EVAL_MODEL: 'mock-model',
    };
    const run = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'agent-eval.cjs'), '--mode=model', '--task=budget-token-cap', '--require-model', '--report-dir=' + modelReportDir],
      { cwd: ROOT, encoding: 'utf8', env, timeout: 150000 }
    );
    const mockRequests = await mock.stop();
    const reports = fs.readdirSync(modelReportDir).filter((f) => f.endsWith('.json'));
    const report = reports.length ? JSON.parse(fs.readFileSync(path.join(modelReportDir, reports[0]), 'utf8')) : null;
    const task = report && report.tasks && report.tasks[0];
    check('[D] mock 服务器真的被请求过（证明走的是真 HTTP，而不是脚本化 fetch 注入）', mockRequests.length > 0, 'requests=' + JSON.stringify(mockRequests));
    check('[D] 真机管线跑通：进程 exit=0', run.status === 0, 'exit=' + String(run.status) + ' stderr=' + String(run.stderr || '').slice(-200).replace(/\n/g, ' '));
    check('[D] 报告 mode=model 且任务未被跳过（真的执行了真机路径）', Boolean(report) && report.mode === 'model' && task && task.status !== 'skipped', JSON.stringify({ mode: report && report.mode, status: task && task.status, reason: task && task.reason }));
    check('[D] 真机模式下 token 预算按规定收口（任务 pass）', Boolean(task) && task.status === 'pass', JSON.stringify({ status: task && task.status, failed: task && task.failed }));
    check('[D] 报告写进了指定 --report-dir（不污染仓库 docs/eval-reports）', reports.length > 0, reports.join(','));

    console.log('\n' + (failures === 0 ? 'REAL MODEL PR TEST: PASS（真机回归已挂 PR 且 fail-closed）' : 'REAL MODEL PR TEST: FAIL —— ' + failures + ' 项断言未通过'));
    process.exit(failures ? 1 : 0);
  });
} catch (error) {
  console.error('REAL MODEL PR TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
}
