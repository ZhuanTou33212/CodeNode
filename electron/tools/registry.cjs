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

const crypto = require('crypto');
const { AgentToolResult } = require('./result.cjs');
// 跨 Agent 资源租约（多 Agent 信息完整性 P3 的「单一写者」）：资源键的推导也在那边
const { resourceKeysFor } = require('./leases.cjs');
// P0-3：动作级复核要不要问模型，先看这个动作的副作用类别（read/write/unknown）
const sideEffectsLib = require('../sideEffects.cjs');
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
    /**
     * 工具面暴露（token 效率审计 P0-1 / 阶段 A）：`null` = 全部暴露（与旧行为**逐字节一致**）；
     * 给定名单 = 只把这些 schema 下发给模型。**只影响「模型看不看得见」，不影响能不能执行** ——
     * execute() 的四道门（角色/能力、网络、审批、租约）与角色白名单判据都不读这个字段。
     * @type {string[]|null}
     */
    this.toolExposure = null;
    /**
     * 被裁掉的工具名（`null` = 没裁剪）。暴露面的**权威表示是「隐藏集」而不是「可见集」**：
     * profile 管不到的东西（项目扩展 / MCP 工具 / 之后才注册的工具）天然不在隐藏集里 →
     * **一律可见（fail-open）**。用可见集会反过来：晚注册的工具不在名单里就永远看不见了。
     * @type {Set<string>|null}
     */
    this._hiddenTools = null;
    /**
     * model-visible specs 的 run 内缓存（P0-1 第 5 条）：此前同一轮里 compaction 估算、preflight
     * 与正式请求会各构造一次完整 JSON（33 工具 ≈ 20k 字符/次 × 4 次），既浪费 CPU 又容易口径漂移。
     * 键 = 暴露名单签名 + 注册表版本号；任何注册/契约/暴露变更都会清空并推进 `schemaRevision`。
     * @type {Map<string, any>}
     */
    this._schemaCache = new Map();
    /** 注册表内容版本号：缓存键的一部分，也把「这一版 schema」带进 run 事件/审计 */
    this.schemaRevision = 0;
    /** 缓存被清空的次数（只增）；用例用它证明「注册/注销/改契约真的让缓存失效」 */
    this.schemaCacheMisses = 0;
  }

  /** 任何会让「下发给模型的 schema」变化的事都要走这里（注册/注销/改契约/改暴露） */
  _invalidateSchemas() {
    this.schemaRevision += 1;
    if (this._schemaCache.size) {
      this._schemaCache.clear();
      this.schemaCacheMisses += 1;
    }
    return this.schemaRevision;
  }

  /**
   * 设定暴露名单（P0-1）。传 `null` 恢复「全部暴露」。
   *
   * 归一化到**注册顺序**：顺序一变前缀哈希就变 → 每轮都 cache miss。所以名单只做过滤、不重排
   * （与「run 内只增不减」配套，见 exposeNames）。名单里注册表没有的名字被静默丢弃 ——
   * profile 名单是能力清单，配了 rag/web_search 开关时那些工具可能压根没注册。
   * @param {string[]|null} names
   */
  setExposure(names) {
    if (names == null) {
      this.toolExposure = null;
      this._hiddenTools = null;
    } else {
      const wanted = new Set(Array.isArray(names) ? names.map((n) => String(n)) : []);
      this.toolExposure = [...this.tools.keys()].filter((n) => wanted.has(n));
      this._hiddenTools = new Set([...this.tools.keys()].filter((n) => !wanted.has(n)));
    }
    this._invalidateSchemas();
    return this.exposedNames();
  }

  /**
   * **单调追加**暴露（`discover_tools` 用）：一个 run 内工具面只增不减。
   * 为什么只增：减会让模型上一轮刚看到的工具突然消失，中途换面比多带一个 schema 更贵。
   * @param {string[]} names
   * @returns {string[]} 追加后的完整暴露名单（仍按注册顺序）
   */
  exposeNames(names) {
    const add = Array.isArray(names) ? names : [];
    if (!add.length) return this.exposedNames();
    return this.setExposure([...this.exposedNames(), ...add]);
  }

  /** 当前有效暴露名单（注册顺序）；`null` 暴露 = 全部工具 */
  exposedNames() {
    if (!this._hiddenTools) return [...this.tools.keys()];
    return [...this.tools.keys()].filter((n) => !this._hiddenTools.has(n));
  }

  /**
   * 这个工具此刻会不会下发给模型（`discover_tools` 与「提示词规则是否注入」共用同一判据）。
   * 判定看**隐藏集**：不在隐藏集里就是可见 —— 于是「注册表里没有的名字」「profile 管不到的名字」
   * 「晚一步注册进来的名字」都不会被误伤。
   */
  isExposed(name) {
    const n = String(name || '');
    if (!this.tools.has(n)) return false;
    return !this._hiddenTools || !this._hiddenTools.has(n);
  }

  /**
   * 指定名单（缺省 = 当前暴露面）的 schema 快照：tools 数组 + 序列化 JSON + 哈希 + 字符数。
   *
   * `hash` 是**稳定口径**：同一份暴露面在任何进程/任何轮次都得到同一个值 —— run 事件与成本账本
   * 据此回答「这轮贵在哪个工具面上」，也是「前缀有没有被改坏」的判据（P1-1/P2-2 的基础设施）。
   * @param {string[]} [names]
   */
  schemaInfo(names) {
    // 缺省（当前暴露面）走**隐藏集口径**（fail-open：profile 管不到/晚注册的工具天然可见）；
    // 显式给名单时按名单**精确过滤**（成本探针与审计要能单独量某一个面，不受 fail-open 影响）。
    const wanted = names == null ? null : (Array.isArray(names) ? names.map((n) => String(n)) : []);
    const list = wanted == null
      ? this.exposedNames()
      : [...this.tools.keys()].filter((n) => wanted.includes(n));
    const key = list.join('\u0000') + '#' + this.schemaRevision;
    const cached = this._schemaCache.get(key);
    if (cached) return cached;
    const tools = list.map((n) => {
      const t = this.tools.get(n);
      return {
        type: 'function',
        function: {
          name: t.spec.name,
          description: t.spec.description,
          parameters: t.spec.inputSchema == null ? { type: 'object', properties: {} } : t.spec.inputSchema,
        },
      };
    });
    const json = JSON.stringify(tools);
    const entry = Object.freeze({
      tools: Object.freeze(tools),
      json,
      hash: crypto.createHash('sha256').update(json).digest('hex').slice(0, 16),
      chars: json.length,
      count: tools.length,
      revision: this.schemaRevision,
      names: Object.freeze(list),
    });
    this._schemaCache.set(key, entry);
    return entry;
  }

  /** 旧接口：按名单合成保守契约（未声明只读 = 可写） */
  register(name, description, inputSchema, executor) {
    const spec = { name, description, inputSchema: closeInputSchema(inputSchema || null) };
    this.tools.set(name, {
      spec,
      descriptor: descriptorLib.descriptorForLegacy(name, description, spec.inputSchema),
      executor,
    });
    this._invalidateSchemas();
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
    this._invalidateSchemas();
    return this;
  }

  unregister(name) {
    this.tools.delete(name);
    this._invalidateSchemas();
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
    this._invalidateSchemas();
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
      /**
       * P0-3：把「静态层会怎么走」一起交给复核方，让它能算出**分类到底能不能改变结果**：
       *   - `effect`       —— 副作用类别（`unknown` = 外部/不可逆）；
       *   - `staticRequires` —— 不带意图时这个工具是否本来就要审批；
       *   - `wouldConfirm` —— **不带意图**时是否无论如何都会问到用户（要审批 + 没命中免打扰规则）。
       *     已经必问的动作不再先花一次模型调用（审计原文：分类不会改变结果）。
       *   - `ruleAllows`   —— 命中了免打扰规则（静态层会放行）→ 收紧才有意义。
       * 判定本身是纯函数（`intent.shouldConsultGuardian`），这里只负责**如实提供事实**。
       */
      const staticRequires =
        !!descriptor.requiresConfirmation &&
        (this.confirmWrites === true ? true : this.confirmWrites === false ? false : descriptor.confirmationEnforced === true);
      let ruleAllows = null;
      try {
        const approvalForPreview = /** @type {any} */ (execContext.approval);
        if (approvalForPreview && typeof approvalForPreview.preview === 'function') {
          const preview = approvalForPreview.preview({
            capability: descriptor.requiredCapability || null,
            tool: name,
            level: descriptor.requiresConfirmation || 'WRITE',
          });
          ruleAllows = preview.ruleAllows === true;
        }
      } catch {
        ruleAllows = null;
      }
      const review = await execContext.intentReview({
        tool: name,
        detail: (() => {
          try {
            return JSON.stringify(args).slice(0, 400);
          } catch {
            return '';
          }
        })(),
        effect: sideEffectsLib.classify(name),
        capability: descriptor.requiredCapability || null,
        readOnly: descriptor.readOnly === true,
        mutatesWorkspace: descriptor.mutatesWorkspace === true,
        staticRequires,
        wouldConfirm: staticRequires && ruleAllows !== true,
        ruleAllows,
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
      /**
       * 归因：收紧导致的这次确认要**说清原因**（否则用户只会看到「又问了一次」，
       * 不知道是意图复核判定的结果，也不知道该不该改口径）。
       */
      const intentNote = intentTighten
        ? '（意图复核：本轮动作被判定为「风险高 / 授权不明 / 置信低」，所以即使有免打扰规则也会问你一次）'
        : '';
      const token = await approval.request({
        capability: descriptor.requiredCapability || null,
        level: descriptor.requiresConfirmation,
        what: name,
        detail: (descriptor.description || '') + intentNote,
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

  /**
   * 转换为 OpenAI chat.completions 的 tools 参数。
   *
   * - 无参：当前暴露面（`toolExposure == null` 时 = 全部工具，与旧行为逐字节一致）；
   * - 给定名单：那个名单的 schema（例如成本探针要单独量某个 profile）。
   * 返回**缓存数组的浅拷贝**：调用方只读（JSON.stringify），别指望改它会影响注册表。
   * @param {string[]} [names]
   */
  toOpenAiTools(names) {
    return this.schemaInfo(names).tools.slice();
  }
}

module.exports = { AgentToolRegistry, validateInput, closeInputSchema };
