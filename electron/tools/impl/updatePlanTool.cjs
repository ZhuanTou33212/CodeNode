/**
 * update_plan —— Agent 自己的任务清单（对照 Codex 的 `update_plan`）
 *
 * 语义：把「这件事分几步、现在做到哪一步」显式写下来。计划会
 *   ① 立刻回给模型（本次工具结果就是渲染后的清单）；
 *   ② 落 run 事件 `plan_updated` + `.codenode/runs/<runId>.plan.json`（跨进程/续跑/回放可查）；
 *   ③ 之后随进度提示一起回灌（`agent.cjs` 的 buildProgressNote 接 plan）——
 *      否则模型几轮之后就不记得自己承诺过什么。
 *
 * 契约要点（每条都有对应用例）：
 *   - `mutatesWorkspace: false`：它不改文件/画布，只改 Agent 自己的状态 → 只读角色上下文里也不该被拦
 *     （但**不进**只读角色白名单，子代理默认拿不到：计划是主代理的职责）；
 *   - `cachePolicy: none`：两次同样的 update_plan **必须真的执行两次**（它是状态变更，不是幂等读）；
 *   - `requiresConfirmation: false`：Agent 内部状态，不打扰用户（与 Codex/Claude Code 一致）。
 */
'use strict';

const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const planLib = require('../../plan.cjs');

const DESCRIPTION_LONG =
  '更新当前任务的执行计划（清单）。每项一个步骤，status 取 pending|in_progress|completed；同一时刻最多一项 in_progress。' +
  '长任务（预计超过 3 步）先写计划再动手；每完成一步就更新它。计划会随进度提示回灌给你。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '步骤清单（按执行顺序）',
      minItems: 1,
      maxItems: planLib.MAX_PLAN_ITEMS,
      items: {
        type: 'object',
        properties: {
          step: { type: 'string', description: '这一步要做什么（可自检的具体动作）', maxLength: planLib.MAX_STEP_CHARS },
          status: { type: 'string', description: '这一步的状态', enum: planLib.PLAN_STATUSES.slice() },
        },
        required: ['step', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'integer' },
    completed: { type: 'integer' },
    inProgress: { type: 'integer' },
    persisted: { type: 'boolean' },
    file: { type: 'string' },
  },
};

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'update_plan',
      version: '1',
      description: DESCRIPTION_LONG,
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      readOnly: false,
      // 同参数重放安全（覆盖式写入），但**不**进缓存白名单：状态变更必须真的执行
      idempotent: true,
      mutatesWorkspace: false,
      requiresConfirmation: false,
      requiredCapability: 'workspace.read',
      timeoutMs: 5000,
      cachePolicy: { mode: 'none' },
      retryPolicy: { maxAttempts: 1, backoff: 'none', retryOn: [] },
      concurrencyPolicy: { parallelSafe: false },
      roleAllowlist: null,
    },
    async (context, args) => {
      const normalized = planLib.normalizePlan(args && args.items);
      if (!normalized.ok) {
        return AgentToolResult.error(normalized.error, {
          code: normalized.code || 'ARG_SCHEMA',
          tool: 'update_plan',
          items: (args && args.items) || null,
        });
      }
      const items = normalized.items;
      const summary = planLib.summarizePlan({ items });
      const root = typeof context.projectRoot === 'function' ? context.projectRoot() : null;
      const runId = typeof context.runId === 'function' ? context.runId() : '';

      // 落盘：run 事件（统一事件流可见）+ run 级文件（跨进程/续跑可查）
      let file = null;
      let eventWritten = null;
      if (root && runId) {
        const updatedAt = new Date().toISOString();
        file = planLib.writePlan(root, runId, items, { updatedAt });
        try {
          const runStore = require('../../runStore.cjs');
          eventWritten = runStore.appendEvent(root, runId, 'plan_updated', {
            total: summary.total,
            completed: summary.completed,
            inProgress: summary.inProgress,
            pending: summary.pending,
            items,
            file: file ? path.relative(root, file) : null,
          });
        } catch {
          eventWritten = null;
        }
      }
      if (typeof context.audit === 'function') {
        context.audit(
          'update_plan ' + summary.total + ' 项（完成 ' + summary.completed + '，进行中 ' + summary.inProgress + '）'
        );
      }

      const text =
        '计划已更新（' +
        summary.total +
        ' 项：完成 ' +
        summary.completed +
        ' / 进行中 ' +
        summary.inProgress +
        ' / 待办 ' +
        summary.pending +
        '）\n' +
        planLib.renderPlan({ items }) +
        (eventWritten ? '' : '\n（本次没有 run 上下文或事件未写入：计划只对当前调用可见，未落盘）');

      return AgentToolResult.ok(text, {
        total: summary.total,
        completed: summary.completed,
        inProgress: summary.inProgress,
        pending: summary.pending,
        items,
        persisted: !!eventWritten,
        file: file || null,
      });
    }
  );
}

module.exports = { register };
