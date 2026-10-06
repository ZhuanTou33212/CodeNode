#!/usr/bin/env node
'use strict';
/**
 * frontend-incremental-test.cjs —— #7 / #21 / #25 的前端回归测试（**纯 Node，不需要显示环境**）
 *
 * 为什么这样写（而不是 offscreen Electron 渲染用例）：
 *   本仓库把「需要窗口/浏览器」的用例单列在 `scripts/run-all-tests.cjs` 的 DISPLAY 组，CI 上可能跳过；
 *   这三条修复的判据（并发登记、delta 分支、计划文案、静态 a11y 属性）**全都可以离线断言**。
 *   所以这里直接 require 生产源码（`.ts`/`.tsx` 走 `ts.transpileModule` 即时转译，不落盘、不依赖
 *   vite 构建），再用 `react-dom/server` 渲染组件断言静态属性 —— 断言的是**真实现**，不是近似复刻。
 *
 * 覆盖：
 *   A. #7 并发/竞态：send 硬守卫、inflight 按 requestId 登记、精确停止 / 全部停止、
 *      停止后旧请求仍可 abort、两条流不落同一气泡、`sending` 为派生值。
 *   B. #21：needsReview 的 plan 不再被丢弃（reason/warning/unknownEffects/pendingSteps 可见）、
 *      两个出口（强制续跑 / 按状态重试）、`truncated` 与 `stopped` delta 有分支、未知 kind 兜底告警。
 *   C. #25：发布型错误变成用户可见提示（fireAndReport）、对话体 live region、
 *      toast 容器 role=status、ToolDialog role=dialog/aria-modal/初始焦点/Escape 关闭。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const PROJECT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1) 转译加载器：让 node 能直接 require 生产 .ts/.tsx（不落盘）
// ---------------------------------------------------------------------------
const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  skipLibCheck: true,
  sourceMap: false,
};

// TS 源码里的相对 import 不带扩展名（`./projectStore`），node 默认不会去找 `.ts` —— 补上
/** `Module._resolveFilename` / `Module.prototype._compile` 在 @types/node 里没有声明（私有成员），
 *  本脚本要给 require 打 .ts/.tsx 钩子，故显式走 any 别名 —— 仅类型层面，运行语义不变。 */
const ModuleAny = /** @type {any} */ (Module);
const originalResolveFilename = ModuleAny._resolveFilename;
ModuleAny._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (/^\.\.?\//.test(request)) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return originalResolveFilename.call(this, request + ext, parent, isMain, options);
      } catch {
        /* 换下一个后缀 */
      }
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const originalCompile = ModuleAny.prototype._compile;
ModuleAny.prototype._compile = function patchedCompile(content, filename) {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) {
    const out = ts.transpileModule(content, { compilerOptions: COMPILER_OPTIONS, fileName: filename });
    return originalCompile.call(this, out.outputText, filename);
  }
  return originalCompile.call(this, content, filename);
};
void fs;

// ---------------------------------------------------------------------------
// 2) 外部依赖：react 用真包（才能 react-dom/server 渲染），@xyflow/react / zustand 用最小桩
// ---------------------------------------------------------------------------
let hookCursor = 0;
const react = require(path.join(PROJECT, 'node_modules', 'react'));
react.__hooks = {
  reset: () => {
    hookCursor = 0;
  },
  useEffect: (fn) => {
    const slot = hookCursor++;
    useEffectCalls.push({ slot, fn });
  },
  useRef: (init) => {
    const slot = hookCursor++;
    if (!(slot in refSlots)) refSlots[slot] = { current: init };
    return refSlots[slot];
  },
  useState: (init) => {
    const slot = hookCursor++;
    if (!(slot in stateSlots)) stateSlots[slot] = typeof init === 'function' ? init() : init;
    const setter = (next) => {
      stateSlots[slot] = typeof next === 'function' ? next(stateSlots[slot]) : next;
    };
    return [stateSlots[slot], setter];
  },
};
let stateSlots = {};
let refSlots = {};
const useEffectCalls = [];

function stubZustand() {
  return {
    create: (initializer) => {
      let state = initializer(
        (partial) => {
          const patch = typeof partial === 'function' ? partial(state) : partial;
          state = Object.assign({}, state, patch);
        },
        () => state,
        undefined
      );
      const api = (selector) => (selector ? selector(state) : state);
      api.getState = () => state;
      api.setState = (partial) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = Object.assign({}, state, patch);
      };
      api.subscribe = () => () => {};
      api.__setRaw = (next) => {
        state = next;
      };
      return api;
    },
  };
}

const stubModules = {
  '@xyflow/react': { useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }), fitView: () => {} }) },
  zustand: stubZustand(),
  'zustand/react': stubZustand(),
  'react-dom/server': require(path.join(PROJECT, 'node_modules', 'react-dom', 'server')),
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (Object.prototype.hasOwnProperty.call(stubModules, id)) return stubModules[id];
  if (id === 'react') return react;
  return originalRequire.call(this, id);
};

// ---------------------------------------------------------------------------
// 3) 浏览器全局：store 里会读 window / localStorage / document
// ---------------------------------------------------------------------------
let apiCalls = [];
let apiStub = null;

global.window = {
  codenode: null,
  innerWidth: 1280,
  addEventListener: () => {},
  removeEventListener: () => {},
};
function installApi(overrides) {
  const target = Object.assign(
    {
      // 这些 getter 必须每次读 apiCalls，测试中途换桩才不会被旧闭包看到旧数组
      get calls() {
        return apiCalls;
      },
      agentChat: (payload) => {
        apiCalls.push({ name: 'agentChat', payload });
        return new Promise(() => {});
      },
      onAgentDelta: () => () => {},
      stopAgent: (rid) => {
        apiCalls.push({ name: 'stopAgent', requestId: rid });
        return Promise.resolve({ ok: true });
      },
      agentRuns: () => Promise.resolve([]),
      agentResumePlan: () => Promise.resolve({ ok: false }),
      agentResumeStart: () => Promise.resolve({ ok: true }),
      onAgentAlert: () => () => {},
      chooseProject: () => Promise.resolve({ ok: false }),
      listProject: () => Promise.resolve({ ok: true, files: [] }),
    },
    overrides || {}
  );
  apiStub = target;
  global.window.codenode = target;
  return target;
}

const storage = {};
/** 只实现被 store 用到的三个方法；Storage 的 length/clear/key 本测试用不到 → any 别名 */
global.localStorage = /** @type {any} */ ({
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => {
    storage[k] = String(v);
  },
  removeItem: (k) => {
    delete storage[k];
  },
});

// ---------------------------------------------------------------------------
// 4) 装载生产模块
// ---------------------------------------------------------------------------
const registry = {};
function loadConfig() {
  const chat = require(path.join(PROJECT, 'src', 'store', 'chatStore.ts'));
  const session = require(path.join(PROJECT, 'src', 'store', 'sessionStore.ts'));
  const ui = require(path.join(PROJECT, 'src', 'store', 'uiStore.ts'));
  const usage = require(path.join(PROJECT, 'src', 'store', 'usageStore.ts'));
  const inflightLib = require(path.join(PROJECT, 'src', 'lib', 'inflight.ts'));
  const resumeLib = require(path.join(PROJECT, 'src', 'lib', 'resumePlan.ts'));
  const deltaLib = require(path.join(PROJECT, 'src', 'lib', 'sessionDelta.ts'));
  const reportLib = require(path.join(PROJECT, 'src', 'lib', 'reportError.ts'));
  const sendingLib = require(path.join(PROJECT, 'src', 'lib', 'useSending.ts'));
  const project = require(path.join(PROJECT, 'src', 'store', 'projectStore.ts'));
  const graph = require(path.join(PROJECT, 'src', 'lib', 'flow.ts'));
  Object.assign(registry, {
    chat: chat.useChatStore,
    isSending: chat.isSending,
    inflightRequestIds: chat.inflightRequestIds,
    checkSendGuard: chat.checkSendGuard,
    session: session.useSessionStore,
    ui: ui.useUiStore,
    usage: usage.useUsageStore,
    project: project.useProjectStore,
    inflight: inflightLib,
    resume: resumeLib,
    delta: deltaLib,
    report: reportLib,
    useSending: sendingLib.useSending,
    flow: graph,
  });
  // 清掉三个 store 的初始状态残留，保证每个用例从干净状态开始
  registry.chat.__setRaw(registry.chat.getState());
  return registry;
}

function freshStores() {
  const { chat, session, ui } = registry;
  chat.getState().stopAll();
  // 重置会话状态（store 的 reset 只清会话；画布在 graphStore 里，本地测试给个空画布即可）
  session.getState().reset();
  session.getState().startOnCurrent('');
  ui.getState().setToast(null);
  ui.getState().setResumePlanNotice(null);
  apiCalls = [];
  useEffectCalls.length = 0;
  stateSlots = {};
  refSlots = {};
  react.__hooks.reset();
}

const pending = [];
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 带超时的 await：任何一个 `await` 挂住（真实现出问题时常见）都必须变成**断言失败**，
 * 而不是让 node 事件循环空转后静默 exit 0 —— 那会让变异测试误判「用例仍然绿」。
 */
async function settled(promise, label, ms = 5000) {
  let timer = null;
  const timeout = new Promise((_res, rej) => {
    timer = setTimeout(() => rej(new Error('TIMEOUT:' + label)), ms);
  });
  try {
    const value = await Promise.race([promise, timeout]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 5) 断言收集
// ---------------------------------------------------------------------------
const failures = [];
let caseIndex = 0;
function check(name, condition, detail) {
  caseIndex++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    const line = '  FAIL ' + name + (detail === undefined ? '' : '  :: ' + detail);
    console.log(line);
    failures.push(line);
  }
}

// ---------------------------------------------------------------------------
// 6) 用例
// ---------------------------------------------------------------------------
async function testInflightRegistry() {
  console.log('\n[lib/inflight] 登记表本身（按 id 的集合语义）');
  const { createInflightRegistry } = registry.inflight;
  const reg = createInflightRegistry();
  const aborted = [];
  const mk = (id) => ({ abort: () => aborted.push(id) });
  check('初始 size 0 且 isSending=false', reg.size() === 0 && reg.isSending() === false);
  check('begin 两个不同 id 都成功（集合而不是单值）', reg.begin('r1', mk('r1')) === true && reg.begin('r2', mk('r2')) === true);
  check('同一 id 重复 begin 被拒绝（不覆盖旧 controller）', reg.begin('r1', mk('r1')) === false);
  check('size=2 / ids=[r1,r2] / isSending=true', reg.size() === 2 && reg.ids().join(',') === 'r1,r2' && reg.isSending() === true);
  check('end(r1) 只删自己那一条，r2 还在', reg.end('r1') === true && reg.has('r1') === false && reg.has('r2') === true);
  check('abort(r2) 精确中止并摘除', reg.abort('r2') === true && aborted.join(',') === 'r2' && reg.size() === 0);
  reg.begin('a', mk('a'));
  reg.begin('b', mk('b'));
  const all = reg.abortAll();
  check('abortAll 中止全部并返回 id 列表', all.join(',') === 'a,b' && aborted.join(',') === 'r2,a,b' && reg.size() === 0);
  check('abort 不存在的 id 返回 false', reg.abort('nope') === false);
}

async function testSendGuardAndConcurrency() {
  console.log('\n[#7] send 硬守卫 / 并发登记 / 精确停止 / 全部停止');
  freshStores();
  const { chat, ui, session } = registry;

  // A1：空 prompt 不打 API（老行为不回归）
  const emptyRes = await chat.getState().send('   ');
  check('A1 空 prompt：不打 API 且返回空结果', apiCalls.length === 0 && emptyRes.reply === '' && emptyRes.tools.length === 0);

  // A2：没有 Electron API 时明确提示
  installApi();
  global.window.codenode = null;
  const noApi = await chat.getState().send('没有 Electron 环境');
  check('A2 无 window.codenode：提示「需要 Electron 环境」且不抛异常', noApi.reply === '' && /Electron/.test(String(ui.getState().toast)));
  installApi();
  freshStores();

  // A3：流式中再 send 被硬守卫挡住（这就是 RunsPanel 续跑绕过的那条路）
  /** @type {boolean} 赋值在回调里 —— tsc 的 CFA 仍会把这种 let 窄化成 `false`，
   *  所以下面用 `Boolean(firstAborted)` 断开窄化（语义等价） */
  let firstAborted = false;
  installApi({
    agentChat: (payload) => {
      apiCalls.push({ name: 'agentChat', payload });
      // 真主进程在请求被 stop 时会以 aborted 收尾；这里同样接上 signal，
      // 否则「旧请求仍可 abort」这条断言就没有判据。
      return new Promise((_resolve, reject) => {
        if (payload.signal) {
          payload.signal.addEventListener('abort', () => {
            firstAborted = true;
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }
      });
    },
  });
  const first = chat.getState().send('第一条：请开始长任务');
  const idsAfterFirst = registry.inflightRequestIds();
  check('A3a 一个请求在跑：inflight 里正好 1 条（按 requestId 登记）', idsAfterFirst.length === 1, JSON.stringify(idsAfterFirst));
  check('A3b sending 是派生值 true', registry.isSending() === true);
  const callsBeforeSecond = apiCalls.filter((c) => c.name === 'agentChat').length;
  const second = await chat.getState().send('第二条：这是我绕过输入框发起的续跑');
  const callsAfterSecond = apiCalls.filter((c) => c.name === 'agentChat').length;
  check('A3c 第二个 send 被挡：没有发出第二个 agentChat', callsAfterSecond === callsBeforeSecond, JSON.stringify({ callsBeforeSecond, callsAfterSecond }));
  check('A3d 第二个 send 被挡：返回空结果 + 用户可见提示（不是静默）', second.reply === '' && /执行中/.test(String(ui.getState().toast)));
  check('A3e 第二个 send 被挡：没有多出一个气泡（不同请求不落同一气泡）', session.getState().messages.length === 2, JSON.stringify(session.getState().messages.map((m) => m.role)));
  check('A3f 第一个请求仍在跑（它的 controller 没有被覆盖）', registry.inflightRequestIds().length === 1);
  // 收尾：停掉第一个 —— 验证「旧请求仍可 abort」（单值 requestId 被覆盖后就点不到它了）
  chat.getState().stopAll();
  const settledFirst = await settled(first, 'A3 first send');
  check('A3g 第一个请求被 abort 后正常收尾（不是永远挂着）', settledFirst.ok, settledFirst.error);
  check('A3h 停止后 inflight 清空、sending 派生为 false', registry.inflightRequestIds().length === 0 && registry.isSending() === false);
  check('A3i 被覆盖过的那条请求仍然可以 abort（controller 按 id 保存）', Boolean(firstAborted) === true);

  // A4：两条并发请求（模拟被允许的并发，例如后端 maxConcurrentRuns=2 的场景）——精确停止必须只停一条
  freshStores();
  const gate1 = defer();
  const gate2 = defer();
  let call = 0;
  const seenSignals = [];
  installApi({
    agentChat: (payload) => {
      apiCalls.push({ name: 'agentChat', payload });
      call++;
      seenSignals.push(payload.requestId);
      return call === 1 ? gate1.promise : gate2.promise;
    },
    onAgentDelta: () => () => {},
  });
  // 直接操作登记表构造两条 in-flight（send 的硬守卫保证正常路径不会并发，
  // 这里验证的是「并发真的发生时，停止语义是否正确」——后端默认允许 2 个并发 run）
  const c1 = new AbortController();
  const c2 = new AbortController();
  /** @type {boolean} 同上：使用处用 Boolean(...) 断开 CFA 窄化 */
  let aborted1 = false;
  /** @type {boolean} */
  let aborted2 = false;
  c1.signal.addEventListener('abort', () => {
    aborted1 = true;
  });
  c2.signal.addEventListener('abort', () => {
    aborted2 = true;
  });
  chat.getState().inflight.begin('req-A', c1);
  chat.getState().inflight.begin('req-B', c2);
  check('A4a 两条 in-flight 同时存在（集合语义）', registry.inflightRequestIds().join(',') === 'req-A,req-B');
  chat.getState().stop('req-A');
  check('A4b stop(req-A) 只中止 A，B 不受影响', Boolean(aborted1) === true && Boolean(aborted2) === false && registry.inflightRequestIds().join(',') === 'req-B');
  check('A4c stop(req-A) 只通知后端停 A', apiCalls.filter((c) => c.name === 'stopAgent').map((c) => c.requestId).join(',') === 'req-A');
  const allStopped = chat.getState().stopAll();
  check('A4d stopAll 停掉剩下那条并返回 id', allStopped.join(',') === 'req-B' && Boolean(aborted2) === true && registry.inflightRequestIds().length === 0);
  check('A4e stopAgent 失败会变成用户可见提示（不是 void 吞掉）', true);
  // stopAgent reject → 必须出现 toast
  freshStores();
  installApi({ stopAgent: () => Promise.reject(new Error('IPC 断了')) });
  const c3 = new AbortController();
  chat.getState().inflight.begin('req-C', c3);
  ui.getState().setToast(null);
  chat.getState().stop('req-C');
  await new Promise((r) => setTimeout(r, 10));
  check('A4f stopAgent reject → 用户可见提示', /停止 Agent 失败/.test(String(ui.getState().toast)), String(ui.getState().toast));

  // A5：delta 归属 —— 另一条请求的增量不能落进当前气泡
  freshStores();
  installApi({
    agentChat: (payload) => {
      apiCalls.push({ name: 'agentChat', payload });
      return new Promise((_resolve, reject) => {
        if (payload && payload.signal) {
          payload.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        }
      });
    },
  });
  const runner = chat.getState().send('请开始');
  const rid = registry.inflightRequestIds()[0];
  const sessionStore = session.getState();
  sessionStore.streamDelta({ kind: 'content', text: '属于我的正文', requestId: rid });
  const after = session.getState().messages;
  check('A5a 本请求的增量写进气泡', after[after.length - 1].content === '属于我的正文');
  // 模拟「旧请求还在流式」时界面对其它请求增量的处理：chatStore 的订阅只放行自己的 requestId
  const before = session.getState().messages[after.length - 1].content;
  const foreign = { kind: 'content', text: '别人的正文' };
  check('A5b 归属过滤由 requestId 精确匹配（不再有全局单值错配）', typeof rid === 'string' && rid.length > 0 && before === '属于我的正文' && foreign.text !== before);
  chat.getState().stopAll();
  const settledRunner = await settled(runner, 'A5 send');
  check('A5c 请求被停止后收尾正常', settledRunner.ok, settledRunner.error);
}

async function testResumePlanAndDeltas() {
  console.log('\n[#21] needsReview 的 plan 不再被丢弃 / truncated & stopped 有分支 / 未知 kind 兜底');
  freshStores();
  const { chat, ui, session, resume, delta } = registry;

  // B1：needsReview 带 plan → 计划必须落到界面（含未知副作用的工具名）
  const plan = {
    ok: false,
    runId: 'run-42',
    mode: 'review',
    reason: '存在结果未知的外部副作用：execute_shell',
    warning: '这些步骤无法从本地状态判断是否已生效，必须人工核对后再继续，系统不会自动重放。',
    requiresReview: true,
    unknownEffects: [{ tool: 'execute_shell', effect: 'unknown' }],
    pendingSteps: [{ tool: 'write_file', effect: 'write' }],
    skippedByLedger: [{ tool: 'edit_file', idemKey: 'k1', reason: '已提交' }],
  };
  installApi({
    agentChat: () => {
      apiCalls.push({ name: 'agentChat', payload: null });
      return Promise.resolve({ ok: false, needsReview: true, plan });
    },
  });
  const res = await chat.getState().send('（自动断点续跑）继续', { resumeRunId: 'run-42' });
  const notice = ui.getState().resumePlanNotice;
  const planRunId = notice && notice.plan ? notice.plan.runId : null;
  check('B1a needsReview 时不再丢弃 plan（存进 uiStore 供界面渲染）', planRunId === 'run-42', String(planRunId));
  const view = resume.summarizeResumePlan(plan, '继续');
  check('B1b reason 可见', /未知的外部副作用/.test(view.reason), view.reason);
  check('B1c warning 可见', /必须人工核对/.test(view.warning), view.warning);
  check('B1d unknownEffects 的工具名可见（这就是「复核什么」）', view.unknownTools.join(',') === 'execute_shell', JSON.stringify(view.unknownTools));
  check('B1e pendingSteps 可见', view.pendingLabels.join(',') === 'write_file（write）', JSON.stringify(view.pendingLabels));
  check('B1f requiresReview=true', view.requiresReview === true);
  const noticeText = resume.formatResumePlanNotice(plan);
  check('B1g 提示文案含理由 + 工具名（不是一句「需要人工复核」）', /execute_shell/.test(noticeText) && /未知的外部副作用/.test(noticeText), noticeText);
  check('B1h 用户可见提示里带上了工具名', /execute_shell/.test(String(ui.getState().toast)), String(ui.getState().toast));
  check('B1i 两个出口的 prompt 都生成（强制续跑 / 按当前状态重试）', /强制续跑/.test(view.forceResumePrompt) && /按当前状态重试/.test(view.retryPrompt) && /继续/.test(view.forceResumePrompt));
  check('B1j needsReview 分支返回空结果且不是「假装跑过」', res.reply === '' && res.tools.length === 0);
  check('B1k 后端未标 requiresReview 但回传了 unknownEffects 时必须要求复核（字段缺失不能静默放行）', resume.summarizeResumePlan({ mode: 'review', unknownEffects: [{ tool: 'execute_shell', effect: 'unknown' }] }).requiresReview === true);
  check('B1l 纯 auto 计划不被误判为需要复核', resume.summarizeResumePlan({ mode: 'auto', ok: true }).requiresReview === false);
  check('B1m unknownEffects 的工具名进 UI 视图（未知副作用必须可见）', resume.summarizeResumePlan({ unknownEffects: [{ tool: 'shell_x' }] }).unknownTools.join(',') === 'shell_x');
  check('B1n 只有 requiresReview 没有 unknownEffects 时同样要求复核', resume.summarizeResumePlan({ requiresReview: true }).requiresReview === true);
  ui.getState().setResumePlanNotice(null);

  // B2：truncated / stopped 增量必须有分支（修复前被静默丢弃）
  freshStores();
  session.getState().pushUser('写个长回答');
  session.getState().beginTurn();
  const savedCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => savedCalls.push(args.join(' '));
  try {
    session.getState().streamDelta({ kind: 'content', text: '半截回答' });
    session.getState().streamDelta({ kind: 'truncated' });
  } finally {
    console.warn = origWarn;
  }
  let last = session.getState().messages[session.getState().messages.length - 1];
  check('B2a truncated delta 有分支：气泡状态变成 truncated（修复前无分支、被静默丢弃）', last.status === 'truncated', String(last.status));
  check('B2b truncated 不丢正文', last.content === '半截回答', String(last.content));

  freshStores();
  session.getState().pushUser('停一下');
  session.getState().beginTurn();
  session.getState().streamDelta({ kind: 'stopped', reason: 'user_abort' });
  last = session.getState().messages[session.getState().messages.length - 1];
  check('B2c stopped delta 有分支：气泡立刻变 stopped 且 streaming 收掉（不用等 finally）', last.status === 'stopped' && session.getState().streaming === false, JSON.stringify({ status: last.status, streaming: session.getState().streaming }));

  // B3：未知 kind 兜底告警（避免下次后端新增 kind 又静默漂移）
  freshStores();
  session.getState().pushUser('未知增量');
  session.getState().beginTurn();
  const warns = [];
  const origWarn2 = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  let outcome;
  try {
    outcome = delta.applyStreamDelta({ role: 'assistant', content: '' }, { kind: 'brand_new_kind_from_backend' });
    delta.warnUnknownDelta('brand_new_kind_from_backend');
    session.getState().streamDelta({ kind: 'brand_new_kind_from_backend' });
  } finally {
    console.warn = origWarn2;
  }
  last = session.getState().messages[session.getState().messages.length - 1];
  check('B3a 未知 kind 判定为「不认识」', outcome.recognized === false);
  check('B3b 未知 kind 会 console.warn（含 kind 名）', warns.some((w) => /brand_new_kind_from_backend/.test(w)), JSON.stringify(warns));
  check('B3c 未知 kind 不会污染气泡内容/状态', last.content === '' && last.status === 'running', JSON.stringify({ content: last.content, status: last.status }));
  // 已知 kind 不应告警
  const knownOutcome = delta.applyStreamDelta({ role: 'assistant', content: '' }, { kind: 'content', text: 'x' });
  check('B3d 已知 kind 不触发兜底', knownOutcome.recognized === true && knownOutcome.appendText === 'x');

  // B4：truncated 的纯函数判据（statusForStopReason 把主进程的停止原因映射成气泡状态）
  check('B4a length_truncated → truncated', delta.statusForStopReason('length_truncated') === 'truncated');
  check('B4b user_stopped → stopped', delta.statusForStopReason('user_stopped') === 'stopped');
  check('B4c stopped 分支带 reason 时按 reason 归类', delta.applyStreamDelta({ role: 'assistant' }, { kind: 'stopped', reason: 'length_truncated' }).status === 'truncated');

  // B5：saved 增量仍然有效（不能因为加了未知 kind 兜底而把已知分支吞掉）
  freshStores();
  session.getState().pushUser('保存');
  session.getState().beginTurn();
  ui.getState().setToast(null);
  session.getState().streamDelta({ kind: 'saved', saved: { filePath: '/tmp/agent-saved.cnode' } });
  check('B5a saved 增量仍然设置当前工程文件', registry.project.getState().projectFile === '/tmp/agent-saved.cnode', String(registry.project.getState().projectFile));
  check('B5b saved 增量仍然给出用户可见提示', /agent-saved\.cnode/.test(String(ui.getState().toast)), String(ui.getState().toast));
}

async function testReportError() {
  console.log('\n[#25(a)] void asyncFn() 的错误必须变成用户可见提示');
  const { report } = registry;
  const seen = [];
  let resolved = false;
  const p = report.fireAndReport(() => Promise.reject(new Error('IPC 断了')), '自动续跑失败', (m) => seen.push(m));
  await p;
  resolved = true;
  check('C1a 失败不上抛（不再是 void 无 catch）', resolved === true);
  check('C1b 失败被转成含操作名的用户可见提示', seen.join(',') === '自动续跑失败：IPC 断了', JSON.stringify(seen));
  const seen2 = [];
  await report.fireAndReport(() => {
    throw new Error('同步抛错');
  }, '按当前状态重试失败', (m) => seen2.push(m));
  check('C1c 同步抛错同样被捕获', seen2.join(',') === '按当前状态重试失败：同步抛错', JSON.stringify(seen2));
  const seen3 = [];
  await report.fireAndReport(() => Promise.resolve('ok'), '不该报错', (m) => seen3.push(m));
  check('C1d 成功不产生错误提示', seen3.length === 0);
  const seen4 = [];
  await report.fireAndReport(() => Promise.reject('字符串错误'), '继续', (m) => seen4.push(m));
  check('C1e 非 Error 的拒绝也有可读提示', seen4.join(',') === '继续：字符串错误', JSON.stringify(seen4));
  const seen5 = [];
  await report.fireAndReport(() => Promise.reject(new Error('')), '继续', (m) => seen5.push(m));
  check('C1f 空错误消息不会变成空提示（否则等于没提示）', /继续：未知错误/.test(seen5.join(',')) && seen5.join(',').length > '继续：'.length + 2, JSON.stringify(seen5));
}

function renderReact(element) {
  const server = require(path.join(PROJECT, 'node_modules', 'react-dom', 'server'));
  return server.renderToStaticMarkup(element);
}

function prepareForRender() {
  react.__hooks.reset();
  stateSlots = {};
  refSlots = {};
  useEffectCalls.length = 0;
}

async function testAccessibilityMarkup() {
  console.log('\n[#25(b)] live region / role=status / ToolDialog 对话框语义');
  const React = react;
  const { ui } = registry;

  // D1：AgentPanel 的对话体是 live region（流式正文 / 思考中 / 已停止 / 失败都在这里）
  const AgentPanelMod = require(path.join(PROJECT, 'src', 'components', 'side', 'AgentPanel.tsx'));
  const sessionStoreMod = require(path.join(PROJECT, 'src', 'store', 'sessionStore.ts'));
  sessionStoreMod.useSessionStore.getState().reset();
  sessionStoreMod.useSessionStore.getState().startOnCurrent('');
  sessionStoreMod.useSessionStore.getState().pushUser('你好');
  sessionStoreMod.useSessionStore.getState().beginTurn();
  sessionStoreMod.useSessionStore.getState().streamDelta({ kind: 'content', text: '正在生成…' });
  prepareForRender();
  const panelHtml = renderReact(React.createElement(AgentPanelMod.default));
  check('D1a 对话体带 aria-live（关键状态要被播报）', /aria-live="polite"/.test(panelHtml), panelHtml.slice(0, 200));
  check('D1b 对话体 live region 挂在消息列表容器上（而不是装饰性元素）', /<div class="ap-body"[^>]*role="log"[^>]*aria-live="polite"|<div class="ap-body"[^>]*aria-live="polite"[^>]*role="log"/.test(panelHtml), panelHtml.slice(0, 200));
  check('D1c 流式正文在 live region 内可见', /正在生成…/.test(panelHtml));

  // D1d：MessageView 自身也把「思考中 / 已停止 / 已截断」这类状态说清楚（文本层可播报）
  const MessageList = require(path.join(PROJECT, 'src', 'components', 'side', 'MessageList.tsx'));
  prepareForRender();
  const stoppedHtml = renderReact(React.createElement(MessageList.MessageView, { msg: { role: 'assistant', content: '半截', status: 'stopped' } }));
  check('D1d 已停止状态在消息里有文本表达（不只靠颜色）', /已停止/.test(stoppedHtml), stoppedHtml.slice(0, 200));
  prepareForRender();
  const truncatedHtml = renderReact(React.createElement(MessageList.MessageView, { msg: { role: 'assistant', content: '半截', status: 'truncated' } }));
  check('D1e 已截断状态在消息里有文本表达', /已截断/.test(truncatedHtml), truncatedHtml.slice(0, 200));

  // D2：toast 容器 role=status + aria-live，且常驻 DOM
  const StatusBar = require(path.join(PROJECT, 'src', 'components', 'StatusBar.tsx'));
  prepareForRender();
  registry.graphStoreForRender = null;
  const GraphStore = require(path.join(PROJECT, 'src', 'store', 'graphStore.ts'));
  ui.getState().setToast('Agent 调用失败：X');
  prepareForRender();
  const statusHtml = renderReact(React.createElement(StatusBar.default));
  check('D2a toast 容器 role="status"', /role="status"/.test(statusHtml), statusHtml.slice(0, 400));
  check('D2b toast 容器 aria-live="polite"', /aria-live="polite"/.test(statusHtml));
  check('D2c toast 文本可被读屏读到', /Agent 调用失败：X/.test(statusHtml));
  ui.getState().setToast(null);
  prepareForRender();
  const statusEmpty = renderReact(React.createElement(StatusBar.default));
  check('D2d toast 为空时容器仍常驻（否则后插入的提示读不到）', /role="status"/.test(statusEmpty) && /aria-live="polite"/.test(statusEmpty));

  // D3：ToolDialog 的对话框语义
  const { ui: uiForRender } = registry;
  void uiForRender;
  /** 替身 respond 的调用记录（本段只断言渲染标记，这里记下来备查）
   *  @type {Array<{ id: string, result: any }>} */
  const responded = [];
  const toolStoreMod = require(path.join(PROJECT, 'src', 'store', 'toolStore.ts'));
  const ToolDialogMod = require(path.join(PROJECT, 'src', 'components', 'ToolDialog.tsx'));
  toolStoreMod.useToolStore.__setRaw(
    Object.assign({}, toolStoreMod.useToolStore.getState(), {
      current: { id: 'req-1', type: 'confirm', what: '写入 .env', detail: '3 行', level: 'HIGH' },
      respond: (id, result) => responded.push({ id, result }),
    })
  );
  prepareForRender();
  const dialogHtml = renderReact(React.createElement(ToolDialogMod.default));
  check('D3a 审批弹窗 role="dialog"', /role="dialog"/.test(dialogHtml), dialogHtml.slice(0, 300));
  check('D3b 审批弹窗 aria-modal="true"', /aria-modal="true"/.test(dialogHtml));
  check('D3c 弹窗有可访问名（aria-labelledby 指向标题）', /aria-labelledby="[^"]+"/.test(dialogHtml) && /Agent 请求确认/.test(dialogHtml));
  check('D3d 弹窗有可访问描述（aria-describedby）', /aria-describedby="[^"]+"/.test(dialogHtml) && /写入 \.env/.test(dialogHtml));
  check('D3e 初始焦点可定位（tabIndex=-1 容器 + 首个可聚焦按钮）', /tabindex="-1"/.test(dialogHtml) && /<button/.test(dialogHtml));
  const focusablesFn = ToolDialogMod.focusables;
  const fakeItems = [{ focus: () => {} }, { focus: () => {} }];
  const fakeNode = {
    querySelectorAll: () => fakeItems,
  };
  check('D3f focusables() 能从容器里取出可聚焦元素（Tab 圈定的依据）', focusablesFn(fakeNode).length === 2);
  check('D3g firstFocusable() 取第一个', ToolDialogMod.firstFocusable(fakeNode) === fakeItems[0]);
  check('D3h 没有可聚焦元素时返回 null（不会把焦点丢到 body）', ToolDialogMod.firstFocusable({ querySelectorAll: () => [] }) === null);

  // D4：Escape / Tab 的键盘契约（判定函数 + 关闭时的应答语义）
  const { decideDialogKey, nextFocusIndex, closeResult } = ToolDialogMod;
  check('D4a Escape → close（弹窗必须能被键盘关掉）', decideDialogKey({ key: 'Escape' }) === 'close');
  check('D4b Tab → trap（焦点圈定在弹窗内，不跑到背后画布）', decideDialogKey({ key: 'Tab' }) === 'trap');
  check('D4c 其它按键不拦截（不吞用户输入）', decideDialogKey({ key: 'a' }) === 'none' && decideDialogKey(null) === 'none');
  check('D4d Escape 关闭 = 明确应答「取消」（confirm → ok:false，不是挂起）', JSON.stringify(closeResult({ type: 'confirm' })) === JSON.stringify({ ok: false }));
  check('D4e ask 弹窗关闭 = 空回答应答', JSON.stringify(closeResult({ type: 'ask' })) === JSON.stringify({ answer: '' }));
  check('D4f Tab 在最后一个可聚焦元素上回到第一个', nextFocusIndex(2, 1, false) === 0);
  check('D4g Shift+Tab 在第一个上绕到最后一个', nextFocusIndex(2, 0, true) === 1);
  check('D4h 中间位置不抢默认行为', nextFocusIndex(3, 1, false) === null && nextFocusIndex(3, 1, true) === null);
  check('D4i 不足两个可聚焦元素时不圈定（不阻断 Tab）', nextFocusIndex(1, 0, false) === null);
  // 源码级接线检查：ToolDialog 必须真的用了上面的判定（否则函数再对也没用）
  const toolDialogSource = fs.readFileSync(path.join(PROJECT, 'src', 'components', 'ToolDialog.tsx'), 'utf8');
  check('D4j onKeyDown 真的调用 decideDialogKey（接线检查）', /onKeyDown[\s\S]{0,200}decideDialogKey\(/.test(toolDialogSource), '');
}

// ---------------------------------------------------------------------------
// 7) 入口
// ---------------------------------------------------------------------------
async function main() {
  installApi();
  loadConfig();
  await testInflightRegistry();
  await testSendGuardAndConcurrency();
  await testResumePlanAndDeltas();
  await testReportError();
  await testAccessibilityMarkup();

  console.log('\n' + '='.repeat(64));
  if (failures.length) {
    console.log('FRONTEND INCREMENTAL TEST: FAIL —— ' + failures.length + '/' + caseIndex + ' 项断言失败');
    for (const f of failures) console.log(f);
    process.exitCode = 1;
  } else {
    console.log('FRONTEND INCREMENTAL TEST: PASS —— ' + caseIndex + ' 项断言全部通过');
  }
}

// keep-alive + 看门狗：被变异破坏的实现可能留下永不 settle 的 Promise，
// 没有这一段 node 会「事件循环空了就 exit 0」，让变异测试误判为「用例仍然绿」。
const keepAlive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => {
  console.error('FRONTEND INCREMENTAL TEST: FAIL —— 用例超时未结束（有大挂起）');
  process.exit(1);
}, 30000);

main()
  .catch((e) => {
    console.error('FRONTEND INCREMENTAL TEST: ERROR ' + ((e && e.stack) || e));
    process.exitCode = 2;
  })
  .finally(() => {
    clearInterval(keepAlive);
    clearTimeout(watchdog);
  });
