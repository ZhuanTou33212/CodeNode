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
    this.undoAction = o.undo || null;
    this.redoAction = o.redo || null;
  }

  projectRoot() {
    return this.projectRootValue || '.';
  }

  model() {
    return this.modelValue;
  }

  async confirm(level, what, detail) {
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
    if (!this.workbenchMutator || !fn) return false;
    try {
      return await this.workbenchMutator(fn);
    } catch (e) {
      throw e;
    }
  }

  async saveProject() {
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
}

AgentToolContext.ConfirmationLevel = ConfirmationLevel;

module.exports = { AgentToolContext, ConfirmationLevel };
