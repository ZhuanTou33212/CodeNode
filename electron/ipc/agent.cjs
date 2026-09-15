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
const runCheckpoint = require('../runCheckpoint.cjs');
const { SideEffectLedger, createGuard } = require('../sideEffects.cjs');
const agentState = require('../agentState.cjs');
const sandbox = require('../sandbox.cjs');
const { CostLedger } = require('../costLedger.cjs');
const { AlertDispatcher } = require('../alerts.cjs');
const { modelQueue } = require('../requestQueue.cjs');
const { RequestBudget } = require('../requestBudget.cjs');
const attachmentSpec = require('../attachments.cjs');
const memoryStore = require('../memory.cjs');
const extensionStore = require('../tools/extensions.cjs');
const { getScalarStore } = require('../scalars/index.cjs');
const { GraphModel } = require('../tools/GraphModel.cjs');
const { AgentToolContext } = require('../tools/context.cjs');
const { makeBridge } = require('../tools/bridge.cjs');
const { SubagentManager } = require('../subagents.cjs');
const { atomicWriteFile } = require('../atomicFile.cjs');
const cnode = require('../cnode.cjs');
const { resolveInRoot } = require('../tools/impl/shared.cjs');
const { auditLog } = require('./project.cjs');

/** 正在运行的 Agent 请求：requestId/runId → AbortController（「停止思考」与中断恢复判定都用它） */
const activeRequests = new Map();

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
    const registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot });
    const subagentManager = new SubagentManager({ agent, toolkit, cfg, registry });
    subagentManager.register(registry);
    toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot });
    return {
      enabled: cfg.tools.toolsEnabled,
      tools: registry.listTools().map((spec) => ({
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
      })),
    };
  });

  ipcMain.handle('agent:runs', async (_event, projectRoot) => {
    if (!projectRoot) return [];
    runStore.recoverInterrupted(projectRoot, new Set(activeRequests.keys()));
    return runStore.listRuns(projectRoot, 50);
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

  ipcMain.handle('agent:chat', async (event, payload) => {
    const { projectRoot, prompt, history, canvasSummary, nodeId, requestId, document, projectFile, modelId, model: reqModel, reasoningEffort: reqEffort, resumeRunId, resumeForce, attachments } = payload || {};
    const sender = event.sender;
    let runId = null;
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
        } else if (['start', 'error', 'stopped', 'done'].includes(delta.kind)) {
          runStore.appendEvent(projectRoot, runId, delta.kind, { error: delta.error || null, state: delta.state || null });
        }
      };
      const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));

      // 先装配工具注册表：用于系统提示中的工具引导，也用于工具循环
      let registry = null;
      if (cfg.tools.toolsEnabled) {
        registry = toolkit.buildDefaultRegistryWithConfig({ ...cfg.tools, projectRoot, ragEnabled: cfg.rag.enabled && !!projectRoot });
      }
      let subagentManager = null;
      if (registry) {
        subagentManager = new SubagentManager({
          agent,
          toolkit,
          cfg,
          registry,
          runId,
          onDelta: onAgentDelta,
        });
        subagentManager.register(registry);
        toolkit.filterByConfig(registry, { ...cfg.tools, ragEnabled: cfg.rag.enabled && !!projectRoot });
      }
      const toolGuide = agent.buildToolGuide(registry ? registry.listTools() : []);
      const memory = projectRoot ? memoryStore.readMemory(projectRoot) : { entries: [] };
      const memoryText = memory.entries.slice(-30).map((entry) => `- ${entry.key ? '[' + entry.key + '] ' : ''}${entry.content}`).join('\n');
      const skills = projectRoot ? extensionStore.readManifest(projectRoot).filter((item) => String(item.kind || '').toLowerCase() === 'skills') : [];
      const skillsText = skills.map((item) => `- ${item.name}: ${item.instructions || item.description || '按项目扩展定义执行'}`).join('\n');
      const systemContent = agent.buildSystemPrompt(soul, canvasSummary, toolGuide, memoryText, skillsText);
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
      const controller = new AbortController();
      if (registry && registry.listTools().length > 0) {
        bridge = makeBridge(sender, controller.signal);
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
          // 注意：这里必须传策略对象本身。曾写成 `sandbox: () => sandboxPolicy`，而 context.sandbox()
          // 会把注入值原样返回 → currentPolicy() 拿到函数、mode/capabilities 全为 undefined →
          // 隔离静默降级（Windows 的 Job Object 限额不生效；macOS/Linux 退化成无隔离 spawn；strict 不再 fail-closed）。
          sandbox: sandboxPolicy,
          sideEffectGuard,
          checkpoint: checkpointSink,
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
            dirty = true;
            return true;
          },
          undo: async () => {
            if (undoStack.length) {
              redoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(undoStack.pop()));
              dirty = true;
            }
          },
          redo: async () => {
            if (redoStack.length) {
              undoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(redoStack.pop()));
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
      activeRequests.set(runId, controller);
      let result;
      try {
        result = await agent.runAgentChat({
          cfg,
          messages,
          onDelta: onAgentDelta,
          tools,
          signal: controller.signal,
        });
      } finally {
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
      });
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
      if (dirty && model) out.document = model.doc;
      if (bridge) bridge.cleanup();
      return out;
    } catch (e) {
      if (runId) runStore.finishRun(projectRoot, runId, 'error', { state: 'FAILED', error: String((e && e.message) || e) });
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
