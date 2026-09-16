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
  signal() { return this.signalValue; }
  cancelled() { return !!(this.signalValue && this.signalValue.aborted); }

  /** 文件遍历类工具是否走 worker 线程（tools.fs_worker，默认 true） */
  fsWorkerEnabled() { return this.fsWorkerValue !== false; }

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
        taskId: this.taskIdValue,
        role: this.roleValue,
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
  async beginSideEffect(toolName, args) {
    if (!this.sideEffectGuardValue || typeof this.sideEffectGuardValue.begin !== 'function') return { skip: false, token: null };
    try {
      return await this.sideEffectGuardValue.begin(toolName, args, { taskId: this.taskIdValue, role: this.roleValue });
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
    });
  }
}

AgentToolContext.ConfirmationLevel = ConfirmationLevel;

module.exports = { AgentToolContext, ConfirmationLevel };
