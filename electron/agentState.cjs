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
 * 合法迁移通过 `onDelta({kind:'state'})` 上报并落成 `run_state`；非法迁移通过
 * `onDelta({kind:'state_violation'})` 写入审计事件，避免只留在内存里。
 *
 * 状态语义（进入条件 / 退出条件 / 恢复策略提示 / 关联持久化证据）：
 *
 * | 状态           | 进入条件                              | 退出条件                                   | 恢复策略提示 | 持久化证据 |
 * |----------------|---------------------------------------|--------------------------------------------|--------------|------------|
 * | RUNNING        | run_start 写入成功、尚未产生工具调用  | 有 tool_calls → WAITING_TOOL；纯文本 → COMPLETED；异常 → FAILED；abort → CANCELLED | 依检查点和副作用账本 | run_start / checkpoint |
 * | WAITING_TOOL   | 本轮 assistant 消息含 tool_calls      | 全部调用结算 → RUNNING；需要审批 → WAITING_USER；触顶 → LIMIT_REACHED | 依检查点和副作用账本 | tool intent / side-effect ledger |
 * | WAITING_USER   | 审批/提问已发出（等用户应答）         | 用户应答（包括拒绝结果）回到工具流程；中断后需复核；abort → CANCELLED | 中断后需复核 | approval audit / checkpoint |
 * | COMPLETED      | 模型给出无 tool_calls 的最终文本      | —（终态）                                  | 不可续跑 | run_finish |
 * | FAILED         | 系统错误 / 不可重试失败               | 根据检查点和副作用账本决定续跑方式          | 依检查点和副作用账本 | run_finish / checkpoint |
 * | CANCELLED      | 用户 abort                            | 用户确认后续跑                             | 必须人工复核 | run_finish / checkpoint |
 * | LIMIT_REACHED  | 迭代 / 工具 / 上下文 / 输出上限触发   | 用户续跑（预算重置或继续处理部分结果）      | 依检查点和副作用账本 | run_finish / checkpoint |
 *
 * `recoveryPolicy` 只是状态层提示。是否能 auto 续跑由 runCheckpoint.planResume 根据检查点和
 * side-effect ledger 判断；单看状态本身不能证明重放副作用是安全的。
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

/** 每个状态的人类可读语义 + 恢复策略提示（具体续跑决策由 runCheckpoint.planResume 完成）。
 * recoverable 为兼容字段，仅表示存在续跑处理路径，不代表可以自动续跑。
 * @type {Record<string, {label: string, terminal: boolean, recoverable: boolean, recoveryPolicy: 'never'|'checkpoint-dependent'|'review-required', persists: string[]}>} */
const STATE_INFO = Object.freeze({
  [STATES.RUNNING]: { label: '执行中', terminal: false, recoverable: true, recoveryPolicy: 'checkpoint-dependent', persists: ['run_start', 'checkpoint'] },
  [STATES.WAITING_TOOL]: { label: '等待工具', terminal: false, recoverable: true, recoveryPolicy: 'checkpoint-dependent', persists: ['toolIntent(prepared)', 'side-effect ledger'] },
  [STATES.WAITING_USER]: { label: '等待用户', terminal: false, recoverable: true, recoveryPolicy: 'review-required', persists: ['approval audit', 'checkpoint'] },
  [STATES.COMPLETED]: { label: '已完成', terminal: true, recoverable: false, recoveryPolicy: 'never', persists: ['run_finish'] },
  [STATES.FAILED]: { label: '失败', terminal: true, recoverable: true, recoveryPolicy: 'checkpoint-dependent', persists: ['run_finish', 'checkpoint'] },
  [STATES.CANCELLED]: { label: '已取消', terminal: true, recoverable: true, recoveryPolicy: 'review-required', persists: ['run_finish', 'checkpoint'] },
  [STATES.LIMIT_REACHED]: { label: '达到上限', terminal: true, recoverable: true, recoveryPolicy: 'checkpoint-dependent', persists: ['run_finish', 'checkpoint'] },
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
  if (typeof o.stopReason === 'string' && ['iteration_limit', 'tool_limit', 'context_overflow', 'length_truncated'].includes(o.stopReason)) {
    return STATES.LIMIT_REACHED;
  }
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
 * @param {{ runId?: string, onTransition?: (info: {from: string, to: string, reason: string, ts: string}) => void, onViolation?: (violation: object) => void }} [options]
 */
function createStateMachine(options = {}) {
  const machine = {
    runId: options.runId || null,
    state: STATES.RUNNING,
    history: /** @type {Array<any>} */ ([]),
    violations: /** @type {Array<any>} */ ([]),
    startedAt: new Date().toISOString(),
  };

  const recordViolation = (violation) => {
    machine.violations.push(violation);
    try {
      if (typeof options.onViolation === 'function') options.onViolation({ ...violation });
    } catch {}
  };

  /**
   * 迁移到目标状态。相同状态为空操作；非法迁移被拒绝并记录（不抛异常、不改变现状）。
   * @param {string} to
   * @param {string} [reason]
   * @returns {boolean} 是否真的发生了迁移
   */
  machine.go = (to, reason) => {
    if (!isState(to)) {
      recordViolation({ type: 'unknown-state', to: String(to), reason: String(reason || '') });
      return false;
    }
    if (to === machine.state) return false;
    if (!canTransition(machine.state, to)) {
      recordViolation({ type: 'illegal-transition', from: machine.state, to, reason: String(reason || '') });
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
    recoveryPolicy: (STATE_INFO[machine.state] || {}).recoveryPolicy || 'checkpoint-dependent',
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
