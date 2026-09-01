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

const ConfirmationLevel = { LOW: 'LOW', WRITE: 'WRITE', HIGH: 'HIGH' };

class AgentToolContext {
  constructor(options) {
    const o = options || {};
    this.projectRootValue = o.projectRoot || '.';
    this.modelValue = o.model || null;
    this.confirmHandler = o.confirm || null;
    this.auditLogger = o.audit || null;
    this.workbenchMutator = o.mutateWorkbench || null;
    this.saveAction = o.saveProject || null;
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

  async confirm(level, what, detail) {
    // 低敏感操作（LOW）直接放行，不弹窗询问；只有写入/高风险才需要确认
    if (level === ConfirmationLevel.LOW) return true;
    if (!this.confirmHandler) return true;
    try {
      return await this.confirmHandler(level || ConfirmationLevel.WRITE, what || '', detail || '');
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
        return await this.saveAction();
      } catch {}
    }
    return null;
  }

  async askUser(question, options) {
    if (!this.questionHandler) return '';
    try {
      return await this.questionHandler(question, options || []);
    } catch {
      return '';
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
    });
  }
}

AgentToolContext.ConfirmationLevel = ConfirmationLevel;

module.exports = { AgentToolContext, ConfirmationLevel };
