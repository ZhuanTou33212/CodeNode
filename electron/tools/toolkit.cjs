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

const ROLE_TOOLS = Object.freeze({
  explorer: [
    'get_workbench_model', 'project_info', 'scan_project', 'read_file',
    'find_files', 'search_files', 'list_directory', 'retrieve_context', 'query_scalars',
  ],
  builder: [
    'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
    'list_directory', 'retrieve_context', 'query_scalars', 'write_file', 'edit_file', 'workbench_edit',
  ],
  verifier: [
    'project_info', 'read_file', 'find_files', 'search_files', 'list_directory',
    'retrieve_context', 'query_scalars', 'execute_shell', 'poll_job', 'code_review',
  ],
  reviewer: [
    'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
    'retrieve_context', 'query_scalars', 'code_review',
  ],
  canvas: [
    'get_workbench_model', 'workbench_edit', 'write_analysis_md', 'save_project', 'ui_control',
  ],
});

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
  if (cfg.projectRoot) registerProjectExtensions(registry, cfg.projectRoot);
  if (cfg.role) filterByRole(registry, cfg.role);
  return filterByConfig(registry, cfg);
}

function filterByRole(registry, role) {
  if (!role || role === 'supervisor') return registry;
  const allowed = ROLE_TOOLS[role];
  if (!allowed) {
    for (const spec of registry.listTools()) registry.unregister(spec.name);
    registry.allowedTools = new Set();
    return registry;
  }
  const allowedSet = new Set(allowed);
  for (const spec of registry.listTools()) {
    if (!allowedSet.has(spec.name)) registry.unregister(spec.name);
  }
  registry.allowedTools = allowedSet;
  return registry;
}

module.exports = { buildDefaultRegistry, filterByConfig, filterByRole, buildDefaultRegistryWithConfig, BUILTINS, ROLE_TOOLS };
