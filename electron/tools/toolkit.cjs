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
];

function buildDefaultRegistry() {
  const registry = new AgentToolRegistry();
  for (const mod of BUILTINS) {
    mod.register(registry);
  }
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

module.exports = { buildDefaultRegistry, filterByConfig, filterByRole, buildDefaultRegistryWithConfig, BUILTINS, ROLE_TOOLS };
