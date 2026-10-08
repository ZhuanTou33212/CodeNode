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
    const rendered = await win.webContents.executeJavaScript(`({canvas:!!document.querySelector('.canvas-wrap'),composer:!!document.querySelector('.pp-composer'),body:!!document.querySelector('.ap-body')})`);
    if (!rendered.canvas || !rendered.composer || !rendered.body) throw new Error(JSON.stringify(rendered));
    const setup = await win.webContents.executeJavaScript(`(() => {
      const ss=window.__codenodeSession;
      ss.getState().startOnCurrent('Origin A'); const a=ss.getState().activeId;
      ss.getState().beginWorkSession('Other B'); const b=ss.getState().activeId;
      ss.getState().switchSession(a); ss.getState().beginTurn(); return {a,b};
    })()`);
    for (let theme=0;theme<2;theme++) {
      await new Promise(resolve=>setTimeout(resolve,120));
      const state=await win.webContents.executeJavaScript(`(() => {
        const ss=window.__codenodeSession; ss.getState().switchSession(${JSON.stringify(setup.b)});
        const buttons=[...document.querySelectorAll('.project-session-row > button:first-child')];
        return {active:ss.getState().activeId,streaming:ss.getState().streaming,count:buttons.length,disabled:buttons.every(button=>button.disabled)};
      })()`);
      if(state.active!==setup.a||!state.streaming||state.count<2||!state.disabled)throw new Error(JSON.stringify(state));
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().toggleTheme()');
    }
    const restored=await win.webContents.executeJavaScript(`(() => {const ss=window.__codenodeSession;ss.getState().stopTurn();ss.getState().switchSession(${JSON.stringify(setup.b)});return ss.getState().activeId})()`);
    if(restored!==setup.b)throw new Error('Session switching did not resume after stop');
    console.log('CONCURRENT SESSION UI: PASS (actual packaged UI; both themes lock running session, store guard, theme state preserved, switching restored after stop)');
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
