/**
 * subagents.cjs —— 子代理（delegate_task / delegate_tasks）管理器
 *
 * S9（2026-09-16）收口了五件事，读代码时别再按旧行为推理：
 *   1. **角色契约单一来源**：只读判定 / 工具白名单 / 角色提示全部来自 `tools/roles.cjs`
 *      （此前三处各写一份，实测 `canvas` 有工具却没有角色提示，enum 还对模型暴露它）。
 *   2. **独立预算（父子链）**：每个子代理拿到自己的配额（`agent.subagent.max_total_tokens`），
 *      通过 parent 链把真实用量记回父 run —— 一个子代理超额只让它自己失败，不拖垮父与其他子代理，
 *      同时不绕过 `agent.max_total_tokens` 的 run 总量。
 *   3. **总时长预算**：`timeoutSeconds` 现在是**任务总时长**（默认 600s，可配），用组合信号 +
 *      定时器中止；此前它被当成 runAgentChat 的「单轮超时」（默认 180s × 最多 12 轮）。
 *   4. **结果合并契约**：回灌主上下文的结果带固定字段头（taskId/role/status/工具调用数/变更文件）、
 *      按 `agent.subagent.result_max_chars` 截断并指向 `get_subagent_task`；结构字段放进 data。
 *      失败时显式提示「不要原样重试」，避免主循环的「失败请重试」诱导重复委派。
 *   5. **画布痕迹不再静默丢**：stage 回写前校验节点存在与类型，回写失败写审计与 task.stageWarning。
 *
 * 幂等归因：子代理与父代理共享同一个 side-effect 账本（**刻意如此**：续跑时「已提交就跳过」
 * 的语义必须跨角色成立），但每次登记都带 actor（taskId/role），去重文案说清是谁提交的 —— 见 sideEffects.cjs。
 */
'use strict';

const { AgentToolResult } = require('./tools/result.cjs');
const roles = require('./tools/roles.cjs');
const subagentPrompt = require('./subagentPrompt.cjs');
const { createSubagentBudget } = require('./requestBudget.cjs');

/** 只读角色（来自角色契约，不再各留一份名单） */
const READ_ONLY_ROLES = new Set(roles.ROLE_NAMES.filter((name) => roles.isReadOnlyRole(name)));

/** 角色提示（保留旧导出：外部/测试按名字取提示） */
const ROLE_PROMPTS = Object.freeze(
  Object.fromEntries(roles.ROLE_NAMES.map((name) => [name, roles.rolePrompt(name)])),
);

const DEFAULTS = Object.freeze({
  maxTasksPerRun: 12,
  maxBatchTasks: 8,
  totalTimeoutSeconds: 600,
  resultMaxChars: 8000,
});

/** 单轮模型调用超时上限（子代理总时长再长，单轮也不该无限等） */
const MAX_SINGLE_TURN_TIMEOUT_MS = 180000;
const MIN_TOTAL_TIMEOUT_MS = 10000;
const MAX_TOTAL_TIMEOUT_MS = 3600000;
/** 会改文件/画布的工具名（用于从工具调用记录里提取「变更了什么」，只报事实） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bulk_edit', 'write_analysis_md']);

function makeTaskId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 子代理任务总时长（秒 → 毫秒）。缺省取配置值，钳到 [10s, 1h]。
 * @param {any} seconds 模型传入的 timeoutSeconds
 * @param {number} fallbackSeconds 配置里的默认总时长
 * @returns {number}
 */
function clampTotalTimeout(seconds, fallbackSeconds) {
  const fallback =
    Number.isFinite(Number(fallbackSeconds)) && Number(fallbackSeconds) > 0
      ? Number(fallbackSeconds)
      : DEFAULTS.totalTimeoutSeconds;
  const n = Number(seconds);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(MIN_TOTAL_TIMEOUT_MS, Math.min(MAX_TOTAL_TIMEOUT_MS, Math.floor(base * 1000)));
}

/**
 * 默认的项目 Skill 读取：与主代理**同一个来源**（`.codenode/extensions.json` 或
 * `config/extensions.json` 里 kind=skills 的条目），此前子代理完全看不到它们。
 * 延迟 require extensions.cjs —— 它连带 sandbox / context 等重量级依赖，构造路径上不需要。
 * @param {string|null} projectRoot
 */
function defaultProjectSkills(projectRoot) {
  if (!projectRoot) return [];
  try {
    return require('./tools/extensions.cjs')
      .readManifest(projectRoot)
      .filter((item) => String(item.kind || '').toLowerCase() === 'skills')
      .map((item) => ({ name: String(item.name), instructions: String(item.instructions || item.description || '') }));
  } catch {
    return [];
  }
}

/** 从工具调用记录里提取被改动的文件（best-effort，解析不出就跳过，绝不猜） */
function changedFiles(toolCalls) {
  const out = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || call.ok === false || !WRITE_TOOLS.has(call.name)) continue;
    let parsed = null;
    try {
      parsed = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args;
    } catch {
      parsed = null;
    }
    const p = parsed && (parsed.path || parsed.filePath || parsed.file || parsed.target);
    if (p) out.add(String(p));
    if (out.size >= 20) break;
  }
  return [...out];
}

/**
 * 对外的任务视图（也会作为 AgentToolResult.data 回给主代理）。
 * contract 字段是 S9 的「结构化合并契约」：主代理不必只靠读自然语言判断成败。
 */
function taskView(task) {
  const files = changedFiles(task.toolCalls);
  return {
    taskId: task.taskId,
    runId: task.runId,
    role: task.role,
    objective: task.objective,
    stageNodeId: task.stageNodeId,
    status: task.status,
    summary: task.summary || '',
    error: task.error || null,
    grounding: task.grounding || null,
    usage: task.usage || null,
    stageWarning: task.stageWarning || null,
    contract: {
      role: task.role,
      status: task.status,
      totalTimeoutMs: task.totalTimeoutMs,
      toolCalls: Array.isArray(task.toolCalls)
        ? task.toolCalls.slice(-30).map((call) => ({ name: call && call.name, ok: !!(call && call.ok) }))
        : [],
      changedFiles: files,
      toolCallCount: Array.isArray(task.toolCalls) ? task.toolCalls.length : 0,
      // 验收是否达成不做自动判定（会变成编造）：交给主代理按 acceptanceCriteria 自行核对
      acceptanceJudgement: 'manual',
    },
    startedAt: task.startedAt,
    finishedAt: task.finishedAt || null,
  };
}

class SubagentManager {
  constructor(options) {
    const o = options || {};
    this.agent = o.agent;
    this.toolkit = o.toolkit;
    this.cfg = o.cfg;
    this.registry = o.registry;
    this.runId = o.runId || 'run-' + Date.now().toString(36);
    this.onDelta = o.onDelta || null;
    /** 读项目自定义 Skill（kind=skills 的扩展）；可注入，便于用例离线验证 */
    this.readProjectSkills = typeof o.readProjectSkills === 'function' ? o.readProjectSkills : defaultProjectSkills;
    this.tasks = new Map();
    /** @type {Record<string, number>} 子代理配置（agent.subagent.*），缺项用默认值 */
    this.subCfg = Object.assign({}, DEFAULTS, (o.cfg && o.cfg.subagent) || {});
  }

  register(registry) {
    this.registry = registry;
    const roleList = roles.ROLE_NAMES.join('/');
    // 派活对照表：主代理必须能看出「这类工作该交给哪个角色」，否则会拿 explorer 去改代码、拿 reviewer 去跑测试
    const roleGuide = roles.ROLE_NAMES
      .map((name) => {
        const def = roles.roleDefinition(name);
        return '  - ' + name + '（' + (def ? def.label : name) + '）：' + (def ? def.work.join('；') : '');
      })
      .join('\n');
    registry.register(
      'delegate_task',
      '创建并执行一个受角色工具权限约束的子代理任务。\n按工作类型选角色：\n' + roleGuide +
        '\nstageNodeId 可绑定画布 stage 节点；timeoutSeconds 是**任务总时长**（秒，默认 ' + this.subCfg.totalTimeoutSeconds + '）。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          role: { type: 'string', enum: roles.ROLE_NAMES },
          objective: { type: 'string' },
          inputs: { type: 'object' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          stageNodeId: { type: 'string' },
          timeoutSeconds: { type: 'integer', description: '任务总时长（秒），超时会被中止' },
        },
        required: ['role', 'objective'],
      },
      (context, args) => this.delegate(context, args)
    );
    registry.register(
      'get_subagent_task',
      '读取已创建的子代理任务状态和结果（含变更文件与工具调用摘要）。',
      {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      async (_context, args) => {
        const task = this.tasks.get(String(args.taskId || ''));
        return task
          ? AgentToolResult.ok(JSON.stringify(taskView(task)), taskView(task))
          : AgentToolResult.error('子代理任务不存在：' + String(args.taskId || ''));
      }
    );
    registry.register(
      'delegate_tasks',
      '批量执行子代理任务（角色含义与 delegate_task 一致；全部为只读角色时并行执行，包含写角色时按顺序执行）。',
      {
        type: 'object',
        properties: { tasks: { type: 'array', items: { type: 'object' } } },
        required: ['tasks'],
      },
      async (context, args) => {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return AgentToolResult.error('缺少 tasks');
        if (tasks.length > this.subCfg.maxBatchTasks) {
          return AgentToolResult.error('单次最多委派 ' + this.subCfg.maxBatchTasks + ' 个子代理任务');
        }
        if (tasks.some((item) => !item || !roles.roleDefinition(item.role) || !String(item.objective || '').trim())) {
          return AgentToolResult.error('tasks 中存在无效的 role 或 objective（可选角色：' + roleList + '）');
        }
        const run = tasks.every((item) => READ_ONLY_ROLES.has(item.role))
          ? Promise.all(tasks.map((item) => this.delegate(context, item)))
          : tasks.reduce(async (previous, item) => [...await previous, await this.delegate(context, item)], Promise.resolve([]));
        const results = await run;
        return AgentToolResult.ok(results.map((result) => result.text).join('\n'), { results: results.map((result) => taskView(result.data)) });
      }
    );
  }

  async delegate(context, args) {
    if (typeof context.cancelled === 'function' && context.cancelled()) return AgentToolResult.error('主 Agent 已取消，未启动子代理');
    if (this.tasks.size >= this.subCfg.maxTasksPerRun) {
      return AgentToolResult.error('本轮最多执行 ' + this.subCfg.maxTasksPerRun + ' 个子代理任务');
    }
    const role = String(args.role || '').trim();
    const objective = String(args.objective || '').trim();
    if (!roles.roleDefinition(role)) {
      return AgentToolResult.error('不支持的子代理角色：' + role + '（可选：' + roles.ROLE_NAMES.join('/') + '）');
    }
    if (!objective) return AgentToolResult.error('缺少子代理 objective');

    const totalMs = clampTotalTimeout(args.timeoutSeconds, this.subCfg.totalTimeoutSeconds);
    const task = {
      taskId: String(args.taskId || makeTaskId()),
      runId: this.runId,
      role,
      objective,
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
      acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria.map(String) : [],
      stageNodeId: String(args.stageNodeId || ''),
      totalTimeoutMs: totalMs,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    context.audit(JSON.stringify({ kind: 'subagent_start', runId: this.runId, taskId: task.taskId, role, totalTimeoutMs: totalMs }));
    await this.updateStage(context, task, 'running', '子代理 ' + role + ' 正在执行');

    // 总时长预算：组合父信号 + 自己的定时器。
    // 注意定时器**不能 unref** —— 被 unref 的 timer 不维持事件循环，被测/被中止场景下
    // 超时分支可能永不执行（S3 踩过同一个坑）。
    const parentSignal = typeof context.signal === 'function' ? context.signal() : null;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, totalMs);
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    let result = null;
    try {
      const childRegistry = this.toolkit.buildDefaultRegistryWithConfig({
        ...this.cfg.tools,
        ragEnabled: this.cfg.rag.enabled && !!context.projectRoot(),
        role,
      });
      const childContext = context.fork({
        runId: this.runId,
        taskId: task.taskId,
        role,
        readOnly: roles.isReadOnlyRole(role),
        signal: controller.signal,
      });
      // 独立配额（父子链）：0 = 不设独立配额，直接共享父预算（旧行为）
      const childBudget = createSubagentBudget(this.cfg.requestBudget, this.subCfg.maxTotalTokens);
      const childCfg = childBudget && childBudget !== this.cfg.requestBudget
        ? { ...this.cfg, requestBudget: childBudget }
        : this.cfg;
      // 子代理的 system prompt：身份 + 工作范围 + **真实注册表里的**可用工具 + 职责技能 + 项目 Skill + 运行规则。
      // 工具清单取自 childRegistry（不是手写名单），永远不会与角色权限裁剪漂移。
      const childTools = childRegistry.listTools().map((spec) => ({ name: spec.name, description: spec.description }));
      const systemPrompt = subagentPrompt.buildSubagentPrompt(task, {
        role,
        tools: childTools,
        projectSkills: this.readProjectSkills(context.projectRoot()),
      });
      result = await this.agent.runAgentChat({
        cfg: childCfg,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: objective },
        ],
        tools: { registry: childRegistry, context: childContext },
        signal: controller.signal,
        timeoutMs: Math.min(MAX_SINGLE_TURN_TIMEOUT_MS, totalMs),
        onDelta: (event) => this.onDelta && this.onDelta({ kind: 'subagent_delta', taskId: task.taskId, role, event }),
      });
      task.toolCalls = result.toolCalls || [];
      task.grounding = result.grounding || null;
      task.usage = result.usage || null;
      task.summary = String(result.content || '');
      if (timedOut) {
        task.status = 'blocked';
        task.error = '子代理任务达到总时长上限（约 ' + Math.round(totalMs / 1000) + 's），已中止';
      } else if (result.error) {
        task.status = 'failed';
        task.error = String(result.error);
      } else if (result.aborted) {
        task.status = 'blocked';
        task.error = '子代理被取消（主 Agent 停止或信号中断）';
      } else {
        task.status = 'done';
      }
      // 成本账本：子代理的模型用量计入同一个任务账（跨子代理共享预算，不再各记各的）
      try {
        require('./agent.cjs').recordCost(this.cfg, {
          kind: 'subagent',
          model: this.cfg.model,
          usage: result.usage,
          runId: this.runId,
          latencyMs: Date.now() - (Date.parse(String(task.startedAt || '')) || Date.now()),
          meta: { role, taskId: task.taskId },
        });
      } catch {}
    } catch (error) {
      task.status = timedOut ? 'blocked' : 'failed';
      task.error = timedOut
        ? '子代理任务达到总时长上限（约 ' + Math.round(totalMs / 1000) + 's），已中止'
        : String(error && error.message ? error.message : error);
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }

    task.finishedAt = new Date().toISOString();
    this.tasks.set(task.taskId, task);

    const view = taskView(task);
    const head =
      '[子代理结果] taskId=' + task.taskId + ' role=' + task.role + ' status=' + task.status +
      ' 工具调用=' + view.contract.toolCallCount +
      (view.contract.changedFiles.length ? ' 变更文件=' + view.contract.changedFiles.length : '');
    const body = task.status === 'done' ? (task.summary || '（子代理未返回文本）') : (task.error || '子代理任务未完成');
    const cap = this.subCfg.resultMaxChars;
    const clipped = body.length > cap
      ? body.slice(0, cap) + '\n…（结果过长，已截断 ' + (body.length - cap) + ' 字符；完整结果可用 get_subagent_task(taskId=' + task.taskId + ') 查看）'
      : body;
    const text = head + '\n' + clipped;
    await this.updateStage(context, task, task.status, text.slice(0, 4000));
    context.audit(JSON.stringify({ kind: 'subagent_end', runId: this.runId, taskId: task.taskId, role, status: task.status }));
    if (this.onDelta) this.onDelta({ kind: 'subagent_state', taskId: task.taskId, role, status: task.status, summary: clipped.slice(0, 200) });
    return task.status === 'done'
      ? AgentToolResult.ok(text, view)
      : AgentToolResult.error(
          text + '\n请勿用相同 objective 原样重试（同参数会再执行一次）：先按上面的原因缩小范围或换角色（只读探查用 explorer、验证用 verifier），或由主代理直接完成这一步。',
          view
        );
  }

  /**
   * 回写绑定的 stage 节点。
   * S9：先校验节点存在与类型，再看 registry 的返回值 —— 之前这里静默忽略失败，
   * 画布上「子代理痕迹消失」没有任何提示。
   */
  async updateStage(context, task, status, summary) {
    if (!task.stageNodeId || !this.registry) return null;
    try {
      const model = context && typeof context.model === 'function' ? context.model() : null;
      const node = model && typeof model.byId === 'function' ? model.byId(task.stageNodeId) : null;
      if (model && typeof model.byId === 'function' && !node) {
        task.stageWarning = 'stage 节点不存在：' + task.stageNodeId + '（子代理结果未回写画布）';
        context.audit(JSON.stringify({ kind: 'subagent_stage_missing', taskId: task.taskId, stageNodeId: task.stageNodeId }));
        return null;
      }
      if (node && node.type && node.type !== 'stage') {
        task.stageWarning = '绑定的节点不是 stage 类型（' + node.type + '）：状态仍会写入，但语义可能不符';
        context.audit(JSON.stringify({ kind: 'subagent_stage_type_mismatch', taskId: task.taskId, stageNodeId: task.stageNodeId, type: node.type }));
      }
    } catch {}
    const res = await this.registry.execute(
      'workbench_edit',
      {
        operations: [
          { action: 'set_status', nodeId: task.stageNodeId, value: status },
          { action: 'set_result_summary', nodeId: task.stageNodeId, value: summary },
        ],
      },
      context
    );
    if (!res || res.ok !== true) {
      task.stageWarning = '画布回写失败：' + String((res && res.text) || '未知原因');
      context.audit(JSON.stringify({ kind: 'subagent_stage_update_failed', taskId: task.taskId, stageNodeId: task.stageNodeId, error: String((res && res.text) || '').slice(0, 300) }));
    }
    return res;
  }
}

module.exports = { SubagentManager, READ_ONLY_ROLES, ROLE_PROMPTS, changedFiles, taskView, clampTotalTimeout, DEFAULTS };
