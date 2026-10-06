'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog, ipcMain } = require('electron');
const cnode = require('../electron/cnode.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-project-ui-'));
const projectFile = path.join(root, 'created.cnode');
const invalidFile = path.join(root, 'invalid.cnode');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
let win = null;
let firstSendCalls = 0, completeFirstSend;
app.on('browser-window-created', (_event, window) => { win = window; });
const originalSaveDialog = dialog.showSaveDialog;
const originalOpenDialog = dialog.showOpenDialog;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: projectFile });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [invalidFile] });
if (process.env.CODENODE_MODELS_UI_TEST === '1') {
  require(process.env.CODENODE_UI_TEST_PACKAGE
    ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources', 'app.asar', 'electron', 'providerModels.cjs')
    : '../electron/providerModels.cjs').discover = async (provider, key) => {
    assert.equal(provider, 'deepseek'); assert.equal(key, 'synthetic-ui-key');
    return ['alpha', 'beta'].map((name) => ({ id: 'deepseek:' + name, model: name, label: name, provider: 'deepseek', apiBase: 'https://api.deepseek.com', contextWindow: 128000, supportsEffort: false, priceInput: 0, priceInputHit: 0, priceOutput: 0 }));
  };
}
require(process.env.CODENODE_UI_TEST_PACKAGE
  ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources', 'app.asar', 'electron', 'main.cjs')
  : '../electron/main.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(80);
  }
  throw new Error('等待超时：' + label);
}

app.whenReady().then(async () => {
  if (process.env.CODENODE_FIRST_SEND_UI_TEST === '1') {
    ipcMain.removeHandler('agent:chat');
    ipcMain.handle('agent:chat', async (_event, payload) => { firstSendCalls++; assert.equal(payload.prompt, '你好'); return await new Promise(resolve => { completeFirstSend = () => resolve({ok:true,reply:'你好，已收到。',reasoning:'',tools:[]}); }); });
  }
  try {
    await waitFor(async () => win && await win.webContents.executeJavaScript('!!document.querySelector(".gate-actions")').catch(() => false), '启动页');
    win.hide();
    const modelFixtures = require('../electron/modelStore.cjs').seedModels({apiKey:'synthetic-ui-key'});
    fs.mkdirSync(app.getPath('userData'),{recursive:true});
    fs.writeFileSync(path.join(app.getPath('userData'),'models.json'),JSON.stringify({models:modelFixtures,activeId:modelFixtures[0].id}));
    const alternateRoot = path.join(root, 'alternate-project');
    fs.mkdirSync(alternateRoot, {recursive:true});
    const alternateFile = path.join(alternateRoot, 'alternate.cnode');
    fs.writeFileSync(alternateFile, cnode.encodeCnode({graph:{nodes:[],edges:[]},canvases:{sessions:[{id:'alternate-session',label:'另一项目聊天',status:'active',createdAt:Date.now(),nodeCount:0,root:{nodes:[],edges:[]}}],messages:[]}}));
    await win.webContents.executeJavaScript('localStorage.setItem("codenode.recentProjects", '+JSON.stringify(JSON.stringify([{root:alternateRoot,file:alternateFile,name:'alternate-project',openedAt:Date.now()}]))+')');
    await win.webContents.executeJavaScript('document.querySelectorAll(".gate-actions .gate-btn")[1].click()');
    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".app") && !!window.__codenodeProject.getState().root'), '新建后进入工作台');
    assert.equal(fs.existsSync(projectFile), true);
    assert.equal(cnode.decodeCnode(fs.readFileSync(projectFile)).ok, true);
    const opened = await win.webContents.executeJavaScript('({root:window.__codenodeProject.getState().root,file:window.__codenodeProject.getState().projectFile})');
    assert.equal(opened.root, root);
    assert.equal(opened.file, projectFile);

    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".pp-input") || !!document.querySelector(".crash")'), 'Agent 侧栏');
    win.webContents.on('console-message', event => { if (event.level === 'error') console.log('RENDER ERROR', event.message); });
    const agentView = await win.webContents.executeJavaScript(`(() => { const panel=document.querySelector('.conversation-workspace'); const input=document.querySelector('.pp-input'); return { crash:document.querySelector('.crash')?.textContent, panel:panel?.getBoundingClientRect().toJSON(), input:input?.getBoundingClientRect().toJSON(), text:panel?.textContent }; })()`);
    console.log('AGENT VIEW', JSON.stringify(agentView));
    const centered = await win.webContents.executeJavaScript(`(() => { const a=document.querySelector('.conversation-right').getBoundingClientRect(), b=document.querySelector('.pp-composer').getBoundingClientRect(); return {offset:Math.abs((a.left+a.right-b.left-b.right)/2),bottom:a.bottom-b.bottom,width:b.width,sideAgent:!!document.querySelector('.side-panel .pp-input')}; })()`);
    assert.ok(centered.offset < 2 && centered.bottom < 35 && centered.width > 280 && !centered.sideAgent, 'Agent composer must remain at the bottom of the right conversation pane');

    assert.ok(!agentView.crash, agentView.crash);
    assert.ok(agentView.panel?.width >= 260 && agentView.input?.height > 0, 'Agent panel and composer must be visible');
    if (process.env.CODENODE_FIRST_SEND_UI_TEST === '1') {
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-new").click()');
      await sleep(100);
      await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.pp-input'); input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'你好'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true})); })()`);
      await sleep(150);
      assert.equal(firstSendCalls,0,'IME Enter must only confirm composing text');
      await win.webContents.executeJavaScript(`document.querySelector('.pp-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
      await sleep(80);
      await win.webContents.executeJavaScript(`document.querySelector('.pp-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`);
      await waitFor(async () => firstSendCalls === 1, '首次发送你好');
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".agent-run-status").textContent.includes("正在回复")'));
      for (const theme of ['dark','light']) {
      await win.webContents.executeJavaScript('window.__codenodeUi.setState({theme:'+JSON.stringify(theme)+'})');
      for (const width of [1300,900,500]) {
        win.setSize(width,740); await sleep(150);
        const layout = await win.webContents.executeJavaScript(`(() => {const a=document.querySelector('.pp-composer').getBoundingClientRect(),b=document.querySelector('.pp-input').getBoundingClientRect(),c=document.querySelector('.pp-stop').getBoundingClientRect(),d=document.querySelector('.pp-steer-input').getBoundingClientRect(),host=document.querySelector('.workspace-main').getBoundingClientRect(),controls=document.querySelector('.pp-controls');return {input:b.height,stop:c.height,steer:d.width,contained:c.right<=a.right&&d.left>=a.left&&d.right<=a.right,overflow:controls.scrollWidth>controls.clientWidth,bottom:a.bottom<=host.bottom+1};})()`);
        assert.ok(layout.input>=28 && layout.stop>=24 && layout.steer>50 && layout.contained && !layout.overflow && layout.bottom, 'running composer must stay visible and contained at '+width+': '+JSON.stringify(layout));
      }
      }
      win.setSize(1300,850); win.showInactive(); await sleep(150);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      fs.writeFileSync(path.join(__dirname,'..','out','first-send-running.png'),(await win.webContents.capturePage()).toPNG());
      win.hide(); completeFirstSend();
      await waitFor(async () => await win.webContents.executeJavaScript('!window.__codenodeSession.getState().streaming && document.querySelector(".ap-body").textContent.includes("你好，已收到")'), '首次回复显示');
      assert.equal(firstSendCalls,1,'first send must run exactly once');
      console.log('FIRST SEND UI: PASS (Chinese IME, immediate status, running layout, reply)');
    }
    if (process.env.CODENODE_WORKBENCH_UI_TEST === '1') {
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".canvas-welcome")'), true);
      const otherModel = await win.webContents.executeJavaScript('window.__codenodeUi && document.querySelector(".pp-model").textContent');
      await win.webContents.executeJavaScript('document.querySelector(".pp-model").click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).find(button=>button.textContent.includes('Pro')).click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".pp-model").textContent.includes("Pro")'), '切换到 Pro');
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'models.json'),'utf8')).activeId, 'deepseek-v4-pro');
      await win.webContents.executeJavaScript('document.querySelector(".pp-model").click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).find(button=>button.textContent.includes('Flash')).click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".pp-model").textContent.includes("Flash")'), '切回 Flash');
      const frame = await win.webContents.executeJavaScript(`(() => {const input=getComputedStyle(document.querySelector('.pp-input')),composer=getComputedStyle(document.querySelector('.pp-composer'));return {input:input.borderWidth,outer:composer.borderWidth,radius:composer.borderRadius};})()`);
      assert.equal(frame.input, '0px'); assert.equal(frame.outer, '0px'); assert.equal(frame.radius,'26px');
      const modelWidth = await win.webContents.executeJavaScript(`document.querySelector('.pp-model').getBoundingClientRect().width`);
      assert.ok(modelWidth >= 120, 'model selector must remain readable in the composer');
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".canvas-welcome button").length'), 0);
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".project-navigation")'), true);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".project-nav-foot button").length'), 0);
      await win.webContents.executeJavaScript('document.querySelector(".project-actions summary").click()');
      assert.deepEqual(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-actions[open] button")).map(b=>b.textContent)'), ['新建项目', '打开项目', '打开工程文件']);
      await win.webContents.executeJavaScript('document.querySelector(".project-actions summary").click()');
      await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.pp-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'draft retained'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(80);
      for (const view of ['node','project','preview','agent']) {
        console.log('VIEW SWITCH', view);
        await win.webContents.executeJavaScript(`window.__codenodeUi.getState().setSideTab('${view}')`);
        await sleep(80);
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.workspace-${view}') !== null`));
      }
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".pp-input").value'), 'draft retained');
      const canvasWidth = await win.webContents.executeJavaScript('document.querySelector(".canvas-wrap").getBoundingClientRect().width');
      await win.webContents.executeJavaScript('document.querySelector(".conversation-head button").click()');
      await sleep(100);
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".conversation-right").hidden'));
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".canvas-wrap").getBoundingClientRect().width') > canvasWidth);
      await win.webContents.executeJavaScript('document.querySelector(".conversation-toggle").click()');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".pp-input").value'), 'draft retained');
      await win.webContents.executeJavaScript(`document.querySelector('.conversation-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().conversationWidth'), 416);
      await win.webContents.executeJavaScript(`(() => {const handle=document.querySelector('.conversation-resize'),right=document.querySelector('.conversation-right').getBoundingClientRect().right;handle.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:right-480}));window.dispatchEvent(new PointerEvent('pointerup',{}));})()`);
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().conversationWidth'), 480);
      assert.equal(await win.webContents.executeJavaScript('localStorage.getItem("codenode.conversationWidth")'), '480');
      await win.webContents.executeJavaScript(`document.querySelector('.conversation-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().conversationWidth'), 400);
      await win.webContents.executeJavaScript(`(() => {const handle=document.querySelector('.navigation-resize'),left=document.querySelector('.project-navigation').getBoundingClientRect().left;handle.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{clientX:left+300}));window.dispatchEvent(new PointerEvent('pointerup',{}));})()`);
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().navigationWidth'), 300);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".project-navigation").getBoundingClientRect().width'), 300);
      assert.equal(await win.webContents.executeJavaScript('localStorage.getItem("codenode.navigationWidth")'), '300');
      await win.webContents.executeJavaScript(`document.querySelector('.navigation-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().navigationWidth'), 216);
      const beforeProjectOrder = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-group-name")).map(button=>button.title)');
      await win.webContents.executeJavaScript('document.querySelectorAll(".project-group-name")[1].click()');
      await waitFor(async () => await win.webContents.executeJavaScript('window.__codenodeProject.getState().root === '+JSON.stringify(alternateRoot)+' && window.__codenodeProject.getState().projectFile === '+JSON.stringify(alternateFile)+' && !!window.__codenodeSession.getState().sessions["alternate-session"]'), '展开其他项目');
      assert.deepEqual(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-group-name")).map(button=>button.title)'), beforeProjectOrder, 'expanding another project must not reorder projects');
      await win.webContents.executeJavaScript('document.querySelectorAll(".project-group-name")[1].click()');
      await sleep(100);
      assert.deepEqual(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-group-name")).map(button=>button.title)'), beforeProjectOrder);
      await win.webContents.executeJavaScript('document.querySelectorAll(".project-group-name")[0].click()');
      await waitFor(async () => await win.webContents.executeJavaScript('window.__codenodeProject.getState().root === '+JSON.stringify(root)+' && window.__codenodeProject.getState().projectFile === '+JSON.stringify(projectFile)), '返回原项目');
      assert.deepEqual(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-group-name")).map(button=>button.title)'), beforeProjectOrder);
      await win.webContents.executeJavaScript('(() => { const button=document.querySelector(".project-group-name"); if (button.getAttribute("aria-expanded") === "true") button.click(); })()');
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".project-session-row").length'), 0);
      await win.webContents.executeJavaScript('document.querySelector(".project-group-name").click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`document.querySelector('.project-row-menu summary').click(); Array.from(document.querySelectorAll('.project-row-menu button')).find(b=>b.textContent==='置顶').click()`);
      await sleep(80);
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".project-group-name").textContent.includes("置顶")'));
      const originalSession = await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId');
      await win.webContents.executeJavaScript('window.__codenodeSession.getState().pushUser("原对话记录")');
      const beforeDraftCount = await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length');
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-new").click()');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), null);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length'), beforeDraftCount);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".pp-input").value'), '');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().messages.length'), 0);
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-new").click()');
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length'), beforeDraftCount);
      await win.webContents.executeJavaScript('window.__codenodeSession.getState().startOnCurrent("第一条任务")');
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length'), beforeDraftCount+1);
      assert.notEqual(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), originalSession);
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-sessions button").click()');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), originalSession);
      assert.ok(await win.webContents.executeJavaScript('window.__codenodeSession.getState().messages.some(m=>m.content==="原对话记录")'));
      const archiveCount = await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length');
      await win.webContents.executeJavaScript('(() => { const store=window.__codenodeSession; const state=store.getState(); state.order.forEach(id=>store.getState().setArchived(id,true)); })()');
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length'), archiveCount, 'archiving the last canvas must not create another canvas');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), null);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".project-session-row").length'), 0);
      await win.webContents.executeJavaScript('(() => { const state=window.__codenodeSession.getState(); const list=state.order.map(id=>state.sessions[id]); state.restoreSessions(list,state.messages); })()');
      await sleep(80);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().order.length'), archiveCount, 'restoring all archived canvases must not create a replacement');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), null);
      await win.webContents.executeJavaScript('window.__codenodeSession.getState().newCanvas()');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().current().label'), '画布1', 'new canvas after clearing the visible list must restart at 1');
      await win.webContents.executeJavaScript('window.__codenodeSession.getState().newCanvas()');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().current().label'), '画布2');
      await win.webContents.executeJavaScript('(() => { const state=window.__codenodeSession.getState(); const first=state.order.find(id=>!state.sessions[id].archived && state.sessions[id].label==="画布1"); state.setArchived(first,true); state.newCanvas(); })()');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().current().label'), '画布1', 'reuse an available number without renaming canvas 2');
      await win.webContents.executeJavaScript('(() => { const state=window.__codenodeSession.getState(); const originals=state.order.slice(0,'+archiveCount+').map(id=>state.sessions[id]); state.restoreSessions(originals,state.messages); })()');
      await win.webContents.executeJavaScript('(() => { const store=window.__codenodeSession; store.getState().order.forEach(id=>store.getState().setArchived(id,false)); })()');
      await sleep(80);
      await win.webContents.executeJavaScript('window.__codenodeSession.getState().switchSession('+JSON.stringify(originalSession)+')');
      const samePage = await win.webContents.executeJavaScript(`(() => { const canvas=document.querySelector('.canvas-wrap').getBoundingClientRect(), composer=document.querySelector('.pp-composer').getBoundingClientRect(), panel=document.querySelector('.conversation-right').getBoundingClientRect(); return {canvas:canvas.height,composer:composer.height,separated:canvas.right<=panel.left,visible:getComputedStyle(document.querySelector('.workspace-canvas')).visibility}; })()`);
      assert.ok(samePage.canvas > 150 && samePage.composer > 80 && samePage.separated && samePage.visible === 'visible', 'canvas and composer must be usable together on the same page');
      await win.webContents.executeJavaScript('document.querySelector(".session-archive").click()');
      await waitFor(async () => cnode.decodeCnode(fs.readFileSync(projectFile)).canvases?.sessions.some(s=>s.id===originalSession && s.archived), '归档写入工程');
      assert.notEqual(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), originalSession);
      win.webContents.reload();
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".gate-recent-item")').catch(()=>false), '重启后的最近工程');
      await win.webContents.executeJavaScript('document.querySelector(".gate-recent-item").click()');
      await waitFor(async () => await win.webContents.executeJavaScript(`!!document.querySelector('.pp-input') && window.__codenodeSession?.getState().sessions['${originalSession}']?.archived === true`).catch(()=>false), '重启后保留归档');
      assert.deepEqual(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".project-group-name")).map(button=>button.title)'), beforeProjectOrder, 'project order must survive reload and reopening');
      await win.webContents.executeJavaScript('document.querySelector(".global-settings-trigger").click()');
      await sleep(100);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-layout nav button')).find(b=>b.textContent==='已归档聊天').click()`);
      await sleep(100);
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".settings-content").textContent.includes("画布1")'));
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-content button')).find(b=>b.textContent==='恢复').click()`);
      await waitFor(async () => cnode.decodeCnode(fs.readFileSync(projectFile)).canvases?.sessions.some(s=>s.id===originalSession && !s.archived), '恢复写入工程');
      for (const setting of ['检索','扩展']) {
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-layout nav button')).find(b=>b.textContent==='${setting}').click()`);
        await sleep(100);
        assert.ok(await win.webContents.executeJavaScript('document.querySelector(".settings-content h2").textContent === '+JSON.stringify(setting)));
      }
      win.showInactive(); await sleep(150);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      const settingsShot = await Promise.race([win.webContents.capturePage(),sleep(5000).then(()=>{throw new Error('capture timeout');})]);
      fs.writeFileSync(path.join(__dirname,'..','out','global-settings.png'),settingsShot.toPNG());
      win.hide();
      await win.webContents.executeJavaScript('document.querySelector(".settings-close").click()');
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".toolbar button")).some(b=>b.textContent.trim()==="终端")'), false);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().openDock("editor")');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".dock-tabs button")).filter(b=>b.textContent==="终端").length'), 1);
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".dock-tabs button")).some(b=>["检索设置","扩展"].includes(b.textContent))'), false);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeDock()');
      await win.webContents.executeJavaScript(`document.querySelector('.pp-model').click()`);
      await sleep(100);
      await win.webContents.executeJavaScript(`document.querySelector('.hermes-settings-trigger').click()`);
      await sleep(100);
      const flyoutPosition = await win.webContents.executeJavaScript(`(() => { const main=document.querySelector('.hermes-model-menu').getBoundingClientRect(); const sub=document.querySelector('.hermes-effort-menu').getBoundingClientRect(); return {right:main.right,left:sub.left,subRight:sub.right,viewport:innerWidth}; })()`);
      assert.ok(flyoutPosition.left >= flyoutPosition.right && flyoutPosition.subRight <= flyoutPosition.viewport, 'effort must be a separate right-hand submenu');
      win.showInactive(); await sleep(150);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      const pickerShot = await Promise.race([win.webContents.capturePage(),sleep(5000).then(()=>{throw new Error('capture timeout');})]);
      fs.writeFileSync(path.join(__dirname,'..','out','hermes-model-picker.png'),pickerShot.toPNG());
      win.hide();
      await win.webContents.executeJavaScript(`document.querySelectorAll('.hermes-effort-menu button')[2].click()`);
      await sleep(100);
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".pp-model").textContent.includes("max")'));
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".pp-controls > select.pp-effort").length'), 0);
      await win.webContents.executeJavaScript('document.querySelector(".pp-model").click()');
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".toolbar summary")).some(el=>el.textContent.includes("项目"))'), false);
      await win.webContents.executeJavaScript(`document.querySelector('.toolbar-dropdown').open=true`);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toolbar-menu button')).find(b=>b.textContent.trim()==='恢复').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".dock-checkpoints")'), '恢复菜单入口');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeDock()');
      win.showInactive(); await sleep(200);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      const capture = await Promise.race([win.webContents.capturePage(),sleep(5000).then(()=>{throw new Error('capture timeout');})]);
      fs.writeFileSync(path.join(__dirname,'..','out','workbench-clean.png'),capture.toPNG());
      fs.writeFileSync(path.join(__dirname,'..','out','workbench-glass-dark.png'),capture.toPNG());
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".toolbar-theme")'), false);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().openSettings("general")');
      await sleep(80);
      await win.webContents.executeJavaScript('document.querySelector(".settings-theme-toggle").click()');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeSettings()');
      await waitFor(async () => await win.webContents.executeJavaScript('document.documentElement.dataset.theme==="light"'), '日间主题');
      await sleep(250);
      assert.equal(await win.webContents.executeJavaScript('localStorage.getItem("codenode.theme")'), 'light');
      const material = await win.webContents.executeJavaScript(`(() => { const panel=getComputedStyle(document.querySelector('.pp-composer')); return {background:panel.backgroundColor,blur:panel.backdropFilter}; })()`);
      assert.ok(material.background.startsWith('rgba(') && material.blur.includes('blur'), '主题应使用透明玻璃材质');
      const dayCapture = await Promise.race([win.webContents.capturePage(),sleep(5000).then(()=>{throw new Error('capture timeout');})]);
      fs.writeFileSync(path.join(__dirname,'..','out','workbench-glass-light.png'),dayCapture.toPNG());
      win.setSize(500,740); await sleep(200);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().setSideTab("agent")');
      await sleep(100);
      const narrow = await win.webContents.executeJavaScript(`(() => { const toolbar=document.querySelector('.toolbar'); const input=document.querySelector('.pp-input'); return {overflow:toolbar.scrollWidth>toolbar.clientWidth,input:input.getBoundingClientRect().width}; })()`);
      assert.ok(!narrow.overflow && narrow.input>200, 'narrow window toolbar and composer must remain usable');
      win.hide(); win.setSize(1300,850);
      await sleep(100);
      await win.webContents.executeJavaScript(`(() => { const graph=window.__codenodeStore.getState(); graph.addNode({id:'phase-one',type:'task',position:{x:40,y:40},data:{label:'阶段一',prompt:'',status:'pending'}}); graph.addNode({id:'phase-two',type:'stage',position:{x:400,y:40},data:{label:'阶段二',prompt:'第二阶段原文',status:'pending'}}); graph.setSelectedIds(['phase-one']); })()`);
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".wf-prompt").length'), 0);
      await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.pp-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'第一阶段任务'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(100);
      await win.webContents.executeJavaScript('document.querySelector(".pp-send").click()');
      await sleep(200);
      await waitFor(async () => cnode.decodeCnode(fs.readFileSync(projectFile)).canvases?.sessions.some(s=>s.root?.nodes.some(n=>n.id==='phase-one' && n.data.prompt==='第一阶段任务')), '节点 Prompt 写入工程');
      await win.webContents.executeJavaScript('window.__codenodeStore.getState().setSelectedIds(["phase-two"])');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".pp-input").value'), '第二阶段原文');
      await win.webContents.executeJavaScript('window.__codenodeStore.getState().updateNodeData("phase-one",{status:"running"})');
      await sleep(100);
      assert.ok(await win.webContents.executeJavaScript('!!document.querySelector(".wf-node-task.wf-status-running")'));
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".conversation-workspace").textContent.includes("你好")'), false);
      await win.webContents.executeJavaScript('window.__codenodeStore.getState().clear()');
      await sleep(100);
      await win.webContents.executeJavaScript('document.querySelector(".toolbar-vector").click()');
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".wf-vector-stage .vs-stage")'), '画布节点绘图区');
      const nodeLayout = await win.webContents.executeJavaScript(`(() => { const node=document.querySelector('.wf-vector'); const rail=node.querySelector('.wf-vector-rail'); return {welcome:!!document.querySelector('.canvas-welcome'),railOverflow:rail.scrollWidth>rail.clientWidth,stage:node.querySelector('.wf-vector-stage').getBoundingClientRect().width}; })()`);
      assert.ok(!nodeLayout.welcome && !nodeLayout.railOverflow && nodeLayout.stage>100, '画布节点绘图区和工具仍可操作');
      win.webContents.reload();
      await waitFor(async () => await win.webContents.executeJavaScript('!!window.__codenodeUi && document.documentElement.dataset.theme==="light"').catch(()=>false), '重载后保留日间主题');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().theme'), 'light');
      console.log('WORKBENCH CLEAN UI: PASS (menus, empty state, model row, narrow window)');
    }
    if (process.env.CODENODE_MODELS_UI_TEST === '1') {
      const modelFile = path.join(app.getPath('userData'), 'models.json');
      const locked = { id: 'legacy', label: 'Legacy', model: 'legacy', apiKey: 'safe:v1:invalid-cipher' };
      fs.writeFileSync(modelFile, JSON.stringify({ models: [locked], activeId: 'legacy' }));
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().openModelManager()');
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".mm-connect-dialog")?.textContent.includes("需重新连接")'), '失效 Key 恢复提示');
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".mm-connect-dialog input[type=password]").length'), 1);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice").length'), 0);

      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('.mm-connect-dialog input[type=password]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'synthetic-ui-key');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mm-connect-dialog button')).find(b=>b.textContent==='连接').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice").length===2'), '实时模型列表');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-key-row input").value'), 'syntheti*****-key');
      await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice")[1].click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mm-connect-dialog button')).find(b=>b.textContent==='切换').click()`);
      await waitFor(async () => JSON.parse(fs.readFileSync(modelFile,'utf8')).activeId === 'deepseek:beta', '保存连接');
      const stored = JSON.parse(fs.readFileSync(modelFile,'utf8'));
      assert.equal(stored.activeId, 'deepseek:beta');
      assert.deepEqual(stored.models.find(model=>model.id==='legacy'), locked);
      assert.equal(fs.readFileSync(modelFile,'utf8').includes('synthetic-ui-key'), false);
      const usable = require('../electron/modelStore.cjs').readUsableModels(app.getPath('userData'), {});
      assert.equal(usable.models.find(model=>model.id==='deepseek:beta').apiKey, 'synthetic-ui-key');
      assert.equal(usable.models.find(model=>model.id==='legacy').apiKeyError, true);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".mm-key-row button").textContent === "切换"'), '连接完成后切换按钮');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-key-row input").value'), 'syntheti*****-key');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-key-row button").textContent'), '切换');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeModelManager()');
      await sleep(80);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().openModelManager()');
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".mm-key-row input")?.value === "syntheti*****-key"'), '重开窗口显示脱敏 Key');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-key-row button").textContent'), '切换');
      await win.webContents.executeJavaScript('document.querySelector(".mm-key-row button").click()');
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice").length === 2'), '已保存连接切换模型');
      const providerEntries = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("select[aria-label=供应商] option")).map(o=>o.value)');
      assert.ok(providerEntries.includes('kimi') && providerEntries.includes('minimax') && providerEntries.includes('custom'), '主流供应商和兼容入口必须出现在 UI');
      win.setSize(500, 740);
      await sleep(200);
      const narrow = await win.webContents.executeJavaScript(`(() => { const dialog=document.querySelector('.mm-connect-dialog'); const input=dialog.querySelector('.mm-key-row input'); const a=dialog.getBoundingClientRect(), b=input.getBoundingClientRect(); return {width:a.width, window:innerWidth, inputWidth:b.width, overflow:dialog.scrollWidth>dialog.clientWidth}; })()`);
      assert.ok(narrow.width < narrow.window && narrow.inputWidth > 100 && !narrow.overflow, '窄窗口模型管理控件必须可见');
      win.setSize(1300, 850);
      await sleep(200);
      if (process.env.CODENODE_UI_CAPTURE === '1') {
        win.showInactive();
        await sleep(200);
        const screenshot = await Promise.race([win.webContents.capturePage(), sleep(5000).then(() => { throw new Error('Screenshot timed out'); })]);
        fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '..', 'out', 'model-connection-ui.png'), screenshot.toPNG());
        win.hide();
      }
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeModelManager()');
      await win.webContents.executeJavaScript('document.querySelector(".pp-model").click()');
      await sleep(100);
      const lockedRow = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).find(button=>button.textContent.includes('Legacy'))?.disabled`);
      assert.equal(lockedRow, false, 'locked models must explain recovery instead of silently disabling selection');
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).find(button=>button.textContent.includes('Legacy')).click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".mm-connect-dialog")'), '无可用 Key 时提示填写');
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".mm-connect-dialog").textContent.includes("请填写 Legacy 的 API Key")'));
      assert.equal(JSON.parse(fs.readFileSync(modelFile,'utf8')).activeId,'deepseek:beta');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeModelManager()');
      const blankKeyStore = JSON.parse(fs.readFileSync(modelFile,'utf8'));
      blankKeyStore.models.push({id:'openai-empty',label:'OpenAI empty key',model:'gpt-6.1-sol',provider:'openai',apiBase:'https://api.openai.com/v1',apiKey:'',supportsEffort:true});
      fs.writeFileSync(modelFile,JSON.stringify(blankKeyStore));
      await win.webContents.executeJavaScript('document.querySelector(".pp-model").click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-footer button')).find(b=>b.textContent.includes('刷新')).click()`);
      await waitFor(async () => await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).some(b=>b.textContent.includes('OpenAI empty key'))`), '无 Key 模型列表');
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.hermes-model-row > button:first-child')).find(b=>b.textContent.includes('OpenAI empty key')).click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".mm-connect-dialog")'), '提示填写 API Key');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-connect-dialog select").value'), 'openai');
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".mm-connect-dialog").textContent.includes("请填写 OpenAI empty key 的 API Key")'));
      assert.equal(JSON.parse(fs.readFileSync(modelFile,'utf8')).activeId,'deepseek:beta');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().closeModelManager()');
      console.log('MODEL CONNECTION UI: PASS (locked-key recovery, select model, encrypted save, legacy preservation)');
    }

    fs.writeFileSync(invalidFile, 'invalid cnode file');
    await win.webContents.executeJavaScript('window.__codenodeProject.setState({root:null,projectFile:null})');
    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".gate-actions")'), '返回启动页');
    await win.webContents.executeJavaScript('document.querySelectorAll(".gate-actions .gate-btn")[2].click()');
    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".gate-status.err")'), '损坏文件错误提示');
    const error = await win.webContents.executeJavaScript('document.querySelector(".gate-status.err").textContent');
    assert.match(error, /打开工程文件失败/);
    assert.equal(await win.webContents.executeJavaScript('window.__codenodeProject.getState().root'), null);
    console.log('PROJECT UI TEST: PASS');
    process.exitCode = 0;
    app.quit();
  } catch (error) {
    console.error('PROJECT UI TEST: FAIL', error);
    process.exitCode = 1;
    app.quit();
  }
});

app.on('will-quit', () => {
  dialog.showSaveDialog = originalSaveDialog;
  dialog.showOpenDialog = originalOpenDialog;
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-project-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
