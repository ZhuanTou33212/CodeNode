/**
 * roles.cjs —— 子代理角色契约的**唯一来源**（S9，2026-09-16；角色档案升级，2026-09-16）
 *
 * 背景：角色语义此前散落三处 —— `toolkit.cjs` 的工具白名单、`subagents.cjs` 的
 * `READ_ONLY_ROLES` 与 `ROLE_PROMPTS`。结果是不一致（实测）：`ROLE_TOOLS` 有 5 个角色
 * （含 `canvas`），`ROLE_PROMPTS` 只有 4 个；`delegate_task` 的 enum 把 `canvas` 暴露给模型，
 * 而 canvas 子代理**没有角色提示**（taskPrompt 里 `filter(Boolean)` 静默丢掉 undefined），
 * 却能 `save_project` / `ui_control` / `write_analysis_md`。
 *
 * 现在每个角色的档案只在本文件声明一次：
 *   - `label`      —— 身份（中文名，进 system prompt 与派生工具描述）
 *   - `work`       —— **这个角色负责哪类工作**（主代理据此派活，子代理据此把握范围）
 *   - `notWork`    —— 明确不属于它的工作（避免角色越界，例如 explorer 去跑测试）
 *   - `tools`      —— 工具白名单；`toolkit.filterByRole` 按它裁剪注册表
 *   - `capabilities` —— 授予的能力；`registry.execute` 的只读门据此放行（verifier 的 execute_shell）
 *   - `skills`     —— 内置技能 id（`roleSkills.cjs`），子代理 system prompt 里逐条展开成规程
 *   - `guidance`   —— 工作方式（顺序、边界、完成标准）
 *   - `prompt`     —— 保留的历史一句话提示（外部/用例按名字取，不要删）
 *
 * 能力口径：只写「角色明确需要、且会越过只读门」的能力。`workspace.read` 是所有角色的下限，
 * 写类工具由 `workspace.write` 表达，跑命令由 `shell.execute` 表达。
 *
 * 一致性约束（用例 `test:subagent-role-skill` 会核对）：`work` 里出现"修改/写入"类工作时，
 * 角色必须同时具备写能力与非只读标记；只读角色不得声明写工作。
 */

'use strict';

/** @type {Record<string, {label: string, readOnly: boolean, capabilities: readonly string[], tools: readonly string[], work: readonly string[], notWork: readonly string[], skills: readonly string[], guidance: string, prompt: string}>} */
const ROLE_DEFINITIONS = Object.freeze({
  explorer: Object.freeze({
    label: '项目探查员',
    readOnly: true,
    capabilities: Object.freeze(['workspace.read']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'scan_project', 'read_file',
      'find_files', 'search_files', 'list_directory', 'retrieve_context', 'query_scalars',
    ]),
    work: Object.freeze([
      '回答「在哪里 / 怎么实现的 / 依赖谁」这类定位问题',
      '定位文件、符号、调用点与配置',
      '收集可引用的证据（路径 + 行号 + 关键字段）',
    ]),
    notWork: Object.freeze([
      '修改文件或画布（包括「顺手修复」）',
      '执行构建 / 测试 / 命令（那是 verifier 的工作）',
    ]),
    skills: Object.freeze(['explore-structure-first', 'cite-evidence', 'read-only-discipline']),
    guidance: '工作方式：先拿到项目结构与形态，再按需逐层展开；结论只写读到的事实，读不到就写「未确认」。需要改动时给出「建议 + 理由 + 影响面」，不动手。',
    prompt: '你负责项目探查和证据收集，只读分析，不修改文件或画布。scan_project 只用于读取目录树；带 applyToWorkbench 的写入请求会被只读上下文拒绝，不要用它改画布。',
  }),
  builder: Object.freeze({
    label: '实现工程师',
    readOnly: false,
    capabilities: Object.freeze(['workspace.read', 'workspace.write']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
      'list_directory', 'retrieve_context', 'query_scalars', 'write_file', 'edit_file', 'workbench_edit',
    ]),
    work: Object.freeze([
      '按任务目标实施最小必要修改（源码文件或画布）',
      '新建 / 编辑文件、补上缺失的实现与连线',
      '改完自检并把变更文件、验证方式写清',
    ]),
    notWork: Object.freeze([
      '大规模重构、重命名、格式化（超出任务范围）',
      '改动测试与构建配置来「让结果变绿」',
    ]),
    skills: Object.freeze(['recon-before-write', 'minimal-change', 'followup-verify']),
    guidance: '工作方式：先读后写、最小改动、改完自检。写操作会按确认策略询问用户；被拒绝时不要绕道（例如改用 shell 写同一文件），如实报告并交回主代理。',
    prompt: '你负责按任务目标实施最小必要修改，只修改任务范围内的文件或画布；写入会按确认策略询问用户，不要扩大范围。',
  }),
  verifier: Object.freeze({
    label: '验证工程师',
    readOnly: true,
    capabilities: Object.freeze(['workspace.read', 'shell.execute']),
    tools: Object.freeze([
      'project_info', 'read_file', 'find_files', 'search_files', 'list_directory',
      'retrieve_context', 'query_scalars', 'execute_shell', 'poll_job', 'code_review',
    ]),
    work: Object.freeze([
      '跑测试 / 构建 / 静态检查并给出原始输出',
      '复现问题、确认修复是否真的生效',
      '把失败定位到最小可复现命令',
      // P4：核验别人的交付（子代理信封）—— 不采信自述，重算 + 复跑
      '核验子代理交付：先用 get_subagent_task 拿 verification（它会重算产物哈希与画布快照），再独立复跑 evidence.commands 里的命令',
    ]),
    notWork: Object.freeze([
      '修改被测源码、测试或配置',
      '凭阅读代码推断「应该能过」而跳过执行',
    ]),
    skills: Object.freeze(['verify-by-execution', 'raw-output-discipline', 'no-source-edits']),
    guidance:
      '工作方式：用执行说话。先跑最小可判定命令，失败再扩大范围；长任务用 async + poll_job 轮询，不要前台硬等。' +
      '结论必须附命令与原始输出摘要。核验别人的交付时按三步走：① get_subagent_task 看 verification（哈希对不上=invalid，' +
      '结论不得采信；只是画布变过=stale，要按最新状态重新核对）；② 独立**复跑**信封里 evidence.commands 的命令，用真实退出码对账，' +
      '不要复述它的自述；③ 结果不一致就直说哪一条对不上，不要为了给出结论而含糊。',
    prompt: '你负责执行验证、测试和静态检查，不修改项目文件（execute_shell 只用于跑测试/检查/构建，不得写盘或改配置）。',
  }),
  reviewer: Object.freeze({
    label: '独立审查员',
    readOnly: true,
    capabilities: Object.freeze(['workspace.read']),
    tools: Object.freeze([
      'get_workbench_model', 'project_info', 'read_file', 'find_files', 'search_files',
      'retrieve_context', 'query_scalars', 'code_review',
    ]),
    work: Object.freeze([
      '独立审查实现质量、安全性与验收覆盖',
      '对抗式找反例（边界值、空输入、重复调用、失败路径）',
      '按严重度排序输出发现与依据',
    ]),
    notWork: Object.freeze([
      '修改项目（含画布）—— 审查与修改必须分离',
      '替实现方写代码（可以给修复方向）',
    ]),
    skills: Object.freeze(['adversarial-read', 'severity-ranked-findings', 'no-fix-by-owner']),
    guidance: '工作方式：先看验收条件与改动面，再逐条追问「什么输入会错、错误怎么暴露」。无法复现的怀疑写成「待确认」，不要写成结论。',
    prompt: '你负责独立审查实现质量、安全性和验收覆盖，不修改项目。',
  }),
  canvas: Object.freeze({
    label: '画布架构师',
    readOnly: false,
    capabilities: Object.freeze(['workspace.read', 'workspace.write', 'project.save', 'ui.interact']),
    tools: Object.freeze([
      'get_workbench_model', 'workbench_edit', 'write_analysis_md', 'save_project', 'ui_control',
    ]),
    work: Object.freeze([
      '增删节点 / 连线、调整画布结构并保证 start→end 链路完整',
      '把长方案写进节点 prompt（长文本下沉）',
      '保存工程与分析文档',
    ]),
    notWork: Object.freeze([
      '读写项目源码文件（那是 builder / explorer 的工作）',
      '在回复里抄回完整 prompt 全文',
    ]),
    skills: Object.freeze(['canvas-grammar', 'chain-completeness', 'summarize-not-dump']),
    guidance: '工作方式：先看画布现状（get_workbench_model）再改；一次提交批量 operations；改完确认链路完整并把关键节点 id 写进结论。',
    prompt: '你负责画布与工程结构操作（增删节点/连线、写入分析文档、保存工程、界面动作），不碰项目源码文件；保存工程与界面动作会请求用户确认。',
  }),
});

const ROLE_NAMES = Object.freeze(Object.keys(ROLE_DEFINITIONS));

/** 角色档案的形状（缺字段的角色按最保守的取值兜底）。 */
function emptyRole() {
  return {
    label: '',
    readOnly: true,
    capabilities: [],
    tools: [],
    work: [],
    notWork: [],
    skills: [],
    guidance: '',
    prompt: '',
  };
}

/**
 * 取角色档案。
 * @param {string} role
 * @returns {{label: string, readOnly: boolean, capabilities: readonly string[], tools: readonly string[], work: readonly string[], notWork: readonly string[], skills: readonly string[], guidance: string, prompt: string}|null}
 */
function roleDefinition(role) {
  const name = String(role == null ? '' : role).trim();
  if (!name || name === 'supervisor') return null;
  return Object.prototype.hasOwnProperty.call(ROLE_DEFINITIONS, name)
    ? /** @type {any} */ (ROLE_DEFINITIONS[name])
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

/** 角色 → 身份名（未定义角色返回空串）。 */
function roleLabel(role) {
  const def = roleDefinition(role);
  return def ? def.label : '';
}

/** 角色 → 负责的工作类型（未定义角色返回空数组）。 */
function roleWork(role) {
  const def = roleDefinition(role);
  return def ? def.work.slice() : [];
}

/** 角色 → 明确不属于它的工作。 */
function roleNotWork(role) {
  const def = roleDefinition(role);
  return def ? def.notWork.slice() : [];
}

/** 角色 → 内置技能 id 清单。 */
function roleSkillIds(role) {
  const def = roleDefinition(role);
  return def ? def.skills.slice() : [];
}

/** 角色 → 工作方式说明。 */
function roleGuidance(role) {
  const def = roleDefinition(role);
  return def ? def.guidance : '';
}

/** 供文档 / 审计 / 用例核对的只读目录。 */
function roleCatalog() {
  return ROLE_NAMES.map((name) => {
    const def = roleDefinition(name) || emptyRole();
    return {
      name,
      label: def.label,
      readOnly: def.readOnly,
      capabilities: def.capabilities.slice(),
      tools: def.tools.slice(),
      work: def.work.slice(),
      notWork: def.notWork.slice(),
      skills: def.skills.slice(),
    };
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
  roleLabel,
  roleWork,
  roleNotWork,
  roleSkillIds,
  roleGuidance,
  roleCatalog,
};
