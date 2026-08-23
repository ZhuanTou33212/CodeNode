const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codenode', {
  saveGraph: (data) => ipcRenderer.invoke('graph:save', data),
  openGraph: () => ipcRenderer.invoke('graph:open'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  createProject: () => ipcRenderer.invoke('project:create'),
  listProject: (root) => ipcRenderer.invoke('project:list', root),
  readProjectFile: (root, relPath) => ipcRenderer.invoke('project:read', root, relPath),
  saveProject: (target, payload) => ipcRenderer.invoke('project:save', target, payload),
  loadProject: (target) => ipcRenderer.invoke('project:load', target),
  agentConfig: (root) => ipcRenderer.invoke('agent:config', root),
  agentGreeting: (root) => ipcRenderer.invoke('agent:greeting', root),
  agentTools: (root) => ipcRenderer.invoke('agent:tools', root),
  agentChat: (payload) => ipcRenderer.invoke('agent:chat', payload),
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
