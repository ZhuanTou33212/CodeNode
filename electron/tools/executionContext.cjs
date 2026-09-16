/**
 * executionContext.cjs —— 工具执行上下文的能力面（拆 AgentToolContext，审查第 2 项）
 *
 * 问题：此前工具拿到的是**同一个巨大的 AgentToolContext**，20 个注入依赖全部可见可调 ——
 * 一个只读的 `read_file` 手里也握着 `mutateWorkbench` / `saveProject` / `ui` / `scalars`。
 * 「工具只能获得完成自身任务所需的最小能力」这条约束在类型与运行时上都不存在。
 *
 * 方案（双轨并存，不破坏 24 个既有工具）：
 *   - 每次 `registry.execute` 按该工具的契约（descriptor.requiredCapability）**现场组装**一个
 *     ExecutionContext 交给工具：`exec` + `project` / `approval` / `audit` / `ui` / `checkpoint` /
 *     `cancel` / `trace`，让新工具只用最小面；
 *   - 越权的**特权方法**（mutateWorkbench / saveProject / storeScalars / ui / askUser / sandbox / fork …）
 *     按能力放行：没授予时不是「能调但没人管」，而是返回安全默认值（false/null/[]）并写一条
 *     `capability-denied` 审计 —— fail-closed，又不让旧工具直接崩；
 *   - 旧方法名作为 **deprecated 转发**保留在同一个对象上。`audit` / `checkpoint` / `ui` 这三个名字
 *     在新旧两套里重名，因此做成**可调用对象**：`ctx.audit('文本')`（旧）与 `ctx.audit.log({...})`（新）
 *     同时可用，`ctx.checkpoint(...)` / `ctx.checkpoint.toolIntent(...)`、`ctx.ui(...)` / `ctx.ui.action(...)` 同理。
 *
 * 能力 → 面的对应（`CAPABILITY_SURFACES` 导出，供文档与用例核对）：
 *   workspace.read   → 读面 + 本地标量索引（派生数据，不算项目内容）
 *   workspace.write  → + mutate/notifyFileChange/undo/redo
 *   project.save     → + 严格的新面 project.save()
 *   shell.execute    → + sandbox
 *   network.request  → 只读面（网络本身由 sandbox 策略把关）
 *   ui.interact      → + ui.action / approval.askUser
 *   subagent.delegate→ + fork
 * 所有工具都拿到（跨切面）：exec 标识、approval.confirm、audit、checkpoint、cancel、trace。
 */
'use strict';

/** 所有能力都可用的方法（跨切面） */
const COMMON_METHODS = Object.freeze([
  'projectRoot', 'model', 'runId', 'taskId', 'role', 'readOnly', 'signal', 'cancelled',
  'confirm', 'notifyState', 'setStateNotifier', 'conversationHistory', 'ragConfig',
  'checkpointMessages', 'beginSideEffect', 'commitSideEffect', 'failSideEffect',
]);

/**
 * 需要能力才放行的特权方法 → 允许的能力（任一命中即放行）+ 未授予时的安全默认值。
 * 说明几处刻意的「宽松」：
 *   - storeScalars / scalars / queryScalars 操作的是**本地标量索引（派生数据）**，不是项目内容，
 *     读面即可用（get_workbench_model 读画布时顺手同步索引就靠这条）；
 *   - saveProject 允许写工具使用：write_analysis_md 等既有工具会顺手保存工程（旧行为不收紧）；
 *     严格意义上的工程保存由新面 `project.save()` 把关（只认 project.save 能力）。
 */
const GATED_METHODS = Object.freeze({
  mutateWorkbench: { caps: ['workspace.write'], fallback: false },
  undo: { caps: ['workspace.write'], fallback: false },
  redo: { caps: ['workspace.write'], fallback: false },
  notifyFileChange: { caps: ['workspace.write'], fallback: null },
  scalars: { caps: ['workspace.read', 'workspace.write'], fallback: null },
  queryScalars: { caps: ['workspace.read', 'workspace.write'], fallback: [] },
  storeScalars: { caps: ['workspace.read', 'workspace.write'], fallback: 0 },
  saveProject: { caps: ['project.save', 'workspace.write'], fallback: null },
  saveError: { caps: ['project.save', 'workspace.write'], fallback: null },
  sandbox: { caps: ['shell.execute'], fallback: null },
  askUser: { caps: ['ui.interact'], fallback: '' },
  fork: { caps: ['subagent.delegate'], fallback: null },
});

/** 旧方法名与「新面对象」重名的三个：做成可调用对象（旧调用 + `.方法`） */
const HYBRID_METHODS = Object.freeze(['audit', 'checkpoint', 'ui']);

/**
 * 能力蕴含关系：一切能力都蕴含 workspace.read（读是最弱的能力，不构成提权）。
 * write 蕴含 read；project.save 蕴含 write；shell.execute 能改文件 → 蕴含 write。
 */
const IMPLIED_CAPABILITIES = Object.freeze({
  'workspace.read': [],
  'workspace.write': ['workspace.read'],
  'project.save': ['workspace.write'],
  'shell.execute': ['workspace.write'],
  'network.request': ['workspace.read'],
  'ui.interact': ['workspace.read'],
  'subagent.delegate': ['workspace.read'],
});

/** 能力 → 该能力解锁的特权方法（文档/用例用） */
const CAPABILITY_SURFACES = Object.freeze({
  'workspace.read': ['scalars', 'queryScalars', 'storeScalars（派生标量索引）'],
  'workspace.write': ['mutateWorkbench', 'undo', 'redo', 'notifyFileChange'],
  'project.save': ['project.save（新面，严格）'],
  'shell.execute': ['sandbox'],
  'network.request': [],
  'ui.interact': ['ui.action', 'askUser'],
  'subagent.delegate': ['fork'],
});

function safeCall(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 组装一次工具调用的执行上下文。
 * @param {any} source 底层 AgentToolContext（或另一个 ExecutionContext —— 会先解包，支持套娃调用）
 * @param {any} descriptor 该工具的契约
 * @param {{ turnId?: string|number, toolCallId?: string, attemptId?: string }} [callInfo]
 */
function createExecutionContext(source, descriptor, callInfo) {
  const base = (source && source.__context) || source || {};
  const info = callInfo || {};
  const toolName = (descriptor && descriptor.name) || '';
  const capability = (descriptor && descriptor.requiredCapability) || 'workspace.read';

  // 能力蕴含：写蕴含读、save 蕴含写、shell 蕴含写……（读是能力下限，不构成提权）
  const granted = new Set();
  const grant = (cap) => {
    if (!cap || granted.has(cap)) return;
    granted.add(cap);
    for (const implied of IMPLIED_CAPABILITIES[cap] || []) grant(implied);
  };
  grant(capability);

  /** 拒绝并留审计；返回 null 以便调用方 `deny(x) || fallback`（void 会被 tsc 判成「对 void 取真值」） */
  const deny = (method) => {
    try {
      if (typeof base.audit === 'function') {
        base.audit(JSON.stringify({
          kind: 'capability-denied',
          tool: toolName,
          method,
          capability,
          need: (GATED_METHODS[method] || {}).caps || null,
        }));
      }
    } catch {}
    return null;
  };
  const allow = (...caps) => caps.some((cap) => granted.has(cap));

  const runId = safeCall(() => base.runId(), '') || '';
  const turnId = info.turnId == null ? null : String(info.turnId);
  const toolCallId = info.toolCallId == null ? null : String(info.toolCallId);
  const attemptId = info.attemptId == null ? (toolCallId ? toolCallId + '#1' : null) : String(info.attemptId);

  const ctx = {};

  // ---- 面 1：标识与运行信息（每个动作都能带回 runId/turnId/toolCallId/attemptId） ----
  ctx.exec = Object.freeze({
    runId,
    turnId,
    toolCallId,
    attemptId,
    tool: toolName,
    role: safeCall(() => base.role(), 'supervisor'),
    readOnly: safeCall(() => base.readOnly(), false) === true,
    capability,
    capabilities: [...granted].sort(),
    describe: () => ({ runId, turnId, toolCallId, attemptId, tool: toolName, capability }),
  });

  // ---- 面 2：项目 ----
  ctx.project = {
    root: () => safeCall(() => base.projectRoot(), '.'),
    model: () => safeCall(() => base.model(), null),
    ragConfig: () => safeCall(() => base.ragConfig(), {}),
    conversationHistory: () => safeCall(() => base.conversationHistory(), []),
    scalars: () => (allow('workspace.read', 'workspace.write') ? safeCall(() => base.scalars(), null) : deny('scalars') || null),
    queryScalars: (query) => (allow('workspace.read', 'workspace.write') ? safeCall(() => base.queryScalars(query), []) : deny('queryScalars') || []),
    storeScalars: (records) => (allow('workspace.read', 'workspace.write') ? safeCall(() => base.storeScalars(records), 0) : deny('storeScalars') || 0),
    mutate: (fn) => (allow('workspace.write') ? base.mutateWorkbench(fn) : Promise.resolve(deny('mutateWorkbench') || false)),
    notifyFileChange: (rel, kind, detail) => (allow('workspace.write') ? safeCall(() => base.notifyFileChange(rel, kind, detail), null) : deny('notifyFileChange') || null),
    // 新面是严格的：只有 project.save 能力能保存工程（旧面 context.saveProject 对写工具仍放行，见 GATED_METHODS）
    save: () => (allow('project.save') ? base.saveProject() : Promise.resolve(deny('saveProject') || null)),
    saveError: () => (allow('project.save') ? safeCall(() => base.saveError(), null) : deny('saveError') || null),
    undo: () => (allow('workspace.write') ? base.undo() : Promise.resolve(deny('undo') || false)),
    redo: () => (allow('workspace.write') ? base.redo() : Promise.resolve(deny('redo') || false)),
  };

  // ---- 面 3：审批（所有工具都能请求确认；提问属于 ui.interact 能力） ----
  ctx.approval = {
    confirm: (level, what, detail) => base.confirm(level, what, detail),
    askUser: (question, options) => (allow('ui.interact') ? base.askUser(question, options) : Promise.resolve(deny('askUser') || '')),
    // S7：令牌化审批 —— 令牌由 ApprovalService 服务端签发（绑定 capability/scope/toolCallId/有效期，
    // 单次有效）；工具参数里的自填审批字段一律不被采信（注册表在校验前剥离）。
    request: (req) => (typeof base.approval === 'function' ? base.approval().request(req) : Promise.resolve(null)),
    verify: (token, req) => (typeof base.approval === 'function' ? base.approval().verify(token, req) : { valid: false, reason: 'NO_APPROVAL_CHANNEL' }),
    available: () => (typeof base.approval === 'function' ? base.approval().available() : false),
    revoke: (id) => (typeof base.approval === 'function' ? base.approval().revoke(id) : false),
    service: () => (typeof base.approval === 'function' ? base.approval() : null),
  };

  // ---- 面 4/6/5：审计 / 检查点 / 界面（与旧方法同名 → 可调用对象，两套同时可用） ----
  const auditHybrid = (...args) => safeCall(() => base.audit(...args), null);
  // 新面 audit.log 接受对象：底层 audit 只保存字符串（auditLog 里是 String(entry)），
  // 直接传对象会落成 "[object Object]"，所以这里显式序列化。
  auditHybrid.log = (entry) => safeCall(() => base.audit(typeof entry === 'string' ? entry : JSON.stringify(entry == null ? null : entry)), null);
  ctx.audit = auditHybrid;

  const checkpointHybrid = (type, payload) => safeCall(() => base.checkpoint(type, payload), null);
  checkpointHybrid.toolIntent = (payload) => safeCall(() => base.checkpoint('tool_intent', payload), null);
  checkpointHybrid.toolCommit = (payload) => safeCall(() => base.checkpoint('tool_commit', payload), null);
  checkpointHybrid.messages = (messages, reason) => safeCall(() => base.checkpointMessages(messages, reason), null);
  ctx.checkpoint = checkpointHybrid;

  const uiHybrid = (action, args) => (allow('ui.interact') ? base.ui(action, args) : Promise.resolve(deny('ui') || false));
  uiHybrid.action = uiHybrid;
  uiHybrid.ask = (question, options) => (allow('ui.interact') ? base.askUser(question, options) : Promise.resolve(deny('askUser') || ''));
  ctx.ui = uiHybrid;

  // ---- 面 7：取消 ----
  ctx.cancel = Object.freeze({
    signal: () => safeCall(() => base.signal(), null),
    isCancelled: () => safeCall(() => base.cancelled(), false) === true,
    throwIfCancelled: () => {
      if (safeCall(() => base.cancelled(), false) === true) {
        throw Object.assign(new Error('已取消'), { name: 'AbortError', code: 'CANCELLED' });
      }
      return false;
    },
  });

  // ---- 面 8：追踪 ----
  ctx.trace = Object.freeze({
    runId,
    taskId: safeCall(() => base.taskId(), '') || '',
    role: safeCall(() => base.role(), 'supervisor'),
    note: (event, data) => safeCall(() => base.audit(JSON.stringify({
      kind: 'trace', event, data: data == null ? null : data, runId, turnId, toolCallId, attemptId, tool: toolName,
    })), null),
  });

  // ---- 双轨并存：旧方法名按能力转发（deprecated，迁移中的工具仍可用） ----
  for (const method of COMMON_METHODS) {
    if (HYBRID_METHODS.includes(method)) continue;
    if (typeof base[method] !== 'function') continue;
    ctx[method] = (...args) => base[method](...args);
  }
  for (const [method, rule] of Object.entries(GATED_METHODS)) {
    if (HYBRID_METHODS.includes(method)) continue;
    if (typeof base[method] !== 'function') continue;
    ctx[method] = (...args) => (allow(...rule.caps) ? base[method](...args) : (deny(method), rule.fallback));
  }

  // 内部指针：registry 对「已经是 ExecutionContext 的上下文」再次包装时会解包，
  // 保证套娃调用（例如 delegate_task 内部再 execute workbench_edit）始终作用在同一个底层上下文
  ctx.__context = base;
  ctx.__descriptor = descriptor || null;
  return ctx;
}

module.exports = {
  COMMON_METHODS,
  GATED_METHODS,
  HYBRID_METHODS,
  IMPLIED_CAPABILITIES,
  CAPABILITY_SURFACES,
  createExecutionContext,
};
