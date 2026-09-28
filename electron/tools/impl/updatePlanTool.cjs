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
  '更新当前会话的执行计划。每项包含稳定 id、步骤、验收标准、可选 dependsOn / ownerTaskId 和状态；状态取 pending|in_progress|blocked|completed|cancelled。' +
  '长任务先规划；完成项必须引用此前成功工具调用编号 evidenceCallIds，阻塞/取消项写 reason。ownerTaskId 必须是已创建的子代理任务。更新时保留旧步骤和 id，不再需要的步骤标为 cancelled。';

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
          id: { type: 'string', description: '稳定步骤编号；更新现有步骤时原样保留', maxLength: planLib.MAX_STEP_ID_CHARS },
          step: { type: 'string', description: '这一步要做什么（可自检的具体动作）', maxLength: planLib.MAX_STEP_CHARS },
          acceptanceCriteria: { type: 'string', description: '可核验的完成条件', maxLength: planLib.MAX_ACCEPTANCE_CHARS },
          status: { type: 'string', description: '这一步的状态', enum: planLib.PLAN_STATUSES.slice() },
          evidenceCallIds: { type: 'array', description: 'completed 必填：实际成功工具调用编号', maxItems: planLib.MAX_EVIDENCE_CALLS, items: { type: 'string', maxLength: 128 } },
          dependsOn: { type: 'array', description: '前置步骤 ID；被依赖步骤完成前不能开始', maxItems: planLib.MAX_DEPENDENCIES, items: { type: 'string', maxLength: planLib.MAX_STEP_ID_CHARS } },
          ownerTaskId: { type: 'string', description: '负责此步骤的子代理 taskId（需先用 delegate_task 创建）', maxLength: 120 },
          reason: { type: 'string', description: 'blocked/cancelled 必填：阻塞或取消原因', maxLength: planLib.MAX_REASON_CHARS },
        },
        required: ['step', 'acceptanceCriteria', 'status'],
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
    blocked: { type: 'integer' },
    cancelled: { type: 'integer' },
    persisted: { type: 'boolean' },
    runFilePersisted: { type: 'boolean' },
    sessionFilePersisted: { type: 'boolean' },
    eventPersisted: { type: 'boolean' },
    file: { type: 'string' },
    sessionFile: { type: 'string' },
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
      const root = typeof context.projectRoot === 'function' ? context.projectRoot() : null;
      const runId = typeof context.runId === 'function' ? context.runId() : '';
      const sessionId = typeof context.planSessionId === 'function' ? context.planSessionId() : '';
      const sessionPlan = sessionId ? planLib.readSessionPlan(root, sessionId) : null;
      const previousSessionPlan = sessionPlan &&
        (String(sessionPlan.runId || '') === String(runId) || !planLib.isTerminalPlan(sessionPlan))
        ? sessionPlan
        : null;
      const previous = previousSessionPlan || planLib.readPlan(root, runId);
      const normalized = planLib.normalizePlan(args && args.items, { previousItems: previous && previous.items });
      if (normalized.ok === false) {
        return AgentToolResult.error(normalized.error, {
          code: normalized.code || 'ARG_SCHEMA',
          tool: 'update_plan',
          items: (args && args.items) || null,
        });
      }
      const items = normalized.items;
      const summary = planLib.summarizePlan({ items });
      const availableEvidence = typeof context.toolEvidence === 'function' ? context.toolEvidence() : [];
      const allowedEvidence = new Map(availableEvidence.map((entry) => [String(entry.callId), entry]));
      for (const item of items) {
        const oldOwner = previous && previous.items && previous.items.find((candidate) => candidate && candidate.id === item.id);
        if (item.ownerTaskId && (!oldOwner || oldOwner.ownerTaskId !== item.ownerTaskId) &&
          (typeof context.planOwnerExists !== 'function' || context.planOwnerExists(item.ownerTaskId) !== true)) {
          return AgentToolResult.error(
            `步骤 ${item.id} 关联的子代理 taskId 不存在：${item.ownerTaskId}。请先调用 delegate_task 创建任务并保留返回的 taskId。`,
            { code: 'ARG_SEMANTIC', tool: 'update_plan', ownerTaskId: item.ownerTaskId }
          );
        }
        if (item.status !== 'completed') continue;
        const old = previous && previous.items && previous.items.find((candidate) => candidate && candidate.id === item.id);
        const unchangedCompleted = old && old.status === 'completed' &&
          JSON.stringify(old.evidenceCallIds || []) === JSON.stringify(item.evidenceCallIds || []);
        if (unchangedCompleted) continue;
        const invalidEvidence = (item.evidenceCallIds || []).filter((callId) => !allowedEvidence.has(callId));
        if (invalidEvidence.length) {
          const choices = availableEvidence.map((entry) => entry.tool + '#' + entry.callId).join('、') || '（当前 run 尚无成功工具调用）';
          return AgentToolResult.error(
            `步骤 ${item.id} 的证据编号不属于本次 run 中已成功的工具调用：${invalidEvidence.join('、')}。可用证据：${choices}`,
            { code: 'ARG_SEMANTIC', tool: 'update_plan', invalidEvidence, availableEvidence }
          );
        }
      }
      // 落盘：run 事件（统一事件流可见）+ run 级文件（跨进程/续跑可查）
      let file = null;
      let sessionFile = null;
      let eventWritten = null;
      if (root && runId) {
        const updatedAt = new Date().toISOString();
        file = planLib.writePlan(root, runId, /** @type {any} */ (items), { updatedAt, sessionId });
        if (sessionId) sessionFile = planLib.writeSessionPlan(root, sessionId, runId, items, { updatedAt });
        try {
          const runStore = require('../../runStore.cjs');
          eventWritten = runStore.appendEvent(root, runId, 'plan_updated', {
            total: summary.total,
            completed: summary.completed,
            inProgress: summary.inProgress,
            blocked: summary.blocked,
            cancelled: summary.cancelled,
            pending: summary.pending,
            items,
            file: file ? path.relative(root, file) : null,
            sessionFile: sessionFile ? path.relative(root, sessionFile) : null,
            sessionId: sessionId || null,
          });
        } catch {
          eventWritten = null;
        }
      }
      const runFilePersisted = !!file;
      const sessionFilePersisted = !sessionId || !!sessionFile;
      const eventPersisted = !!eventWritten;
      const persisted = runFilePersisted && sessionFilePersisted && eventPersisted;
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
        (persisted ? '' : '\n（计划持久化未完整：run 文件 ' + (runFilePersisted ? '成功' : '失败') +
          '，会话文件 ' + (sessionFilePersisted ? '成功/不需要' : '失败') +
          '，run 事件 ' + (eventPersisted ? '成功' : '失败') + '；请勿假设重启后可恢复）');

      return AgentToolResult.ok(text, {
        total: summary.total,
        completed: summary.completed,
        inProgress: summary.inProgress,
        blocked: summary.blocked,
        cancelled: summary.cancelled,
        pending: summary.pending,
        items,
        persisted,
        runFilePersisted,
        sessionFilePersisted,
        eventPersisted,
        file: file || null,
        sessionFile: sessionFile || null,
      });
    }
  );
}

module.exports = { register };
