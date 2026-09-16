const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codenode', {
  saveGraph: (data) => ipcRenderer.invoke('graph:save', data),
  openGraph: () => ipcRenderer.invoke('graph:open'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  // S8：统一事件流的按 run 回放（时间线 + 摘要）
  replayEvents: (root, options) => ipcRenderer.invoke('agent:events', root, options),
  createProject: () => ipcRenderer.invoke('project:create'),
  listProject: (root) => ipcRenderer.invoke('project:list', root),
  readProjectFile: (root, relPath, options) => ipcRenderer.invoke('project:read', root, relPath, options),
  writeProjectFile: (root, relPath, content, backup) => ipcRenderer.invoke('project:write', root, relPath, content, backup),
  searchProject: (root, query, maxResults) => ipcRenderer.invoke('project:search', root, query, maxResults),
  runProjectCommand: (root, command, timeoutSeconds) => ipcRenderer.invoke('project:run', root, command, timeoutSeconds),
  startProjectCommand: (root, command, timeoutSeconds) => ipcRenderer.invoke('project:run:start', root, command, timeoutSeconds),
  stopProjectCommand: (sessionId) => ipcRenderer.invoke('project:run:stop', sessionId),
  sendProjectCommandInput: (sessionId, input) => ipcRenderer.invoke('project:run:input', sessionId, input),
  onProjectCommandEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('project:run:event', listener);
    return () => ipcRenderer.removeListener('project:run:event', listener);
  },
  listExtensions: (root) => ipcRenderer.invoke('extensions:list', root),
  saveProject: (target, payload) => ipcRenderer.invoke('project:save', target, payload),
  loadProject: (target) => ipcRenderer.invoke('project:load', target),
  agentConfig: (root) => ipcRenderer.invoke('agent:config', root),
  agentGreeting: (root) => ipcRenderer.invoke('agent:greeting', root),
  agentTools: (root) => ipcRenderer.invoke('agent:tools', root),
  agentRuns: (root) => ipcRenderer.invoke('agent:runs', root),
  agentResumePlan: (root, runId) => ipcRenderer.invoke('agent:resume-plan', root, runId),
  agentResumeStart: (root, runId, replacementRunId) => ipcRenderer.invoke('agent:resume-start', root, runId, replacementRunId),
  // 运行指标 / 成本 / 告警 / 执行隔离状态
  agentMetrics: (root) => ipcRenderer.invoke('agent:metrics', root),
  onAgentAlert: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:alert', listener);
    return () => ipcRenderer.removeListener('agent:alert', listener);
  },
  modelsList: () => ipcRenderer.invoke('models:list'),
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
