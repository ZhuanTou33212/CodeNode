/**
 * AgentToolkit：装配默认工具注册表 + 按配置过滤（复刻原版 AgentToolkit）。
 *
 * 配置支持（agent.properties）：
 *   tools.allowed   = read_file,write_file,...   （白名单，空=全部允许）
 *   tools.deny      = execute_shell               （黑名单）
 *   tools.enabled   = true/false                  （总开关，默认 true）
 */
'use strict';

const { AgentToolRegistry } = require('./registry.cjs');
const { registerProjectExtensions } = require('./extensions.cjs');
// 角色契约（白名单 / 是否只读 / 授予的能力 / 角色提示）的唯一来源 —— 见 tools/roles.cjs。
// 本文件只做「按角色裁剪注册表」这件事，不再自己维护一份角色语义。
const roles = require('./roles.cjs');
// 工具面分层（阶段 A / P0-1）：profile 名单与「按任务裁剪」的确定性判定
const profiles = require('./profiles.cjs');

/** @type {Record<string, readonly string[]>} 兼容旧导入：角色 → 工具白名单（从 roles.cjs 派生） */
const ROLE_TOOLS = Object.freeze(
  Object.fromEntries(roles.ROLE_NAMES.map((name) => [name, roles.roleTools(name) || []])),
);

const BUILTINS = [
  require('./impl/getWorkbenchModelTool.cjs'),
  require('./impl/workbenchEditTool.cjs'),
  require('./impl/scanProjectTool.cjs'),
  require('./impl/readFileTool.cjs'),
  require('./impl/writeFileTool.cjs'),
  require('./impl/editFileTool.cjs'),
  require('./impl/findFilesTool.cjs'),
  require('./impl/searchFilesTool.cjs'),
  require('./impl/listDirectoryTool.cjs'),
  require('./impl/executeShellTool.cjs'),
  require('./impl/codeReviewTool.cjs'),
  require('./impl/askUserTool.cjs'),
  require('./impl/fetchUrlTool.cjs'),
  require('./impl/saveProjectTool.cjs'),
  require('./impl/bulkEditTool.cjs'),
  require('./impl/analyzeProjectTool.cjs'),
  require('./impl/uiControlTool.cjs'),
  require('./impl/writeAnalysisMdTool.cjs'),
  require('./impl/projectInfoTool.cjs'),
  require('./impl/retrieveContextTool.cjs'),
  require('./impl/queryScalarsTool.cjs'),
  require('./impl/memoryTool.cjs'),
  // 任务清单（对照 Codex 的 update_plan）：模型自己写下「分几步、现在在哪一步」。
  // 它不是工作区写操作（mutatesWorkspace=false），但也不是只读缓存项 —— 见 impl/updatePlanTool.cjs。
  require('./impl/updatePlanTool.cjs'),
  // Skill 正文按需读取（渐进披露）：system prompt 只放索引，正文由模型自己调这个工具取
  require('./impl/readSkillTool.cjs'),
  // 看图（对照 Codex 的 view_image）：把项目内的图片附到对话里，让模型真的看到画面
  require('./impl/viewImageTool.cjs'),
  // 联网搜索（对照 Codex/Claude Code 的 web_search）：后端由配置指定，**不配就不注册**
  require('./impl/webSearchTool.cjs'),
  // 工作树隔离（对照 Codex/Claude Code）：create/list/remove，只在 .codenode/worktrees/ 下动手
  require('./impl/worktreeTool.cjs'),
];
// 注意：`discover_tools`（工具面分层的取回入口）**故意不在这里** —— 它只在真的裁剪了工具面时才注册
// （见 registerDiscoverTool）。理由：`agent.tool_profile=off` 时请求体必须与没有这个功能**逐字节一致**，
// 而进 BUILTINS 会让它无条件多出一个工具 schema（约 60 tokens/轮）。

function buildDefaultRegistry() {
  const registry = new AgentToolRegistry();
  for (const mod of BUILTINS) {
    mod.register(registry);
  }
  return declareSemantics(registry);
}

/**
 * 把每个工具的语义**显式**写进契约（S3「24 个工具逐个迁移」的收口）。
 *
 * descriptor.cjs 的名单是唯一来源，legacy 合成契约的字段值同样来自它 —— 这里只是把结果
 * 固化成 `explicit: true` 的声明（source 从 'legacy' 变 'explicit'，字段值逐字不变）。
 * 特别注意 `requiresConfirmation` **原样传递**：补声明不能顺手给写工具加一道审批，
 * 行为变化只允许来自显式配置（tools.confirm_writes）。
 */
function declareSemantics(registry) {
  for (const descriptor of registry.listDescriptors()) {
    registry.declareContract(descriptor.name, {
      readOnly: descriptor.readOnly,
      idempotent: descriptor.idempotent,
      mutatesWorkspace: descriptor.mutatesWorkspace,
      requiresConfirmation: descriptor.requiresConfirmation,
      requiredCapability: descriptor.requiredCapability,
      timeoutMs: descriptor.timeoutMs,
      cachePolicy: descriptor.cachePolicy,
      concurrencyPolicy: descriptor.concurrencyPolicy,
    });
  }
  return registry;
}

/**
 * 注册 `discover_tools`（工具面分层 / P0-1 的取回入口）。**只在裁剪真的生效时调用** ——
 * 未裁剪时它没有可发现的工具，多注册一个 schema 纯属白付固定开销。
 * 必须在 `filterByConfig` **之前**调用：用户的 `tools.allowed/deny` 是显式白/黑名单，照旧说了算。
 */
function registerDiscoverTool(registry) {
  require('./impl/discoverToolsTool.cjs').register(registry);
  return registry;
}

/** 按配置过滤工具（tools.enabled / tools.allowed / tools.deny）。 */
function filterByConfig(registry, config) {
  const cfg = config || {};
  if (cfg.toolsEnabled === false) {
    for (const spec of registry.listTools()) registry.unregister(spec.name);
    return registry;
  }
  const allowed = cfg.toolsAllowed || null; // null 或空 = 全部允许
  const deny = cfg.toolsDeny || [];
  for (const spec of registry.listTools()) {
    if ((spec.name === 'retrieve_context' || spec.name === 'query_scalars') && cfg.ragEnabled === false) {
      registry.unregister(spec.name);
      continue;
    }
    // 联网搜索同样是「关掉的能力不占上下文」：未启用就不注册（不留下一个永远报错的工具）
    if (spec.name === 'web_search' && cfg.webSearchEnabled !== true) {
      registry.unregister(spec.name);
      continue;
    }
    if (deny.includes(spec.name)) {
      registry.unregister(spec.name);
      continue;
    }
    if (allowed && allowed.length > 0 && !allowed.includes(spec.name)) {
      registry.unregister(spec.name);
    }
  }
  return registry;
}

function buildDefaultRegistryWithConfig(config) {
  const cfg = config || {};
  const registry = buildDefaultRegistry();
  // S7：确认策略三态随配置下发（true = 声明了 requiresConfirmation 的工具全部强制审批；
  // false = 全部关闭；未配置 = 沿用各工具 descriptor 自带的判定，兼容既有行为）
  if (cfg.toolsConfirmWrites !== undefined) {
    registry.confirmWrites = cfg.toolsConfirmWrites === true ? true : cfg.toolsConfirmWrites === false ? false : undefined;
  }
  // 跨 Agent 资源租约（P3）：**同一个 run 内的所有注册表（主代理 + 每个子代理）必须共享同一个实例**，
  // 否则各建一份 = 谁也没锁住谁。实例由 ipc 按 run 创建后传进来。
  if (cfg.leases) registry.leases = cfg.leases;
  if (cfg.projectRoot) registerProjectExtensions(registry, cfg.projectRoot);
  if (cfg.role) filterByRole(registry, cfg.role);
  return filterByConfig(registry, cfg);
}

/**
 * 按角色裁剪注册表：白名单与能力集都来自 tools/roles.cjs（唯一来源）。
 * `registry.roleCapabilities` 是注册表只读门的判据 —— 角色契约里显式授予的能力，
 * 允许越过「只读上下文不得执行写工具」这道门（verifier 的 execute_shell 就是这种情况）。
 */
function filterByRole(registry, role) {
  if (!role || role === 'supervisor') {
    registry.allowedTools = null;
    registry.roleCapabilities = null;
    return registry;
  }
  const allowed = ROLE_TOOLS[role];
  if (!allowed) {
    for (const spec of registry.listTools()) registry.unregister(spec.name);
    registry.allowedTools = new Set();
    registry.roleCapabilities = new Set();
    return registry;
  }
  const allowedSet = new Set(allowed);
  for (const spec of registry.listTools()) {
    if (!allowedSet.has(spec.name)) registry.unregister(spec.name);
  }
  registry.allowedTools = allowedSet;
  registry.roleCapabilities = new Set(roles.roleCapabilities(role));
  return registry;
}

module.exports = {
  buildDefaultRegistry,
  filterByConfig,
  filterByRole,
  buildDefaultRegistryWithConfig,
  declareSemantics,
  BUILTINS,
  ROLE_TOOLS,
  registerDiscoverTool,
  /** 工具面分层（阶段 A / P0-1）：profile 名单与确定性路由都在 tools/profiles.cjs（唯一来源） */
  profiles,
};
