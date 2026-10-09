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
const workspace = path.join(root, 'project/.trellis/workspace/tester'); fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'journal-1.md'), '# Journal - tester (Part 1)\n\nKEEP JOURNAL\n');
fs.writeFileSync(path.join(workspace, 'index.md'), '# Workspace Index - tester\nKEEP NOTES\n<!-- @@@auto:current-status -->\n- **Active File**: `journal-1.md`\n- **Total Sessions**: 0\n- **Last Active**: 2026-10-09\n<!-- @@@/auto:current-status -->\n<!-- @@@auto:active-documents -->\n| File | Lines | Status |\n|------|-------|--------|\n| `journal-1.md` | ~3 | Active |\n<!-- @@@/auto:active-documents -->\n<!-- @@@auto:session-history -->\n| # | Date | Title | Commits | Branch |\n|---|------|-------|---------|--------|\n<!-- @@@/auto:session-history -->\n');
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
    const click = async text => win.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('.trellis-write-panel button')].find(b=>b.textContent===${JSON.stringify(text)});if(!button||button.disabled)throw new Error('Button unavailable');button.click();})()`);
    const selector = label => JSON.stringify('[aria-label=' + JSON.stringify(label) + ']');
    const field = async (label, value) => win.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!input)throw new Error('Field unavailable');if(input.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));}else{input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    for (const [theme, nextStatus] of [['light', 'planning'], ['dark', 'in_progress']]) {
      await win.webContents.executeJavaScript(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}});document.querySelector('.trellis-task-panel').open=true;document.querySelector('.trellis-write-panel').open=true;`);
      await waitFor(win, `document.querySelector(${selector('Trellis 写回状态')})?.options.length===3`);
      await field('Trellis 写回状态', nextStatus); await field('Trellis 写回说明', '人工状态更新证据'); await click('预览修改');
      await waitFor(win, `!!document.querySelector(${selector('Trellis 修改预览')})`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(project, fixture.taskPath, 'task.json'), 'utf8')).status, nextStatus === 'planning' ? 'in_progress' : 'planning');
      const previewText = await win.webContents.executeJavaScript(`document.querySelector(${selector('Trellis 修改预览')}).textContent`);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().toggleTheme()');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${selector('Trellis 修改预览')}).textContent`), previewText);
      await click('应用预览修改'); await waitFor(win, 'document.querySelector(".trellis-write-panel")?.textContent.includes("事务状态：applied")');
      assert.equal(JSON.parse(fs.readFileSync(path.join(project, fixture.taskPath, 'task.json'), 'utf8')).status, nextStatus);
      await click('重新读取写回结果'); await waitFor(win, 'document.querySelector(".trellis-task-panel")?.textContent.includes("资料就绪")');
    }
    await win.webContents.executeJavaScript(`document.querySelector('.trellis-task-panel').open=true;document.querySelector('.trellis-write-panel').open=true;`);
    await field('Trellis 修改类型', 'journal'); await waitFor(win, `!!document.querySelector(${selector('Trellis 日志开发者')})`);
    await field('Trellis 日志开发者', 'tester'); await field('Trellis 写回说明', 'UI 工作摘要'); await field('日志验证结果', '局部 UI 验证，非全部验收'); await field('日志下一步', '继续审查');
    await click('预览修改'); await waitFor(win, `!!document.querySelector(${selector('Trellis 修改预览')})`);
    await click('应用预览修改'); await waitFor(win, 'document.querySelector(".trellis-write-panel")?.textContent.includes("事务状态：applied")');
    assert.match(fs.readFileSync(path.join(workspace, 'journal-1.md'), 'utf8'), /UI 工作摘要/); assert.match(fs.readFileSync(path.join(workspace, 'index.md'), 'utf8'), /KEEP NOTES/);
    await click('添加任务执行流程'); await waitFor(win, 'window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length===4');
    const bound = await win.webContents.executeJavaScript('window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).map(n=>n.data.trellis.role)'); assert.deepEqual(bound, ['explorer','builder','verifier','reviewer']);
    await win.webContents.executeJavaScript('window.__codenodeStore.getState().undo()'); assert.equal(await win.webContents.executeJavaScript('window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length'), 0);
    await win.webContents.executeJavaScript('window.__codenodeStore.getState().redo()'); assert.equal(await win.webContents.executeJavaScript('window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length'), 4);
    await waitFor(win, 'document.querySelector(".trellis-write-panel")?.textContent.includes("已添加准备")');
    const canvasFile = await win.webContents.executeJavaScript('window.__codenodeProject.getState().projectFile');
    assert.ok(canvasFile, 'generated canvas is saved to a real project file');
    const writes = require(path.join(appRoot, 'electron/trellis/writes.cjs'));
    const trellis = require(path.join(appRoot, 'electron/trellis/index.cjs'));
    const recoveryProposal = writes.proposeJournal(project, fixture.taskPath, { developer: 'tester', summary: '重开后恢复日志', verification: '恢复测试', nextSteps: '后续检查', expectedFingerprint: trellis.readTask(project, fixture.taskPath).fingerprint });
    let writesCount = 0;
    const atomic = require(path.join(appRoot, 'electron/atomicFile.cjs')).atomicWriteFile;
    const partial = writes.applyProposal(project, recoveryProposal.id, 'apply', { write: (file, content, encoding, guard) => { if (++writesCount === 2) throw new Error('injected UI index failure'); atomic(file, content, encoding, guard); } });
    assert.equal(partial.status, 'needs-recovery');
    await win.reload(); await waitFor(win, '!!window.__codenodeProject');
    await win.webContents.executeJavaScript(`(async()=>{const result=await window.codenode.loadProject(${JSON.stringify(canvasFile)});if(!result.ok)throw new Error(result.error);const data=result.data.canvases;await window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)});window.__codenodeSession.getState().restoreSessions(data.sessions.map(s=>({...s,doc:s.doc||{root:s.root}})),data.messages,data.activeId,data.memoryConversationId);})()`);
    assert.equal(await win.webContents.executeJavaScript('window.__codenodeStore.getState().nodes.filter(n=>n.data.trellis).length'), 4, 'saved canvas retains execution bindings after reopen');
    await waitFor(win, `!!document.querySelector(${selector('Trellis 恢复事务')})`);
    await win.webContents.executeJavaScript(`document.querySelector('.trellis-task-panel').open=true;document.querySelector('.trellis-write-panel').open=true;`);
    await field('Trellis 恢复事务', recoveryProposal.id); await waitFor(win, 'document.querySelector(".trellis-write-panel")?.textContent.includes("恢复剩余写入")');
    await click('恢复剩余写入'); await waitFor(win, 'document.querySelector(".trellis-write-panel")?.textContent.includes("事务状态：applied")');
    assert.equal((fs.readFileSync(path.join(workspace, 'journal-1.md'), 'utf8').match(/## Session 2:/g) || []).length, 1);
    assert.match(fs.readFileSync(path.join(workspace, 'index.md'), 'utf8'), /Total Sessions\*\*: 2/);
    console.log('TRELLIS UI: PASS (real main/preload/renderer, task selection, PRD/spec display, light/dark state parity, saved project reopening, upstream files untouched)');
    console.log('TRELLIS WRITE/CANVAS UI: PASS (actual preview/apply in both themes, preview survives theme switch, journal/index append, explicit canvas roles, undo/redo, reopen partial transaction and resume without duplicates)');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
app.on('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
