const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codenode', {
  saveGraph: (data) => ipcRenderer.invoke('graph:save', data),
  openGraph: () => ipcRenderer.invoke('graph:open'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  trellisProject: (root, conversationId) => ipcRenderer.invoke('trellis:project', root, conversationId),
  trellisContext: (root, taskPath) => ipcRenderer.invoke('trellis:context', root, taskPath),
  trellisSelect: (root, conversationId, taskPath) => ipcRenderer.invoke('trellis:select', root, conversationId, taskPath),
  // S8：统一事件流的按 run 回放（时间线 + 摘要）
  replayEvents: (root, options) => ipcRenderer.invoke('agent:events', root, options),
  // §4.2：Run 级文件回滚 —— 先取只读计划（逐项 restore/delete/skip + 原因），确认后再执行
  rollbackPlan: (root, runId) => ipcRenderer.invoke('agent:rollback-plan', root, runId),
  rollbackApply: (root, runId, options) => ipcRenderer.invoke('agent:rollback-apply', root, runId, options),
  // §4.2：子代理任务视图（跨 run 可查）
  subagentViews: (root, options) => ipcRenderer.invoke('agent:subagents', root, options),
  // §4.2：运行中插话（steering）—— 长任务跑偏时不用整停
  steerAgent: (requestId, text) => ipcRenderer.invoke('agent:steer', requestId, text),
  createProject: () => ipcRenderer.invoke('project:create'),
  listProject: (root) => ipcRenderer.invoke('project:list', root),
  readProjectFile: (root, relPath, options) => ipcRenderer.invoke('project:read', root, relPath, options),
  writeProjectFile: (root, relPath, content, backup) => ipcRenderer.invoke('project:write', root, relPath, content, backup),
  searchProject: (root, query, maxResults) => ipcRenderer.invoke('project:search', root, query, maxResults),
  runProjectCommand: (root, command, timeoutSeconds) => ipcRenderer.invoke('project:run', root, command, timeoutSeconds),
  workflowState: (root, workflowId, request) => ipcRenderer.invoke('project:workflow-state', root, workflowId, request),
  workflowExecute: (root, workflowId, request) => ipcRenderer.invoke('project:workflow-execute', root, workflowId, request),
  startProjectCommand: (root, command, timeoutSeconds) => ipcRenderer.invoke('project:run:start', root, command, timeoutSeconds),
  stopProjectCommand: (sessionId) => ipcRenderer.invoke('project:run:stop', sessionId),
  sendProjectCommandInput: (sessionId, input) => ipcRenderer.invoke('project:run:input', sessionId, input),
  onProjectCommandEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('project:run:event', listener);
    return () => ipcRenderer.removeListener('project:run:event', listener);
  },
  addExtensions: (root,input) => ipcRenderer.invoke('extensions:add', root,input),
  listExtensions: (root) => ipcRenderer.invoke('extensions:list', root),
  saveProject: (target, payload) => ipcRenderer.invoke('project:save', target, payload),
  loadProject: (target) => ipcRenderer.invoke('project:load', target),
  agentConfig: (root, sessionId, conversationId) => ipcRenderer.invoke('agent:config', root, sessionId, conversationId),
  backendSave: (root, scope, settings, options) => ipcRenderer.invoke('agent:backend-save', root, scope, settings, options),
  backendStatus: (root, settings) => ipcRenderer.invoke('agent:backend-status', root, settings),
  backendControl: (root, settings, method, params) => ipcRenderer.invoke('agent:backend-control', root, settings, method, params),
  goalList: root => ipcRenderer.invoke('goal:list', root),
  goalCreate: (root, input) => ipcRenderer.invoke('goal:create', root, input),
  goalUpdate: (root, goalId, patch) => ipcRenderer.invoke('goal:update', root, goalId, patch),
  goalAutoAdvanceClaim: (root, goalId, taskId) => ipcRenderer.invoke('goal:auto-advance-claim', root, goalId, taskId),
  goalAutoAdvanceRelease: (root, goalId, taskId, claimId, reason) => ipcRenderer.invoke('goal:auto-advance-release', root, goalId, taskId, claimId, reason),
  goalTaskCreate: (root, goalId, input) => ipcRenderer.invoke('goal:task-create', root, goalId, input),
  goalTaskUpdate: (root, goalId, taskId, patch) => ipcRenderer.invoke('goal:task-update', root, goalId, taskId, patch),
  goalRunReview: (root, goalId, taskId, runId) => ipcRenderer.invoke('goal:run-review', root, goalId, taskId, runId),
  goalRunReviewConfirm: (root, goalId, taskId, runId, projectFingerprint) => ipcRenderer.invoke('goal:run-review-confirm', root, goalId, taskId, runId, projectFingerprint),
  goalDecisionCreate: (root, goalId, input) => ipcRenderer.invoke('goal:decision-create', root, goalId, input),
  goalDecisionResolve: (root, decisionId, value, reason) => ipcRenderer.invoke('goal:decision-resolve', root, decisionId, value, reason),
  goalVerify: (root, goalId, taskId, criterionId, command) => ipcRenderer.invoke('goal:verify', root, goalId, taskId, criterionId, command),
  goalAudit: (root, goalId) => ipcRenderer.invoke('goal:audit', root, goalId),
  goalCanRun: (root, goalId, taskId) => ipcRenderer.invoke('goal:can-run', root, goalId, taskId),
  goalContextAdd: (root, goalId, kind, input) => ipcRenderer.invoke('goal:context-add', root, goalId, kind, input),
  goalExperienceConfirm: (root, goalId, itemId) => ipcRenderer.invoke('goal:experience-confirm', root, goalId, itemId),
  goalContextForRole: (root, goalId, taskId, role) => ipcRenderer.invoke('goal:context-for-role', root, goalId, taskId, role),
  goalWaitObserve: (root, goalId, taskId, observation) => ipcRenderer.invoke('goal:wait-observe', root, goalId, taskId, observation),
  goalWaitCheck: (root, goalId, taskId) => ipcRenderer.invoke('goal:wait-check', root, goalId, taskId),
  ragCheck: (root, settings) => ipcRenderer.invoke('agent:rag-check', root, settings),
  ragSave: (root, settings) => ipcRenderer.invoke('agent:rag-save', root, settings),
  editingSave: (root, settings) => ipcRenderer.invoke('agent:editing-save', root, settings),
    executionSave: (root, settings) => ipcRenderer.invoke('agent:execution-save', root, settings),
  schedulingSave: settings => ipcRenderer.invoke('agent:scheduling-save', settings),
    costSettingsSave: (root, settings) => ipcRenderer.invoke('agent:cost-settings-save', root, settings),
  agentGreeting: (root) => ipcRenderer.invoke('agent:greeting', root),
  agentTools: (root) => ipcRenderer.invoke('agent:tools', root),
  agentRuns: (root) => ipcRenderer.invoke('agent:runs', root),
  agentFeedback: (root, payload) => ipcRenderer.invoke('agent:feedback', root, payload),
  agentFeedbackExport: (root, options) => ipcRenderer.invoke('agent:feedback-export', root, options),
  agentFeedbackReview: (root, id, expectedOutput, reviewer) => ipcRenderer.invoke('agent:feedback-review', root, id, expectedOutput, reviewer),
  agentResumePlan: (root, runId) => ipcRenderer.invoke('agent:resume-plan', root, runId),
  agentReadPlan: (root, sessionId) => ipcRenderer.invoke('agent:plan-read', root, sessionId),
  agentResumeStart: (root, runId, replacementRunId) => ipcRenderer.invoke('agent:resume-start', root, runId, replacementRunId),
  agentTimeTravel: (root, sourceRunId, branchRunId, checkpointIndex) => ipcRenderer.invoke('agent:time-travel', root, sourceRunId, branchRunId, checkpointIndex),
  // 运行指标 / 成本 / 告警 / 执行隔离状态
  agentMetrics: (root) => ipcRenderer.invoke('agent:metrics', root),
  onAgentAlert: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:alert', listener);
    return () => ipcRenderer.removeListener('agent:alert', listener);
  },
  modelsList: () => ipcRenderer.invoke('models:list'),
  modelsDiscover: (provider, apiKey, options) => ipcRenderer.invoke('models:discover', provider, apiKey, options),
  modelsConnect: (ticket, selectedId) => ipcRenderer.invoke('models:connect', ticket, selectedId),
  modelsSave: (model) => ipcRenderer.invoke('models:save', model),
  modelsDelete: (id) => ipcRenderer.invoke('models:delete', id),
  modelsActive: (id) => ipcRenderer.invoke('models:active', id),
  agentChat: (payload) => ipcRenderer.invoke('agent:chat', payload),
  stopAgent: (requestId) => ipcRenderer.invoke('agent:stop', requestId),
  onAgentDelta: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:delta', listener);
    return () => ipcRenderer.removeListener('agent:delta', listener);
  },
  onToolRequest: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('tools:request', listener);
    return () => ipcRenderer.removeListener('tools:request', listener);
  },
  respondToolRequest: (id, result) => ipcRenderer.send('tools:response', { id, result }),
});
