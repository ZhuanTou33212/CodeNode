/**
 * agent-state-test.cjs —— Agent 运行状态机（纯函数 + 真实 IPC 链路）
 *
 * 审查第 1/5 项：状态此前靠 `stopReason` 字符串 + `result.error` 真假隐式表达，
 * 达到上限与真正的失败混为一谈，「等待工具」「等待用户确认」这两个真实过程状态完全缺失。
 *
 * 判据分两层：
 *   A. 纯函数状态机：合法/非法迁移、终态、classifyOutcome、toRunStatus、状态语义表；
 *   B. **真实 IPC 链路**：用假的 ipcMain/sender 调用 `agent:chat` handler（与 app 完全同一条路径），
 *      脚本化模型驱动真实工具循环，断言 `.codenode/runs/<runId>.jsonl` 里的 `run_state` 事件序列
 *      与 `summarizeRun().state`；副作用用磁盘真实字节（write_file 落盘）判定。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agentState = require('../electron/agentState.cjs');
const runStore = require('../electron/runStore.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

// bridge.cjs 在 CODENODE_TEST 下会无条件放行确认 —— 本用例要测「等用户」，必须确保没被打开
delete process.env.CODENODE_TEST;

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

// ======================= A. 纯函数 =======================
{
  const m = agentState.createStateMachine({ runId: 'r1' });
  check('A1 初始状态为 RUNNING', m.state === 'RUNNING' && m.history.length === 0, m.state);
  check('A2 RUNNING → WAITING_TOOL 合法', m.go('WAITING_TOOL', 'tool_calls:1') === true && m.state === 'WAITING_TOOL');
  check('A3 相同状态重复 go 是空操作（不产生历史）', m.go('WAITING_TOOL', 'again') === false && m.history.length === 1);
  check('A4 WAITING_TOOL → WAITING_USER 合法（工具在等用户确认）', m.go('WAITING_USER', 'confirm') === true && m.state === 'WAITING_USER');
  check('A5 WAITING_USER → WAITING_TOOL 合法（用户应答后回到工具执行）', m.go('WAITING_TOOL', 'confirm_settled') === true);
  check('A6 WAITING_TOOL → RUNNING → COMPLETED 是主循环的真实路径',
    m.go('RUNNING', 'tools_settled') === true && m.go('COMPLETED', 'answer_complete') === true && m.state === 'COMPLETED');
  check('A7 终态不可再迁移且被记为 violation（COMPLETED → RUNNING）',
    m.go('RUNNING', 'oops') === false && m.violations.length === 1 &&
    m.violations[0].from === 'COMPLETED' && m.violations[0].to === 'RUNNING', JSON.stringify(m.violations));
  check('A8 终态判定与快照', m.isTerminal() === true && m.snapshot().terminal === true && m.snapshot().transitions === 5, JSON.stringify(m.snapshot()));
  const mWa = agentState.createStateMachine({});
  mWa.go('WAITING_TOOL', 't');
  check('A8b WAITING_TOOL → COMPLETED 被拒绝（必须先回 RUNNING，避免状态跳变掩盖中间过程）',
    mWa.go('COMPLETED', 'skip') === false && mWa.state === 'WAITING_TOOL' && mWa.violations.length === 1, JSON.stringify(mWa.snapshot()));

  const m2 = agentState.createStateMachine({});
  m2.go('WAITING_TOOL', 't');
  check('A9 WAITING_TOOL → LIMIT_REACHED 合法（上限不是「等待工具」的终局）', m2.go('LIMIT_REACHED', 'tool_limit') === true);
  check('A10 未知状态被拒绝（不污染历史）', m2.go('BOGUS', 'x') === false && m2.violations.some((v) => v.type === 'unknown-state'));

  // 语义表：每个状态都要有标签/终态/可恢复性，避免文档与代码两处定义漂移
  const missing = agentState.ALL_STATES.filter((s) => !agentState.STATE_INFO[s] || !agentState.STATE_INFO[s].label);
  check('A11 七个状态全部有语义定义（label/terminal/recoverable）', missing.length === 0 && agentState.ALL_STATES.length === 7, JSON.stringify(missing));
  check('A12 终态集合 = 完成/失败/取消/达上限',
    ['COMPLETED', 'FAILED', 'CANCELLED', 'LIMIT_REACHED'].every((s) => agentState.canTransition(s, 'RUNNING') === false), '终态不该有出边');

  check('A13 classifyOutcome：abort → CANCELLED，上限 → LIMIT_REACHED，error → FAILED，其余 → COMPLETED',
    agentState.classifyOutcome({ aborted: true }) === 'CANCELLED' &&
    agentState.classifyOutcome({ stopReason: 'iteration_limit', error: 'x' }) === 'LIMIT_REACHED' &&
    agentState.classifyOutcome({ stopReason: 'tool_limit', error: 'x' }) === 'LIMIT_REACHED' &&
    agentState.classifyOutcome({ error: 'boom' }) === 'FAILED' &&
    agentState.classifyOutcome({}) === 'COMPLETED');
  check('A14 toRunStatus：status 取值保持既有语义（LIMIT_REACHED 仍写 error，靠 state 字段区分）',
    agentState.toRunStatus('COMPLETED') === 'completed' && agentState.toRunStatus('CANCELLED') === 'cancelled' &&
    agentState.toRunStatus('FAILED') === 'error' && agentState.toRunStatus('LIMIT_REACHED') === 'error');
}

// ======================= B. 真实 IPC 链路 =======================
const repo = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-state-'));
const userDataDir = path.join(tmp, 'userdata');

function makeProject(name, overrides) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
  const lines = [
    'api_base=http://scripted.local/v1',
    'api_key=scripted-key',
    'model=scripted-model',
    'tools.allowed=read_file,write_file',
    'rag.enabled=false',
    'agent.compression.enabled=false',
    'agent.request_max_attempts=1',
    ...(overrides || []),
  ];
  fs.writeFileSync(path.join(root, '.codenode', 'agent.properties'), lines.join('\n') + '\n');
  return root;
}

/** 用假的 ipcMain + 假 sender 调真实的 agent:chat handler（channel 名与 app 完全一致） */
/** @param {{ onRequest?: (data: any, deltas: any[]) => void }} [options] */
function makeHarness(options = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    removeListener: (channel) => listeners.delete(channel),
  };
  // bridge.cjs 是在模块顶层 `require('electron')` 拿 ipcMain 的：纯 node 下必须先把 electron 换成桩，
  // 否则 makeBridge 会因 ipcMain 为 undefined 直接抛错（真实 app 里由 Electron 注入）。桩里的 ipcMain
  // 就是上面这个假 ipcMain，因此渲染进程应答（tools:response）也能被同一份 listeners 捕获。
  const electronPath = require.resolve('electron');
  const electronStub = {
    ipcMain,
    app: { getPath: () => userDataDir },
    dialog: {},
    shell: {},
    BrowserWindow: function BrowserWindow() {},
  };
  /** @type {any} */ (require.cache)[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronStub };
  delete require.cache[require.resolve('../electron/ipc/agent.cjs')];
  delete require.cache[require.resolve('../electron/tools/bridge.cjs')];
  const fakeIpcMain = /** @type {any} */ (ipcMain);
  require('../electron/ipc/agent.cjs').register({ ipcMain: fakeIpcMain, userDataDir: () => userDataDir });

  const deltas = [];
  const requests = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, data) => {
      if (channel === 'agent:delta') deltas.push(data);
      if (channel === 'tools:request') {
        requests.push(data);
        // 渲染进程应答：confirm 一律同意（状态机是否进入 WAITING_USER 与用户答什么无关）
        const listener = listeners.get('tools:response');
        if (listener) {
          setTimeout(() => {
            try {
              if (data.type === 'confirm') listener({ sender: { id: 1 } }, { id: data.id, result: { ok: true } });
              else if (data.type === 'ask') listener({ sender: { id: 1 } }, { id: data.id, result: { answer: 'ok' } });
              else if (data.type === 'ui') listener({ sender: { id: 1 } }, { id: data.id, result: { applied: true } });
            } catch {}
          }, 5);
        }
        if (typeof options.onRequest === 'function') options.onRequest(data, deltas);
      }
    },
  };
  return { handlers, sender, deltas, requests };
}

function statesOf(root, runId) {
  return runStore.readRun(root, runId).filter((e) => e.type === 'run_state').map((e) => e.state);
}

(async () => {
  // ---- B1 正常链路：RUNNING → WAITING_TOOL → RUNNING → COMPLETED ----
  {
    const root = makeProject('normal');
    const h = makeHarness();
    const stub = installScriptedModel([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { content: '读完了。' },
    ], { loopLast: false });
    let out;
    try {
      out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt: '读 a.txt', requestId: 'run-normal' });
    } finally {
      stub.restore();
    }
    const runId = runStore.normalizeRunId('run-normal');
    const states = statesOf(root, runId);
    check('B1.1 正常链路返回 ok 且终态 COMPLETED', out.ok === true && out.reply === '读完了。', JSON.stringify({ ok: out.ok, reply: out.reply }));
    check('B1.2 run_state 事件序列 = RUNNING → WAITING_TOOL → RUNNING → COMPLETED',
      JSON.stringify(states) === JSON.stringify(['RUNNING', 'WAITING_TOOL', 'RUNNING', 'COMPLETED']), JSON.stringify(states));
    const summary = runStore.summarizeRun(runStore.readRun(root, runId));
    check('B1.3 summarizeRun 暴露 state=COMPLETED 且 status 仍为 completed', summary.state === 'COMPLETED' && summary.status === 'completed',
      JSON.stringify({ state: summary.state, status: summary.status }));
    const listed = await h.handlers.get('agent:runs')({ sender: h.sender }, root);
    check('B1.4 agent:runs 列出的 Run 带 state 字段', listed.length >= 1 && listed[0].state === 'COMPLETED', JSON.stringify(listed.map((r) => r.state)));
    check('B1.5 工具调用有 state 事件包裹（WAITING_TOOL 出现在 tool_result 之前）', deltasIndex(h.deltas) > -1, JSON.stringify(h.deltas.filter((d) => d.kind === 'state').map((d) => d.state)));
  }

  // ---- B2 等待用户：write_file 触发确认 → WAITING_USER，用户应答后回到 WAITING_TOOL ----
  {
    const root = makeProject('waiting-user');
    const h = makeHarness();
    const stub = installScriptedModel([
      { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'X-USER-WAIT\n' } }] },
      { content: '写好了。' },
    ], { loopLast: false });
    let out;
    try {
      out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt: '写 b.txt', requestId: 'run-user' });
    } finally {
      stub.restore();
    }
    const runId = runStore.normalizeRunId('run-user');
    const states = statesOf(root, runId);
    check('B2.1 状态序列出现 WAITING_USER（等用户是真的可观测状态）', states.includes('WAITING_USER'), JSON.stringify(states));
    check('B2.2 WAITING_USER 夹在 WAITING_TOOL 与回程 WAITING_TOOL 之间（次序正确）',
      states.indexOf('WAITING_TOOL') < states.indexOf('WAITING_USER') &&
      states.lastIndexOf('WAITING_TOOL') > states.indexOf('WAITING_USER'),
      JSON.stringify(states));
    check('B2.3 确认请求真的发到渲染进程且级别为 WRITE',
      h.requests.some((r) => r.type === 'confirm' && r.level === 'WRITE'), JSON.stringify(h.requests.map((r) => ({ type: r.type, level: r.level }))));
    check('B2.4 副作用真实落盘（用户确认后确实写了文件）',
      fs.existsSync(path.join(root, 'b.txt')) && fs.readFileSync(path.join(root, 'b.txt'), 'utf8').includes('X-USER-WAIT'),
      fs.existsSync(path.join(root, 'b.txt')) ? fs.readFileSync(path.join(root, 'b.txt'), 'utf8') : '(无文件)');
    check('B2.5 终态 COMPLETED', runStore.summarizeRun(runStore.readRun(root, runId)).state === 'COMPLETED');
  }

  // ---- B3 达到上限：LIMIT_REACHED（不再折叠成笼统的 error 语义） ----
  {
    const root = makeProject('limit');
    const h = makeHarness();
    // loopLast=true：模型永远返回同一个工具调用（结果命中只读缓存，成本极低）
    const stub = installScriptedModel([{ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }], { loopLast: true });
    let out;
    try {
      out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt: '无限读', requestId: 'run-limit' });
    } finally {
      stub.restore();
    }
    const runId = runStore.normalizeRunId('run-limit');
    const summary = runStore.summarizeRun(runStore.readRun(root, runId));
    check('B3.1 返回 stopReason=iteration_limit', out.ok === false && /迭代上限/.test(String(out.error || '')), JSON.stringify({ ok: out.ok, error: String(out.error || '').slice(0, 60) }));
    check('B3.2 终态是 LIMIT_REACHED（与真正的 FAILED 分开）', summary.state === 'LIMIT_REACHED', JSON.stringify({ state: summary.state, status: summary.status }));
    check('B3.3 status 保持既有取值 error（兼容既有读取路径）', summary.status === 'error', summary.status);
    check('B3.4 run_finish 里带上 stopReason 便于续跑判定', /iteration_limit/.test(JSON.stringify(runStore.readRun(root, runId).find((e) => e.type === 'run_finish') || {})),
      JSON.stringify((runStore.readRun(root, runId).find((e) => e.type === 'run_finish') || {}).stopReason));
  }

  // ---- B4 用户取消：CANCELLED ----
  {
    const root = makeProject('cancel');
    const h = makeHarness({
      onRequest: () => {},
    });
    let stopped = false;
    const stub = installScriptedModel([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { content: '不该走到这里。' },
    ], { loopLast: false });
    // 看到第一个工具结果就点「停止」（与界面行为一致：agent:stop + requestId）
    const origSend = h.sender.send;
    h.sender.send = (channel, data) => {
      origSend(channel, data);
      if (!stopped && channel === 'agent:delta' && data && data.kind === 'tool_result') {
        stopped = true;
        h.handlers.get('agent:stop')({ sender: h.sender }, 'run-cancel');
      }
    };
    let out;
    try {
      out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt: '读然后被停', requestId: 'run-cancel' });
    } finally {
      stub.restore();
    }
    const runId = runStore.normalizeRunId('run-cancel');
    const summary = runStore.summarizeRun(runStore.readRun(root, runId));
    check('B4.1 返回 aborted=true', out.aborted === true, JSON.stringify({ aborted: out.aborted, ok: out.ok }));
    check('B4.2 终态是 CANCELLED 且 status=cancelled', summary.state === 'CANCELLED' && summary.status === 'cancelled',
      JSON.stringify({ state: summary.state, status: summary.status }));
    check('B4.3 取消没有把工具结果误报成最终答复', !String(out.reply || '').includes('不该走到这里'), JSON.stringify(String(out.reply || '').slice(0, 40)));
  }

  // ---- B5 真实失败：FAILED ----
  {
    const root = makeProject('failed');
    const h = makeHarness();
    const originalFetch = global.fetch;
    global.fetch = /** @type {any} */ (async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) }));
    let out;
    try {
      out = await h.handlers.get('agent:chat')({ sender: h.sender }, { projectRoot: root, prompt: '会失败', requestId: 'run-failed' });
    } finally {
      global.fetch = originalFetch;
    }
    const runId = runStore.normalizeRunId('run-failed');
    const summary = runStore.summarizeRun(runStore.readRun(root, runId));
    check('B5.1 返回 ok=false 且带错误', out.ok === false && !!out.error, JSON.stringify({ ok: out.ok, error: String(out.error || '').slice(0, 60) }));
    check('B5.2 终态是 FAILED 且 status=error', summary.state === 'FAILED' && summary.status === 'error',
      JSON.stringify({ state: summary.state, status: summary.status }));
  }

  console.log(failures === 0 ? 'AGENT STATE TEST: PASS' : 'AGENT STATE TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('AGENT STATE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

/** WAITING_TOOL 事件出现的位置（用于 B1.5 的粗判） */
function deltasIndex(deltas) {
  return deltas.findIndex((d) => d.kind === 'state' && d.state === 'WAITING_TOOL');
}
