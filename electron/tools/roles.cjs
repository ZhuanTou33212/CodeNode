/**
 * roles.cjs —— 子代理角色契约的**唯一来源**（S9，2026-09-16）
 *
 * 背景：角色语义此前散落三处 —— `toolkit.cjs` 的工具白名单、`subagents.cjs` 的
 * `READ_ONLY_ROLES` 与 `ROLE_PROMPTS`。结果是不一致（实测）：`ROLE_TOOLS` 有 5 个角色
 * （含 `canvas`），`ROLE_PROMPTS` 只有 4 个；`delegate_task` 的 enum 把 `canvas` 暴露给模型，
 * 而 canvas 子代理**没有角色提示**（taskPrompt 里 `filter(Boolean)` 静默丢掉 undefined），
 * 却能 `save_project` / `ui_control` / `write_analysis_md`。
 *
 * 现在每个角色的「工具白名单 / 是否只读 / 授予的能力 / 角色提示」只在本文件声明一次：
 *   - `toolkit.filterByRole` 按 `tools` 裁剪注册表，并把 `capabilities` 写到
 *     `registry.roleCapabilities`；`registry.execute` 的只读门据此判断
 *     「这个角色的契约里是否显式授予了该工具所需能力」（verifier 的 `execute_shell` 靠它放行）；
 *   - `subagents.cjs` 的只读判定与角色提示也从这里取，不再各自维护一份。
 *
 * 能力口径：只写「角色明确需要、且会越过只读门」的能力。`workspace.read` 是所有角色的下限，
 * 写类工具由 `workspace.write` 表达，跑命令由 `shell.execute` 表达。
 */

'use strict';

/** @type {Record<string, {readOnly: boolean, capabilities: readonly string[], tools: readonly string[], prompt: string}>} */
const ROLE_DEFINITIONS = Object.freeze({
  explorer: Object.freeze({
    readOnly: true,
    capabilities: Object.freeze(['workspace.read']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'scan_project', 'read_file',
      'find_files', 'search_files', 'list_directory', 'retrieve_context', 'query_scalars',
    ]),
    prompt: '你负责项目探查和证据收集，只读分析，不修改文件或画布。scan_project 只用于读取目录树；带 applyToWorkbench 的写入请求会被只读上下文拒绝，不要用它改画布。',
  }),
  builder: Object.freeze({
    readOnly: false,
    capabilities: Object.freeze(['workspace.read', 'workspace.write']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
      'list_directory', 'retrieve_context', 'query_scalars', 'write_file', 'edit_file', 'workbench_edit',
    ]),
    prompt: '你负责按任务目标实施最小必要修改，只修改任务范围内的文件或画布；写入会按确认策略询问用户，不要扩大范围。',
  }),
  verifier: Object.freeze({
    readOnly: true,
    capabilities: Object.freeze(['workspace.read', 'shell.execute']),
    tools: Object.freeze([
      'project_info', 'read_file', 'find_files', 'search_files', 'list_directory',
      'retrieve_context', 'query_scalars', 'execute_shell', 'poll_job', 'code_review',
    ]),
    prompt: '你负责执行验证、测试和静态检查，不修改项目文件（execute_shell 只用于跑测试/检查/构建，不得写盘或改配置）。',
  }),
  reviewer: Object.freeze({
    readOnly: true,
    capabilities: Object.freeze(['workspace.read']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
      'retrieve_context', 'query_scalars', 'code_review',
    ]),
    prompt: '你负责独立审查实现质量、安全性和验收覆盖，不修改项目。',
  }),
  canvas: Object.freeze({
    readOnly: false,
    capabilities: Object.freeze(['workspace.read', 'workspace.write', 'project.save', 'ui.interact']),
    tools: Object.freeze([
      'get_workbench_model', 'workbench_edit', 'write_analysis_md', 'save_project', 'ui_control',
    ]),
    prompt: '你负责画布与工程结构操作（增删节点/连线、写入分析文档、保存工程、界面动作），不碰项目源码文件；保存工程与界面动作会请求用户确认。',
  }),
});

const ROLE_NAMES = Object.freeze(Object.keys(ROLE_DEFINITIONS));

/**
 * 取角色契约。
 * @param {string} role
 * @returns {{readOnly: boolean, capabilities: readonly string[], tools: readonly string[], prompt: string}|null}
 */
function roleDefinition(role) {
  const name = String(role == null ? '' : role).trim();
  if (!name || name === 'supervisor') return null;
  return Object.prototype.hasOwnProperty.call(ROLE_DEFINITIONS, name)
    ? /** @type {{readOnly: boolean, capabilities: readonly string[], tools: readonly string[], prompt: string}} */ (ROLE_DEFINITIONS[name])
    : null;
}

/**
 * 角色 → 工具白名单（未定义角色返回 null，调用方应视为「无工具」）。
 * @param {string} role
 * @returns {string[]|null}
 */
function roleTools(role) {
  const def = roleDefinition(role);
  return def ? def.tools.slice() : null;
}

/**
 * 角色 → 授予的能力集合（未定义角色返回空数组）。
 * @param {string} role
 * @returns {string[]}
 */
function roleCapabilities(role) {
  const def = roleDefinition(role);
  return def ? def.capabilities.slice() : [];
}

/** 角色 → 是否只读（未定义角色按只读取，fail-closed）。 */
function isReadOnlyRole(role) {
  const def = roleDefinition(role);
  return def ? def.readOnly === true : true;
}

/** 角色 → 角色提示（未定义角色返回空串，不再静默丢掉整行）。 */
function rolePrompt(role) {
  const def = roleDefinition(role);
  return def ? def.prompt : '';
}

/** 供文档 / 审计 / 用例核对的只读目录。 */
function roleCatalog() {
  return ROLE_NAMES.map((name) => {
    const def = roleDefinition(name) || { readOnly: true, capabilities: [], tools: [], prompt: '' };
    return { name, readOnly: def.readOnly, capabilities: def.capabilities.slice(), tools: def.tools.slice() };
  });
}

module.exports = {
  ROLE_DEFINITIONS,
  ROLE_NAMES,
  roleDefinition,
  roleTools,
  roleCapabilities,
  isReadOnlyRole,
  rolePrompt,
  roleCatalog,
};
