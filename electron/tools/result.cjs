/**
 * AgentToolResult：工具执行结果 = 确定性文本 + 结构化数据（复刻原版 AgentToolResult）
 */
'use strict';

class AgentToolResult {
  constructor(ok, text, data) {
    this.ok = !!ok;
    this.text = text || '';
    this.data = data || {};
  }

  toJSON() {
    return { ok: this.ok, text: this.text, data: this.data };
  }

  static ok(text, data) {
    return new AgentToolResult(true, text, data);
  }

  static error(text, data) {
    return new AgentToolResult(false, text, data);
  }
}

module.exports = { AgentToolResult };
