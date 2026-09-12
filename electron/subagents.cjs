'use strict';

const { AgentToolResult } = require('./tools/result.cjs');
const { ROLE_TOOLS } = require('./tools/toolkit.cjs');

const READ_ONLY_ROLES = new Set(['explorer', 'verifier', 'reviewer']);
const MAX_TASKS_PER_RUN = 12;
const MAX_BATCH_TASKS = 8;
const ROLE_PROMPTS = {
  explorer: '你负责项目探查和证据收集，只读分析，不修改文件或画布。',
  builder: '你负责按任务目标实施最小必要修改，只修改任务范围内的文件或画布。',
  verifier: '你负责执行验证、测试和静态检查，不修改项目文件。',
  reviewer: '你负责独立审查实现质量、安全性和验收覆盖，不修改项目。',
};

function makeTaskId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 180000;
  return Math.max(10000, Math.min(900000, Math.floor(n * 1000)));
}

function taskPrompt(task) {
  const criteria = Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length
    ? '\n验收条件：\n- ' + task.acceptanceCriteria.join('\n- ')
    : '';
  const inputs = task.inputs && typeof task.inputs === 'object'
    ? '\n上游输入：\n' + JSON.stringify(task.inputs)
    : '';
  return [
    '你是 CodeNode 的子代理。',
    ROLE_PROMPTS[task.role],
    '只完成当前任务，不扩展范围；不要假设未读取到的事实。',
    '任务编号：' + task.taskId,
    '任务目标：' + task.objective,
    criteria,
    inputs,
    '完成后用简洁文本返回：结论、证据引用、变更文件、测试结果、风险和未完成事项。',
  ].filter(Boolean).join('\n');
}

function taskView(task) {
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
    this.tasks = new Map();
  }

  register(registry) {
    this.registry = registry;
    registry.register(
      'delegate_task',
      '创建并执行一个受角色工具权限约束的子代理任务。role 可选 explorer/builder/verifier/reviewer；stageNodeId 可绑定画布 stage 节点。',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          role: { type: 'string', enum: Object.keys(ROLE_TOOLS) },
          objective: { type: 'string' },
          inputs: { type: 'object' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          stageNodeId: { type: 'string' },
          timeoutSeconds: { type: 'integer' },
        },
        required: ['role', 'objective'],
      },
      (context, args) => this.delegate(context, args)
    );
    registry.register(
      'get_subagent_task',
      '读取已创建的子代理任务状态和结果。',
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
      '批量执行子代理任务；全部为只读角色时并行执行，包含 builder 时按顺序执行。',
      {
        type: 'object',
        properties: { tasks: { type: 'array', items: { type: 'object' } } },
        required: ['tasks'],
      },
      async (context, args) => {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return AgentToolResult.error('缺少 tasks');
        if (tasks.length > MAX_BATCH_TASKS) return AgentToolResult.error('单次最多委派 ' + MAX_BATCH_TASKS + ' 个子代理任务');
        if (tasks.some((item) => !item || !ROLE_TOOLS[item.role] || !String(item.objective || '').trim())) {
          return AgentToolResult.error('tasks 中存在无效的 role 或 objective');
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
    if (this.tasks.size >= MAX_TASKS_PER_RUN) return AgentToolResult.error('本轮最多执行 ' + MAX_TASKS_PER_RUN + ' 个子代理任务');
    const role = String(args.role || '').trim();
    const objective = String(args.objective || '').trim();
    if (!ROLE_TOOLS[role]) return AgentToolResult.error('不支持的子代理角色：' + role);
    if (!objective) return AgentToolResult.error('缺少子代理 objective');

    const task = {
      taskId: String(args.taskId || makeTaskId()),
      runId: this.runId,
      role,
      objective,
      inputs: args.inputs && typeof args.inputs === 'object' ? args.inputs : {},
      acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria.map(String) : [],
      stageNodeId: String(args.stageNodeId || ''),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    context.audit(JSON.stringify({ kind: 'subagent_start', runId: this.runId, taskId: task.taskId, role }));
    await this.updateStage(context, task, 'running', '子代理 ' + role + ' 正在执行');

    let result;
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
        readOnly: READ_ONLY_ROLES.has(role),
      });
      result = await this.agent.runAgentChat({
        cfg: this.cfg,
        messages: [
          { role: 'system', content: taskPrompt(task) },
          { role: 'user', content: objective },
        ],
        tools: { registry: childRegistry, context: childContext },
        signal: typeof context.signal === 'function' ? context.signal() : null,
        timeoutMs: clampTimeout(args.timeoutSeconds),
        onDelta: (event) => this.onDelta && this.onDelta({ kind: 'subagent_delta', taskId: task.taskId, role, event }),
      });
      task.status = result.error ? 'failed' : result.aborted ? 'blocked' : 'done';
      task.summary = result.content || '';
      task.toolCalls = result.toolCalls || [];
      task.grounding = result.grounding || null;
      task.usage = result.usage || null;
      if (result.error) task.error = result.error;
    } catch (error) {
      task.status = 'failed';
      task.error = String(error && error.message ? error.message : error);
    }
    task.finishedAt = new Date().toISOString();
    this.tasks.set(task.taskId, task);
    const summary = task.status === 'done' ? task.summary : (task.error || '子代理任务未完成');
    await this.updateStage(context, task, task.status, summary.slice(0, 4000));
    context.audit(JSON.stringify({ kind: 'subagent_end', runId: this.runId, taskId: task.taskId, role, status: task.status }));
    const view = taskView(task);
    return task.status === 'done'
      ? AgentToolResult.ok('子代理任务 ' + task.taskId + ' 已完成：\n' + summary, view)
      : AgentToolResult.error('子代理任务 ' + task.taskId + ' ' + task.status + '：' + summary, view);
  }

  async updateStage(context, task, status, summary) {
    if (!task.stageNodeId || !this.registry) return;
    await this.registry.execute('workbench_edit', {
      operations: [
        { action: 'set_status', nodeId: task.stageNodeId, value: status },
        { action: 'set_result_summary', nodeId: task.stageNodeId, value: summary },
      ],
    }, context);
  }
}

module.exports = { SubagentManager, READ_ONLY_ROLES, ROLE_PROMPTS };
