/**
 * profiles.cjs —— 主 Agent 的**工具面分层**（阶段 A / P0-1）
 *
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
 *   agent.tool_profile = auto        出厂默认：按任务确定性裁剪（见 PROFILE_TOOLS）
 *                      = off         完全关闭：暴露全部工具（与没有这个功能逐字节一致）
 *                      = core,code   显式指定：按名字叠加（core 永远在）
 */
'use strict';

/**
 * profile → 工具名单（**唯一来源**）。
 *
 * 纪律：
 *   1. core 常驻 —— 任何任务都可能要读/写/查/跑命令/看计划/**取项目知识**（retrieve_context）。
 *      `discover_tools` 也必须在 core，否则「取回被裁掉的工具」这条退路本身也会被裁掉。
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
    'retrieve_context', 'read_skill',
    'update_plan', 'ask_user', 'remember',
    'discover_tools',
  ]),
  /** 代码面：项目级只读分析 + 看图（规则 17/18 点名的 scan_project / analyze_project 在这里） */
  code: Object.freeze([
    'scan_project', 'project_info', 'analyze_project', 'code_review', 'view_image',
  ]),
  /** 画布面：工作台模型的读写与界面动作（含标量库大字段免回灌的那几个） */
  canvas: Object.freeze([
    'get_workbench_model', 'workbench_edit', 'bulk_edit', 'query_scalars',
    'write_analysis_md', 'ui_control', 'save_project',
  ]),
  /** 调研面：出网 + 记忆检索 */
  research: Object.freeze([
    'fetch_url', 'web_search', 'recall', 'retrieve_context', 'view_image',
  ]),
  /** 编排面：子代理与工作树隔离（单价最贵的一组，实测 delegate_task 557 tokens + worktree 201） */
  orchestration: Object.freeze([
    'delegate_task', 'delegate_tasks', 'get_subagent_task', 'cancel_subagent_task',
    'merge_subagent_results', 'worktree',
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
const RESEARCH_RE = /联网|搜索|搜一下|查一下|查资料|调研|最新的?资料|网上|浏览器|抓取|爬取|文档站|web|http/i;
const ORCHESTRATION_RE = /子代理|子任务|并行|分工|多个\s*(agent|代理)|delegate|工作树|worktree/i;

/**
 * 按任务判定该暴露哪些 profile。
 *
 * @param {{canvas?: boolean, prompt?: string, intentHint?: string|null, mode?: string}} input
 *   canvas  —— `agent.resolvePromptLayers().canvas` 的结论（唯一来源，本模块不重判）
 *   mode    —— 'off' 关闭裁剪 / 'auto' 或未给按任务裁剪 / 其他值 = 逗号分隔的显式 profile 名
 * @returns {{profiles: string[], reason: string, source: 'auto'|'explicit'|'off'}}
 */
function resolveToolProfiles(input) {
  const i = input || {};
  const mode = String(i.mode == null ? 'auto' : i.mode).trim();

  if (mode === 'off') return { profiles: [], reason: 'config-off', source: 'off' };

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

  // auto：core + code 是**基线**（规则 4/5/17/18 点名的工具都在里面），额外面只在命中时叠加。
  // 不做「画布替代代码面」这种省法：见 PROFILE_TOOLS 纪律 2（规则悬空 = 真实故障模式）。
  const profiles = ['core', 'code'];
  const reasons = [];
  if (i.canvas === true) {
    profiles.push('canvas');
    reasons.push('canvas-task');
  }
  const prompt = String(i.prompt == null ? '' : i.prompt);
  if (RESEARCH_RE.test(prompt)) {
    profiles.push('research');
    reasons.push('prompt-mentions-research');
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
  resolveToolProfiles,
  namesForProfiles,
};
