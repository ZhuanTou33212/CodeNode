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
// 跨 Agent 资源租约（多 Agent 信息完整性 P3 的「单一写者」）：资源键的推导也在那边
const { resourceKeysFor } = require('./leases.cjs');
const descriptorLib = require('./descriptor.cjs');

/**
 * S7：模型自填的「审批字段」—— 审批只能由服务端（ApprovalService）签发令牌，参数里塞这些
 * 一律在校验前剥离（既不生效、也不制造参数错误），避免留下「模型自己批准自己」的后门。
 */
const CONFIRMATION_SELF_FIELDS = Object.freeze(['confirmed', 'approved', 'approvalToken', 'approval_token', 'approvalId', 'approval_id', 'userApproved']);

/** S7：审批 scope —— 能力 + 本次目标（路径/节点类参数优先），供令牌的覆盖校验使用 */
function approvalScopeFor(descriptor, name, args) {
  const capability = descriptor.requiredCapability || descriptor.name || name;
  const a = args || {};
  const target = a.relativePath || a.path || a.filePath || a.nodeId || '';
  return [capability + ':' + String(target || name)];
}
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
    // 闭合 schema（additionalProperties=false）：未声明的字段直接拒绝。
    // 宽松校验会让「参数名拼错」表现为「参数被静默忽略、走默认值」—— 判据消失而不报错。
    if (schema.additionalProperties === false && schema.properties) {
      const declared = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) return `${path}.${key} 不是该工具已声明的参数（参数名拼写错误？）`;
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

/**
 * 闭合工具参数 schema：有 `properties` 且未显式声明 `additionalProperties` 时补 `false`。
 *
 * 为什么必须闭合：`validateInput` 只校验**已声明**字段，模型把 `maxLines` 拼成 `maxLine`
 * 会静默走默认值 —— 判据消失而不报错（审查 §2 实测 0/24 声明 additionalProperties）。
 * 闭合后错误当场暴露给模型，它才有机会改参数重试；同时 `toOpenAiTools()` 会把闭合的
 * schema 下发给模型，减少乱传字段本身。
 */
function closeInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.properties) return schema;
  if (schema.additionalProperties !== undefined) return schema;
  return { ...schema, additionalProperties: false };
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
    /**
     * 跨 Agent 资源租约账本（P3）。由 toolkit 注入：**同一 run 内所有注册表共享同一个实例**，
     * 否则各建一份就等于没锁。null = 不开租约（既有单测/独立用法不受影响）。
     * @type {{enabled?: boolean, acquire?: Function, releaseAll?: Function, holder?: Function}|null}
     */
    this.leases = null;
    // 注册表兜底超时：工具未声明 timeoutMs 时用它（0 = 不加限制）
    this.defaultTimeoutMs = descriptorLib.DEFAULT_TIMEOUT_MS;
    /**
     * S7：确认策略三态。undefined = 沿用 descriptor 自带的 confirmationEnforced（兼容既有行为）；
     * true = 所有声明了 requiresConfirmation 的工具都强制走令牌审批；false = 全部关闭。
     * @type {boolean|undefined}
     */
    this.confirmWrites = options ? options.confirmWrites : undefined;
  }

  /** 旧接口：按名单合成保守契约（未声明只读 = 可写） */
  register(name, description, inputSchema, executor) {
    const spec = { name, description, inputSchema: closeInputSchema(inputSchema || null) };
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
    descriptor.inputSchema = closeInputSchema(descriptor.inputSchema);
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
  /**
   * S7：在不重写整份 descriptor 的前提下补/改契约字段（渐进迁移用，S3 计划里「24 个工具逐个迁移」
   * 的落地方式）。会把 explicit 置真并**重算 confirmationEnforced** —— 声明了 requiresConfirmation
   * 就真的强制，而不是只写在文档里。
   * @param {string} name
   * @param {any} patch
   */
  declareContract(name, patch) {
    const tool = this.tools.get(name);
    if (!tool) return false;
    tool.descriptor = descriptorLib.normalizeDescriptor({ ...tool.descriptor, ...(patch || {}), explicit: true });
    return true;
  }

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
      // S5：显式失败码 —— 分类化提示才能告诉模型「这是权限问题，别原样重试」
      return AgentToolResult.failure('PERMISSION_DENIED', '当前子代理角色无权使用工具：' + name, { tool: name });
    }
    const tool = this.tools.get(name);
    if (!tool) return AgentToolResult.failure('FATAL_FAILURE', '未知工具：' + name, { tool: name });
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

    /**
     * 门 1.5（A2 意图复核）：副作用动作在**执行前**再判一次「这个动作有没有授权、风险多大」。
     *
     * 为什么要有：轮级判定看不到「助手接下来真要做什么」—— 它只看得见用户说了什么、以及 assistant
     * 自述过什么。真机取证证实了这个盲区：assistant 把越权动作**说**出来能被抓住，**没说出来的**不在输入里。
     *
     * **只收紧**：命中高风险 / 授权不明 / 低置信 → 即使这个工具本来不需要审批，也要走下面门 3 问用户。
     * 未接线 / 复核抛错 / 判定不收紧 → 完全维持原判定（与没有这个功能逐字节一致）。
     * 频率与预算由注入的实现控制（`agent.intent_action_review` 与 `..._max_calls_per_run`）。
     */
    let intentTighten = false;
    if (
      descriptor.mutatesWorkspace === true &&
      descriptor.readOnly !== true &&
      typeof execContext.intentReview === 'function'
    ) {
      const review = await execContext.intentReview({
        tool: name,
        detail: (() => {
          try {
            return JSON.stringify(args).slice(0, 400);
          } catch {
            return '';
          }
        })(),
      });
      intentTighten = !!(review && review.tighten === true);
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

    // S7：剥离模型自填的审批字段 —— **所有工具**、且在校验之前。
    // 不能只在声明了 requiresConfirmation 的工具上剥离：schema 闭合（additionalProperties=false）
    // 之后，任何一个自填字段都会变成「未知参数」错误，把本来能正常执行的调用直接打回
    // （实测：write_file 带 confirmed=true → INVALID_TOOL_ARGUMENTS）。自填字段必须始终无效，
    // 而不是有时报错、有时被忽略。
    {
      /** @type {string[]} */
      const stripped = [];
      for (const key of CONFIRMATION_SELF_FIELDS) {
        if (args && Object.prototype.hasOwnProperty.call(args, key)) {
          delete args[key];
          stripped.push(key);
        }
      }
      // 审计走 trace 的**方法**（execContext.trace 是新面的冻结对象，不是可调用函数 —— 早前这里
      // 把对象当函数调，判定恒假，自填字段被剥离这件事从来没留下痕迹）。
      const traceNote = /** @type {any} */ (execContext).trace;
      if (stripped.length && traceNote && typeof traceNote.note === 'function') {
        traceNote.note('approval_self_fields_stripped', { tool: name, fields: stripped });
      }
    }

    const schemaError = validateInput(args, tool.spec.inputSchema, '$');
    if (schemaError) return AgentToolResult.error('工具参数校验失败：' + schemaError, { code: 'INVALID_TOOL_ARGUMENTS', path: schemaError });

    // 门 3（S7）：确认类工具必须拿到**服务端签发的令牌**才执行。令牌绑定
    // capability / scope / toolCallId，且有有效期、单次有效 —— 批准一次只够一次调用。
    // 旧 register() 合成的契约（requiresConfirmation=false）不触发，保持既有行为。
    // 意图复核收紧（A2）优先：即使这个工具本身不需要确认，被判定为「授权不明 / 高风险」时也要问用户
    const requiresApproval =
      intentTighten === true ||
      (!!descriptor.requiresConfirmation &&
        (this.confirmWrites === true ? true : this.confirmWrites === false ? false : descriptor.confirmationEnforced === true));
    if (requiresApproval) {
      const approval = /** @type {any} */ (execContext.approval);
      // 「没有审批通道」与「用户拒绝」必须分开报（前者是配置/接线问题，后者要劝退重试）
      const channelReady =
        !!approval &&
        typeof approval.request === 'function' &&
        (typeof approval.available !== 'function' || approval.available() === true);
      if (!channelReady) {
        return AgentToolResult.failure('APPROVAL_REQUIRED', '工具 ' + name + ' 需要用户确认，但当前上下文没有审批通道，已拒绝执行。', {
          tool: name,
          userActionRequired: true,
        });
      }
      const scope = approvalScopeFor(descriptor, name, args);
      const toolCallId = (callInfo && callInfo.toolCallId) || null;
      const token = await approval.request({
        capability: descriptor.requiredCapability || null,
        level: descriptor.requiresConfirmation,
        what: name,
        detail: descriptor.description || '',
        scope,
        toolCallId,
        attemptId: (callInfo && callInfo.attemptId) || null,
      });
      if (!token) {
        return AgentToolResult.failure('APPROVAL_DENIED', '用户未批准，已跳过 ' + name + '（未执行任何操作）。', { tool: name, userActionRequired: true });
      }
      const verdict = approval.verify(token, { capability: descriptor.requiredCapability || null, scope, toolCallId });
      if (!verdict || verdict.valid !== true) {
        return AgentToolResult.failure(
          'APPROVAL_DENIED',
          '审批令牌校验失败（' + ((verdict && verdict.reason) || 'UNKNOWN') + '），已跳过 ' + name + '（未执行任何操作）。',
          { tool: name, userActionRequired: true },
        );
      }
    }

    // 门 4（S16）：跨 Agent **资源租约** —— 多 Agent 信息完整性的「单一写者」。
    // 只在写类工具上生效；申请是原子的（多文件批量编辑要么全拿到要么不占），被占用时**不排队等待**，
    // 直接返回 RESOURCE_LOCKED（可重试）+ 谁在占用。租约持有到**任务结束**（子代理完成/取消/主 run 收尾）
    // 或 TTL 到期 —— 写完就放会让另一个 Agent 基于过期的读去覆盖，那正是我们要防的「静默互相覆盖」。
    if (descriptor.mutatesWorkspace && this.leases && this.leases.enabled) {
      const base = (context && context.__context) || context;
      const itsRoot = base && typeof base.projectRoot === 'function' ? base.projectRoot() : '';
      const keys = resourceKeysFor(name, args, { projectRoot: itsRoot || process.cwd() });
      if (keys.length) {
        const holder = (base && typeof base.taskId === 'function' && base.taskId()) || 'supervisor';
        const role = (base && typeof base.role === 'function' && base.role()) || '';
        const claim = this.leases.acquire(keys, holder, { role });
        if (!claim.ok) {
          const c = claim.conflict || {};
          const traceNote = /** @type {any} */ (execContext).trace;
          if (traceNote && typeof traceNote.note === 'function') {
            traceNote.note('resource_locked', { tool: name, keys, holder, owner: c.holder, expiresAt: c.expiresAt });
          }
          return AgentToolResult.failure(
            'RESOURCE_LOCKED',
            '该资源正被另一个 Agent 持有（并行写会互相覆盖）：' + String(c.key || keys[0]) +
              ' 由 ' + String(c.holder || '未知') + ' 持有（' + String(c.role || '未知角色') + '，约 ' +
              Math.max(0, Math.round(((c.expiresAt || 0) - Date.now()) / 1000)) +
              's 后过期）。不要用相同调用硬撞：等它结束再试，或先做与它不冲突的步骤。',
            { tool: name, keys, holder: c.holder || null, role: c.role || null, expiresAt: c.expiresAt || null },
          );
        }
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

module.exports = { AgentToolRegistry, validateInput, closeInputSchema };
