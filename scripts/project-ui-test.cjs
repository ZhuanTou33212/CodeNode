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
    ipcMain.handle('agent:chat', async (_event, payload) => { firstSendCalls++; assert.equal(payload.prompt, '你好'); return await new Promise(resolve => { completeFirstSend = () => resolve({ok:true,reply:'你好，我能为你做什么？',reasoning:'',tools:[]}); }); });
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
    if(process.env.CODENODE_BATCH_ARCHIVE_TEST==='1'){
      const js=code=>win.webContents.executeJavaScript(code);win.showInactive();win.setSize(1300,850);
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})`);
      const archivedIds=await js(`(()=>{const ids=[];for(let i=0;i<3;i++){const ss=window.__codenodeSession.getState();ss.newCanvas();const id=window.__codenodeSession.getState().activeId;window.__codenodeSession.setState(s=>({sessions:{...s.sessions,[id]:{...s.sessions[id],label:'已归档聊天 '+(i+1)}}}));window.__codenodeSession.getState().pushUser('旧消息 '+i);window.__codenodeSession.getState().setArchived(id,true);ids.push(id)}return ids})()`);
      const activeId=await js(`window.__codenodeSession.getState().activeId`);
      assert.equal(await js(`window.__codenodeSession.getState().deleteArchivedSessions([${JSON.stringify(archivedIds[0])},${JSON.stringify(activeId)}])`),false);
      assert.equal(await js(`Object.values(window.__codenodeSession.getState().sessions).filter(session=>session.archived).length`),3);
      await js(`window.__codenodeUi.getState().openSettings('archived')`);await sleep(100);
      await js(`document.querySelector('[aria-label="全选归档聊天"]').click()`);await sleep(80);
      assert.equal(await js(`document.querySelectorAll('.archived-chat-choice input:checked').length`),3);
      await js(`document.querySelector('[aria-label="删除选中的归档聊天"]').click()`);await sleep(60);
      assert.ok(await js(`document.querySelector('.archive-delete-dialog h3').textContent.includes('3 个聊天')`));
      await js(`document.querySelector('.archive-delete-dialog button').click()`);await sleep(60);
      assert.equal(await js(`Object.values(window.__codenodeSession.getState().sessions).filter(session=>session.archived).length`),3);
      await js(`document.querySelectorAll('.archived-chat-choice input')[2].click()`);await sleep(60);
      assert.equal(await js(`document.querySelector('[aria-label="全选归档聊天"]').indeterminate`),true);
      ipcMain.removeHandler('project:save');let fail=true;
      ipcMain.handle('project:save',async(_event,target,payload)=>{if(fail)return {ok:false,error:'批量删除保存失败'};fs.writeFileSync(target,cnode.encodeCnode(payload));return {ok:true,filePath:target}});
      await js(`document.querySelector('[aria-label="删除选中的归档聊天"]').click()`);await sleep(60);
      await js(`document.querySelector('.archive-delete-dialog .archive-delete').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.archive-delete-error')`),'批量删除失败回退');
      assert.equal(await js(`Object.values(window.__codenodeSession.getState().sessions).filter(session=>session.archived).length`),3);
      assert.equal(await js(`document.querySelectorAll('.archived-chat-choice input:checked').length`),2);
      fail=false;await js(`document.querySelector('.archive-delete-dialog .archive-delete').click()`);
      await waitFor(async()=>await js(`!document.querySelector('.archive-delete-dialog')`),'批量删除成功');
      const remaining=await js(`window.__codenodeSession.getState().order`);
      assert.ok(!remaining.includes(archivedIds[0])&&!remaining.includes(archivedIds[1]));assert.ok(remaining.includes(archivedIds[2])&&remaining.includes(activeId));
      for(const theme of ['light','dark']){await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(350);assert.ok(await js(`document.querySelector('.archive-bulk-toolbar')!==null`));}
      await js(`window.__codenodeUi.getState().closeSettings()`);win.webContents.reload();await sleep(350);await js(`document.querySelector('.gate-recent-item').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.activity-bar')`),'批量删除后重开项目');
      const saved=cnode.decodeCnode(fs.readFileSync(projectFile));assert.ok(!saved.canvases.sessions.some(session=>archivedIds.slice(0,2).includes(session.id)));assert.ok(saved.canvases.sessions.some(session=>session.id===archivedIds[2]));
      console.log('BATCH ARCHIVE UI: PASS (select/all/partial, count confirmation, cancel, all-or-nothing guard, failure rollback, preserve unselected/active, reload persistence, both themes)');
    }
    if (process.env.CODENODE_VECTOR_ARCHIVE_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.showInactive();win.setSize(1300,850);await sleep(100);
      await js(`window.__codenodeUi.getState().openSettings('rag')`);
      await waitFor(async()=>await js(`!!document.querySelector('[aria-label="向量存储"]')`),'向量存储设置');await sleep(100);
      assert.equal(await js(`document.querySelector('[aria-label="向量存储"]').disabled`),false);
      assert.deepEqual(await js(`[...document.querySelector('[aria-label="向量存储"]').options].map(option=>option.value)`),['memory','sqlite','milvus']);
      await js(`const select=document.querySelector('[aria-label="向量存储"]');select.value='sqlite';select.dispatchEvent(new Event('change',{bubbles:true}))`);await sleep(80);
      await js(`document.querySelector('.dock-rag-actions .dock-primary').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.dock-rag-success')`),'保存 SQLite 选择');
      assert.match(fs.readFileSync(path.join(root,'.codenode','agent.properties'),'utf8'),/rag.vector_store=sqlite/);
      await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('rag')`);await sleep(150);
      assert.equal(await js(`document.querySelector('[aria-label="向量存储"]').value`),'sqlite');
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false});window.__codenodeUi.getState().closeSettings();window.__codenodeSession.getState().pushUser('要删除的旧聊天');window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().finishTurn('归档示例','',[])`);
      const archivedId=await js(`window.__codenodeSession.getState().activeId`);
      await js(`window.__codenodeSession.getState().setArchived(${JSON.stringify(archivedId)},true);window.__codenodeSession.getState().newCanvas();window.__codenodeSession.getState().pushUser('必须保留的聊天')`);await sleep(100);
      const activeId=await js(`window.__codenodeSession.getState().activeId`);
      assert.notEqual(activeId,archivedId);
      assert.equal(await js(`window.__codenodeSession.getState().deleteArchivedSession(${JSON.stringify(activeId)})`),false);
      await js(`window.__codenodeUi.getState().openSettings('archived')`);await sleep(100);
      await js(`document.querySelector('.archived-chat-row .archive-delete').click()`);await sleep(80);
      assert.ok(await js(`document.querySelector('[role="alertdialog"]').textContent.includes('永久删除')`));
      await js(`document.querySelector('.archive-delete-dialog button').click()`);await sleep(60);
      assert.equal(await js(`!!window.__codenodeSession.getState().sessions[${JSON.stringify(archivedId)}]`),true);
      await js(`document.querySelector('.archived-chat-row .archive-delete').click()`);await sleep(60);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','out','archive-delete-confirm.png'),(await win.webContents.capturePage()).toPNG());
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:true,autoSaveDelayMs:500})`);await sleep(80);
      ipcMain.removeHandler('project:save');let writeFails=true;
      ipcMain.handle('project:save',async(_event,target,payload)=>{if(writeFails)return {ok:false,error:'模拟保存失败'};fs.writeFileSync(target,cnode.encodeCnode(payload));return {ok:true,filePath:target};});
      await js(`document.querySelector('.archive-delete-dialog .archive-delete').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.archive-delete-error')`),'删除失败保留聊天');
      assert.equal(await js(`!!window.__codenodeSession.getState().sessions[${JSON.stringify(archivedId)}]`),true);
      await sleep(650);assert.equal(await js(`!!window.__codenodeSession.getState().sessions[${JSON.stringify(archivedId)}]`),true);
      writeFails=false;
      await js(`document.querySelector('.archive-delete-dialog .archive-delete').click()`);
      await waitFor(async()=>await js(`!document.querySelector('.archive-delete-dialog')`),'永久删除成功');
      const saved=cnode.decodeCnode(fs.readFileSync(projectFile));
      assert.ok(!saved.canvases.sessions.some(session=>session.id===archivedId));
      assert.ok(saved.canvases.sessions.some(session=>session.id===activeId));
      assert.equal(await js(`window.__codenodeSession.getState().messages.some(message=>message.content==='必须保留的聊天')`),true);
      await js(`window.__codenodeUi.getState().closeSettings()`);
      win.webContents.reload();await sleep(350);
      await js(`document.querySelector('.gate-recent-item').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.activity-bar')`),'重新打开项目');
      assert.equal(await js(`!!window.__codenodeSession.getState().sessions[${JSON.stringify(archivedId)}]`),false);
      await js(`window.__codenodeUi.getState().openSettings('rag')`);await sleep(120);
      assert.equal(await js(`document.querySelector('[aria-label="向量存储"]').value`),'sqlite');
      await js(`window.__codenodeUi.getState().closeSettings()`);
      await js(`window.__codenodeSession.setState({streaming:true})`);
      assert.equal(await js(`window.__codenodeSession.getState().deleteArchivedSession(${JSON.stringify(activeId)})`),false);
      await js(`window.__codenodeSession.setState({streaming:false});window.__codenodeSession.getState().setArchived(${JSON.stringify(activeId)},true);window.__codenodeUi.getState().openSettings('archived')`);await sleep(80);
      await js(`document.querySelector('.archived-chat-row .archive-delete').click()`);await sleep(50);await js(`document.querySelector('.archive-delete-dialog .archive-delete').click()`);
      await waitFor(async()=>await js(`window.__codenodeSession.getState().order.length===0&&!document.querySelector('.archive-delete-dialog')`),'删除最后一条归档聊天');
      assert.deepEqual(cnode.decodeCnode(fs.readFileSync(projectFile)).canvases.messages,[]);
      await js(`window.__codenodeUi.getState().closeSettings()`);
      console.log('VECTOR AND ARCHIVE UI: PASS (all backend choices, BM25 preserves SQLite, reload persistence, delete confirmation/cancel, failed-save rollback, active chat guard, permanent deletion persisted)');
    }
    if (process.env.CODENODE_SIMPLIFIED_WORKBENCH_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.showInactive();win.setSize(1300,850);await sleep(100);
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:true,autoSaveDelayMs:500});window.__codenodeUi.setState({theme:'light'})`);await sleep(80);
      assert.equal(await js(`!!document.querySelector('.toolbar-save') || !!document.querySelector('.toolbar-run')`),false);
      await js(`window.__codenodeSession.setState({intentVerdict:{intent:'chat',risk:'low',authorization:'high',confidence:.95,reason:'普通问候',source:'model',tighten:false}})`);
      assert.equal(await js(`!!document.querySelector('.conversation-right .ap-intent')`),false);
      await js(`document.querySelector('.toolbar-dropdown summary').click()`);await sleep(60);
      assert.equal(await js(`document.querySelector('[data-action="workflow"]').disabled`),true);
      await js(`document.querySelector('.toolbar-dropdown summary').click();window.__codenodeStore.getState().addNode({id:'auto-task',type:'task',position:{x:40,y:50},data:{label:'自动保存测试',prompt:'整理当前项目结构'}});window.__codenodeStore.getState().setSelectedIds([])`);
      await waitFor(async()=>cnode.decodeCnode(fs.readFileSync(projectFile)).graph.nodes.some(node=>node.id==='auto-task'),'画布自动保存');
      await waitFor(async()=>await js(`document.querySelector('.toolbar-save-state').textContent==='已保存'`),'已保存状态');
      await js(`window.__codenodeSession.getState().pushUser('自动保存对话测试');window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().finishTurn('已收到。','',[])`);
      await waitFor(async()=>cnode.decodeCnode(fs.readFileSync(projectFile)).canvases.messages.some(message=>message.content==='已收到。'),'会话自动保存');
      for(const theme of ['light','dark']) {
        await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(350);
        fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','out','simplified-workbench-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      let executions=0;ipcMain.removeHandler('project:workflow-execute');ipcMain.handle('project:workflow-execute',()=>{executions++;return {ok:false,error:'不应自动执行'}});
      await js(`document.querySelector('.toolbar-dropdown summary').click();document.querySelector('[data-action="workflow"]').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.workflow-scope')`),'执行范围预览');
      assert.equal(executions,0);assert.ok(await js(`document.querySelector('.workflow-scope').textContent.includes('自动保存测试')`));
      assert.equal(await js(`document.querySelector('.run-diagnostics').open`),false);
      assert.equal(await js(`document.querySelector('.dock-run-toolbar .dock-primary').textContent`),'开始执行');
      await js(`window.__codenodeUi.getState().closeDock();window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})`);await sleep(100);
      const prior=fs.readFileSync(projectFile,'utf8');
      await js(`window.__codenodeStore.getState().updateNodeData('auto-task',{label:'关闭自动保存后修改'})`);await sleep(750);
      assert.equal(fs.readFileSync(projectFile,'utf8'),prior);
      assert.equal(await js(`document.querySelector('.toolbar-save-state').textContent`),'未保存');
      await js(`document.querySelector('.toolbar-dropdown summary').click();[...document.querySelectorAll('.toolbar-menu button')].find(button=>button.textContent.includes('保存项目')).click()`);
      await waitFor(async()=>cnode.decodeCnode(fs.readFileSync(projectFile)).graph.nodes.some(node=>node.data.label==='关闭自动保存后修改'),'手动保存仍可用');
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:true})`);await sleep(80);
      ipcMain.removeHandler('project:save');let saveFails=true;const writeScopes=[];
      ipcMain.handle('project:save',async(_event,target,payload)=>{
        if(saveFails)return {ok:false,error:'模拟磁盘写入失败'};
        await sleep(250);fs.writeFileSync(target,cnode.encodeCnode(payload));writeScopes.push({target,label:payload.graph.nodes[0]?.data?.label});return {ok:true,filePath:target};
      });
      await js(`window.__codenodeStore.getState().updateNodeData('auto-task',{label:'失败必须显示'})`);
      await waitFor(async()=>await js(`document.querySelector('.toolbar-save-state').textContent==='保存失败'`),'写入失败状态');
      assert.ok(await js(`document.querySelector('.toolbar-save-state').title.includes('模拟磁盘写入失败')`));
      saveFails=false;
      await js(`document.querySelector('.toolbar-dropdown summary').click();[...document.querySelectorAll('.toolbar-menu button')].find(button=>button.textContent.includes('保存项目')).click()`);
      await waitFor(async()=>await js(`document.querySelector('.toolbar-save-state').textContent==='已保存'`),'失败后重试');
      await js(`window.__codenodeStore.getState().updateNodeData('auto-task',{label:'旧项目最后一份修改'})`);await sleep(50);
      await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(alternateRoot)})`);
      await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(alternateFile)});window.__codenodeStore.getState().clear()`);
      await waitFor(async()=>writeScopes.some(write=>write.target===projectFile&&write.label==='旧项目最后一份修改'),'切换项目前保留待保存快照');
      assert.equal(await js(`window.__codenodeProject.getState().projectFile`),alternateFile);
      assert.ok(!writeScopes.some(write=>write.target===alternateFile&&write.label==='旧项目最后一份修改'));
      await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false});window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
      await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);await sleep(80);
      console.log('SIMPLIFIED WORKBENCH: PASS (autosave graph/conversation, disabled setting, manual save, failure/retry, project-switch isolation, workflow preview only, hidden intent, both themes)');
    }
    if (process.env.CODENODE_PLUGIN_RAIL_UI_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.setSize(1300,850);win.showInactive();await sleep(100);
      await js(`window.__codenodeUi.setState({navigationOpen:true});const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'离开工作台也要保留这份草稿');input.dispatchEvent(new Event('input',{bubbles:true}));window.__codenodeStore.getState().addNode({id:'rail-test-node',type:'task',position:{x:60,y:70},data:{label:'保留节点'}});window.__codenodeStore.getState().setSelectedIds([])`);await sleep(80);
      const before=await js(`({messages:window.__codenodeSession.getState().messages,model:document.querySelector('.pp-model').textContent,nodes:window.__codenodeStore.getState().nodes})`);
      const rail=await js(`(() => {const r=document.querySelector('.activity-bar').getBoundingClientRect();return {x:r.x,width:r.width,height:r.height,h:innerHeight}})()`);
      assert.equal(rail.x,0);assert.equal(rail.width,48);assert.ok(Math.abs(rail.height-rail.h)<1);
      for(const theme of ['light','dark']) {
        await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}});document.querySelector('.activity-bar button[aria-label="插件"]').click()`);await sleep(350);
        assert.equal(await js(`!!document.querySelector('.settings-mask')`),false);
        assert.equal(await js(`getComputedStyle(document.querySelector('.workspace-main')).visibility`),'hidden');
        assert.equal(await js(`getComputedStyle(document.querySelector('.app-workbench-toolbar')).display`),'none');
        assert.ok(await js(`document.querySelector('.plugin-navigation').textContent.includes('自定义')`));
        const layout=await js(`(() => {const rail=document.querySelector('.activity-bar').getBoundingClientRect(),nav=document.querySelector('.plugin-navigation').getBoundingClientRect(),page=document.querySelector('.plugin-page').getBoundingClientRect();return {railRight:rail.right,navX:nav.x,navRight:nav.right,pageX:page.x,pageW:page.width,viewport:innerWidth,pageR:page.right}})()`);
        assert.equal(layout.navX,layout.railRight);assert.equal(layout.pageX,layout.navRight);assert.ok(Math.abs(layout.pageR-layout.viewport)<1);
        fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','out','plugin-rail-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
        await js(`document.querySelector('.plugin-navigation button[aria-pressed="false"]').click()`);await sleep(80);
        assert.equal(await js(`document.querySelector('.extensions-heading h2').textContent`),'技能');
        await js(`document.querySelector('.extensions-add').click()`);await sleep(80);
        assert.equal(await js(`document.querySelector('[aria-label="扩展类型"]').value`),'skills');
        await js(`document.querySelector('.extension-connect-head button').click();document.querySelector('.toolbar-navigation-toggle').click()`);await sleep(80);
        assert.equal(await js(`!!document.querySelector('.plugin-navigation')`),false);
        await js(`document.querySelector('.toolbar-navigation-toggle').click();document.querySelector('.activity-bar button[aria-label="工作台"]').click()`);await sleep(80);
        assert.equal(await js(`document.querySelector('.pp-input').value`),'离开工作台也要保留这份草稿');
        assert.deepEqual(await js(`({messages:window.__codenodeSession.getState().messages,model:document.querySelector('.pp-model').textContent,nodes:window.__codenodeStore.getState().nodes})`),before);
        await js(`document.querySelector('.activity-bar button[aria-label="全局设置"]').click()`);await sleep(60);
        assert.equal(await js(`!![...document.querySelectorAll('.settings-layout nav button')].find(button=>button.textContent==='插件'||button.textContent==='扩展')`),false);
        await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().setPluginView('plugins')`);await sleep(60);
      }
      for(const width of [700,500]) {
        win.setSize(width,740);await sleep(150);
        assert.equal(await js(`document.querySelector('.plugin-page').scrollWidth>document.querySelector('.plugin-page').clientWidth`),false);
        assert.ok(await js(`document.querySelector('.activity-bar button[aria-label="插件"]').getBoundingClientRect().width`)>0);
      }
      win.setSize(1300,850);await js(`window.__codenodeUi.getState().setAppPage('workbench');window.__codenodeStore.getState().clear()`);await sleep(100);
      console.log('PLUGIN RAIL UI: PASS (full-height narrow rail, independent page, secondary sidebar, Skills, no settings duplication, retained draft/session/model/canvas, themes and narrow layouts)');
    }
    if (process.env.CODENODE_EXTENSION_CONNECT_UI_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.setSize(1300,850);win.showInactive();
      await js(`window.__codenodeUi.getState().openSettings('extensions')`);
      await waitFor(async()=>await js(`!!document.querySelector('.extension-connector')`),'插件接入入口');
      assert.equal(await js(`getComputedStyle(document.querySelector('.extensions-connect-grid')).gridTemplateColumns.split(' ').length`),2);
      const fill=async(label,value)=>await js(`(() => {const input=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await js(`document.querySelector('.extensions-add').click()`);await sleep(80);
      await fill('扩展名称','ui-command');await fill('扩展启动命令','node tools/helper.cjs');await fill('扩展用途','处理项目文件');
      await js(`document.querySelector('.extension-connect button[type="submit"]').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.extensions-notice')`),'扩展保存成功');
      const manifest=path.join(root,'.codenode','extensions.json');
      assert.equal(JSON.parse(fs.readFileSync(manifest,'utf8')).extensions[0].name,'ui-command');
      await waitFor(async()=>await js(`document.querySelector('.extensions-installed')?.textContent.includes('ui-command')`),'已接入列表自动刷新');
      await js(`[...document.querySelectorAll('.plugin-navigation nav button')].find(button=>button.textContent.includes('技能')).click()`);await sleep(80);await js(`document.querySelector('.extensions-add').click()`);await sleep(80);
      await fill('扩展名称','ui-skill');await fill('Skill 指令','分析任务时先列出验证步骤。');
      await js(`document.querySelector('.extension-connect button[type="submit"]').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.extensions-notice') && !document.querySelector('.extension-connect')`),'Skill 保存成功');
      assert.equal(JSON.parse(fs.readFileSync(manifest,'utf8')).extensions.length,2);
      await js(`[...document.querySelectorAll('.plugin-navigation nav button')].find(button=>button.textContent.includes('插件')).click()`);await sleep(80);
      await js(`document.querySelector('.extensions-add').click()`);await sleep(80);
      await fill('扩展名称','ui-command');await fill('扩展启动命令','node x');
      await js(`document.querySelector('.extension-connect button[type="submit"]').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.extension-connect-error')`),'重名提示');
      assert.equal(JSON.parse(fs.readFileSync(manifest,'utf8')).extensions.length,2);
      await js(`[...document.querySelectorAll('.extension-connect-modes button')].find(button=>button.textContent.includes('粘贴')).click()`);await sleep(60);
      await fill('扩展配置',JSON.stringify({name:'ui-import',command:'node tools/import.cjs'}));
      await js(`document.querySelector('.extension-connect button[type="submit"]').click()`);
      await waitFor(async()=>await js(`!document.querySelector('.extension-connect')`),'配置导入成功');
      assert.equal(JSON.parse(fs.readFileSync(manifest,'utf8')).extensions.length,3);
      for (const theme of ['light','dark']) {
        await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(350);
        fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','out','plugin-catalog-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await js(`document.querySelector('.extensions-add').click()`);await sleep(80);
      for (const width of [700,500]) {win.setSize(width,740);await sleep(150);assert.equal(await js(`document.querySelector('.plugin-page').scrollWidth>document.querySelector('.plugin-page').clientWidth`),false);}
      await js(`window.__codenodeUi.getState().setAppPage('workbench')`);win.setSize(1300,850);await sleep(80);
      console.log('EXTENSION CONNECT UI: PASS (two-column catalog, add form, Skill, import, duplicate rejection, saved manifest, automatic refresh, themes, narrow layouts)');
    }
    if (process.env.CODENODE_EXTENSIONS_UI_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.setSize(1300,850);win.showInactive();
      await js(`window.__codenodeUi.getState().openSettings('extensions')`);
      await waitFor(async()=>await js(`document.querySelectorAll('.extension-entry').length>0`),'扩展列表');
      const original=await js(`window.codenode.listExtensions(${JSON.stringify(root)})`);
      const rows=await js(`document.querySelectorAll('.extension-entry').length`);
      assert.equal(rows,original.extensions.length);
      for (const theme of ['light','dark']) {
        await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(350);
        assert.equal(await js(`document.documentElement.dataset.theme`),theme);
        console.log('EXTENSION THEME',theme,await js(`getComputedStyle(document.documentElement).getPropertyValue('--glass-text')`));
        const layout=await js(`(() => { const list=document.querySelector('.extensions-list'),rows=[...list.querySelectorAll('details')];return {rows:rows.length,expanded:rows.filter(row=>row.open).length,maxHeight:Math.max(...rows.map(row=>row.getBoundingClientRect().height)),overflow:getComputedStyle(list).overflowY,nested:[...document.querySelectorAll('.plugin-page-content *')].filter(el=>['auto','scroll'].includes(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight).length};})()`);
        assert.equal(layout.expanded,0);assert.ok(layout.maxHeight<90);assert.equal(layout.nested,0);
        fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
        fs.writeFileSync(path.join(__dirname,'..','out','extensions-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await js(`(() => {const input=document.querySelector('[aria-label="搜索扩展与工具"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'workbench_edit');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(80);
      assert.equal(await js(`document.querySelectorAll('.extension-entry').length`),1);
      await js(`document.querySelector('.extension-entry summary').click()`);await sleep(80);
      assert.equal(await js(`document.querySelector('.extension-entry').open`),true);
      assert.ok(await js(`document.querySelector('.extension-detail p').textContent.length`)>200);
      await js(`document.querySelector('[data-category="mcp"]').click()`);await sleep(80);
      assert.equal(await js(`!!document.querySelector('.extensions-empty')`),true);
      await js(`document.querySelector('.extensions-empty button').click()`);await sleep(80);
      ipcMain.removeHandler('extensions:list');
      let fixtureError=true;
      ipcMain.handle('extensions:list',async()=>fixtureError ? {ok:false,error:'测试读取失败'} : {ok:true,extensions:[...original.extensions,{name:'demo-mcp',kind:'mcp',description:'用于验证登记信息展示',enabled:false,source:'fixture'}]});
      await js(`document.querySelector('.extensions-refresh').click()`);
      await waitFor(async()=>await js(`!!document.querySelector('.extensions-empty[role="alert"]')`),'读取失败提示');
      fixtureError=false;
      await js(`document.querySelector('.extensions-empty button').click()`);
      await waitFor(async()=>await js(`document.querySelectorAll('.extension-entry').length===${rows+1}`),'重试刷新');
      await js(`document.querySelector('[data-category="mcp"]').click()`);await sleep(80);
      assert.equal(await js(`document.querySelectorAll('.extension-entry').length`),1);
      assert.equal(await js(`document.querySelector('.extension-state').textContent`),'已停用');
      for (const width of [700,500]) {
        win.setSize(width,740);await sleep(150);
        const overflow=await js(`(() => {const el=document.querySelector('.plugin-page');return el.scrollWidth>el.clientWidth})()`);
        assert.equal(overflow,false,'extension controls must fit at '+width);
      }
      await js(`window.__codenodeUi.getState().setAppPage('workbench')`);win.setSize(1300,850);await sleep(80);
      console.log('EXTENSIONS UI: PASS (actual counts, summaries, search, filters, details, error/retry, disabled state, one scroll, both themes, narrow layouts)');
    }
    if (process.env.CODENODE_NIGHT_PALETTE_UI_TEST === '1') {
      const js=code=>win.webContents.executeJavaScript(code);
      win.setSize(1300,850); win.showInactive();
      await js(`window.__codenodeUi.setState({theme:'dark',navigationOpen:true,conversationOpen:true})`);await sleep(150);
      assert.equal(await js(`getComputedStyle(document.querySelector('.app')).backgroundColor`),'rgb(23, 25, 29)');
      await js(`window.__codenodeSession.getState().pushUser('这个项目可以做什么？');window.__codenodeSession.getState().beginTurn();window.__codenodeSession.getState().finishTurn('可以在这里查看项目文件、编辑代码，或在画布中整理任务。告诉我具体需求，我们就可以开始。','',[])`);await sleep(100);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      fs.writeFileSync(path.join(__dirname,'..','out','night-graphite-workspace.png'),(await win.webContents.capturePage()).toPNG());
      await js(`window.__codenodeUi.getState().openSettings()`);await sleep(100);
      fs.writeFileSync(path.join(__dirname,'..','out','night-graphite-settings.png'),(await win.webContents.capturePage()).toPNG());
      assert.equal(await js(`!!document.querySelector('[aria-label="夜间配色"]')`),false);
      await js(`localStorage.setItem('codenode.uiPreferences',JSON.stringify({...window.__codenodeUi.getState().preferences,nightPalette:'blue'}))`);
      win.webContents.reload(); await sleep(400);
      await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
      await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
      await sleep(100);
      assert.equal(await js(`getComputedStyle(document.querySelector('.app')).backgroundColor`),'rgb(23, 25, 29)');
      assert.equal(await js(`'nightPalette' in JSON.parse(localStorage.getItem('codenode.uiPreferences'))`),false);
      await js(`window.__codenodeUi.getState().toggleTheme()`);await sleep(60);
      assert.equal(await js(`document.documentElement.dataset.theme`),'light');
      await js(`window.__codenodeUi.getState().toggleTheme()`);await sleep(60);
      assert.equal(await js(`getComputedStyle(document.querySelector('.app')).backgroundColor`),'rgb(23, 25, 29)');
      console.log('NIGHT THEME UI: PASS (single appearance toggle, obsolete palette migration, neutral night theme)');
    }
    if (process.env.CODENODE_UI_PREFERENCES_TEST === '1') {
      const js = code => win.webContents.executeJavaScript(code);
      win.showInactive();
      await js(`window.__codenodeUi.getState().openSettings()`); await sleep(100);
      await js(`(() => {const input=document.querySelector('input[aria-label="菜单宽度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'280');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await js(`(() => {const label=[...document.querySelectorAll('.settings-row')].find(el=>el.textContent==='显示快捷键提示');label.querySelector('input').click()})()`); await sleep(80);
      assert.equal(await js(`window.__codenodeUi.getState().preferences.menuWidth`),280);
      assert.equal(await js(`window.__codenodeUi.getState().preferences.showShortcuts`),false);
      await js(`window.__codenodeUi.getState().updatePreferences({menuRowHeight:40,showGroupLabels:false,visibleActions:['terminal','duplicate'],hideDisabledActions:true,autoCollapseSidebars:false});window.__codenodeUi.getState().closeSettings();document.querySelector('.toolbar-dropdown').open=true`); await sleep(100);
      const configured=await js(`(() => {const menu=document.querySelector('.toolbar-menu');return {width:menu.getBoundingClientRect().width,labels:menu.querySelectorAll('.toolbar-menu-label').length,shortcuts:menu.querySelectorAll('kbd').length,ids:[...menu.querySelectorAll('[data-action]')].map(el=>el.dataset.action),height:menu.querySelector('[data-action]').getBoundingClientRect().height};})()`);
      assert.deepEqual(configured,{width:280,labels:0,shortcuts:0,ids:['terminal'],height:40});
      const saved=await js(`JSON.stringify(window.__codenodeUi.getState().preferences)`);
      await js(`window.__codenodeUi.getState().toggleTheme()`); await sleep(80);
      assert.equal(await js(`JSON.stringify(window.__codenodeUi.getState().preferences)`),saved);
      win.webContents.reload(); await sleep(400);
      await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
      await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
      await waitFor(async()=>await js(`!!document.querySelector('.toolbar-navigation-toggle')`).catch(()=>false),'配置重新加载');
      assert.equal(await js(`JSON.stringify(window.__codenodeUi.getState().preferences)`),saved);
      await js(`window.__codenodeUi.getState().resetPreferences();window.__codenodeUi.setState({theme:'light',navigationOpen:true,conversationOpen:true})`); await sleep(80);
      assert.equal(await js(`window.__codenodeUi.getState().preferences.menuWidth`),220);
      await js(`localStorage.setItem('codenode.uiPreferences',JSON.stringify({menuWidth:99999,menuRowHeight:'oops',visibleActions:['unknown','terminal','terminal']}))`);
      win.webContents.reload(); await sleep(400);
      await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
      await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
      await waitFor(async()=>await js(`!!document.querySelector('.toolbar-navigation-toggle')`).catch(()=>false),'异常配置恢复');
      const sanitized=await js(`window.__codenodeUi.getState().preferences`);
      assert.equal(sanitized.menuWidth,360); assert.equal(sanitized.menuRowHeight,34);assert.deepEqual(sanitized.visibleActions,['terminal','workflow']);
      await js(`window.__codenodeUi.getState().resetPreferences()`);
      console.log('UI PREFERENCES: PASS (settings controls, immediate menu changes, reload persistence, shared themes, defaults, validation)');
    }
    if (process.env.CODENODE_THEME_PARITY_UI_TEST === '1') {
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll(".workspace-tabs").length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll(".activity-bar button[aria-label=文件]").length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll(".conversation-toggle").length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll(".conversation-head button").length`),0);
      const js = code => win.webContents.executeJavaScript(code);
      win.setSize(1300,850); win.showInactive(); await sleep(150);
      await js(`window.__codenodeUi.setState({theme:'light',navigationOpen:true,conversationOpen:true}); const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'切换主题保留草稿');input.dispatchEvent(new Event('input',{bubbles:true}));`);
      await sleep(100);
      for (const navigationOpen of [true,false]) {
        for (const conversationOpen of [true,false]) {
          await js(`window.__codenodeUi.setState({theme:'light',navigationOpen:${navigationOpen},conversationOpen:${conversationOpen}});document.querySelector('.toolbar-dropdown').open=true`);
          await sleep(100);
          const snapshot = `(() => {
            const ui=window.__codenodeUi.getState(), ss=window.__codenodeSession.getState();
            const selectors=['.toolbar','.toolbar-navigation-toggle','.project-navigation','.workspace-tabs','.conversation-right','.pp-composer','.toolbar-menu'];
            return {state:{navigationOpen:ui.navigationOpen,conversationOpen:ui.conversationOpen,navigationWidth:ui.navigationWidth,conversationWidth:ui.conversationWidth,sideTab:ui.sideTab,activeId:ss.activeId,messages:ss.messages},
              draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model').textContent,
              controls:[...document.querySelectorAll('.toolbar button,.toolbar summary,.toolbar-menu-label')].map(el=>({text:el.textContent,label:el.getAttribute('aria-label'),disabled:!!el.disabled,expanded:el.getAttribute('aria-expanded')})),
              layout:selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {selector,x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,position:s.position,visibility:s.visibility,pointerEvents:s.pointerEvents}})};
          })()`;
          const day=await js(snapshot);
          const dayColor=await js(`getComputedStyle(document.querySelector('.toolbar-menu')).backgroundColor`);
          await js(`window.__codenodeUi.getState().toggleTheme()`); await sleep(100);
          assert.deepEqual(await js(snapshot),day,'theme must preserve layout, controls and work state');
          assert.notEqual(await js(`getComputedStyle(document.querySelector('.toolbar-menu')).backgroundColor`),dayColor);
          assert.equal(await js(`localStorage.getItem('codenode.theme')`),'dark');
          for (const theme of ['dark','light']) {
            assert.equal(await js(`document.documentElement.dataset.theme`),theme);
            await js(`document.querySelector('.toolbar-navigation-toggle').click()`); await sleep(60);
            assert.equal(await js(`window.__codenodeUi.getState().navigationOpen`),!navigationOpen);
            await js(`document.querySelector('.toolbar-navigation-toggle').click();document.querySelector('.conversation-toggle').click()`); await sleep(60);
            assert.equal(await js(`window.__codenodeUi.getState().conversationOpen`),!conversationOpen);
            await js(`document.querySelector('.conversation-toggle').click()`);
            await js(`window.__codenodeUi.getState().toggleTheme()`); await sleep(80);
          }
          await js(`document.querySelector('.toolbar-dropdown').open=false`);
        }
      }
      await js(`window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,theme:'light'})`);
      console.log('THEME PARITY UI: PASS (same DOM, geometry, controls, sidebar actions, draft, model, session and persistence)');
    }
    if (process.env.CODENODE_CANVAS_MENU_UI_TEST === '1') {
      const js = code => win.webContents.executeJavaScript(code);
      assert.equal(await js(`document.querySelectorAll('.toolbar-navigation-toggle').length`),1);
      assert.equal(await js(`!!document.querySelector('.project-nav-toggle') || !!document.querySelector('[aria-label="收起项目导航"]')`),false);
      await js(`window.__codenodeUi.setState({navigationOpen:true})`);
      await sleep(80);
      await js(`document.querySelector('.toolbar-navigation-toggle').click()`);
      await sleep(80);
      assert.equal(await js(`!!document.querySelector('.project-navigation')`),false);
      assert.equal(await js(`document.querySelector('.toolbar-navigation-toggle').getAttribute('aria-label')`),'显示侧边栏');
      await js(`document.querySelector('.toolbar-navigation-toggle').click()`);
      await sleep(80);
      assert.equal(await js(`!!document.querySelector('.project-navigation')`),true);
      assert.equal(await js(`document.querySelector('.toolbar-navigation-toggle').getAttribute('aria-expanded')`),'true');
      for (const theme of ['light', 'dark']) {
        for (const width of [1300, 500, 360]) {
          win.setSize(width, 800); win.showInactive();
          await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
          await sleep(100);
          await js(`document.querySelector('.toolbar-dropdown').open=false`);
          await js(`document.querySelector('.toolbar-dropdown summary').click()`);
          await sleep(100);
          const menu = await js(`(() => {
            const el=document.querySelector('.toolbar-menu'), r=el.getBoundingClientRect(), s=getComputedStyle(el);
            const buttons=[...el.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().height);
            return {left:r.left,right:r.right,bottom:r.bottom,width:r.width,background:s.backgroundColor,
              rows:buttons.map(b=>b.getBoundingClientRect().height),labels:[...el.querySelectorAll('.toolbar-menu-label')].map(b=>b.textContent),
              copyDisabled:buttons.find(b=>b.textContent.includes('复制节点')).disabled,
              manualSaveVisible:[...el.querySelectorAll('button')].some(button=>button.textContent.includes('保存项目')&&button.getBoundingClientRect().height>0)};
          })()`);
          assert.equal(menu.width, 220);
          assert.ok(menu.left>=0 && menu.right<=width && menu.bottom<=800, JSON.stringify(menu));
          assert.ok(!menu.background.startsWith('rgba'), 'menu surface must be opaque');
          assert.ok(menu.rows.every(height=>height===34), JSON.stringify(menu.rows));
          assert.deepEqual(menu.labels, ['工作流','节点','布局','视图','工具与历史']);
          assert.equal(menu.copyDisabled,true);
          assert.equal(menu.manualSaveVisible,true, JSON.stringify({width,menu}));
          if (width===1300) {
            win.showInactive(); await sleep(150);
            const bounds=await js(`(() => { const r=document.querySelector('.toolbar-menu').getBoundingClientRect();return {x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16};})()`);
            fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
            fs.writeFileSync(path.join(__dirname,'..','out','canvas-menu-'+theme+'.png'),(await win.webContents.capturePage(bounds)).toPNG());

          }
          await js(`document.querySelector('.toolbar-menu button:not(:disabled)').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
          assert.equal(await js(`document.querySelector('.toolbar-dropdown').open`),false);
          assert.equal(await js(`document.activeElement===document.querySelector('.toolbar-dropdown summary')`),true);
        }
      }
      win.setSize(1300,850);
      await js(`window.__codenodeStore.getState().addNode({id:'menu-node',type:'task',position:{x:50,y:50},data:{label:'菜单验证'}});window.__codenodeStore.getState().setSelectedIds(['menu-node'])`);
      await sleep(100);
      await js(`document.querySelector('.toolbar-dropdown summary').click()`);
      await sleep(100);
      assert.equal(await js(`document.querySelector('.toolbar-menu button[data-action="duplicate"]').disabled`),false);
      await js(`document.querySelector('.toolbar-menu button[data-action="duplicate"]').click()`);
      assert.equal(await js(`window.__codenodeStore.getState().nodes.length`),2);
      assert.equal(await js(`document.querySelector('.toolbar-dropdown').open`),false);
      await js(`document.querySelector('.toolbar-dropdown summary').click();document.querySelector('.toolbar-save-state').dispatchEvent(new Event('pointerdown',{bubbles:true}))`);
      assert.equal(await js(`document.querySelector('.toolbar-dropdown').open`),false);
      await js(`window.__codenodeStore.getState().clear()`);
      console.log('CANVAS MENU UI: PASS (both themes, three widths, disabled state, copy, dismissal, keyboard focus)');
    }
    if (process.env.CODENODE_RESPONSIVE_UI_TEST === '1') {
      for (const theme of ['light','dark']) {
        await win.webContents.executeJavaScript('window.__codenodeUi.setState({theme:'+JSON.stringify(theme)+'})');
        for (const [width,height] of [[1920,1080],[1280,800],[1024,700],[820,640],[520,600]]) {
          await win.webContents.executeJavaScript('document.activeElement?.blur()');
          win.setSize(width,height); await sleep(200);
          if (await win.webContents.executeJavaScript('document.querySelector(".conversation-right").hidden')) await win.webContents.executeJavaScript('document.querySelector(".conversation-toggle").click()');
          await sleep(80);
          const layout = await win.webContents.executeJavaScript(`(() => {const pane=document.querySelector('.conversation-right'),p=pane.getBoundingClientRect(),input=document.querySelector('.pp-composer').getBoundingClientRect(),canvas=document.querySelector('.canvas-wrap').getBoundingClientRect(),toolbar=document.querySelector('.toolbar'),workspace=document.querySelector('.workspace-main').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth||toolbar.scrollWidth>toolbar.clientWidth,contained:input.left>=p.left&&input.right<=p.right+1&&input.bottom<=p.bottom+1,mode:getComputedStyle(pane).position,canvas:canvas.width,overlap:canvas.right>p.left+1,workspace:workspace.width,pane:p.width};})()`);
          assert.ok(!layout.overflow && layout.contained, 'responsive controls at '+theme+' '+width+'x'+height+': '+JSON.stringify(layout));
          if (layout.mode==='relative') assert.ok(layout.canvas>=278 && !layout.overlap, 'docked sidebars preserve the canvas');
          else assert.ok(layout.workspace<=660 && layout.pane<=layout.workspace-18,'compact conversation floats within the workspace');
        }
      }
      win.setSize(1280,800); await sleep(150);
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().setNavigationWidth(400);window.__codenodeUi.getState().setConversationWidth(640);window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,conversationAutoHidden:false})');
      await sleep(150);
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".canvas-wrap").getBoundingClientRect().width')>=278,'largest sidebar widths must not squeeze away the canvas');
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().setNavigationWidth(216);window.__codenodeUi.getState().setConversationWidth(400)');
      win.setSize(520,600); await sleep(200);
      await win.webContents.executeJavaScript('window.__codenodeUi.setState({conversationOpen:false,conversationAutoHidden:false})');
      await win.webContents.executeJavaScript('window.__codenodeUi.setState({navigationOpen:true,navigationAutoHidden:false})');
      await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".project-nav-new")'), '窄窗口展开项目栏');
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-new").click()');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".conversation-right").hidden'),false,'new chat must reveal the composer even in a narrow window');
      await win.webContents.executeJavaScript('window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,conversationAutoHidden:false})');
      win.setSize(1300,850); await sleep(100);
      console.log('RESPONSIVE WORKBENCH: PASS (five window sizes, both themes, maximum widths, new chat)');
    }
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
      await waitFor(async () => await win.webContents.executeJavaScript('!window.__codenodeSession.getState().streaming && document.querySelector(".ap-body").textContent.includes("你好，我能为你做什么？")'), '首次回复显示');
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
      await win.webContents.executeJavaScript('document.querySelector(".conversation-toggle").click()');
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
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".workspace-tabs button")).some(button=>button.textContent==="预览")'), false);
      fs.writeFileSync(path.join(root,'readme.txt'),'文件内容直接打开');
      await win.webContents.executeJavaScript('window.__codenodeProject.getState().refresh()');
      await win.webContents.executeJavaScript(`document.querySelector('.activity-bar button[aria-label="文件"]').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".files-explorer .pm-file")).some(row=>row.title==="readme.txt")'), '文件列表');
      await win.webContents.executeJavaScript(`document.querySelector('.files-explorer .pm-file[title="readme.txt"]').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".files-document .dock-code-editor")?.value==="文件内容直接打开"'), '点击文件直接显示内容');
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeUi.getState().sideTab'), 'project');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".activity-bar button[aria-current=page]").getAttribute("aria-label")'), '文件');
      win.showInactive(); await sleep(100);
      fs.mkdirSync(path.join(__dirname,'..','out'),{recursive:true});
      fs.writeFileSync(path.join(__dirname,'..','out','unified-file-view.png'),(await win.webContents.capturePage()).toPNG());
      win.hide();

      await win.webContents.executeJavaScript(`(() => {const editor=document.querySelector('.files-document .dock-code-editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'修改后的文件内容');editor.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(80);
      await win.webContents.executeJavaScript(`(() => {const editor=document.querySelector('.files-document .dock-code-editor');editor.focus();editor.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}));})()`);
      await waitFor(async () => fs.readFileSync(path.join(root,'readme.txt'),'utf8')==='修改后的文件内容', '文件页直接保存');
      for (const [width,height] of [[850,700],[520,600]]) {
        win.setSize(width,height); await sleep(200);
        const codeLayout = await win.webContents.executeJavaScript(`(() => {const area=document.querySelector('.files-document').getBoundingClientRect(),editor=document.querySelector('.dock-code-editor').getBoundingClientRect();return {height:editor.height,contained:editor.left>=area.left&&editor.right<=area.right+1&&editor.bottom<=area.bottom+1,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.ok(codeLayout.height>=60 && codeLayout.contained && !codeLayout.overflow, 'inline editor fits '+width+'x'+height+': '+JSON.stringify(codeLayout));
      }
      win.setSize(1300,850); await sleep(200);

      await win.webContents.executeJavaScript(`document.querySelector('.files-explorer .pm-file[title="created.cnode"]').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelector(".project-document-summary")?.textContent.includes("画布")'), '工程文件显示摘要');
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".files-document .dock-code-editor")'), false);
      const engineeringBytes = fs.readFileSync(projectFile);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeProject.getState().saveSelected()'),false);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeProject.getState().forceSaveSelected()'),false);
      const nativeSave = await win.webContents.executeJavaScript('window.codenode.writeProjectFile('+JSON.stringify(root)+',"created.cnode","invalid text")');
      assert.equal(nativeSave.ok,false);
      assert.ok(fs.readFileSync(projectFile).equals(engineeringBytes),'project container must retain its exact bytes');
      assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".toolbar button")).some(button=>button.textContent.trim()==="编辑")'),false);

      await win.webContents.executeJavaScript(`document.querySelector('.activity-bar button[aria-label="工作台"]').click()`);
      await sleep(80);
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
      const samePage = await win.webContents.executeJavaScript(`(() => { const canvas=document.querySelector('.canvas-wrap').getBoundingClientRect(), composer=document.querySelector('.pp-composer').getBoundingClientRect(), panel=document.querySelector('.conversation-right').getBoundingClientRect(); return {canvas:canvas.height,composer:composer.height,separated:canvas.right<=panel.left,mode:getComputedStyle(document.querySelector('.conversation-right')).position,visible:getComputedStyle(document.querySelector('.workspace-canvas')).visibility}; })()`);
      assert.ok(samePage.canvas > 150 && samePage.composer > 80 && (samePage.separated || samePage.mode === 'absolute') && samePage.visible === 'visible', 'canvas and composer must be usable together on the same page');
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
      for (const setting of ['检索']) {
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
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().openDock("terminal")');
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
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toolbar-menu button')).find(b=>b.textContent.trim()==='检查点与恢复').click()`);
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
      await win.webContents.executeJavaScript('window.__codenodeUi.getState().setSideTab("agent");window.__codenodeUi.setState({conversationOpen:true,conversationAutoHidden:false})');
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
