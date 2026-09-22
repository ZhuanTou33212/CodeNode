/**
 * agentState.cjs —— Agent 运行状态机（审查第 1/5 项：状态显式化）
 *
 * 之前的状态全靠 `stopReason` 字符串 + `result.error` 的真假隐式表达：
 *   - 达到迭代/调用上限被折叠成 `error`（和真正的失败、异常、程序错误混在一起），
 *     调用方（IPC / UI / 续跑判定）无法区分「预算用尽需续跑」与「执行出错需排查」；
 *   - 「等待工具」「等待用户确认/回答」这两个真实存在的过程状态完全没有体现，
 *     `context.confirm()` / `context.askUser()` 在界面上弹窗等待时，Run 看上去仍是 running。
 *
 * 本模块是**纯函数状态机**（不碰 IO、不抛异常），被 `agent.cjs` 主循环驱动，
 * 每次迁移通过 `onDelta({kind:'state'})` 上报，由 `ipc/agent.cjs` 落成 run 事件 `run_state`。
 *
 * 状态语义（进入条件 / 退出条件 / 可恢复性 / 需持久化的内容）：
 *
 * | 状态           | 进入条件                              | 退出条件                                   | 可恢复 | 持久化 |
 * |----------------|---------------------------------------|--------------------------------------------|--------|--------|
 * | RUNNING        | run_start 写入成功、尚未产生工具调用  | 有 tool_calls → WAITING_TOOL；纯文本 → COMPLETED；异常 → FAILED；abort → CANCELLED | —      | prompt/model/nodeId/sandbox |
 * | WAITING_TOOL   | 本轮 assistant 消息含 tool_calls      | 全部调用结算 → RUNNING；需要审批 → WAITING_USER；上限 → LIMIT_REACHED | 是（可按 toolCallId 跳过已 committed 的写） | 每次调用的 intent(prepared) |
 * | WAITING_USER   | 审批/提问已发出（等用户应答）         | 用户应答 → WAITING_TOOL；拒绝/超时 → FAILED；abort → CANCELLED | 是（审批可恢复，但不重复发起副作用） | 审批请求 id + 目标 toolCallId |
 * | COMPLETED      | 模型给出无 tool_calls 的最终文本      | —（终态）                                  | 不需要 | content/grounding/usage |
 * | FAILED         | 系统错误 / 不可重试失败 / 审批被拒    | 人工重试 → 新 Run（旧 Run superseded）     | 部分（仅只读阶段可自动续） | state+reason |
 * | CANCELLED      | 用户 abort                            | 续跑需人工复核                             | 是（必须 review） | 已 abort 的工具 id |
 * | LIMIT_REACHED  | 迭代 / 工具调用数触顶                 | 用户续跑（预算重置）                       | 是（只读阶段可 auto） | 触发维度 + 已用值 |
 */
'use strict';

/** @type {Record<string, string>} */
const STATES = Object.freeze({
  RUNNING: 'RUNNING',
  WAITING_TOOL: 'WAITING_TOOL',
  WAITING_USER: 'WAITING_USER',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  LIMIT_REACHED: 'LIMIT_REACHED',
});

/** @type {readonly string[]} */
const ALL = Object.freeze(Object.values(STATES));

/** 终态：不再发生变化
 * @type {readonly string[]} */
const TERMINAL = Object.freeze([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED, STATES.LIMIT_REACHED]);

/** 允许的迁移（未列出的迁移一律拒绝并记为 anomaly，避免状态静默跳变）
 * @type {Record<string, string[]>} */
const TRANSITIONS = Object.freeze({
  [STATES.RUNNING]: [STATES.WAITING_TOOL, STATES.WAITING_USER, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED, STATES.LIMIT_REACHED],
  [STATES.WAITING_TOOL]: [STATES.RUNNING, STATES.WAITING_USER, STATES.FAILED, STATES.CANCELLED, STATES.LIMIT_REACHED],
  [STATES.WAITING_USER]: [STATES.WAITING_TOOL, STATES.RUNNING, STATES.FAILED, STATES.CANCELLED],
  [STATES.COMPLETED]: [],
  [STATES.FAILED]: [],
  [STATES.CANCELLED]: [],
  [STATES.LIMIT_REACHED]: [],
});

/** 每个状态的人类可读语义 + 可恢复性（UI/续跑判定/文档共用一处定义）
 * @type {Record<string, {label: string, terminal: boolean, recoverable: boolean, persists: string[]}>} */
const STATE_INFO = Object.freeze({
  [STATES.RUNNING]: { label: '执行中', terminal: false, recoverable: false, persists: ['prompt', 'model', 'nodeId', 'sandbox'] },
  [STATES.WAITING_TOOL]: { label: '等待工具', terminal: false, recoverable: true, persists: ['toolIntent(prepared)'] },
  [STATES.WAITING_USER]: { label: '等待用户', terminal: false, recoverable: true, persists: ['approvalRequestId', 'toolCallId'] },
  [STATES.COMPLETED]: { label: '已完成', terminal: true, recoverable: false, persists: ['content', 'grounding', 'usage'] },
  [STATES.FAILED]: { label: '失败', terminal: true, recoverable: false, persists: ['state', 'reason'] },
  [STATES.CANCELLED]: { label: '已取消', terminal: true, recoverable: true, persists: ['abortedToolCallIds'] },
  [STATES.LIMIT_REACHED]: { label: '达到上限', terminal: true, recoverable: true, persists: ['limit', 'used'] },
});

/**
 * @param {any} value
 * @returns {boolean}
 */
function isState(value) {
  return typeof value === 'string' && ALL.includes(value);
}

/**
 * @param {any} from
 * @param {any} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * 把一轮 run 的收尾信息归类成终态。
 * @param {{ error?: any, aborted?: boolean, stopReason?: string|null }} outcome
 * @returns {string} STATES.*
 */
function classifyOutcome(outcome) {
  const o = outcome || {};
  if (o.aborted === true) return STATES.CANCELLED;
  if (o.stopReason === 'iteration_limit' || o.stopReason === 'tool_limit') return STATES.LIMIT_REACHED;
  if (o.error) return STATES.FAILED;
  return STATES.COMPLETED;
}

/** 从状态推出 run 的持久化状态串（runStore.finishRun 的 status），保持既有取值不变 */
function toRunStatus(state) {
  if (state === STATES.COMPLETED) return 'completed';
  if (state === STATES.CANCELLED) return 'cancelled';
  if (state === STATES.LIMIT_REACHED) return 'error'; // 保持既有 status 取值（UI/续跑判定依赖），另用 state 字段区分
  if (state === STATES.FAILED) return 'error';
  return 'unknown';
}

/**
 * 创建状态机。
 * @param {{ runId?: string, onTransition?: (info: {from: string, to: string, reason: string, ts: string}) => void }} [options]
 */
function createStateMachine(options = {}) {
  const machine = {
    runId: options.runId || null,
    state: STATES.RUNNING,
    history: /** @type {Array<any>} */ ([]),
    violations: /** @type {Array<any>} */ ([]),
    startedAt: new Date().toISOString(),
  };

  /**
   * 迁移到目标状态。相同状态为空操作；非法迁移被拒绝并记录（不抛异常、不改变现状）。
   * @param {string} to
   * @param {string} [reason]
   * @returns {boolean} 是否真的发生了迁移
   */
  machine.go = (to, reason) => {
    if (!isState(to)) {
      machine.violations.push({ type: 'unknown-state', to: String(to), reason: String(reason || '') });
      return false;
    }
    if (to === machine.state) return false;
    if (!canTransition(machine.state, to)) {
      machine.violations.push({ type: 'illegal-transition', from: machine.state, to, reason: String(reason || '') });
      return false;
    }
    const info = { from: machine.state, to, reason: String(reason || ''), ts: new Date().toISOString() };
    machine.state = to;
    machine.history.push(info);
    try {
      if (typeof options.onTransition === 'function') options.onTransition(info);
    } catch {}
    return true;
  };

  machine.isTerminal = () => TERMINAL.includes(machine.state);
  machine.info = () => STATE_INFO[machine.state] || null;
  machine.snapshot = () => ({
    runId: machine.runId,
    state: machine.state,
    label: (STATE_INFO[machine.state] || {}).label || machine.state,
    terminal: TERMINAL.includes(machine.state),
    recoverable: !!(STATE_INFO[machine.state] || {}).recoverable,
    transitions: machine.history.length,
    violations: machine.violations.slice(),
  });

  return machine;
}

module.exports = {
  STATES,
  ALL_STATES: ALL,
  TERMINAL_STATES: TERMINAL,
  TRANSITIONS,
  STATE_INFO,
  isState,
  canTransition,
  classifyOutcome,
  toRunStatus,
  createStateMachine,
};
