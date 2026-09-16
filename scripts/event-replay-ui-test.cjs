'use strict';
/**
 * event-replay-ui-test.cjs —— 渲染层「运行回放」区块的真实渲染用例（S8）
 *
 * 与 rag-ui-test 同一范式：offscreen BrowserWindow 加载 `dist/index.html`，走**真实渲染路径**
 * （store.load → window.codenode.replayEvents → RunReplayPanel），再断言 DOM 文本。
 *
 * 判据（界面必须把事件流**如实**呈现，不能只显示「有 N 条」）：
 *   1. 打开 dock 的「工作流运行」标签后，`.dock-replay` 出现且时间线行数与事件数一致；
 *   2. 摘要区把工具调用数/失败数/失败码/审批签发与拒绝/成本/token 都显示出来；
 *   3. 时间线每行的描述来自事件字段本身（工具名 + ok + 耗时、审批相位中文、成本金额）；
 *   4. 视觉分组：告警行带 danger、工具失败行走 warn（样式类名可断言）；
 *   5. 事件文件路径显示出来（用户能自己去 CLI 复核）。
 *
 * 注意：这里**不设置** preload —— 用例自己在页面里补 `window.codenode.replayEvents` 桩，
 * 这样测的是组件与 store 的真实代码路径，而不是把 DOM 直接塞死。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-replay-ui-'));

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const EVENTS = [
  { v: 1, ts: '2026-09-16T10:00:00.000Z', kind: 'tool', runId: 'run-ui', turnId: '0', toolCallId: 'call_0_1', attemptId: 'call_0_1#1', name: 'read_file', ok: true, elapsedMs: 12 },
  { v: 1, ts: '2026-09-16T10:00:00.500Z', kind: 'tool', runId: 'run-ui', turnId: '0', toolCallId: 'call_0_2', attemptId: 'call_0_2#1', name: 'write_file', ok: false, elapsedMs: 3 },
  { v: 1, ts: '2026-09-16T10:00:01.000Z', kind: 'approval', runId: 'run-ui', toolCallId: 'call_0_3', event: 'approval_issued', what: 'workbench_edit' },
  { v: 1, ts: '2026-09-16T10:00:01.200Z', kind: 'approval', runId: 'run-ui', toolCallId: 'call_0_4', event: 'approval_denied', what: 'workbench_edit' },
  { v: 1, ts: '2026-09-16T10:00:01.600Z', kind: 'cost', runId: 'run-ui', call: 'chat', model: 'ui-model', tokens: { total: 42, cached: 10 }, costUsd: 0.0042 },
  { v: 1, ts: '2026-09-16T10:00:02.000Z', kind: 'alert', runId: 'run-ui', level: 'warn', code: 'COST_SPIKE', message: '成本突增' },
];

const PAYLOAD = {
  ok: true,
  file: 'C:/some-project/.codenode/events.jsonl',
  total: EVENTS.length,
  runs: [{ runId: 'run-ui', count: EVENTS.length, first: EVENTS[0].ts, last: EVENTS[EVENTS.length - 1].ts, kinds: ['tool', 'approval', 'cost', 'alert'] }],
  events: EVENTS,
  summary: {
    total: EVENTS.length,
    runs: ['run-ui'],
    span: { first: EVENTS[0].ts, last: EVENTS[EVENTS.length - 1].ts },
    kinds: { tool: 2, approval: 2, cost: 1, alert: 1 },
    tools: { read_file: { calls: 1, failures: 0 }, write_file: { calls: 1, failures: 1 } },
    toolCalls: 2,
    toolFailures: 1,
    failureCodes: { ARG_SCHEMA: 1 },
    approvals: { issued: 1, denied: 1, rejected: 0, consumed: 0 },
    costUsd: 0.0042,
    tokens: 42,
  },
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(700);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async (fn, ms) => {
        const deadline = Date.now() + (ms || 4000);
        while (Date.now() < deadline) {
          const value = fn();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      const project = window.__codenodeProject;
      if (!project) return { error: 'project store unavailable' };
      await project.getState().loadRoot(${JSON.stringify(projectRoot)});
      // 真实路径：组件里的 store.load() 会调用 window.codenode.replayEvents
      window.codenode = Object.assign({}, window.codenode || {}, {
        replayEvents: async () => (${JSON.stringify(PAYLOAD)}),
      });
      const ui = window.__codenodeUi;
      if (!ui) return { error: 'ui store unavailable' };
      ui.getState().setDockTab('runs');
      const panel = await waitFor(() => document.querySelector('.dock-replay'), 6000);
      if (!panel) return { error: '.dock-replay not rendered', body: document.body.innerHTML.slice(0, 400) };
      await waitFor(() => document.querySelectorAll('.dock-replay-row').length >= ${EVENTS.length}, 5000);
      const rows = [...document.querySelectorAll('.dock-replay-row')];
      const metrics = panel.querySelector('.dock-metrics');
      return {
        ok: true,
        rows: rows.length,
        metricsText: metrics ? metrics.textContent : '',
        rowTexts: rows.map((row) => row.textContent),
        rowClasses: rows.map((row) => row.className),
        chips: [...panel.querySelectorAll('.dock-replay-chip')].map((chip) => chip.textContent),
        file: panel.querySelector('.dock-replay-file') ? panel.querySelector('.dock-replay-file').textContent : '',
        runOptions: [...panel.querySelectorAll('select option')].map((option) => option.textContent),
      };
    })()`);

    if (!result || result.ok !== true) {
      check('UI 用例能打开运行回放区块', false, JSON.stringify(result));
    } else {
      check('U1 时间线行数与事件数一致（6 条）', result.rows === EVENTS.length, String(result.rows));
      check('U2 摘要显示工具调用数与失败数', /工具调用 2/.test(result.metricsText) && /失败 1/.test(result.metricsText), result.metricsText.slice(0, 160));
      check('U3 摘要显示失败码分布（S5 分类）', /ARG_SCHEMA/.test(result.metricsText), result.metricsText.slice(0, 160));
      check('U4 摘要显示审批签发与拒绝', /签发 1/.test(result.metricsText) && /拒绝 1/.test(result.metricsText), result.metricsText.slice(0, 200));
      check('U5 摘要显示成本与 token', /\$0\.0042/.test(result.metricsText) && /token 42/.test(result.metricsText), result.metricsText.slice(0, 200));
      check('U6 工具行的描述含工具名 / ok / 耗时', /read_file/.test(result.rowTexts[0]) && /ok=true/.test(result.rowTexts[0]) && /12ms/.test(result.rowTexts[0]), result.rowTexts[0]);
      check('U7 审批行用中文相位（已批准 / 用户拒绝）', /已批准/.test(result.rowTexts[2]) && /用户拒绝/.test(result.rowTexts[3]), result.rowTexts[2] + ' | ' + result.rowTexts[3]);
      check('U8 成本行显示模型、token 与金额', /ui-model/.test(result.rowTexts[4]) && /tokens=42/.test(result.rowTexts[4]) && /\$0\.0042/.test(result.rowTexts[4]), result.rowTexts[4]);
      check('U9 视觉分组：告警行走 danger、工具失败行带 warn', /danger/.test(result.rowClasses[5]) && /warn/.test(result.rowClasses[1]), JSON.stringify(result.rowClasses));
      check('U10 事件类型分布以 chip 形式给出', result.chips.some((chip) => /tool ×2/.test(chip)), JSON.stringify(result.chips));
      check('U11 显示事件文件路径（用户可去 CLI 复核）', /events\.jsonl/.test(result.file), result.file);
      check('U12 run 下拉列出可回放的 run', result.runOptions.some((option) => /run-ui/.test(option)), JSON.stringify(result.runOptions));
    }
  } catch (error) {
    check('UI 用例执行未抛异常', false, String((error && error.stack) || error));
  } finally {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    console.log('EVENT REPLAY UI TEST: ' + (failures ? 'FAIL' : 'PASS'));
    app.exit(failures ? 1 : 0);
  }
});
