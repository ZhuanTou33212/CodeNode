/**
 * AgentToolRegistry：register / unregister / listTools / execute（复刻原版 AgentToolRegistry）
 * 工具默认本地直调；toOpenAiTools() 生成 OpenAI chat.completions 的 tools 参数。
 */
'use strict';

const { AgentToolResult } = require('./result.cjs');

function typeMatches(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

/** 统一校验模型生成的工具参数；工具自身仍负责业务约束和路径安全。 */
function validateInput(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return `${path} 必须是 ${schema.enum.join(', ')} 之一`;
  }
  if (schema.type && !typeMatches(value, schema.type)) return `${path} 类型应为 ${schema.type}`;
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} 长度不能小于 ${schema.minLength}`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} 长度不能超过 ${schema.maxLength}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${path} 至少需要 ${schema.minItems} 项`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} 不能超过 ${schema.maxItems} 项`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const error = validateInput(value[i], schema.items, `${path}[${i}]`);
        if (error) return error;
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required) || value[required] === undefined || value[required] === null) {
        return `${path}.${required} 为必填参数`;
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
        const error = validateInput(value[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  return null;
}

class AgentToolRegistry {
  constructor(options) {
    this.tools = new Map(); // name -> { spec, executor }
    this.allowedTools = options && options.allowedTools ? new Set(options.allowedTools) : null;
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
    if (this.allowedTools && !this.allowedTools.has(name)) {
      return AgentToolResult.error('当前子代理角色无权使用工具：' + name);
    }
    const tool = this.tools.get(name);
    if (!tool) return AgentToolResult.error('未知工具：' + name);
    const args = arguments_ == null ? {} : arguments_;
    const schemaError = validateInput(args, tool.spec.inputSchema, '$');
    if (schemaError) return AgentToolResult.error('工具参数校验失败：' + schemaError, { code: 'INVALID_TOOL_ARGUMENTS', path: schemaError });
    try {
      return await tool.executor(context, args);
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

module.exports = { AgentToolRegistry, validateInput };
