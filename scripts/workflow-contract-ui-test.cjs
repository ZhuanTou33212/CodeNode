'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-contract-ui-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 760, show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(600);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const project = window.__codenodeProject;
      const graph = window.__codenodeStore;
      const ui = window.__codenodeUi;
      if (!project || !graph || !ui) return { error: 'stores unavailable' };
      await project.getState().loadRoot(${JSON.stringify(root)});
      graph.getState().loadDocument({ nodes: [{ id: 'task-1', type: 'task', position: { x: 100, y: 100 }, data: { label: 'Needs input', prompt: 'do work', status: 'pending', requiresInput: true } }], edges: [] });
      ui.getState().setSideOpen(true);
      graph.getState().setSelectedId('task-1');
      ui.getState().setSideTab('node');
      ui.getState().openDock('runs');
      const waitFor = async (fn) => { for (let i = 0; i < 80; i++) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
      const warning = await waitFor(() => document.querySelector('.sp-pane .task-trace-warning'));
      const runButton = await waitFor(() => Array.from(document.querySelectorAll('.dock-runs button')).find((button) => button.textContent.includes('运行工作流')));
      if (runButton) runButton.click();
      const blocked = await waitFor(() => document.querySelector('.dock-run-item.blocked'));
      return { warning: warning?.textContent || '', blocked: blocked?.textContent || '', nodeStatus: graph.getState().nodes[0]?.data?.status };
    })()`);
    const ok = result.warning.includes('缺少输入连线') && result.blocked.includes('没有连入节点') && result.nodeStatus === 'blocked';
    console.log('WORKFLOW CONTRACT UI TEST:', JSON.stringify(result));
    console.log(ok ? 'WORKFLOW CONTRACT UI TEST: PASS' : 'WORKFLOW CONTRACT UI TEST: FAIL');
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('WORKFLOW CONTRACT UI TEST: ERROR', error);
    app.exit(2);
  } finally {
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-contract-ui-')) fs.rmSync(root, { recursive: true, force: true });
  }
});
