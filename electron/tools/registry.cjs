/**
 * AgentToolRegistry：register / registerDescriptor / unregister / listTools / execute
 * 工具默认本地直调；toOpenAiTools() 生成 OpenAI chat.completions 的 tools 参数。
 *
 * 每个工具都带一份 **descriptor**（见 descriptor.cjs）：只读/幂等/会改工作区/是否需要确认/
 * 需要什么能力/超时/缓存策略/并行策略。`register()` 是旧接口，会按名单合成契约（缺省保守：
 * 未声明只读 = 可写），迁移中的工具可以逐个改用 `registerDescriptor()` 声明真实语义。
 *
 * execute() 按契约执行三道门（都在真正调用工具之前，fail-closed）：
 *   1. 只读上下文（只读角色子代理）不允许执行会改工作区的工具；
 *   2. 声明了 network.request 的工具，在隔离策略 network=deny 时直接拒绝；
 *   3. 显式声明 requiresConfirmation 的工具，用户不批准就不执行。
 * 之后按契约超时等待，超时返回 code=TIMEOUT 的失败结果（不再傻等）。
 */
'use strict';

const { AgentToolResult } = require('./result.cjs');
const descriptorLib = require('./descriptor.cjs');
const { createExecutionContext } = require('./executionContext.cjs');

/** 超时哨兵：工具返回值不可能等于它 */
const TOOL_TIMEOUT = Symbol('tool-timeout');

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
    this.tools = new Map(); // name -> { spec, descriptor, executor }
    this.allowedTools = options && options.allowedTools ? new Set(options.allowedTools) : null;
    /**
     * 角色契约显式授予的能力（roles.cjs）。null = 不受角色限制（主代理 supervisor）。
     * 只读门的判据 —— 见 execute() 门 1。
     * @type {Set<string>|null}
     */
    this.roleCapabilities = null;
    // 注册表兜底超时：工具未声明 timeoutMs 时用它（0 = 不加限制）
    this.defaultTimeoutMs = descriptorLib.DEFAULT_TIMEOUT_MS;
  }

  /** 旧接口：按名单合成保守契约（未声明只读 = 可写） */
  register(name, description, inputSchema, executor) {
    const spec = { name, description, inputSchema: inputSchema || null };
    this.tools.set(name, {
      spec,
      descriptor: descriptorLib.descriptorForLegacy(name, description, spec.inputSchema),
      executor,
    });
    return this;
  }

  /**
   * 新接口：显式声明契约。未给的字段由 normalizeDescriptor 补全（保守缺省）。
   * @param {any} input descriptor（至少含 name）
   * @param {(context: any, args: any) => Promise<any>} executor
   */
  registerDescriptor(input, executor) {
    const descriptor = descriptorLib.normalizeDescriptor({ ...(input || {}), explicit: true });
    this.tools.set(descriptor.name, {
      spec: { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema },
      descriptor,
      executor,
    });
    return this;
  }

  unregister(name) {
    this.tools.delete(name);
  }

  listTools() {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /** 单个工具的契约；未注册返回 null */
  descriptorOf(name) {
    const tool = this.tools.get(String(name || ''));
    return tool ? tool.descriptor : null;
  }

  /** 全部契约（顺序与 listTools 一致，便于 UI/审计对照） */
  listDescriptors() {
    return [...this.tools.values()].map((t) => t.descriptor);
  }

  /** UI / 审计用的精简契约视图 */
  describeAll() {
    return this.listDescriptors().map((d) => descriptorLib.describeDescriptor(d));
  }

  /** 设置注册表兜底超时（毫秒）；0 = 不对未声明超时的工具设限 */
  setDefaultTimeoutMs(ms) {
    const n = Number(ms);
    this.defaultTimeoutMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : descriptorLib.DEFAULT_TIMEOUT_MS;
    return this.defaultTimeoutMs;
  }

  contains(name) {
    return this.tools.has(name);
  }

  /**
   * 执行工具。
   * @param {string} name
   * @param {any} arguments_
   * @param {any} context 底层 AgentToolContext（或已被包装过的 ExecutionContext）
   * @param {{ turnId?: string|number, toolCallId?: string, attemptId?: string }} [callInfo]
   *   调用标识：每个动作都能带回 runId/turnId/toolCallId/attemptId（审查第 5 项要求）
   */
  async execute(name, arguments_, context, callInfo) {
    if (this.allowedTools && !this.allowedTools.has(name)) {
      return AgentToolResult.error('当前子代理角色无权使用工具：' + name);
    }
    const tool = this.tools.get(name);
    if (!tool) return AgentToolResult.error('未知工具：' + name);
    const descriptor = tool.descriptor;
    const args = arguments_ == null ? {} : arguments_;
    // 按该工具的契约现场组装最小能力面（工具只看到自己需要的那几个面 + deprecated 旧方法转发）
    const execContext = createExecutionContext(context, descriptor, callInfo);

    // 门 1：只读上下文不允许执行「纯写」工具。判据是**角色契约显式授予的能力**（tools/roles.cjs），
    // 而不是「白名单里有这个名字」—— 白名单会把「条件写」工具（scan_project 带 applyToWorkbench）
    // 一并放行，导致只读角色以为写入成功（S9 实测的谎报面）。
    // verifier 的 execute_shell 由 shell.execute 能力显式授予（跑测试是它的核心能力），不受此门影响。
    const roleCaps = this.roleCapabilities;
    const capabilityGrantedByRole = !!(
      roleCaps && descriptor.requiredCapability && roleCaps.has(descriptor.requiredCapability)
    );
    if (
      descriptor.mutatesWorkspace &&
      descriptor.readOnly !== true &&
      !capabilityGrantedByRole &&
      typeof execContext.readOnly === 'function' &&
      execContext.readOnly() === true
    ) {
      return AgentToolResult.error('只读上下文不允许执行会修改工作区的工具：' + name, {
        code: 'PERMISSION_DENIED',
        tool: name,
        capability: descriptor.requiredCapability,
        userActionRequired: false,
      });
    }

    // 门 2：声明需要网络能力的工具，在隔离策略切断网络时直接拒绝（不让它去试一次才发现连不上）
    if (descriptor.requiredCapability === 'network.request') {
      // 注意：策略要从**底层上下文**读，不能走工具的能力面 —— sandbox 属于 shell.execute 能力，
      // 对 network.request 工具是被闸住的（读到的会是 null，网络门就静默失效了）
      const base = (context && context.__context) || context;
      const policy = base && typeof base.sandbox === 'function' ? base.sandbox() : null;
      if (policy && policy.network === 'deny') {
        return AgentToolResult.error('当前执行隔离策略已切断网络（sandbox.network=deny），不能执行 ' + name, {
          code: 'PERMISSION_DENIED',
          tool: name,
          capability: descriptor.requiredCapability,
          userActionRequired: false,
        });
      }
    }

    const schemaError = validateInput(args, tool.spec.inputSchema, '$');
    if (schemaError) return AgentToolResult.error('工具参数校验失败：' + schemaError, { code: 'INVALID_TOOL_ARGUMENTS', path: schemaError });

    // 门 3：显式声明需要确认的工具，用户不批准就不执行（旧 register() 合成的契约不触发，保持既有行为）
    if (descriptor.confirmationEnforced && descriptor.requiresConfirmation) {
      if (typeof execContext.confirm !== 'function') {
        return AgentToolResult.error('工具 ' + name + ' 需要用户确认，但当前上下文无法询问用户，已拒绝执行。', {
          code: 'APPROVAL_REQUIRED',
          tool: name,
          userActionRequired: true,
        });
      }
      let approved = false;
      try {
        approved = await execContext.confirm(descriptor.requiresConfirmation, name, descriptor.description);
      } catch {
        approved = false;
      }
      if (approved !== true) {
        return AgentToolResult.error('用户未批准，已跳过 ' + name + '（未执行任何操作）。', {
          code: 'APPROVAL_DENIED',
          tool: name,
          userActionRequired: true,
        });
      }
    }

    try {
      return await this._executeWithTimeout(tool, descriptor, name, args, execContext);
    } catch (e) {
      return AgentToolResult.error('工具 ' + name + ' 执行失败：' + ((e && e.message) || e));
    }
  }

  /**
   * 按契约超时执行（execContext 是按契约组装的能力面）。timeoutMs=0 表示不加限制；未声明时用注册表兜底。
   * 注意：超时只终止「等待」，同步阻塞的操作（大目录扫描、同步 fs 计算）无法被 JS 单线程打断——
   * 真正的可中断需要把这些工具挪到 worker/子进程（后续阶段）。
   */
  async _executeWithTimeout(tool, descriptor, name, args, context) {
    const limit = descriptor.timeoutMs === 0 ? 0 : (descriptor.timeoutMs == null ? this.defaultTimeoutMs : descriptor.timeoutMs);
    if (!limit || limit <= 0) return await tool.executor(context, args);
    let timer = null;
    const timeout = new Promise((resolve) => {
      // 注意：这里**不能** unref —— 被 unref 的定时器不维持事件循环，当被等待的工具自己也不再持有
      // 任何 handle 时会直接退出进程，超时分支永远不会执行（表现为「测试静默通过/跳过后续断言」）。
      timer = setTimeout(() => resolve(TOOL_TIMEOUT), limit);
    });
    try {
      const outcome = await Promise.race([Promise.resolve(tool.executor(context, args)), timeout]);
      if (outcome === TOOL_TIMEOUT) {
        return AgentToolResult.error('工具 ' + name + ' 执行超时（' + limit + 'ms），已放弃等待。', {
          code: 'TIMEOUT',
          tool: name,
          timeoutMs: limit,
          retryable: tool.descriptor.retryPolicy.maxAttempts > 1,
          userActionRequired: false,
        });
      }
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
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
