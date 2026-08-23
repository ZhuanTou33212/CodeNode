const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codenode', {
  saveGraph: (data) => ipcRenderer.invoke('graph:save', data),
  openGraph: () => ipcRenderer.invoke('graph:open'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  createProject: () => ipcRenderer.invoke('project:create'),
  listProject: (root) => ipcRenderer.invoke('project:list', root),
  readProjectFile: (root, relPath) => ipcRenderer.invoke('project:read', root, relPath),
  saveProject: (root, data) => ipcRenderer.invoke('project:save', root, data),
  loadProject: (root) => ipcRenderer.invoke('project:load', root),
});
