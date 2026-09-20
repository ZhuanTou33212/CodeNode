/**
 * subagent-view-test.cjs —— 子代理任务视图的跨 run 留存（§4.2 的第一件事）
 *
 * 缺口：`SubagentManager.tasks` 只是**进程内** Map —— 请求一结束/界面一刷新，「这次派了谁、
 * 做到哪一步、结论是什么」就只剩事件流里两行 delta，跨 run 完全查不到。
 *
 * 判据：
 *   A. 真实管理器路径（delegate_task 跑完）必须落盘，且**新实例/新进程可读**（这才是缺口本身）；
 *   B. 同 taskId 覆盖更新不追加；条数上限生效；多 run 互不干扰、按时间倒序、maxRuns 生效；
 *   C. 坏文件如实报告（ok:false + error）而不是抛异常或静默当空；
 *   D. 负向：没派过子代理的 run 不产生文件、也不出现在列表里；
 *   E. 接线：IPC handler / preload / 白名单 / 界面入口都真的接上。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const subagents = require(path.join(ROOT, 'electron', 'subagents.cjs'));
const toolkit = require(path.join(ROOT, 'electron', 'tools', 'toolkit.cjs'));
const { AgentToolContext } = require(path.join(ROOT, 'electron', 'tools', 'context.cjs'));
const sandbox = require(path.join(ROOT, 'electron', 'sandbox.cjs'));

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-subview-' + tag + '-'));
}

const baseCfg = {
  apiBase: 'http://scripted.local/v1',
  apiKey: '',
  model: 'scripted',
  maxTokens: 512,
  reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
  limits: { maxTotalTokens: 100000 },
  compression: { enabled: false },
  rag: { enabled: false },
  tools: {},
};

function buildContext(projectRoot, policy) {
  return new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: new AbortController().signal,
  });
}

(async () => {
  // ============================ A. 真实路径落盘 + 跨实例可读 ============================
  console.log('== A. delegate_task 跑完必须落盘，且新实例可读 ==');
  const rootA = tmpdir('a');
  const policyA = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: rootA, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policyA);
  const registryA = toolkit.buildDefaultRegistryWithConfig({ projectRoot: rootA, ragEnabled: false });
  const managerA = new subagents.SubagentManager({
    agent: { runAgentChat: async () => ({ content: '探查结论：入口在 src/main.ts', toolCalls: [], usage: null }) },
    toolkit,
    cfg: baseCfg,
    registry: registryA,
    runId: 'run-sub-a',
  });
  managerA.register(registryA);
  await registryA.execute('delegate_task', { role: 'explorer', objective: '找入口文件' }, buildContext(rootA, policyA));

  const fileA = subagents.subagentViewFile(rootA, 'run-sub-a');
  check('[A] 任务结束即落盘', fs.existsSync(fileA), fileA);
  const viewA = subagents.readTaskViews(rootA, 'run-sub-a');
  check('[A] 落盘内容含角色/状态/结论/目标', viewA.ok && viewA.tasks.length === 1
    && viewA.tasks[0].role === 'explorer'
    && viewA.tasks[0].status === 'done'
    && /入口在 src\/main\.ts/.test(viewA.tasks[0].summary)
    && viewA.tasks[0].objective === '找入口文件', JSON.stringify(viewA.tasks[0] || null).slice(0, 200));
  check('[A] 视图带 finishedAt（可用于「跑了多久/何时结束」）', !!viewA.tasks[0].finishedAt, String(viewA.tasks[0].finishedAt));
  // 跨实例：**另起一个管理器**（等价于进程重启）也必须读得到 —— 缺口就是「进程内 Map 一结束就没」
  const managerB = new subagents.SubagentManager({ agent: { runAgentChat: async () => ({ content: '' }) }, toolkit, cfg: baseCfg, registry: registryA, runId: 'run-sub-a' });
  check('[A] 进程内 Map 是空的（说明查到的确实来自落盘）', managerB.tasks.size === 0);
  check('[A] 新实例读得到（跨请求/跨重启可查）', subagents.readTaskViews(rootA, 'run-sub-a').tasks.length === 1);

  // ============================ B. 覆盖更新 / 上限 / 多 run ============================
  console.log('\n== B. 覆盖更新、条数上限、多 run 隔离与排序 ==');
  subagents.persistTaskView(rootA, 'run-sub-a', { taskId: viewA.tasks[0].taskId, role: 'explorer', objective: '找入口文件', status: 'done', summary: '更新后的结论' });
  const after = subagents.readTaskViews(rootA, 'run-sub-a');
  check('[B] 同 taskId 落盘是**覆盖更新**而非追加', after.tasks.length === 1 && after.tasks[0].summary === '更新后的结论', JSON.stringify(after.tasks.length));

  const rootB = tmpdir('b');
  for (let i = 0; i < 55; i++) {
    subagents.persistTaskView(rootB, 'run-many', { taskId: 'task-' + i, role: 'explorer', objective: 'obj' + i, status: 'done', summary: 's' + i });
  }
  const many = subagents.readTaskViews(rootB, 'run-many');
  check('[B] 条数上限生效（55 条只留最后 50）', many.tasks.length === 50 && many.tasks[many.tasks.length - 1].taskId === 'task-54', 'len=' + many.tasks.length);

  subagents.persistTaskView(rootB, 'run-other', { taskId: 'x-1', role: 'verifier', objective: '另一个 run', status: 'done', summary: 'ok' });
  const listB = subagents.listTaskViews(rootB, { maxRuns: 5, maxTasksPerRun: 20 });
  check('[B] 多 run 互不干扰：两个 run 各在自己的文件里', subagents.readTaskViews(rootB, 'run-many').tasks.length === 50 && subagents.readTaskViews(rootB, 'run-other').tasks.length === 1);
  check('[B] listTaskViews 返回两个 run，且按 updatedAt 倒序', listB.ok && listB.runs.length === 2 && String(listB.runs[0].updatedAt) >= String(listB.runs[1].updatedAt), JSON.stringify(listB.runs.map((r) => r.runId)));
  check('[B] maxRuns 生效', subagents.listTaskViews(rootB, { maxRuns: 1 }).runs.length === 1);
  check('[B] maxTasksPerRun 生效（只取最近若干条）', subagents.listTaskViews(rootB, { maxRuns: 5, maxTasksPerRun: 3 }).runs.every((r) => r.tasks.length <= 3));

  // ============================ C. 坏文件如实报告 ============================
  console.log('\n== C. 损坏的任务视图：如实报告，不抛、不当空 ==');
  const rootC = tmpdir('c');
  fs.mkdirSync(path.join(rootC, '.codenode', 'runs'), { recursive: true });
  fs.writeFileSync(subagents.subagentViewFile(rootC, 'run-broken'), '{ 这不是 JSON');
  const broken = subagents.readTaskViews(rootC, 'run-broken');
  check('[C] readTaskViews 返回 ok:false + error（不抛异常）', broken.ok === false && !!broken.error && broken.tasks.length === 0, String(broken.error));
  const listC = subagents.listTaskViews(rootC, { maxRuns: 5 });
  check('[C] listTaskViews 不因单个坏文件崩掉', listC.ok === true);

  // ============================ D. 负向 ============================
  console.log('\n== D. 负向：没派子代理的 run 不留痕 ==');
  const rootD = tmpdir('d');
  check('[D] 无子代理 → 没有视图文件', !fs.existsSync(subagents.subagentViewFile(rootD, 'run-empty')));
  check('[D] 无子代理 → 列表里不出现该 run', subagents.listTaskViews(rootD, { maxRuns: 5 }).runs.length === 0);
  check('[D] 空视图/非法参数不炸（taskId 缺失直接忽略）', subagents.persistTaskView(rootD, 'run-empty', {}) === null);

  // ============================ E. 接线 ============================
  console.log('\n== E. 接线（实现了必须真的接上） ==');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'agent.cjs'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
  const whitelist = fs.readFileSync(path.join(ROOT, 'scripts', 'ipc-registry-test.cjs'), 'utf8');
  const dock = fs.readFileSync(path.join(ROOT, 'src', 'components', 'WorkbenchDock.tsx'), 'utf8');
  check('[E] IPC handler 走的是同一份 listTaskViews', /agent:subagents'[\s\S]{0,220}listTaskViews/.test(ipcSrc));
  check('[E] preload 暴露 subagentViews', /subagentViews:\s*\(root, options\)/.test(preloadSrc));
  check('[E] IPC 白名单登记 agent:subagents', whitelist.includes("'agent:subagents'"));
  check('[E] 界面上有子代理任务面板（跨运行留存）', dock.includes('dock-subagents') && dock.includes('subagentViews('));
  check('[E] 主循环路径上也接了落盘（manager 结束分支）', /persistTaskView\(context\.projectRoot\(\), this\.runId, view\)/.test(fs.readFileSync(path.join(ROOT, 'electron', 'subagents.cjs'), 'utf8')));

  for (const dir of [rootA, rootB, rootC, rootD]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  console.log('\n' + (failures === 0 ? 'SUBAGENT VIEW TEST: PASS（落盘 / 跨实例 / 覆盖 / 上限 / 坏文件 / 接线）' : 'SUBAGENT VIEW TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('SUBAGENT VIEW TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
