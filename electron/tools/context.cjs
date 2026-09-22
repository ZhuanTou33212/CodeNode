/**
 * AgentToolContext：工具执行上下文（复刻原版 AgentToolContext 的关键能力）。
 *
 * 字段：
 *   projectRoot       项目根目录（string）
 *   model             GraphModel 或 null
 *   confirm(level,what,detail) → Promise<boolean>   分级确认
 *   audit(entry)                                     审计日志
 *   mutateWorkbench(fn) → Promise<boolean>           在工作台模型上执行变更，返回是否真的改动
 *   saveProject() → Promise                          保存工程
 *   askUser(question, options) → Promise<string>     向用户提问
 *   ui(action, args) → Promise<boolean>              界面操控
 *   conversationHistory() → Array                    会话历史
 *   notifyFileChange(rel, kind, detail)              文件变更通知
 *   ragConfig() → object                              本地 RAG 配置
 *   scalars() → ScalarStore|null                      本地标量存储（画布节点等精准数据）
 */
'use strict';

// S7：审批服务（令牌化）—— 令牌只活在内存里，模型无法自填
const approvalLib = require('./approval.cjs');
const ruleLib = require('../approvalRules.cjs');

const ConfirmationLevel = { LOW: 'LOW', WRITE: 'WRITE', HIGH: 'HIGH' };

class AgentToolContext {
  constructor(options) {
    const o = options || {};
    this.projectRootValue = o.projectRoot || '.';
    this.modelValue = o.model || null;
    this.confirmHandler = o.confirm || null;
    // S7：审批服务（懒创建）。显式注入时优先用注入实例（便于同一 run 内共享令牌表）
    this.approvalServiceValue = o.approvalService || null;
    this.approvalTtlMsValue = o.approvalTtlMs || null;
    /** read_skill 的正文上限（0/未给 = 用工具内默认值）；放在上下文里以便配置与测试注入 */
    this.skillMaxCharsValue = Number(o.skillMaxChars) > 0 ? Math.floor(Number(o.skillMaxChars)) : 0;
    /** web_search 的后端配置（未启用时工具根本不注册，这里是「配了才用得上」的那份配置） */
    this.webSearchConfigValue = o.webSearchConfig || null;
    this.auditLogger = o.audit || null;
    this.workbenchMutator = o.mutateWorkbench || null;
    this.saveAction = o.saveProject || null;
    // 最近一次 saveProject 的失败原因（供 save_project 工具如实报错）
    this.saveErrorValue = null;
    this.questionHandler = o.askUser || null;
    this.uiAction = o.ui || null;
    this.conversationSupplier = o.conversationHistory || null;
    this.fileChangeNotifier = o.notifyFileChange || null;
    this.ragConfigValue = o.ragConfig || {};
    this.scalarStoreValue = o.scalarStore || null;
    this.undoAction = o.undo || null;
    this.redoAction = o.redo || null;
    this.runIdValue = o.runId || '';
    this.taskIdValue = o.taskId || '';
    this.roleValue = o.role || 'supervisor';
    this.readOnlyValue = o.readOnly === true;
    this.signalValue = o.signal || null;
    // 文件遍历类工具（scan_project / find_files / search_files）是否走 worker 线程。
    // 默认 true：同步遍历会把 Electron 主进程卡住，且单次同步 fs 调用不可中断。
    // 置 false 退回主线程同步执行（排障 / 老平台兜底），行为与旧版一致但会阻塞界面。
    this.fsWorkerValue = o.fsWorker !== false;
    // 执行隔离策略（sandbox.cjs 解析结果）；未注入时由 sandbox.cjs 的默认策略兜底
    this.sandboxPolicyValue = o.sandbox || null;
    // 副作用幂等守卫（sideEffects.cjs）；未注入时为无操作
    this.sideEffectGuardValue = o.sideEffectGuard || null;
    // 断点检查点写入器（runCheckpoint.cjs）；未注入时为无操作
    this.checkpointSink = o.checkpoint || null;
    /**
     * 意图识别策略（electron/intent.cjs 的 createIntentPolicy 结果）；未注入时为 null。
     * **只用于收紧**：它能让审批在命中免打扰规则时仍然弹窗，绝不可能让任何东西被放行。
     * null 与「没有这个功能」等价（逐字节不变）。
     */
    this.intentPolicyValue = o.intentPolicy || null;
    /**
     * 动作级意图复核（A2）：注入一个 `async ({tool, detail}) => policy|null` 的实现。
     * 轮级判定看不到「助手接下来真要做什么」，所以副作用动作在**执行前**会再判一次。
     * 与轮级同语义 —— **只收紧**：返回 null / 抛错 / `tighten !== true` 都不改变原判定。
     */
    this.intentReviewer = typeof o.intentReview === 'function' ? o.intentReview : null;
    // 状态上报钩子（由 runAgentChat 注入）：让「等待用户」这类过程状态能被状态机看到
    this.stateNotifier = null;
  }

  projectRoot() {
    return this.projectRootValue || '.';
  }

  model() {
    return this.modelValue;
  }

  runId() { return this.runIdValue; }
  taskId() { return this.taskIdValue; }
  role() { return this.roleValue; }
  readOnly() { return this.readOnlyValue; }

  /** read_skill 的正文上限（0 = 用默认值） */
  skillMaxChars() { return this.skillMaxCharsValue; }

  /** web_search 后端配置（null = 未配置） */
  webSearchConfig() { return this.webSearchConfigValue; }
  signal() { return this.signalValue; }
  cancelled() { return !!(this.signalValue && this.signalValue.aborted); }

  /** 文件遍历类工具是否走 worker 线程（tools.fs_worker，默认 true） */
  fsWorkerEnabled() { return this.fsWorkerValue !== false; }

  /**
   * 意图识别策略（electron/intent.cjs）；未注入时返回 null。
   * 消费侧（审批）只读它的 `forceConfirm()` —— 语义是「收紧」，不是「放行」。
   */
  intentPolicy() {
    return this.intentPolicyValue;
  }

  /**
   * 动作级意图复核（A2）：请注入的实现对**即将执行的动作**再判一次
   * （输入含 `<planned_action>` 与用户的插话）。
   *
   * 返回 `policy|null`，调用方**只认 `tighten === true`**（只收紧）。
   * 未接线 / 抛错 / 返回 null 都等价于「不改变原判定」—— 复核不能成为执行的故障点。
   *
   * @param {{tool?: string, detail?: string}} action
   * @returns {Promise<any|null>}
   */
  async intentReview(action) {
    if (!this.intentReviewer) return null;
    try {
      return await this.intentReviewer(action);
    } catch {
      return null;
    }
  }

  /**
   * S7：审批服务 —— 服务端签发/校验令牌（绑定 capability / scope / toolCallId / 有效期，单次有效）。
   * 懒创建；令牌表挂在 run 级上下文上，失败原因落审计（approval_rejected 带 reason）。
   */
  approval() {
    if (!this.approvalServiceValue) {
      this.approvalServiceValue = approvalLib.createApprovalService({
        confirm: this.confirmHandler,
        ttlMs: this.approvalTtlMsValue,
        runId: this.runIdValue,
        // 持久化审批规则：从项目里读一次（`.codenode/approvals.json`），命中就不打扰用户。
        // 读坏文件=没有规则（偏保守：只会多问一次），不会静默放行。
        projectRoot: this.projectRootValue,
        rules: ruleLib.readRules(this.projectRootValue).rules,
        taskId: this.taskIdValue,
        role: this.roleValue,
        /**
         * 意图识别的风险门禁（**只收紧**）：命中「高风险 / 授权 unknown / 低置信」时，
         * 免打扰规则被忽略，这次审批仍然要用户点确认。未接线（null）→ 与旧行为逐字节一致。
         */
        riskGate: this.intentPolicyValue && typeof this.intentPolicyValue.forceConfirm === 'function'
          ? () => {
              try {
                return this.intentPolicyValue.forceConfirm() === true;
              } catch {
                // 门禁自身出错 → 不收紧（等价于没有信号），但留痕，避免「悄悄降级」
                try {
                  this.audit(JSON.stringify({ kind: 'intent_risk_gate_error' }));
                } catch {}
                return false;
              }
            }
          : null,
        trace: (event) => {
          this.audit(JSON.stringify(event));
          // S8：审批事件也进统一事件流（回放时能看到谁在什么时候批了什么）
          require('../eventBus.cjs').bridge(this.projectRootValue, 'approval', event);
        },
      });
    }
    return this.approvalServiceValue;
  }

  async confirm(level, what, detail) {
    if (this.cancelled()) return false;
    // 低敏感操作（LOW）直接放行，不弹窗询问；只有写入/高风险才需要确认
    if (level === ConfirmationLevel.LOW) return true;
    if (!this.confirmHandler) return false;
    // 真正在等用户：上报 WAITING_USER（等待结束后回到 WAITING_TOOL），
    // 状态机据此区分「卡在等用户」与「正在执行」，UI/续跑判定不再只能看到 running
    this.notifyState('WAITING_USER', 'confirm:' + String(what || '').slice(0, 80));
    try {
      const approved = await this.confirmHandler(level || ConfirmationLevel.WRITE, what || '', detail || '');
      return !this.cancelled() && approved === true;
    } catch {
      return false;
    } finally {
      this.notifyState('WAITING_TOOL', 'confirm_settled');
    }
  }

  /** 注入状态上报钩子（runAgentChat 用状态机驱动）；传 null 关闭 */
  setStateNotifier(fn) {
    this.stateNotifier = typeof fn === 'function' ? fn : null;
    return this.stateNotifier;
  }

  /** 上报过程状态；未注入钩子或钩子报错都只是无操作，绝不影响工具执行 */
  notifyState(state, reason) {
    if (!this.stateNotifier) return false;
    try {
      this.stateNotifier(String(state), String(reason || ''));
      return true;
    } catch {
      return false;
    }
  }

  audit(entry) {
    if (this.auditLogger) {
      try {
        this.auditLogger(entry);
      } catch {}
    }
  }

  async mutateWorkbench(fn) {
    if (this.readOnlyValue) return false;
    if (!this.workbenchMutator || !fn) return false;
    try {
      return await this.workbenchMutator(fn);
    } catch (e) {
      throw e;
    }
  }

  async saveProject() {
    if (this.readOnlyValue) return null;
    if (this.saveAction) {
      try {
        const saved = await this.saveAction();
        this.saveErrorValue = null;
        return saved;
      } catch (error) {
        // 不吞掉失败原因：调用方需要据此报错，而不是谎报「已保存」
        this.saveErrorValue = String((error && error.message) || error);
      }
    }
    return null;
  }

  /** 最近一次 saveProject 的失败原因（null = 未发生错误） */
  saveError() {
    return this.saveErrorValue || null;
  }

  async askUser(question, options) {
    if (!this.questionHandler) return '';
    this.notifyState('WAITING_USER', 'ask_user');
    try {
      return await this.questionHandler(question, options || []);
    } catch {
      return '';
    } finally {
      this.notifyState('WAITING_TOOL', 'ask_user_settled');
    }
  }

  async ui(action, args) {
    if (!this.uiAction) return false;
    try {
      return await this.uiAction(action, args || {});
    } catch {
      return false;
    }
  }

  conversationHistory() {
    if (!this.conversationSupplier) return [];
    try {
      return this.conversationSupplier() || [];
    } catch {
      return [];
    }
  }

  notifyFileChange(relative, kind, detail) {
    if (this.fileChangeNotifier) {
      try {
        this.fileChangeNotifier(relative, kind, detail);
      } catch {}
    }
  }

  ragConfig() {
    return this.ragConfigValue || {};
  }

  /** 写入执行检查点（runCheckpoint.cjs）：'tool_intent' | 'tool_commit' | 'messages' */
  checkpoint(type, payload) {
    if (!this.checkpointSink) return null;
    try {
      return this.checkpointSink(type, payload);
    } catch {
      return null;
    }
  }

  /** 保存对话快照用于断点续跑（每轮工具循环结束时调用） */
  checkpointMessages(messages, reason) {
    return this.checkpoint('messages', { messages, reason: reason || 'round_end' });
  }

  /** 执行隔离策略（sandbox.cjs 解析结果）；工具启动子进程时应交给 sandbox.guardedSpawn。
   * 兼容 getter 形式（() => policy）：注入值若为函数则取其返回值，避免误传函数导致隔离静默降级。 */
  sandbox() {
    const value = this.sandboxPolicyValue;
    if (typeof value === 'function') {
      try {
        return value() || null;
      } catch {
        return null;
      }
    }
    return value || null;
  }

  /**
   * 副作用幂等守卫：写操作执行前登记意图，执行后提交结果。
   * 返回 { skip:true } 表示该副作用在中断前已经提交过（续跑时不得重复执行）。
   * S9：带上行为者（runId/taskId/role），让「谁提交的、谁又想重复」在账本里可归因。
   */
  async beginSideEffect(toolName, args, options) {
    if (!this.sideEffectGuardValue || typeof this.sideEffectGuardValue.begin !== 'function') return { skip: false, token: null };
    try {
      return await this.sideEffectGuardValue.begin(toolName, args, { taskId: this.taskIdValue, role: this.roleValue }, options);
    } catch {
      return { skip: false, token: null };
    }
  }

  async commitSideEffect(token, info) {
    if (!token || !this.sideEffectGuardValue || typeof this.sideEffectGuardValue.commit !== 'function') return;
    try {
      await this.sideEffectGuardValue.commit(token, info);
    } catch {}
  }

  async failSideEffect(token, error) {
    if (!token || !this.sideEffectGuardValue || typeof this.sideEffectGuardValue.fail !== 'function') return;
    try {
      await this.sideEffectGuardValue.fail(token, error);
    } catch {}
  }

  /** 本地标量存储；未启用时返回 null。 */
  scalars() {
    return this.scalarStoreValue || null;
  }

  /** 便捷：批量写入标量记录 [{key,value,kind}]，返回写入条数。 */
  storeScalars(records) {
    const store = this.scalars();
    if (!store || !Array.isArray(records) || records.length === 0) return 0;
    try {
      return store.setMany(records);
    } catch {
      return 0;
    }
  }

  /** 便捷：标量查询 {key?, prefix?, max?} → [{key, kind, value, ts, exact}] */
  queryScalars(query) {
    const store = this.scalars();
    if (!store) return [];
    try {
      return store.query(query || {});
    } catch {
      return [];
    }
  }

  async undo() {
    if (this.undoAction) {
      try {
        await this.undoAction();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async redo() {
    if (this.redoAction) {
      try {
        await this.redoAction();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  fork(overrides) {
    const o = overrides || {};
    return new AgentToolContext({
      projectRoot: o.projectRoot || this.projectRootValue,
      model: o.model || this.modelValue,
      confirm: this.confirmHandler,
      audit: this.auditLogger,
      mutateWorkbench: this.workbenchMutator,
      saveProject: this.saveAction,
      askUser: this.questionHandler,
      ui: this.uiAction,
      conversationHistory: this.conversationSupplier,
      notifyFileChange: this.fileChangeNotifier,
      ragConfig: this.ragConfigValue,
      scalarStore: this.scalarStoreValue,
      undo: this.undoAction,
      redo: this.redoAction,
      runId: o.runId || this.runIdValue,
      taskId: o.taskId || this.taskIdValue,
      role: o.role || this.roleValue,
      readOnly: o.readOnly === true,
      signal: o.signal || this.signalValue,
      sandbox: this.sandboxPolicyValue,
      sideEffectGuard: this.sideEffectGuardValue,
      checkpoint: this.checkpointSink,
      // fork（子代理等）必须继承这两项：否则子代理读不了技能正文、也搜不了网（能力在子代理里静默消失）
      skillMaxChars: this.skillMaxCharsValue,
      webSearchConfig: this.webSearchConfigValue,
      /**
       * 意图收紧也要继承（A4）：子代理的写类动作与审批**不能因为「换了个上下文」就绕过收紧**。
       * 语义上这更严格也更正确 —— 子代理动作的授权来源是**用户对主任务的授权**（用户说过的话），
       * 而不是主代理给子代理的任务描述（那是 assistant 生成的东西，属**不可信证据**）。
       * 代价：子代理复核共享主 run 的动作预算（总量仍有上限），预算耗尽时子代理同样按「没有信号」回落
       * （不收紧、也不放宽）。注意这里是**按值**继承 —— 主 run 之后的重判不会回灌到已 fork 的子上下文。
       */
      intentPolicy: this.intentPolicyValue,
      intentReview: this.intentReviewer,
    });
  }
}

AgentToolContext.ConfirmationLevel = ConfirmationLevel;

module.exports = { AgentToolContext, ConfirmationLevel };
