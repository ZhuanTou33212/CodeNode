/**
 * descriptor.cjs —— 工具契约（ToolDescriptor）与旧实现的适配层
 *
 * 审查第 3 项：工具此前只有 `{name, description, inputSchema}`，能力/风险语义全靠散落的硬编码名单——
 * 缓存保活一份（`agent.cjs` 的 CACHEABLE_TOOLS）、画布结果免附加一份（SCALAR_BACKED_TOOLS）、
 * 变成类一份（MUTATION_TOOLS）、副作用分类一份（`sideEffects.cjs`）、角色白名单一份（`toolkit.cjs`）。
 * 同一个工具的「只读吗」在不同文件里各自维护，改一处漏一处。
 *
 * 本模块把这些语义收敛成**一份** descriptor，并让注册表能按声明执行：
 *   - `normalizeDescriptor()` 把任意输入补全成完整契约（缺省一律保守：未声明只读 = 可写）；
 *   - `descriptorForLegacy(name, description)` 为还没迁移的工具合成契约（从下面的名单反推）；
 *   - 名单（READ_ONLY/CACHEABLE/MUTATION/SCALAR_BACKED/CAPABILITY/LONG_RUNNING）是**唯一来源**，
 *     `agent.cjs`、`sideEffects.cjs` 从本模块取，不再各留一份。
 *
 * 契约字段（审查要求的 15 项）：
 *   name / version / description / inputSchema / outputSchema /
 *   readOnly / idempotent / mutatesWorkspace / requiresConfirmation / requiredCapability /
 *   timeoutMs / cachePolicy / retryPolicy / concurrencyPolicy / roleAllowlist
 */
'use strict';

/** 只读工具：可安全重复执行、结果可缓存、可在只读上下文里执行 */
const READ_ONLY_TOOLS = new Set([
  'scan_project', 'analyze_project', 'project_info', 'read_file',
  'find_files', 'search_files', 'list_directory', 'code_review', 'ask_user',
  'retrieve_context', 'read_skill', 'view_image',
  // 语义上只读，但**故意不进缓存白名单**：画布/标量是权威读源，变更后必须立刻读到最新状态
  'get_workbench_model', 'query_scalars', 'poll_job', 'recall', 'get_subagent_task',
  // 取消子任务（第 6 项）：只 abort 一个子代理，不改工作区；与 get_subagent_task 同类
  'cancel_subagent_task',
]);

/**
 * 只读结果缓存白名单（缓存保活 = 只有这些工具执行后缓存继续有效，其余一律清空）。
 * 注意：这是在「谁能读」里再挑一层「结果不会因为别的东西变化而失效」的工具，
 * 所以 get_workbench_model / poll_job / recall 不在其中。
 */
/**
 * 结果可在同一个 run 内复用的只读工具（缓存白名单）。
 *
 * `ask_user` **故意不在里面**：它是交互输入，不是幂等读。此前它在白名单里，导致同一个 run 内
 * 同样的问题问第二次时**直接复用旧答案**（用户根本看不到第二次提问），而「再问一次」往往正是
 * 情况变了之后该做的事。它是唯一被排除的交互型工具，其余只读工具照旧缓存。
 */
const CACHEABLE_TOOLS = new Set([
  'scan_project', 'analyze_project', 'project_info', 'read_file',
  'find_files', 'search_files', 'list_directory', 'code_review',
  // 技能正文也是「同一 run 内不会变」的只读内容 → 同参重复读走缓存（不刷新别的缓存）
  'read_skill',
  'view_image',
]);

/** 会改变画布模型 / 文件 / 工程状态的工具（语义清单，供文档与并行冲突判定引用） */
const MUTATION_TOOLS = new Set([
  'workbench_edit', 'bulk_edit', 'write_file', 'edit_file',
  'write_analysis_md', 'save_project', 'ui_control', 'remember',
  // 遗留未接入（第 4 项）：create_nodes / workbench_connect 的实现文件在，但没注册进
  // toolkit.BUILTINS，模型看不到它们（断言见 scripts/tool-contract-closure-test.cjs 的 NOT_WIRED）。
  // 这里保留名字只为「万一有新路径注册它们」时语义仍然正确，不代表它们是可用工具。
  'create_nodes', 'workbench_connect', 'delegate_task', 'delegate_tasks',
]);

/**
 * 「条件写入者」：默认只读（结果可缓存），但带某个可选参数时会改工作台。
 * 它们的 mutatesWorkspace 必须为 true —— 只读上下文里若无角色白名单授予就该被拦下。
 */
const CONDITIONAL_MUTATORS = new Set(['scan_project']);

/** 结果里的 [data] 不再附加进上下文（数据已落到本地标量库，避免把画布大字段发到云端） */
const SCALAR_BACKED_TOOLS = new Set([
  'get_workbench_model', 'workbench_edit', 'bulk_edit', 'write_analysis_md', 'query_scalars',
]);

/**
 * 同参数重复执行效果相同的写工具（可安全重试）：
 * 按内容写入/整体保存是幂等的；而 workbench_edit（新建节点拿新 id）、remember（追加记忆）不是。
 */
const IDEMPOTENT_WRITES = new Set(['write_file', 'edit_file', 'save_project']);

/** 能力声明（S3 只用于「网络被策略切断时拒绝」，完整能力裁决在 S7） */
const CAPABILITY_BY_TOOL = Object.freeze({
  read_file: 'workspace.read',
  find_files: 'workspace.read',
  search_files: 'workspace.read',
  list_directory: 'workspace.read',
  analyze_project: 'workspace.read',
  project_info: 'workspace.read',
  code_review: 'workspace.read',
  get_workbench_model: 'workspace.read',
  query_scalars: 'workspace.read',
  retrieve_context: 'workspace.read',
  read_skill: 'workspace.read',
  view_image: 'workspace.read',
  // scan_project 默认只读，但带 applyToWorkbench 参数时会写画布 → 能力上按写处理（fail-closed）
  scan_project: 'workspace.write',
  recall: 'workspace.read',
  get_subagent_task: 'workspace.read',
  cancel_subagent_task: 'subagent.delegate',
  poll_job: 'shell.execute',
  write_file: 'workspace.write',
  edit_file: 'workspace.write',
  bulk_edit: 'workspace.write',
  write_analysis_md: 'workspace.write',
  create_nodes: 'workspace.write',
  workbench_edit: 'workspace.write',
  workbench_connect: 'workspace.write',
  remember: 'workspace.write',
  save_project: 'project.save',
  execute_shell: 'shell.execute',
  fetch_url: 'network.request',
  web_search: 'network.request',
  worktree: 'workspace.write',
  ui_control: 'ui.interact',
  ask_user: 'ui.interact',
  delegate_task: 'subagent.delegate',
  delegate_tasks: 'subagent.delegate',
});

/** 自管超时的工具（内部已有秒级超时 / 合法长任务）：timeoutMs = 0 表示注册表不加超时 */
const SELF_TIMED_TOOLS = Object.freeze({
  execute_shell: 0,
  poll_job: 0,
  delegate_task: 0,
  delegate_tasks: 0,
  retrieve_context: 0,
  scan_project: 0,
  analyze_project: 0,
  fetch_url: 0,
  web_search: 0,
  bulk_edit: 0,
});

/** 注册表兜底超时（毫秒）；工具显式声明的 timeoutMs 优先，0 = 不加限制 */
const DEFAULT_TIMEOUT_MS = 120000;

const CAPABILITIES = Object.freeze([
  'workspace.read', 'workspace.write', 'project.save',
  'shell.execute', 'network.request', 'ui.interact', 'subagent.delegate',
]);

const CONFIRMATION_LEVELS = Object.freeze(['LOW', 'WRITE', 'HIGH']);

function toPositiveInt(value) {
  // 注意：null / undefined / '' 必须返回 null（= 未声明），不能落到 Number(null)=0 ——
  // 0 在本契约里表示「显式不设超时」，混淆两者会让注册表兜底超时静默失效。
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * 把任意输入补全成完整契约。**缺省一律保守**：
 * 未声明 readOnly 就按可写处理（fail-closed），未声明 idempotent 就按「不可安全重试」处理。
 * @param {any} input
 * @returns {any} 完整 descriptor
 */
function normalizeDescriptor(input) {
  const d = input || {};
  const name = String(d.name || '').trim();
  if (!name) throw new Error('descriptor 缺少 name');
  const readOnly = d.readOnly === true;
  const timeout = d.timeoutMs === undefined ? null : toPositiveInt(d.timeoutMs);
  const requiresConfirmation = d.requiresConfirmation === true
    ? 'WRITE'
    : CONFIRMATION_LEVELS.includes(d.requiresConfirmation)
      ? d.requiresConfirmation
      : false;
  const capability = CAPABILITIES.includes(d.requiredCapability) ? d.requiredCapability : 'workspace.read';
  const cacheMode = d.cachePolicy && ['none', 'run', 'ttl'].includes(d.cachePolicy.mode) ? d.cachePolicy.mode : null;
  return {
    name,
    version: String(d.version || '1'),
    description: String(d.description || ''),
    inputSchema: d.inputSchema == null ? null : d.inputSchema,
    outputSchema: d.outputSchema == null ? null : d.outputSchema,
    readOnly,
    // 未声明时：只读工具视为幂等（重放安全），写工具视为不幂等
    idempotent: d.idempotent === undefined ? readOnly : d.idempotent === true,
    mutatesWorkspace: d.mutatesWorkspace === undefined ? !readOnly : d.mutatesWorkspace === true,
    requiresConfirmation,
    // 只有显式注册的 descriptor 才会被注册表强制询问；旧 register() 合成的契约不改变既有行为
    confirmationEnforced: d.confirmationEnforced === true || d.explicit === true ? requiresConfirmation !== false : false,
    requiredCapability: capability,
    // 0 = 不加超时；未声明用注册表兜底
    timeoutMs: timeout === null ? null : timeout,
    cachePolicy: {
      mode: cacheMode || (readOnly ? 'run' : 'none'),
      ttlMs: toPositiveInt(d.cachePolicy && d.cachePolicy.ttlMs),
    },
    retryPolicy: {
      maxAttempts: toPositiveInt(d.retryPolicy && d.retryPolicy.maxAttempts) || (readOnly ? 2 : 1),
      backoff: d.retryPolicy && d.retryPolicy.backoff === 'exponential' ? 'exponential' : 'none',
      retryOn: Array.isArray(d.retryPolicy && d.retryPolicy.retryOn) ? d.retryPolicy.retryOn.slice() : [],
    },
    concurrencyPolicy: {
      // 只读 + 可缓存 = 同轮并行安全；写工具默认串行（并行调度在 S6 落地）
      parallelSafe: d.concurrencyPolicy && d.concurrencyPolicy.parallelSafe !== undefined
        ? d.concurrencyPolicy.parallelSafe === true
        : readOnly && CACHEABLE_TOOLS.has(name),
      mutexKey: null,
    },
    // null = 由 ROLE_TOOLS 决定（toolkit.filterByRole 负责），显式给了就按显式来
    roleAllowlist: Array.isArray(d.roleAllowlist) ? d.roleAllowlist.slice() : null,
    source: d.explicit === true ? 'explicit' : 'legacy',
  };
}

/**
 * 为尚未迁移的工具（走旧 register(name, desc, schema, executor)）合成契约。
 * @param {string} name
 * @param {string} description
 * @param {any} inputSchema
 */
function descriptorForLegacy(name, description, inputSchema) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  // 未登记的外部工具（项目扩展 / MCP）按最保守的能力处理：它会执行外部命令
  const capability = CAPABILITY_BY_TOOL[name] || (readOnly ? 'workspace.read' : 'shell.execute');
  const timeout = Object.prototype.hasOwnProperty.call(SELF_TIMED_TOOLS, name) ? SELF_TIMED_TOOLS[name] : null;
  return normalizeDescriptor({
    name,
    description,
    inputSchema,
    readOnly,
    idempotent: readOnly || IDEMPOTENT_WRITES.has(name),
    mutatesWorkspace: !readOnly || CONDITIONAL_MUTATORS.has(name),
    requiredCapability: capability,
    timeoutMs: timeout,
    // 旧 register() 不做注册表级确认（工具自己内部确认的照旧），避免行为突变
    requiresConfirmation: false,
    cachePolicy: { mode: CACHEABLE_TOOLS.has(name) ? 'run' : 'none' },
    concurrencyPolicy: { parallelSafe: readOnly && CACHEABLE_TOOLS.has(name) },
    explicit: false,
  });
}

/** 人类可读摘要（UI / 审计 / 文档共用） */
function describeDescriptor(descriptor) {
  const d = descriptor || {};
  return {
    name: d.name,
    version: d.version,
    readOnly: d.readOnly === true,
    idempotent: d.idempotent === true,
    mutatesWorkspace: d.mutatesWorkspace === true,
    requiresConfirmation: d.requiresConfirmation || false,
    requiredCapability: d.requiredCapability,
    timeoutMs: d.timeoutMs == null ? null : d.timeoutMs,
    cacheMode: (d.cachePolicy || {}).mode || 'none',
    parallelSafe: !!((d.concurrencyPolicy || {}).parallelSafe),
    source: d.source || 'legacy',
  };
}

module.exports = {
  READ_ONLY_TOOLS,
  CONDITIONAL_MUTATORS,
  CACHEABLE_TOOLS,
  MUTATION_TOOLS,
  SCALAR_BACKED_TOOLS,
  IDEMPOTENT_WRITES,
  CAPABILITY_BY_TOOL,
  SELF_TIMED_TOOLS,
  DEFAULT_TIMEOUT_MS,
  CAPABILITIES,
  CONFIRMATION_LEVELS,
  normalizeDescriptor,
  descriptorForLegacy,
  describeDescriptor,
};
