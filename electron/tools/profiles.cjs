/**
 * profiles.cjs —— 主 Agent 的**工具面分层**（阶段 A / P0-1）
 *
 * auto 默认按任务选 core+code；单个明确文件的小改走 edit 面，少带 RAG、全项目分析与编排工具。
 * 问题（token 效率审计 §3.2）：主 Agent 每轮都把整个注册表序列化下发 —— 实测 33 个工具、
 * schema 7,261 tokens/轮，纯代码任务固定输入 9,493 tokens。一个 6 轮代码任务仅固定部分就约
 * 5.7 万 tokens，而且**用不到的能力（画布、子代理编排、联网）也在每轮缴税**。
 *
 * 本模块只做一件事：**按确定性规则决定「这一轮暴露哪些工具」**，不决定任何安全判定 ——
 *   - 未暴露 ≠ 不能执行：注册表执行侧的门（只读门 / 网络门 / 审批门 / 租约门）逐条不受影响，
 *     只是模型暂时看不到这份 schema；要用的工具由 `discover_tools` 显式取回（只增不减）。
 *   - 判定全是纯函数（无模型调用、无文件、无时间）→ 用例可直接锁「什么任务拿什么面」。
 *
 * 与提示词分层同源：画布与否**不在本模块判断**，由调用方把 `agent.resolvePromptLayers` 的结论
 * 传进来（`input.canvas`）—— 两处各判一次迟早会漂移。
 *
 * 配置（config/agent.properties）：
 *   agent.tool_profile = auto        出厂默认：按任务确定性裁剪；单文件小改使用 edit 面
 *                      = off         完全关闭：暴露全部工具（与没有这个功能逐字节一致）
 *                      = core,code   显式指定：按名字叠加（core 永远在）
 */
'use strict';

/**
 * profile → 工具名单（**唯一来源**）。
 *
 * 纪律：
 *   1. core 是普通任务的基础面；自动 edit 面也保留文件读写、定位、验证和 `discover_tools`。
 *      `discover_tools` 必须在每个自动面里，否则「取回被裁掉的工具」这条退路本身也会被裁掉。
 *   2. **规则点名的工具必须留在暴露面里**：`agent.cjs` 的常驻运行规则（4/5/17/18）直接点名
 *      scan_project / analyze_project / retrieve_context / read_file 等；把规则点名的工具裁掉，
 *      模型会照着规则去调一个不存在的工具 —— 那是真实故障模式，不只是浪费。
 *      这条纪律的代价可量化：画布轮因此仍带 code 面（≈760 tokens），画布降幅 27% 而不是 48%。
 *      要更激进可以显式配 `agent.tool_profile=core,canvas`（并自行承担规则悬空）。
 *   3. 一个工具只出现在**它最小充分**的 profile 里，重叠项（retrieve_context / view_image）
 *      显式列出，不靠隐式继承 —— 名单读起来就是一个工具为什么被暴露。
 *   4. 名单外的工具名一律忽略（注册表里没有的能力不该让判定变复杂），见 resolveToolProfiles。
 */
const PROFILE_TOOLS = Object.freeze({
  /** 常驻核心面：读、写、找、跑命令、看进程、取项目知识、技能正文、写计划、求助、记忆写入 */
  core: Object.freeze([
    'read_file', 'write_file', 'edit_file',
    'find_files', 'search_files', 'list_directory',
    'execute_shell', 'poll_job',
    'read_skill',
    'update_plan', 'ask_user', 'remember',
    'discover_tools',
  ]),
  /** 代码面：项目级只读分析 + 看图（规则 17/18 点名的 scan_project / analyze_project 在这里） */
  code: Object.freeze([
    'scan_project', 'project_info', 'analyze_project', 'code_review', 'view_image',
  ]),
  /** 符号导航按需加载；日常代码任务不额外携带四份工具 schema。 */
  symbols: Object.freeze([
    'find_definition', 'find_references', 'get_callers', 'get_callees',
  ]),
  /** 画布面：工作台模型的读写与界面动作（含标量库大字段免回灌的那几个） */
  canvas: Object.freeze([
    'get_workbench_model', 'workbench_edit', 'bulk_edit', 'query_scalars',
    'write_analysis_md', 'ui_control', 'save_project',
  ]),
  /** 调研面：出网 + 记忆检索 */
  research: Object.freeze([
    'fetch_url', 'web_search', 'dify_call', 'recall', 'retrieve_context', 'view_image',
  ]),
  /** 编排面：子代理与工作树隔离（单价最贵的一组，实测 delegate_task 557 tokens + worktree 201） */
  orchestration: Object.freeze([
    'delegate_task', 'delegate_tasks', 'get_subagent_task', 'cancel_subagent_task',
    'inspect_subagent_retry', 'retry_subagent_task',
    'merge_subagent_results', 'review_subagent_result', 'worktree',
  ]),
  /** 单文件小改：目标文件读写、必要的定位/验证与按需取回；不常驻 RAG/编排/全项目分析。 */
  edit: Object.freeze([
    'read_file', 'write_file', 'edit_file',
    'find_files', 'search_files', 'list_directory',
    'execute_shell', 'poll_job', 'read_skill', 'discover_tools',
  ]),
});

const PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_TOOLS));

/** 每个工具被哪些 profile 覆盖（审计/文档用；重叠的 retrieve_context 会列出多个） */
function profilesForTool(name) {
  const n = String(name || '');
  return PROFILE_NAMES.filter((p) => PROFILE_TOOLS[p].includes(n));
}

/**
 * 确定性路由器：从**用户这句话**判断要不要额外的面。
 *
 * 只按「有没有提到」判断，命中才加 —— 漏加的代价是一次 `discover_tools` 往返（可恢复），
 * 多加的代价是每轮固定税（不可恢复）。所以这里**故意宽进**：只要沾边就加上。
 */
const RESEARCH_RE = /联网|搜索|搜一下|查一下|查资料|调研|最新的?资料|网上|浏览器|抓取|爬取|文档站|web|http|dify/i;
const ORCHESTRATION_RE = /子代理|子任务|并行|分工|多个\s*(agent|代理)|delegate|工作树|worktree/i;
const SYMBOL_RE = /符号|跳转.*定义|查找.*定义|谁调用|谁引用|调用链|引用链|\b(find_definition|find_references|get_callers|get_callees|callers?|callees?)\b/i;
const SIMPLE_EDIT_ACTION_RE = /修改|改(?:一下|动|成)|替换|更新|修复|编辑|新增|添加|插入|删除|移除|去掉|\b(rename|change|edit|replace|update|fix|add|remove|delete)\b/i;
const BROAD_EDIT_RE = /重构|批量|所有|每个|全局|整个项目|多个文件|跨文件|项目整体|架构|报错|错误|异常|堆栈|问题|故障|\b(bug|error|debug|issue|test|tests)\b|分析|审查|调研|联网|搜索|查找|部署|发布/i;
const FILE_TARGET_RE = /[\w@.-]+(?:[\\/][\w@.-]+)*\.(?:js|cjs|mjs|ts|tsx|jsx|java|py|go|rs|json|md|css|scss|html|yml|yaml|toml|properties|txt|xml|sql|sh|ps1)\b/gi;

/** 只在短请求明确指向一个文件、且没有广泛排查信号时使用精简编辑面。 */
function isSimpleEditRequest(prompt) {
  const text = String(prompt == null ? '' : prompt).trim();
  if (!text || text.length > 320 || !SIMPLE_EDIT_ACTION_RE.test(text) || BROAD_EDIT_RE.test(text)) return false;
  const targets = new Set((text.match(FILE_TARGET_RE) || []).map((item) => item.toLowerCase()));
  return targets.size === 1;
}

/**
 * 按任务判定该暴露哪些 profile。
 *
 * @param {{canvas?: boolean, prompt?: string, intentHint?: string|null, mode?: string,
 *          resuming?: boolean, resumeProfiles?: string[]|null}} input
 *   canvas  —— `agent.resolvePromptLayers().canvas` 的结论（唯一来源，本模块不重判）
 *   mode    —— 'off' 关闭裁剪 / 'auto' 或未给按任务裁剪 / 其他值 = 逗号分隔的显式 profile 名
 *   resuming —— 本次是**续跑**：读不到原面时退回全量面，绝不重新裁一次（同一 run 只增不减）
 *   resumeProfiles —— 原 run 记下的 profile 名单（续跑时优先于 mode；见下方的续跑分支）
 * @returns {{profiles: string[], reason: string, source: 'auto'|'explicit'|'off'|'resume'|'resume-full'}}
 */
function resolveToolProfiles(input) {
  const i = input || {};
  const mode = String(i.mode == null ? 'auto' : i.mode).trim();

  if (mode === 'off') return { profiles: [], reason: 'config-off', source: 'off' };

  /**
   * 续跑（resume）**绝不重新裁一次**：一个 run 的工具面只增不减，而续跑时 `intentPolicy` 为空
   * （续跑不分类，见 ipc 注释），画布层可能因此从「意图救回来」变成「省掉」—— 于是同一 run 的后半程
   * 比前半程**更窄**：模型上一轮刚调过的工具突然看不见，历史里还留着对它的调用。
   *
   * 两种取值：给出原 run 记下的 profile（`tool_face` 事件）就沿用它；读不到就**退回全量面** ——
   * 「不知道原来有什么」时，多带 schema 只是多花钱，缩窄却是能力静默消失。
   */
  if (Array.isArray(i.resumeProfiles) && i.resumeProfiles.length) {
    const set = new Set(i.resumeProfiles.filter((p) => PROFILE_NAMES.includes(p)));
    return { profiles: PROFILE_NAMES.filter((p) => set.has(p)), reason: 'resume-original-face', source: 'resume' };
  }
  if (i.resuming === true) return { profiles: [], reason: 'resume-keep-full-face', source: 'resume-full' };

  if (mode && mode !== 'auto') {
    const wanted = mode.split(',').map((s) => s.trim()).filter(Boolean);
    const valid = wanted.filter((p) => PROFILE_NAMES.includes(p));
    const unknown = wanted.filter((p) => !PROFILE_NAMES.includes(p));
    // core 永在；显式模式**不做关键词推断**（配置说了算，行为可预测）
    const set = new Set(['core', ...valid]);
    return {
      profiles: PROFILE_NAMES.filter((p) => set.has(p)),
      // 未知名字如实回报（不静默忽略 —— 拼错 profile 名会让「配了但没生效」无从察觉）
      reason: unknown.length ? 'explicit-with-unknown:' + unknown.join('|') : 'explicit',
      source: 'explicit',
    };
  }

  // auto：明确单文件编辑已在上面分流；其它任务以 core + code 为基线，额外面只在命中时叠加。
  // 不做「画布替代代码面」这种省法：见 PROFILE_TOOLS 纪律 2（规则悬空 = 真实故障模式）。
  const profiles = ['core', 'code'];
  const reasons = [];
  if (i.canvas === true) {
    profiles.push('canvas');
    reasons.push('canvas-task');
  }
  const prompt = String(i.prompt == null ? '' : i.prompt);
  if (i.canvas !== true && isSimpleEditRequest(prompt)
    && !RESEARCH_RE.test(prompt) && !ORCHESTRATION_RE.test(prompt)) {
    return { profiles: ['edit'], reason: 'explicit-single-file-edit', source: 'auto' };
  }
  if (RESEARCH_RE.test(prompt)) {
    profiles.push('research');
    reasons.push('prompt-mentions-research');
  }
  if (SYMBOL_RE.test(prompt)) {
    profiles.push('symbols');
    reasons.push('prompt-mentions-symbols');
  }
  if (ORCHESTRATION_RE.test(prompt)) {
    profiles.push('orchestration');
    reasons.push('prompt-mentions-orchestration');
  }
  if (!reasons.length) reasons.push('baseline-only');
  return { profiles: PROFILE_NAMES.filter((p) => profiles.includes(p)), reason: reasons.join('+'), source: 'auto' };
}

/**
 * 把 profile 判定落成「注册表里真实存在的工具名」（稳定顺序 = 注册表注册顺序）。
 *
 * 两条过滤规则：
 *   1. 名单里的名字可能根本没注册 —— 注册表已按 `tools.allowed/deny`、rag/web_search 开关裁过；
 *   2. **不在任何 profile 名单里的工具一律保持暴露（fail-open）**：项目扩展与 MCP 工具是用户自己
 *      装上的能力，profile 名单管不到它们；新加的内置工具若忘了归类，也宁可多带一个 schema
 *      （口径由 `test:token-overhead` 的棘轮盯着），**不能用「悄悄看不见」来省**。
 * @param {string[]} profiles
 * @param {string[]} registeredNames 注册表当前的工具名（顺序即暴露顺序）
 * @returns {string[]}
 */
function namesForProfiles(profiles, registeredNames) {
  const registered = Array.isArray(registeredNames) ? registeredNames.map((n) => String(n)) : [];
  const wanted = new Set();
  for (const p of Array.isArray(profiles) ? profiles : []) {
    const list = PROFILE_TOOLS[p];
    if (!list) continue;
    for (const n of list) wanted.add(n);
  }
  const known = new Set();
  for (const p of PROFILE_NAMES) for (const n of PROFILE_TOOLS[p]) known.add(n);
  return registered.filter((n) => wanted.has(n) || !known.has(n));
}

module.exports = {
  PROFILE_TOOLS,
  PROFILE_NAMES,
  profilesForTool,
  isSimpleEditRequest,
  resolveToolProfiles,
  namesForProfiles,
};
