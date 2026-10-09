'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const fixture = require('../fixtures/trellis-v0.6.17.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-trellis-ui-'));
const asar = process.env.CODENODE_PACKAGED_ASAR;
const appRoot = asar || path.resolve(__dirname, '../..');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userdata');
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
for (const [source, text] of Object.entries(fixture.files)) {
  const full = path.join(root, 'project', source); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
}
app.on('browser-window-created', (_event, win) => win.hide());
require(path.join(appRoot, 'electron/main.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(win, script) { for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript(script)) return; await sleep(100); } throw new Error('UI wait failed: ' + script); }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, preload: path.join(appRoot, 'electron/preload.cjs') } });
  try {
    await win.loadFile(path.join(appRoot, 'dist/index.html'));
    const project = path.join(root, 'project');
    await win.webContents.executeJavaScript(`window.__codenodeSession.getState().initProject(); window.__codenodeSession.setState({memoryConversationId:'trellis-ui-conversation'}); window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
    await waitFor(win, '!!document.querySelector(".trellis-task-panel")');
    await win.webContents.executeJavaScript(`document.querySelector('.trellis-task-panel').open=true; const select=document.querySelector('[aria-label="Trellis 任务"]'); select.value=${JSON.stringify(fixture.taskPath)}; select.dispatchEvent(new Event('change',{bubbles:true}));`);
    await waitFor(win, 'document.querySelector(".trellis-task-panel")?.textContent.includes("资料就绪")');
    const before = await win.webContents.executeJavaScript(`(() => {const s=window.__codenodeSession.getState();const input=document.querySelector('.pp-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'保持草稿');input.dispatchEvent(new Event('input',{bubbles:true}));return {active:s.activeId,conversation:s.memoryConversationId,navigation:window.__codenodeUi.getState().navigationOpen,model:document.querySelector('.pp-model-picker .pp-model')?.textContent};})()`);
    assert.ok(before.model, '真实模型选择器可见且包含当前模型');
    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
      await waitFor(win, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
      const view = await win.webContents.executeJavaScript(`({task:document.querySelector('[aria-label="Trellis 任务"]').value,active:window.__codenodeSession.getState().activeId,conversation:window.__codenodeSession.getState().memoryConversationId,navigation:window.__codenodeUi.getState().navigationOpen,model:document.querySelector('.pp-model-picker .pp-model')?.textContent,draft:document.querySelector('.pp-input').value,content:document.querySelector('.trellis-task-panel').textContent})`);
      assert.equal(view.task, fixture.taskPath); assert.equal(view.draft, '保持草稿'); assert.equal(view.active, before.active); assert.equal(view.conversation, before.conversation); assert.equal(view.navigation, before.navigation); assert.equal(view.model, before.model);
      assert.match(view.content, /DEMO_PRD/); assert.match(view.content, /BASE_RULES/);
    }
    // Reopen a saved project through the real preload and restore its conversation identity.
    const payload = await win.webContents.executeJavaScript(`({graph:{nodes:[],edges:[]},canvases:{sessions:Object.values(window.__codenodeSession.getState().sessions),activeId:window.__codenodeSession.getState().activeId,messages:[],memoryConversationId:window.__codenodeSession.getState().memoryConversationId}})`);
    const cnode = require(path.join(appRoot, 'electron/cnode.cjs'));
    const file = path.join(project, 'demo.cnode'); fs.writeFileSync(file, cnode.encodeCnode(payload));
    await win.reload();
    await waitFor(win, '!!window.__codenodeProject');
    await win.webContents.executeJavaScript(`(async()=>{const result=await window.codenode.loadProject(${JSON.stringify(file)});if(!result.ok)throw new Error(result.error);const data=result.data.canvases;await window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)});window.__codenodeSession.getState().restoreSessions(data.sessions,data.messages,data.activeId,data.memoryConversationId);})()`);
    await waitFor(win, 'document.querySelector(".trellis-task-panel")?.textContent.includes("资料就绪")');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Trellis 任务"]').value`), fixture.taskPath);
    for (const [source, text] of Object.entries(fixture.files)) assert.equal(fs.readFileSync(path.join(project, source), 'utf8'), text);
    console.log('TRELLIS UI: PASS (real main/preload/renderer, task selection, PRD/spec display, light/dark state parity, saved project reopening, upstream files untouched)');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
app.on('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
