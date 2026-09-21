/**
 * Agent 域通道：agent:config / greeting / tools / runs / resume-plan / resume-start / chat / stop。
 *
 * 这是最大也是状态最多的一组：agent:chat 一个 handler 就包含「配置与模型选择 → 附件校验 →
 * 断点续跑判定 → 成本/幂等/检查点装配 → 工具注册表与子代理 → 系统提示 → 工具循环 → 落盘与告警」。
 * 它此前埋在 main.cjs 的窗口逻辑后面，阅读顺序与执行顺序完全相反；搬出来后 main.cjs 只剩
 * 应用/窗口生命周期。
 *
 * 依赖约定（与 models/metrics/project 三组一致）：
 * - 无状态模块与单例（agent、toolkit、runStore、runCheckpoint、sideEffects、sandbox、costLedger、
 *   alerts、requestQueue、memory、extensions、scalars、GraphModel、bridge、context、subagents…）
 *   由本模块自己 require —— Node 的模块缓存保证与其它模块拿到同一份实例；
 * - 只有「需要 app 的东西」（userData 目录）由 register(ctx) 注入；
 * - activeRequests 是纯 Agent 域的运行时状态（并发上限、停止、恢复中断判定都读它），随本模块搬入。
 */

const fs = require('fs');
const path = require('path');

const agent = require('../agent.cjs');
const toolkit = require('../tools/toolkit.cjs');
const modelStore = require('../modelStore.cjs');
const runStore = require('../runStore.cjs');
const eventBus = require('../eventBus.cjs');
const runCheckpoint = require('../runCheckpoint.cjs');
const runRollback = require('../runRollback.cjs');
const { createSteerQueue } = require('../steerQueue.cjs');
const { SideEffectLedger, createGuard } = require('../sideEffects.cjs');
const agentState = require('../agentState.cjs');
const descriptorLib = require('../tools/descriptor.cjs');
const sandbox = require('../sandbox.cjs');
const { CostLedger } = require('../costLedger.cjs');
const { AlertDispatcher } = require('../alerts.cjs');
const { modelQueue } = require('../requestQueue.cjs');
const { RequestBudget } = require('../requestBudget.cjs');
const hooksLib = require('../hooks.cjs');
const userMemoryStore = require('../userMemory.cjs');
// 意图识别 / 授权判定（照 Codex guardian 分类器，见 electron/intent.cjs 顶部注释）
const intentLib = require('../intent.cjs');
const { parseWebSearchConfig } = require('../tools/impl/webSearchTool.cjs');

/** web_search 后端配置（每次按当前 cfg 解析；未启用 → 工具不注册、也不注入配置） */
function webSearchConfig(cfg) {
  const parsed = parseWebSearchConfig(cfg);
  if (parsed.problems.length) {
    // 配了但配错：**不静默当没配** —— 工具不注册，并把原因写进日志（否则用户会以为搜不了是模型的问题）
    try {
      console.warn('[web_search] 配置有问题，工具未启用：' + parsed.problems.join('；'));
    } catch {}
    return Object.assign({}, parsed, { enabled: false });
  }
  return parsed;
}
const attachmentSpec = require('../attachments.cjs');
const memoryStore = require('../memory.cjs');
const extensionStore = require('../tools/extensions.cjs');
const { getScalarStore } = require('../scalars/index.cjs');
const { GraphModel } = require('../tools/GraphModel.cjs');
// 跨 Agent 资源租约（P3）：**按 run 一个实例**，主代理与所有子代理共享
const { LeaseRegistry } = require('../tools/leases.cjs');

/**
 * 画布被 Agent 改过 → 世界状态版本号 +1（并把计数写回 doc.root.revision 供跨请求 round-trip）。
 * 画布变更可能走 GraphModel 的 mutator（那里面自己会 bump），也可能由 `workbench_edit` 直接改
 * `node.data`（绕过 mutator）—— 所以这里在**能力面**统一兜一次，保证「改过就 +1」。
 */
function bumpCanvasRevision(model) {
  if (model && typeof model.bumpRevision === 'function') {
    try {
      model.bumpRevision();
    } catch {
      /* 计数失败绝不影响真正的写入 */
    }
  }
}

const { AgentToolContext } = require('../tools/context.cjs');
const { makeBridge } = require('../tools/bridge.cjs');
const subagents = require('../subagents.cjs');
const { SubagentManager } = subagents;
const { atomicWriteFile } = require('../atomicFile.cjs');
const cnode = require('../cnode.cjs');
const { resolveInRoot } = require('../tools/impl/shared.cjs');
const { auditLog } = require('./project.cjs');

/** 正在运行的 Agent 请求：requestId/runId → AbortController（「停止思考」与中断恢复判定都用它） */
const activeRequests = new Map();

/**
 * 用户插话（steering）队列 —— 实现搬到 `electron/steerQueue.cjs`（独立模块，用例可直接驱动，
 * 不需要起 Electron）。此处只保留 runId → 队列的登记表。
 */
/** runId → 插话队列（随 run 生命周期创建/销毁） */
const steeringQueues = new Map();

/** 保存文档到工程文件（save_project 工具用）。 */
function saveDoc(projectRoot, projectFile, model) {
  const doc = model ? model.doc : null;
  const graph = (doc && doc.root) || { nodes: [], edges: [] };
  // 保存目标必须落在项目根内：projectFile 由渲染层传入，不能当作任意路径写入的入口。
  // 与 write_file / edit_file 共用 resolveInRoot 的边界语义（含符号链接与悬空链接处理）；
  // 越界或项目根不存在时抛错，由 save_project 工具如实报错（不再静默写出去）。
  const root = path.resolve(projectRoot || '.');
  const filePath = resolveInRoot(root, projectFile ? String(projectFile) : path.join(root, 'workflow.cnode'));
  if (!filePath) {
    throw Object.assign(
      new Error('保存目标越出项目根目录（或项目根不存在）：' + String(projectFile || path.join(root, 'workflow.cnode'))),
      { code: 'PATH_OUT_OF_ROOT' }
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, cnode.encodeCnode({ graph, workspace: {}, manifest: {} }));
  return filePath;
}

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   userDataDir: () => string,
 * }} ctx
 */
/**
 * 会话级钩子（SessionStart / SessionStop）：run 开始前与结束后各跑一条用户声明的命令。
 * fire-and-forget 语义：**不进模型上下文**（与 PostToolUse 不同），结果只落 run 事件 + 打印，
 * 失败不影响 run 的结论（否则「钩子坏了」会变成「任务失败」）。
 */
async function runSessionHook(kind, cfg, projectRoot, runId, sandboxPolicy, signal) {
  try {
    const hooksCfg = hooksLib.parseHooksConfig(cfg);
    const command = kind === 'start' ? hooksCfg.sessionStart : hooksCfg.sessionStop;
    if (!hooksCfg.enabled || !command) return null;
    const outcome = await hooksLib.runHook(
      { id: 'session_' + kind, command, tools: ['*'], on: 'always', timeoutMs: null, maxOutputChars: null },
      { projectRoot, policy: sandboxPolicy, signal, defaults: hooksCfg },
    );
    if (runId) {
      try {
        runStore.appendEvent(projectRoot, runId, kind === 'start' ? 'hook_session_start' : 'hook_session_stop', {
          command,
          ok: outcome.ok,
          skipped: !!outcome.skipped,
          exitCode: outcome.exitCode,
          timedOut: !!outcome.timedOut,
          elapsedMs: outcome.elapsedMs,
          reason: outcome.reason || null,
          output: String(outcome.output || '').slice(0, 2000),
        });
      } catch {}
    }
    return outcome;
  } catch (error) {
    // 钩子本身出错绝不能让 run 挂掉（如实记一条即可）
    try {
      if (runId) runStore.appendEvent(projectRoot, runId, 'hook_session_error', { kind, error: String((error && error.message) || error) });
    } catch {}
    return null;
  }
}

function register(ctx) {
  const { ipcMain, userDataDir } = ctx;

  ipcMain.handle('agent:config', async (_event, projectRoot) => {
    const cfg = agent.loadConfig(projectRoot);
    const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
    const store = modelStore.getModels(userDataDir(), cfg);
    return {
      configured: !!cfg.apiKey,
      model: cfg.model,
      soul,
      toolsEnabled: cfg.tools.toolsEnabled,
      ragEnabled: cfg.rag.enabled,
      models: modelStore.toPublicModels(store.models),
      activeModelId: store.activeId,
    };
  });

  ipcMain.handle('agent:greeting', async (_event, projectRoot) => {
    const cfg = agent.loadConfig(projectRoot);
    const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
    return { greeting: soul.greeting, name: soul.name, configured: !!cfg.apiKey };
  });

  ipcMain.handle('agent:tools', async (_event, projectRoot) => {
    const cfg = agent.loadConfig(projectRoot);
    const registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot, webSearchEnabled: webSearchConfig(cfg).enabled });
    const subagentManager = new SubagentManager({ agent, toolkit, cfg, registry });
    subagentManager.register(registry);
    toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot, webSearchEnabled: webSearchConfig(cfg).enabled });
    return {
      enabled: cfg.tools.toolsEnabled,
      tools: registry.listTools().map((spec) => ({
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
        // 契约摘要：只读/幂等/是否改工作区/要不要确认/需要的能力/超时/缓存与并行策略
        descriptor: registry.descriptorOf(spec.name)
          ? descriptorLib.describeDescriptor(registry.descriptorOf(spec.name))
          : null,
      })),
    };
  });

  ipcMain.handle('agent:runs', async (_event, projectRoot) => {
    if (!projectRoot) return [];
    runStore.recoverInterrupted(projectRoot, new Set(activeRequests.keys()));
    return runStore.listRuns(projectRoot, 50);
  });

  // S8：按 run 回放统一事件流（UI 的「运行回放」区块直接用这个载荷）
  ipcMain.handle('agent:events', async (_event, projectRoot, options) => {
    if (!projectRoot) {
      return { ok: false, error: '未选择项目', file: null, total: 0, runs: [], events: [], summary: null };
    }
    try {
      return eventBus.replayPayload(projectRoot, options || {});
    } catch (error) {
      return {
        ok: false,
        error: String((error && error.message) || error),
        file: null,
        total: 0,
        runs: [],
        events: [],
        summary: null,
      };
    }
  });

  ipcMain.handle('agent:resume-plan', async (_event, projectRoot, runId) => {
    if (!projectRoot) return { ok: false, error: '未选择项目' };
    // 带幂等账本的续跑计划：能区分「已完成但没来得及提交」与「结果未知」，避免盲目重放副作用
    const ledger = new SideEffectLedger({ projectRoot, scopeRunId: runId });
    return runCheckpoint.planResume(projectRoot, runId, { activeIds: new Set(activeRequests.keys()), ledger });
  });

  ipcMain.handle('agent:resume-start', async (_event, projectRoot, runId, replacementRunId) => {
    if (!projectRoot) return { ok: false, error: '未选择项目' };
    return runStore.markRetry(projectRoot, runId, replacementRunId);
  });

  // Run 级文件回滚（§4.2）：先给**只读计划**，用户看过再执行。计划里逐项写明
  // restore / delete / skip 与原因（前像缺失、过大、别人改过），不猜、不静默。
  ipcMain.handle('agent:rollback-plan', async (_event, projectRoot, runId) => {
    if (!projectRoot) return { ok: false, error: '未选择项目' };
    if (!runId) return { ok: false, error: '缺少 runId' };
    return runRollback.planRollback(projectRoot, runId);
  });

  ipcMain.handle('agent:rollback-apply', async (_event, projectRoot, runId, options) => {
    if (!projectRoot) return { ok: false, error: '未选择项目' };
    if (!runId) return { ok: false, error: '缺少 runId' };
    // force 只影响「本 Run 之后该文件被外部改过」的项：默认拒绝覆盖，UI 需显式勾选才传 true。
    const report = runRollback.applyRollback(projectRoot, runId, {
      force: !!(options && options.force),
      audit: (kind, payload) => auditLog(projectRoot, { kind, ...payload }),
    });
    return report;
  });

  // 用户插话（§4.2）：运行中的 run 可以边跑边纠偏。找不到 run（已结束/不存在）→ 明确拒绝，
  // 让界面能如实提示「这条没插上」，而不是发出去了却没有任何效果。
  ipcMain.handle('agent:steer', async (_event, requestId, text) => {
    if (!requestId) return { accepted: false, reason: 'missing-request', error: '缺少 requestId' };
    const key = activeRequests.has(requestId) ? requestId : runStore.normalizeRunId(requestId);
    const queueEntry = steeringQueues.get(requestId) || steeringQueues.get(key);
    if (!queueEntry) {
      return {
        accepted: false,
        reason: steeringQueues.size ? 'run-not-found' : 'no-active-run',
        error: '该运行已结束或不存在，插话未生效（可在下一轮对话里直接说）',
      };
    }
    const result = queueEntry.queue.push(text);
    if (result.accepted) {
      // 留痕：插话是用户对运行中任务的干预，事后复盘要能看到「什么时候插了什么」
      try {
        runStore.appendEvent(queueEntry.projectRoot, key, 'steer_queued', { chars: String(text || '').length });
      } catch {
        /* 事件只是留痕，失败不影响插话本身 */
      }
    }
    return result;
  });

  // 子代理任务视图（§4.2）：跨 run 可查 —— 此前只有进程内 Map，请求一结束就查不到了
  ipcMain.handle('agent:subagents', async (_event, projectRoot, options) => {
    if (!projectRoot) return { ok: false, error: '未选择项目', runs: [] };
    return subagents.listTaskViews(projectRoot, options || {});
  });

  ipcMain.handle('agent:chat', async (event, payload) => {
    const { projectRoot, prompt, history, canvasSummary, nodeId, requestId, document, projectFile, modelId, model: reqModel, reasoningEffort: reqEffort, resumeRunId, resumeForce, attachments, forceCompact } = payload || {};
    const sender = event.sender;
    let runId = null;
    /** SessionStop 钩子需要的上下文：run 过程中可能抛异常，catch 里也要能补跑一次（保持外层可见） */
    /** @type {{cfg: any, sandboxPolicy: any, runId: string|null, projectRoot: string|null}|null} */
    let hookSessionCtx = null;
    const sendDelta = (d) => {
      if (!sender.isDestroyed()) sender.send('agent:delta', { requestId, ...d });
    };
    try {
      const cfg = agent.loadConfig(projectRoot);
      // 执行隔离策略：工具子进程 / 扩展 / 项目命令统一生效（strict 模式下能力不足会拒绝执行）
      const sandboxPolicy = sandbox.resolvePolicy(cfg.sandbox, { projectRoot, userDataDir: userDataDir() });
      sandbox.setDefaultPolicy(sandboxPolicy);
      const maxConcurrentRuns = Number(cfg.limits && cfg.limits.maxConcurrentRuns) || 2;
      cfg.requestBudget = new RequestBudget(cfg.limits.maxTotalTokens);
      if (requestId && activeRequests.has(requestId)) return { ok: false, error: '重复的 Agent requestId' };
      if (activeRequests.size >= maxConcurrentRuns) return { ok: false, error: '当前 Agent 正在执行其他任务，请稍后再试（并发上限 ' + maxConcurrentRuns + '）' };
      // 优先按 modelId 从 models.json 读取该模型的接入配置（apiBase/apiKey/model）
      const baseCfg = agent.loadConfig(null);
      const sel = modelId ? modelStore.findModel(userDataDir(), baseCfg, modelId) : null;
      if (sel) {
        if (sel.apiBase) cfg.apiBase = sel.apiBase;
        if (sel.apiKey) cfg.apiKey = sel.apiKey;
        if (sel.model) cfg.model = sel.model;
        // 上下文窗口来自模型管理（models.json）：上下文压缩的触发线 = 窗口 × agent.compact.ratio
        // （Codex 口径）。取不到时留给 agent.compact.fallback_window。
        cfg.contextWindow = Number(sel.contextWindow) > 0 ? Number(sel.contextWindow) : 0;
      } else if (reqModel) {
        cfg.model = reqModel;
      }
      if (reqEffort) cfg.reasoningEffort = reqEffort;
      if (!cfg.apiKey) {
        return { ok: false, error: '未配置 API Key（模型管理中填写或 config/agent.properties）' };
      }
      // 图片附件需要模型具备视觉能力：不支持的模型直接给出明确提示，
      // 而不是把图发过去让模型自己说「无法识别图片」。
      const normalizedAttachments = attachmentSpec.normalizeAttachments(attachments);
      if (!normalizedAttachments.ok) {
        return { ok: false, error: normalizedAttachments.error };
      }
      if (normalizedAttachments.attachments.length > 0 && sel && sel.vision !== true) {
        return {
          ok: false,
          error: `当前模型「${sel.label || sel.model}」未开启视觉能力，无法接收图片；请在模型管理中开启「视觉（图片输入）」或切换到支持视觉的模型`,
        };
      }
      runId = runStore.normalizeRunId(requestId || 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
      runStore.recoverInterrupted(projectRoot, new Set(activeRequests.keys()));

      // ---- 断点续跑：先判定可续跑级别（auto / review），review 需要用户显式复核 ----
      let resumePlan = null;
      let resumeScope = runId;
      if (resumeRunId) {
        const originalId = runStore.normalizeRunId(resumeRunId);
        const originalLedger = new SideEffectLedger({ projectRoot, scopeRunId: originalId });
        resumePlan = runCheckpoint.planResume(projectRoot, originalId, {
          activeIds: new Set(activeRequests.keys()),
          ledger: originalLedger,
        });
        if (!resumePlan.ok) return { ok: false, error: resumePlan.error || '无法生成续跑计划' };
        if (resumePlan.mode === 'complete') return { ok: false, error: '该 Run 无需续跑：' + (resumePlan.reason || '') };
        if (resumePlan.requiresReview && resumeForce !== true) {
          return { ok: false, needsReview: true, plan: resumePlan };
        }
        // 幂等作用域沿用原 Run：这样中断前已提交的写操作在本次续跑里会被识别并跳过
        resumeScope = originalId;
      }

      // ---- 成本账本 + 副作用幂等账本 + 检查点写入器 ----
      const costLedger = new CostLedger({ projectRoot, runId, prices: cfg.costPrices });
      cfg.costLedger = costLedger;
      cfg.costRunId = runId;
      const sideEffectLedger = new SideEffectLedger({ projectRoot, scopeRunId: resumeScope });
      const sideEffectGuard = createGuard(sideEffectLedger);
      const checkpointSink = (type, payload) => {
        if (!projectRoot) return null;
        if (type === 'messages') return runCheckpoint.saveMessages(projectRoot, runId, payload && payload.messages, { reason: payload && payload.reason });
        if (type === 'tool_intent') return runCheckpoint.recordIntent(projectRoot, runId, payload || {});
        if (type === 'tool_commit') return runCheckpoint.recordCommit(projectRoot, runId, payload || {});
        return null;
      };
      const alertDispatcher = new AlertDispatcher({
        projectRoot,
        thresholds: cfg.alertThresholds,
        webhook: cfg.alertWebhook || null,
        onAlert: (alert) => sendDelta({ kind: 'alert', alert }),
      });

      hookSessionCtx = { cfg, sandboxPolicy, runId, projectRoot };
      // SessionStart 钩子：在 run 开始前跑（用户可用它拉依赖、起服务；失败不阻断 run）
      // 注意：此刻 controller 还没创建（它在稍后的并发登记处才建），SessionStart 只受自身超时约束
      await runSessionHook('start', cfg, projectRoot, runId, sandboxPolicy, null);
      runStore.startRun(projectRoot, runId, {
        prompt: String((resumePlan && resumePlan.prompt) || prompt || '').slice(0, 4000),
        model: cfg.model,
        nodeId: nodeId || null,
        resumedFrom: resumePlan ? resumePlan.runId : null,
        sandbox: sandbox.describe(sandboxPolicy),
      });
      const onAgentDelta = (delta) => {
        sendDelta(delta);
        if (!delta || !delta.kind) return;
        if (delta.kind === 'tool_result' && Array.isArray(delta.toolCalls)) {
          runStore.appendEvent(projectRoot, runId, 'tool_result', {
            tools: delta.toolCalls.map((item) => ({ name: item && item.name, ok: item && item.ok, elapsedMs: item && item.elapsedMs })),
          });
        } else if (delta.kind === 'state') {
          // 状态机迁移落成 run 事件：UI / 续跑 / 审计都能看到「等工具 / 等用户 / 达上限」，
          // 而不是只有一个笼统的 running
          runStore.appendEvent(projectRoot, runId, 'run_state', {
            state: delta.state,
            previous: delta.previous || null,
            reason: delta.reason || null,
          });
        } else if (delta.kind === 'subagent_state') {
          // S9：子代理的起止/状态也落 run 事件 —— 此前 run 记录里完全看不到子代理发生过什么，
          // 应用关掉后只剩画布 stage 节点上的那段摘要。
          runStore.appendEvent(projectRoot, runId, 'subagent_state', {
            taskId: delta.taskId || null,
            role: delta.role || null,
            status: delta.status || null,
          });
        } else if (delta.kind === 'subagent_merge') {
          // P5 确定性合并：把指纹与统计落进 run 事件 —— 事后能核对「这一批结果合并成了什么」，
          // 尤其是有冲突待裁决时（冲突不得被静默消化，run 记录是留痕的一处）
          runStore.appendEvent(projectRoot, runId, 'subagent_merge', {
            digest: delta.digest || null,
            counts: delta.counts || null,
          });
        } else if (delta.kind === 'content_reset') {
          // 流中途断线 → 整轮重发，已流出的半截作废。落进 run 事件，事后能看出
          // 「这次回答为什么先出了一段又重来」。
          runStore.appendEvent(projectRoot, runId, 'content_reset', {
            attempt: delta.attempt || null,
            maxAttempts: delta.maxAttempts || null,
            reason: delta.reason || null,
          });
        } else if (delta.kind === 'truncated') {
          // 回答触到 max_tokens 被截断（正在接着写 / 已用尽补问次数）：这是「回答看起来写一半就停」
          // 的第一现场，必须留痕，否则只能靠猜。
          runStore.appendEvent(projectRoot, runId, 'truncated', {
            count: delta.count || 0,
            max: delta.max || 0,
            continuing: !!delta.continuing,
            finishReason: delta.finishReason || null,
          });
        } else if (delta.kind === 'compacted') {
          // 上下文压缩（照 Codex CLI）：run 记录里留下「窗口号 + 前后 token + 保留了几轮人的话」——
          // 这是事后判断「答案为什么对早期细节记忆变模糊 / 为什么少了一次模型调用」的唯一线索。
          runStore.appendEvent(projectRoot, runId, 'compacted', {
            ok: delta.ok !== false,
            windowNumber: delta.windowNumber || null,
            tokensBefore: delta.tokensBefore || 0,
            tokensAfter: delta.tokensAfter || 0,
            keptUserTurns: delta.keptUserTurns || 0,
            trigger: delta.trigger || null,
            summaryChars: delta.summaryChars || 0,
            reason: delta.reason || null,
          });
        } else if (delta.kind === 'compaction') {
          runStore.appendEvent(projectRoot, runId, 'compaction_start', {
            tokens: delta.tokens || 0,
            limit: delta.limit || 0,
            window: delta.window || 0,
            trigger: delta.trigger || null,
          });
        } else if (delta.kind === 'context_overflow') {
          // 超窗（预检拦住 / 供应商真拒了后自救）：这是「回答写一半就断」的最后一类现场，
          // 必须能在 run 记录里查到「当时估算多少 token、窗口按多少算的」。
          runStore.appendEvent(projectRoot, runId, delta.phase === 'recovering' ? 'context_overflow_recovering' : 'context_overflow', {
            phase: delta.phase || null,
            tokens: delta.tokens || 0,
            reserve: delta.reserve || 0,
            window: delta.window || 0,
            status: delta.status || null,
            providerMessage: delta.providerMessage || null,
          });
        } else if (delta.kind === 'max_tokens_capped') {
          // 上下文挤掉输出预算 → 本轮输出上限临时收缩（用户会看到回答变短，原因要留痕）
          runStore.appendEvent(projectRoot, runId, 'max_tokens_capped', {
            from: delta.from || 0,
            to: delta.to || 0,
            tokens: delta.tokens || 0,
            window: delta.window || 0,
          });
        } else if (['start', 'error', 'stopped', 'done'].includes(delta.kind)) {
          runStore.appendEvent(projectRoot, runId, delta.kind, { error: delta.error || null, state: delta.state || null });
        }
      };
      const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));

      // 先装配工具注册表：用于系统提示中的工具引导，也用于工具循环
      let registry = null;
      /** @type {any} 本次 run 的资源租约账本（P3）；run 收尾时释放主代理持有的全部租约 */
      let leases = null;
      if (cfg.tools.toolsEnabled) {
        // 资源租约账本：一次 run 一份（主代理 + 它的所有子代理共享同一个实例，否则锁不住）
        leases = new LeaseRegistry({
          enabled: (cfg.subagent && cfg.subagent.leases) !== false,
          ttlMs: (cfg.subagent && cfg.subagent.leaseTtlMs) || 120000,
        });
        registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot, leases, webSearchEnabled: webSearchConfig(cfg).enabled });
      }
      let subagentManager = null;
      if (registry) {
        subagentManager = new SubagentManager({
          leases,
          agent,
          toolkit,
          cfg,
          registry,
          runId,
          onDelta: onAgentDelta,
        });
        subagentManager.register(registry);
        toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot, webSearchEnabled: webSearchConfig(cfg).enabled });
      }
      const toolGuide = agent.buildToolGuide(registry ? registry.listTools() : []);
      const memory = projectRoot ? memoryStore.readMemory(projectRoot) : { entries: [] };
      // 第 5 项：注入按当前提问检索（key/tags/content 打分，均无命中才退回最近的记忆），
      // 不再是 entries.slice(-30) 的纯时间切片。
      const memoryText = memoryStore.buildMemoryText(memory.entries, prompt, { limit: 30 });
      // 用户级（跨项目）记忆：与项目记忆同口径（按提问打分），但**分开注入**成独立段落
      const userMemoryText = userMemoryStore.buildUserMemoryText(prompt, { limit: 20 });
      const skills = projectRoot ? extensionStore.readManifest(projectRoot).filter((item) => String(item.kind || '').toLowerCase() === 'skills') : [];
      /**
       * 渐进披露（对照 Claude Code 的 Agent Skills）：prompt 里**只放索引**（名字 + 一句话），
       * 正文等模型真需要时用 `read_skill` 去读。此前是把 instructions 整段常驻注入 ——
       * 无论本次任务用不用得上都在付固定开销（每轮都发）。
       */
      // 索引由纯函数生成（可判据直锁）：prompt 只放名字 + 一句话，正文走 read_skill
      const skillsText = agent.buildSkillsIndex(skills);
      // ③ 提示词分层：画布建模规则只在「与画布有关」时注入（画布非空 / 提问含画布词 / 配置强制）。
      // 判定在 agent.resolvePromptLayers 里（纯函数，用例锁）；这里只负责把当轮事实传进去。
      /**
       * 执行控制器 + 并发登记**提前到这里**：意图识别的分类请求也要能随「停止」取消。
       *
       * 此前 controller 在工具装配处才建（下面 `---- 装配工具 ----`）、`activeRequests` 在
       * `sendDelta('start')` 之后才登记 —— 而分类发生在两者之前，于是**分类期间用户点停止是无效的**
       * （真机实测单次分类 0.9~3.7s，超时上限 8s；用户会看到「点了没反应」）。
       * 声明上移后，`agent:stop` 按 requestId/runId 找到同一个 controller 直接 abort，分类请求被取消 →
       * 分类器把它当作「没有信号」（`unavailable`），随即回到原来的路径，不阻断也不收紧。
       */
      const controller = new AbortController();
      activeRequests.set(runId, controller);

      /**
       * ---- 意图识别（照 Codex guardian 分类器；见 electron/intent.cjs 顶部注释）----
       *
       * 为什么在这：它的 `routeHint` 决定**这一轮注入哪层提示词**，所以必须赶在 buildSystemPrompt 之前拿到。
       * 三条不变量（intent.cjs）：只收紧不放宽 / 无信号 = 与没有这个功能逐字节一致 / 判定全是纯函数。
       * 分类失败、超时、没接线都**不阻断 run** —— 最坏情况只是回到原来的关键词快判。
       * 续跑（resumePlan）不分类：那轮的提示词层要沿原 run 的上下文，不该被新判定改写。
       */
      let intentPolicy = null;
      if (!resumePlan) {
        try {
          const intentCfg = cfg.intent || {};
          // 「这一轮要不要分类」是纯函数（intentLib.shouldClassify，用例直接锁它）：
          //   never 永不 / always 每轮 / auto 只在画布为空时（提示词层唯一可能误判的那个分支）。
          if (intentLib.shouldClassify(intentCfg, canvasSummary)) {
            const classifier = intentLib.createIntentClassifier({
              cfg: intentCfg,
              // 取消信号由分类器**透传**给 callModel（见 intent.cjs 的接口注释）：
              // 分类请求要能随「停止」立刻中断，且「已取消」时连请求都不发起
              signal: controller.signal,
              // 走主通道（modelQueue + requestBudget + 重试 + 成本账本），不另开一条绕过预算的路
              callModel: async ({ messages: classifierMessages, model, maxTokens, timeoutMs, signal }) => {
                const callCfg = Object.assign({}, cfg, { maxTokens: maxTokens || cfg.maxTokens });
                if (model) callCfg.model = model;
                const startedAt = Date.now();
                // signal 来自分类器透传（不是这里闭包捕获）：接口显式，用例注入假 signal 即可锁这一跳
                const res = await agent.chatCompletion(callCfg, classifierMessages, { timeoutMs, signal });
                // 记账口径与 compaction 一致：chatCompletion 自己不入账，由**调用方按用途**记账
                // （kind='intent'，所以「意图识别花了多少」在成本面板里单独可查，不混进主对话）
                agent.recordCost(cfg, {
                  kind: 'intent',
                  model: callCfg.model,
                  usage: res && res.usage,
                  latencyMs: Date.now() - startedAt,
                  runId: cfg.costRunId,
                });
                return (res && res.content) || '';
              },
              trace: (event, data) => runStore.appendEvent(projectRoot, runId, event, Object.assign({ traceKind: 'intent' }, data || {})),
            });
            const verdict = await classifier.classify({
              prompt,
              history: history || [],
              canvasSummary,
              projectNotes: soul.raw,
            });
            intentPolicy = intentLib.createIntentPolicy(verdict);
            runStore.appendEvent(projectRoot, runId, 'intent', {
              intent: verdict.intent,
              risk: verdict.risk,
              authorization: verdict.authorization,
              confidence: verdict.confidence,
              source: verdict.source,
              routeHint: intentPolicy.routeHint,
              tighten: intentPolicy.tighten,
              signals: intentPolicy.signals,
              reason: verdict.reason,
              classifyCalls: classifier.stats().calls,
            });
            sendDelta({
              kind: 'intent',
              runId,
              intent: verdict.intent,
              risk: verdict.risk,
              authorization: verdict.authorization,
              confidence: verdict.confidence,
              source: verdict.source,
              routeHint: intentPolicy.routeHint,
              tighten: intentPolicy.tighten,
              // 判据摘要（截断）：界面用它做 tooltip —— 用户要能看到「凭什么这么判」
              reason: String(verdict.reason || '').slice(0, 120),
            });
          }
        } catch (error) {
          // 意图识别永远不能成为 run 的故障点：出错即「没有信号」（既不收紧也不放宽）
          intentPolicy = null;
          try {
            runStore.appendEvent(projectRoot, runId, 'intent', {
              source: 'unavailable',
              reason: 'classify-threw:' + String((error && error.message) || error),
            });
          } catch {}
        }
      }
      const systemContent = agent.buildSystemPrompt(soul, canvasSummary, toolGuide, memoryText, skillsText, {
        prompt,
        canvasMode: cfg.prompt && cfg.prompt.canvasRules,
        userMemoryText,
        // 意图识别的提示词路由信号（只在「本来会省画布层」时把层救回来；null = 不改变既有判定）
        intentHint: intentPolicy ? intentPolicy.routeHint : null,
      });
      const messages = resumePlan
        ? runCheckpoint.buildResumeMessages(resumePlan, { systemPrompt: systemContent })
        : [{ role: 'system', content: systemContent }];
      if (!resumePlan) {
        for (const m of history || []) {
          if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
        }
        // 图片附件 → OpenAI 兼容的多模态 user 消息（无图时保持纯文本，行为不变）
        messages.push(attachmentSpec.buildUserMessage(prompt, normalizedAttachments.attachments));
      } else if (!messages.length) {
        messages.push({ role: 'system', content: systemContent });
      }
      agent.logConversation(projectRoot, {
        ts: new Date().toISOString(),
        role: 'user',
        content: prompt,
        nodeId: nodeId || null,
      });

      // ---- 装配工具 ----
      let tools = null;
      let model = null;
      let bridge = null;
      let dirty = false;
      // 注意：`controller` 与 `activeRequests` 登记已在**意图识别段之前**创建/登记
      // （这样分类请求也能随「停止」取消，见那里的注释）；这里不再重复声明。
      if (registry && registry.listTools().length > 0) {
        bridge = makeBridge(sender, controller.signal, { projectRoot });
        model = new GraphModel(document || undefined);
        const scalarStore = cfg.scalars && cfg.scalars.enabled !== false && projectRoot ? getScalarStore(projectRoot) : null;
        const undoStack = [];
        const redoStack = [];
        const context = new AgentToolContext({
          projectRoot,
          model,
          runId: requestId || '',
          role: 'supervisor',
          signal: controller.signal,
          scalarStore,
          // 文件遍历类工具（scan_project / find_files / search_files）走 worker 线程：
          // 同步遍历会把主进程卡住，且单次同步 fs 调用不可中断（tools.fs_worker 可关）
          fsWorker: cfg.tools ? cfg.tools.toolsFsWorker !== false : true,
          // 注意：这里必须传策略对象本身。曾写成 `sandbox: () => sandboxPolicy`，而 context.sandbox()
          // 会把注入值原样返回 → currentPolicy() 拿到函数、mode/capabilities 全为 undefined →
          // 隔离静默降级（Windows 的 Job Object 限额不生效；macOS/Linux 退化成无隔离 spawn；strict 不再 fail-closed）。
          sandbox: sandboxPolicy,
          sideEffectGuard,
          checkpoint: checkpointSink,
          // 意图识别的审批门禁（**只收紧**）：高风险/授权 unknown/低置信 → 命中的免打扰规则也失效
          intentPolicy,
          // web_search 后端配置：未启用时工具已被卸载，这里是「配了才用得上」的那份配置
          webSearchConfig: webSearchConfig(cfg),
          confirm: (level, what, detail) => bridge.confirm(level, what, detail),
          askUser: (question, options) => bridge.askUser(question, options),
          ui: (action, args) => bridge.ui(action, args),
          audit: (entry) => {
            auditLog(projectRoot, entry);
            runStore.appendEvent(projectRoot, runId, 'audit', { entry: String(entry || '').slice(0, 2000) });
          },
          mutateWorkbench: async (fn) => {
            undoStack.push(JSON.parse(JSON.stringify(model.doc)));
            if (redoStack.length) redoStack.length = 0;
            fn(model);
            bumpCanvasRevision(model);
            dirty = true;
            return true;
          },
          undo: async () => {
            if (undoStack.length) {
              redoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(undoStack.pop()));
              // 撤销也是一次世界状态变更：版本号必须**继续递增**（从快照恢复会带回旧版本号，
              // 那样「报告之后世界变过没有」就判不出来了）
              bumpCanvasRevision(model);
              dirty = true;
            }
          },
          redo: async () => {
            if (redoStack.length) {
              undoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(redoStack.pop()));
              bumpCanvasRevision(model);
              dirty = true;
            }
          },
          saveProject: async () => {
            const saved = saveDoc(projectRoot, projectFile, model);
            sendDelta({ kind: 'saved', filePath: saved });
            return saved;
          },
          conversationHistory: () =>
            messages.filter((m) => m.role !== 'system').slice(-20).map((m) => ({ role: m.role, content: m.content })),
          notifyFileChange: (rel, kind, detail) => {
            require('../rag/index.cjs').invalidateProjectIndex(projectRoot, rel);
            sendDelta({ kind: 'file_change', fileChange: { path: rel, kind, detail } });
          },
          ragConfig: cfg.rag,
        });
        tools = { registry, context };
      }

      sendDelta({ kind: 'start' });
      // 用户插话（§4.2）：运行中的 run 有一条插话队列，agent:steer 按 runId 找到它。
      // 队列随 run 生命周期存在 —— run 结束后再插话会被拒绝（不能静默丢弃）。
      const steerQueue = createSteerQueue();
      steeringQueues.set(runId, { queue: steerQueue, projectRoot });
      // （`activeRequests.set(runId, controller)` 已提前到意图识别段之前：分类请求也要能取消）
      let result;
      try {
        result = await agent.runAgentChat({
          cfg,
          messages,
          onDelta: onAgentDelta,
          tools,
          signal: controller.signal,
          // /compact（照 Codex 的手动压缩命令）：无视阈值立刻压一次
          forceCompaction: forceCompact === true,
          // 主循环每轮 drain 一次；插话作为 user 消息进请求体（见 agent.cjs 的注入点注释）
          steering: steerQueue,
        });
      } finally {
        steerQueue.close();
        steeringQueues.delete(runId);
        // run 收尾：释放主代理持有的全部资源租约（子代理的在各自任务结束时已释放）
        if (leases) {
          try {
            const released = leases.releaseAll('supervisor');
            if (released > 0) runStore.appendEvent(projectRoot, runId, 'leases_released', { released, holder: 'supervisor' });
          } catch {
            /* 释放失败不影响 run 结果（TTL 会兜底） */
          }
        }
        activeRequests.delete(runId);
        if (bridge) bridge.cleanup();
      }
      agent.logConversation(projectRoot, {
        ts: new Date().toISOString(),
        role: 'assistant',
        content: result.content,
        reasoning: result.reasoning || null,
        toolCalls: result.toolCalls || null,
        usage: result.usage || null,
        grounding: result.grounding || null,
      });
      // 终态由状态机给出（LIMIT_REACHED 与真正的 FAILED 分开记在 state 字段里）；
      // status 取值保持既有语义不变（UI 与续跑判定按它过滤），避免影响既有读取路径
      const terminalState = result.state || null;
      const runStatus = terminalState
        ? agentState.toRunStatus(terminalState)
        : result.error ? 'error' : result.aborted ? 'cancelled' : 'completed';
      runStore.finishRun(projectRoot, runId, runStatus, {
        state: terminalState,
        stopReason: result.stopReason || null,
        toolCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
        usage: result.usage || null,
        grounding: result.grounding || null,
        error: result.error || null,
        streamRestarts: result.streamRestarts || 0,
      });
      // SessionStop 钩子：run 结束后跑（输出只进 run 事件，不进模型上下文）
      await runSessionHook('stop', cfg, projectRoot, runId, sandboxPolicy, controller.signal);
      // 续跑成功 → 原 Run 标记为已被取代，避免重复出现在「中断」列表里
      if (resumePlan) {
        try { runStore.markRetry(projectRoot, resumePlan.runId, runId); } catch {}
      }
      // 告警评估：成本 / 失败率 / 队列 / 隔离降级（失败不影响主流程）
      try {
        await alertDispatcher.check({
          ...costLedger.snapshot(modelQueue.stats()),
          degradedSandbox: sandboxPolicy.degraded.length > 0,
          degradedReason: sandboxPolicy.degraded.join('/'),
        });
      } catch {}
      sendDelta({ kind: 'done' });
      const out = {
        ok: !result.error,
        reply: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
        usage: result.usage,
        grounding: result.grounding,
      };
      out.cost = costLedger.summary(runId);
      out.alerts = alertDispatcher.recent(5);
      out.sandbox = { mode: sandboxPolicy.mode, backend: sandbox.capabilities().backend, degraded: sandboxPolicy.degraded };
      if (resumePlan) out.resumedFrom = resumePlan.runId;
      if (result.aborted) out.aborted = true;
      if (result.error) out.error = result.error;
      // 交付形态要如实传给界面：被长度上限截断 / 中途重发过，用户有权知道
      out.stopReason = result.stopReason || null;
      out.streamRestarts = result.streamRestarts || 0;
      // 第 2 项：上限中止时带上结构化收尾（界面据此把阶段性结果交付给用户，而不是只弹一个报错），
      // 并让「续跑」入口能认出这类 Run（status 仍是 error，靠 state 区分）。
      if (result.wrapUp) {
        out.wrapUp = result.wrapUp;
        out.limitReached = true;
      }
      // 第 1 项：上下文裁剪次数（0 表示这一次运行没有触发预算裁剪）
      out.contextTrims = Number(result.contextTrims) || 0;
      out.contextTrimmedChars = Number(result.contextTrimmedChars) || 0;
      // 上下文压缩（照 Codex）：次数 + 最后一次的交接摘要。
      // 界面据此把压缩前的消息折叠掉（下次请求只送摘要 + 之后的新消息），
      // 否则每个新回合都会把整段旧历史再发一遍 —— 刚压完又立刻超线，白烧一次压缩调用。
      out.compacted = Number(result.compacted) || 0;
      out.overflowRecoveries = Number(result.overflowRecoveries) || 0;
      if (result.contextSummary) out.contextSummary = String(result.contextSummary);
      if (result.contextSummaryEnvelope) out.contextSummaryEnvelope = String(result.contextSummaryEnvelope);
      if (dirty && model) out.document = model.doc;
      if (bridge) bridge.cleanup();
      return out;
    } catch (e) {
      if (runId) runStore.finishRun(projectRoot, runId, 'error', { state: 'FAILED', error: String((e && e.message) || e) });
      // MCP 会话在 run 结束时统一关闭：会话复用是本轮的优化，但**不能**留下孤儿 server 进程
      try {
        require('../tools/mcpClient.cjs').closeAll();
      } catch {}
      if (hookSessionCtx) {
        await runSessionHook('stop', hookSessionCtx.cfg, hookSessionCtx.projectRoot, hookSessionCtx.runId, hookSessionCtx.sandboxPolicy, null);
      }
      sendDelta({ kind: 'error', error: String((e && e.message) || e) });
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('agent:stop', (_event, requestId) => {
    const controller = requestId ? (activeRequests.get(requestId) || activeRequests.get(runStore.normalizeRunId(requestId))) : null;
    if (controller) controller.abort();
    return { ok: true };
  });
}

module.exports = { register, activeRequests, saveDoc };
