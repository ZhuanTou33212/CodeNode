'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = process.env.CODENODE_PACKAGED_ASAR;
if (!asar) throw new Error('CODENODE_PACKAGED_ASAR is required');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-startup-'));
app.setPath('userData', tmp);
process.env.CODENODE_HOME = path.join(tmp, 'home');
process.env.CODENODE_SOUL_FILE = path.join(tmp, 'soul.md');
app.on('browser-window-created', (_event, win) => win.hide());
require(path.join(asar, 'electron/main.cjs'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true,
    preload: path.join(asar, 'electron/preload.cjs') } });
  try {
    await win.loadFile(path.join(asar, 'dist/index.html'));
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await win.webContents.executeJavaScript(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await new Promise(resolve => setTimeout(resolve, 700));
    const rendered = await win.webContents.executeJavaScript(`({canvas:!!document.querySelector('.canvas-wrap'),composer:!!document.querySelector('.pp-composer'),body:!!document.querySelector('.ap-body'),goalRunReview:typeof window.codenode?.goalRunReview==='function'&&typeof window.codenode?.goalRunReviewConfirm==='function'})`);
    if (!rendered.canvas || !rendered.composer || !rendered.body || !rendered.goalRunReview) throw new Error(JSON.stringify(rendered));
    console.log('PACKAGED STARTUP: PASS (actual app.asar main, preload, renderer, Goal Run-review IPC, workspace and conversation composer)');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
app.on('quit', () => {
  // Chromium may still hold userData files during quit on Windows.
  // Cleanup must never throw from the Electron lifecycle callback.
  try {
    if (path.dirname(tmp) === os.tmpdir() && path.basename(tmp).startsWith('codenode-startup-')) fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});
