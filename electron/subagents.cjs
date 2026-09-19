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
const { LeaseRegistry } = require('./tools/leases.cjs');
const { changedFilesFromToolCalls } = require('./tools/fileChanges.cjs');
// 确定性合并 + 冲突裁决（P5）：合并结果只依赖贡献项自身，不依赖到达顺序
const mergeLib = require('./tools/merge.cjs');
// 子代理结果的**单一 JSON 信封**（多 Agent 信息完整性 P1/P2）：契约校验 + 产物哈希 + 有损自报
const subagentEnvelope = require('./subagentEnvelope.cjs');
const roles = require('./tools/roles.cjs');
const subagentPrompt = require('./subagentPrompt.cjs');
const { createSubagentBudget } = require('./requestBudget.cjs');

/** 只读角色（来自角色契约，不再各留一份名单） */
const READ_ONLY_ROLES = new Set(roles.ROLE_NAMES.filter((name) => roles.isReadOnlyRole(name)));

/** 角色提示（保留旧导出：外部/测试按名字取提示） */
const ROLE_PROMPTS = Object.freeze(
  Object.fromEntries(roles.ROLE_NAMES.map((name) => [name, roles.rolePrompt(name)])),
);

/**
 * 子代理默认值。
 * 注意：`@type` 里的键类型必须显式写出，否则 `Object.freeze` 会把 `leases: true` 收窄成字面量
 * `true`、`leaseTtlMs` 收窄成 `120000`，随后 `this.subCfg.leases !== false` 会被 tsc 判成
 * 「number 与 boolean 不可能重叠」（checkJs 实测）。
 * @type {{maxTasksPerRun: number, maxBatchTasks: number, totalTimeoutSeconds: number,
 *         resultMaxChars: number, leases: boolean, leaseTtlMs: number}}
 */
const DEFAULTS = Object.freeze({
  maxTasksPerRun: 12,
  maxBatchTasks: 8,
  totalTimeoutSeconds: 600,
  resultMaxChars: 8000,
  /** 跨 Agent 资源租约（P3）：默认开 */
  leases: true,
  leaseTtlMs: 120000,
});

/** 单轮模型调用超时上限（子代理总时长再长，单轮也不该无限等） */
const MAX_SINGLE_TURN_TIMEOUT_MS = 180000;
const MIN_TOTAL_TIMEOUT_MS = 10000;
const MAX_TOTAL_TIMEOUT_MS = 3600000;
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
/**
 * 「已改动文件」的唯一口径在 tools/fileChanges.cjs —— 主循环的进度检查层用的是同一份实现。
 * 这里保留同名薄封装，避免两处各写一份（此前本文件那份还会漏掉 bulk_edit 的 edits[] 路径）。
 */
function changedFiles(toolCalls) {
  return changedFilesFromToolCalls(toolCalls);
}

/**
 * 对外的任务视图（也会作为 AgentToolResult.data 回给主代理）。
 * `envelope` = 该任务完成时**一次性**建好的单一 JSON 信封（见 electron/subagentEnvelope.cjs）：
 * 哈希/产物是那一刻的真实值，之后的查询只做回放，不重算（重算会让哈希随世界变化而变化，
 * 反而毁掉「判断报告之后世界是否又变过」的用途）。
 */
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
    stageWarning: task.stageWarning || null,
    envelope: task.envelope || null,
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
    /**
     * 跨 Agent 资源租约：**必须与主代理共享同一个实例**（由 ipc 按 run 建好传进来），
     * 否则每个子代理各有一份注册表 = 谁也没锁住谁。没传进来时自己建一个（单测/独立使用场景）。
     */
    this.leases =
      o.leases ||
      new LeaseRegistry({
        // String() 兜一层：subCfg 的类型来自多处 Object.assign 的交集，字面量比较会被 tsc 判成
        // 「number 与 boolean 不可能重叠」（checkJs 实测），而这只是配置读值
        enabled: String(this.subCfg.leases) !== 'false',
        ttlMs: Number(this.subCfg.leaseTtlMs) || 120000,
      });
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
      // 这里**需要** context（拿 projectRoot 与画布模型做接收侧核验），所以用实名参数
      async (context, args) => {
        const task = this.tasks.get(String(args.taskId || ''));
        if (!task) return AgentToolResult.error('子代理任务不存在：' + String(args.taskId || ''));
        const view = taskView(task);
        /**
         * **接收侧核验**：读信封的这一刻跟当前世界对一次账（重算产物哈希 + 画布快照）。
         * 这是「不采信自述」的落点 —— 报告之后文件被改/画布被动过，只有重算才发现得了。
         * invalid（产物对不上）→ 拒收（工具结果 error + trust 降级）；stale（世界又变过）→ 交付但明确标出。
         */
        if (view.envelope) {
          const verification = subagentEnvelope.verifyEnvelope(view.envelope, {
            projectRoot: context.projectRoot(),
            model: typeof context.model === 'function' ? context.model() : null,
          });
          view.verification = verification;
          if (verification.verdict === 'invalid') {
            view.envelope = { ...view.envelope, trust: 'untrusted', verificationNote: verification.reasons.join('；') };
            context.audit(
              JSON.stringify({ kind: 'subagent_verification_failed', taskId: task.taskId, reasons: verification.reasons.slice(0, 5) })
            );
            return AgentToolResult.error(
              '该子代理结果的**接收侧核验未通过**，不得作为结论证据：\n- ' +
                verification.reasons.join('\n- ') +
                '\n如需继续用它，请先查明产物为何变化（或被改动的是你自己而不是它）。\n' +
                JSON.stringify(view),
              view
            );
          }
        }
        return AgentToolResult.ok(JSON.stringify(view), view);
      }
    );
    registry.register(
      'cancel_subagent_task',
      '取消一个**正在运行**的子代理任务（只取消这一个，不影响主 Agent 与其他子代理；已提交的写操作不会被回滚）。',
      {
        type: 'object',
        properties: { taskId: { type: 'string' }, reason: { type: 'string' } },
        required: ['taskId'],
      },
      async (context, args) => {
        const taskId = String(args.taskId || '');
        const task = this.tasks.get(taskId);
        if (!task) return AgentToolResult.error('子代理任务不存在：' + taskId);
        if (task.status !== 'running') return AgentToolResult.error('子代理任务已结束（status=' + task.status + '），无需取消');
        // 只 abort 这一个子任务自己的 controller（父信号/其他子代理不受影响）
        task.cancelRequested = true;
        task.cancelReason = String(args.reason || '主 Agent 主动取消');
        if (task.controller && !task.controller.signal.aborted) task.controller.abort();
        context.audit(JSON.stringify({ kind: 'subagent_cancel', runId: this.runId, taskId, role: task.role, reason: task.cancelReason }));
        if (this.onDelta) this.onDelta({ kind: 'subagent_state', taskId, role: task.role, status: 'cancelling', summary: task.cancelReason });
        return AgentToolResult.ok('已取消子代理任务 ' + taskId + '（' + task.role + '）', { taskId, role: task.role, status: 'cancelling' });
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
        /**
         * P5 确定性合并：把这一批信封里的「对世界声称了什么」合并成一份报告。
         * 合并只用贡献项自身的字段（资源键/内容/完成时刻/来源），**不看到达顺序** ——
         * 同一批工作无论谁先返回，digest 逐字节相同。冲突不会被默认消解（requiresArbitration）。
         */
        const envelopes = results.map((r) => r && r.data && r.data.envelope).filter(Boolean);
        const contributions = envelopes.reduce((acc, env) => acc.concat(mergeLib.contributionsFromEnvelope(env)), []);
        const merged = mergeLib.merge({ contributions });
        context.audit(
          JSON.stringify({ kind: 'subagent_batch_merged', runId: this.runId, digest: merged.digest, counts: merged.counts })
        );
        if (this.onDelta) {
          this.onDelta({ kind: 'subagent_merge', digest: merged.digest, counts: merged.counts });
        }
        return AgentToolResult.ok(
          results.map((result) => result.text).join('\n') + '\n\n' + mergeLib.renderMergeReport(merged),
          {
            results: results.map((result) => taskView(result.data)),
            merged: { digest: merged.digest, counts: merged.counts, conflicts: merged.conflicts },
          }
        );
      }
    );

    registry.register(
      'merge_subagent_results',
      '把**已完成**的子代理结果确定性合并成一份报告：同一组结果无论到达顺序如何，digest 逐字节相同。' +
        '内容一致 → agreed；有明确先后 → superseded（记清谁覆盖谁，两份都留痕）；' +
        '无法判定先后 → conflict，**不得默认取胜者** —— 用 decisions 显式裁决（只能指向该资源的候选 taskId）。',
      {
        type: 'object',
        properties: {
          taskIds: { type: 'array', items: { type: 'string' }, description: '要合并的任务 id（缺省 = 本轮所有已完成且有信封的任务）' },
          decisions: {
            type: 'array',
            items: { type: 'object' },
            description: '冲突裁决：[{resourceKey, winnerTaskId, note?}]；winnerTaskId 必须是该资源的候选来源之一',
          },
        },
      },
      async (context, args) => {
        const wanted = Array.isArray(args.taskIds) && args.taskIds.length ? args.taskIds.map(String) : null;
        const tasks = [...this.tasks.values()].filter(
          (task) => task.envelope && (!wanted || wanted.includes(task.taskId))
        );
        if (!tasks.length) {
          return AgentToolResult.error('没有可合并的子代理结果（信封只在任务完成后生成；taskIds 可能写错了）');
        }
        const contributions = tasks.reduce((acc, task) => acc.concat(mergeLib.contributionsFromEnvelope(task.envelope)), []);
        const merged = mergeLib.merge({ contributions, decisions: args.decisions });
        context.audit(
          JSON.stringify({
            kind: 'subagent_merge_requested',
            runId: this.runId,
            taskIds: tasks.map((task) => task.taskId),
            digest: merged.digest,
            counts: merged.counts,
            decidedKeys: (Array.isArray(args.decisions) ? args.decisions : []).map((d) => d && d.resourceKey),
          })
        );
        return AgentToolResult.ok(mergeLib.renderMergeReport(merged, { compact: false }), {
          merged,
          taskIds: tasks.map((task) => task.taskId),
        });
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
    // 单任务取消通道（第 6 项）：cancel_subagent_task 靠它只 abort 这一个子任务
    task.controller = controller;
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
        // 与父共享同一份租约账本（跨子代理的「单一写者」就靠它）
        leases: this.leases,
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
        if (task.cancelRequested) {
          // 第 6 项：主动取消要如实说清是「被谁取消的」，而不是统一报成「信号中断」
          task.status = 'cancelled';
          task.error = '子代理任务被主动取消：' + (task.cancelReason || '未说明原因') + '（已提交的写操作不会回滚）';
        } else {
          task.status = 'blocked';
          task.error = '子代理被取消（主 Agent 停止或信号中断）';
        }
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
      task.controller = null; // 释放取消引用（任务已结束）
    }

    task.finishedAt = new Date().toISOString();
    this.tasks.set(task.taskId, task);
    // 任务结束（成功/失败都算）→ 释放它持有的全部资源租约。
    // 释放点放在这里而不是「每次写完」：写完就放，另一个 Agent 会基于过期的读去覆盖（丢更新）。
    if (this.leases && typeof this.leases.releaseAll === 'function') {
      const released = this.leases.releaseAll(task.taskId);
      if (released > 0) {
        context.audit(JSON.stringify({ kind: 'subagent_leases_released', taskId: task.taskId, released }));
      }
    }

    const body = task.status === 'done' ? (task.summary || '（子代理未返回文本）') : (task.error || '子代理任务未完成');
    const cap = this.subCfg.resultMaxChars;
    const clipped = body.length > cap;
    const summaryText = clipped ? body.slice(0, cap) : body;
    // 单一 JSON 信封（P1）：字段齐全、带世界状态快照、产物真实哈希、截断自报 lossy。
    // 契约违约 → 下面的工具结果会是 error（**拒收**），主代理不得把它的结论当证据。
    const built = subagentEnvelope.buildEnvelope({
      task,
      projectRoot: context.projectRoot(),
      model: typeof context.model === 'function' ? context.model() : null,
      inReplyTo: task.parentToolCallId || null,
      changedFiles: changedFiles(task.toolCalls),
      summary: task.status === 'done' ? summaryText : '',
      error: task.status === 'done' ? '' : summaryText,
      clipped: clipped ? { droppedChars: body.length - cap } : null,
    });
    task.envelope = built.envelope;
    // view 必须在信封建好之后再取：view.envelope 要带上它（回放不改哈希）
    const view = taskView(task);
    const text = subagentEnvelope.renderEnvelopeText(built.envelope, built.violations);
    await this.updateStage(context, task, task.status, text.slice(0, 4000));
    context.audit(JSON.stringify({ kind: 'subagent_end', runId: this.runId, taskId: task.taskId, role, status: task.status }));
    if (this.onDelta) this.onDelta({ kind: 'subagent_state', taskId: task.taskId, role, status: task.status, summary: summaryText.slice(0, 200) });
    if (built.violations.length) {
      // 拒收：契约不完整的结果**不能**当结论用（这正是「信任放大」的闸门）
      context.audit(
        JSON.stringify({
          kind: 'subagent_envelope_rejected',
          taskId: task.taskId,
          violations: built.violations.map((v) => v.path + ': ' + v.message),
        })
      );
      return AgentToolResult.error(
        text + '\n（该结果已被契约校验**拒收**：缺字段/缺快照/无结论的结果不得作为证据。可按上面的违约项让子代理重做，或由主代理直接完成这一步。）',
        view
      );
    }
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
