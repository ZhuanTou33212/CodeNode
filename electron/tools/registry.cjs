/**
 * AgentToolRegistry：register / unregister / listTools / execute（复刻原版 AgentToolRegistry）
 * 工具默认本地直调；toOpenAiTools() 生成 OpenAI chat.completions 的 tools 参数。
 */
'use strict';

const { AgentToolResult } = require('./result.cjs');

class AgentToolRegistry {
  constructor() {
    this.tools = new Map(); // name -> { spec, executor }
  }

  register(name, description, inputSchema, executor) {
    this.tools.set(name, { spec: { name, description, inputSchema: inputSchema || null }, executor });
    return this;
  }

  unregister(name) {
    this.tools.delete(name);
  }

  listTools() {
    return [...this.tools.values()].map((t) => t.spec);
  }

  contains(name) {
    return this.tools.has(name);
  }

  async execute(name, arguments_, context) {
    const tool = this.tools.get(name);
    if (!tool) return AgentToolResult.error('未知工具：' + name);
    try {
      return await tool.executor(context, arguments_ == null ? {} : arguments_);
    } catch (e) {
      return AgentToolResult.error('工具 ' + name + ' 执行失败：' + ((e && e.message) || e));
    }
  }

  /** 转换为 OpenAI chat.completions 的 tools 参数。 */
  toOpenAiTools() {
    const result = [];
    for (const t of this.tools.values()) {
      result.push({
        type: 'function',
        function: {
          name: t.spec.name,
          description: t.spec.description,
          parameters: t.spec.inputSchema == null
            ? { type: 'object', properties: {} }
            : t.spec.inputSchema,
        },
      });
    }
    return result;
  }
}

module.exports = { AgentToolRegistry };
