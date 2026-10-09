'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {app,BrowserWindow}=require('electron');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-workspace-ux-')),project=path.join(temp,'project');fs.mkdirSync(project);
const packageRoot=process.env.CODENODE_UI_TEST_PACKAGE;
const appRoot=packageRoot?path.join(path.resolve(packageRoot),'resources/app.asar'):path.resolve(__dirname,'../..');
const rawFsModule='original-fs';const rawFs=packageRoot?require(rawFsModule):fs;
process.env.CODENODE_USER_DATA_DIR=path.join(temp,'userdata');process.env.CODENODE_HOME=path.join(temp,'home');process.env.CODENODE_SOUL_FILE=path.join(temp,'soul.md');
app.on('browser-window-created',(_e,w)=>w.hide());require(path.join(appRoot,'electron/main.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1500,height:920,webPreferences:{sandbox:true,backgroundThrottling:false,preload:path.join(appRoot,'electron/preload.cjs')}});
 const js=code=>win.webContents.executeJavaScript(code).catch(e=>{throw new Error(String(e)+'\nCODE: '+code)});
 const wait=async(fn,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await sleep(60);}throw new Error('Timeout: '+label);};
 const click=async selector=>{const point=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await sleep(140);};
 const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await sleep(160);};
 try{
  await win.loadFile(path.join(appRoot,'dist/index.html'));await wait(()=>js('!!window.__codenodeProject'),'stores');
  await js('window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})');await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
  await js('window.__codenodeSession.getState().newCanvas()');await js(`window.__codenodeSession.getState().pushUser('帮我完善这个画布的节点编辑体验。')`);await js(`(()=>{const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'我还想检查一下撤销操作。');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(()=>js('!!document.querySelector(".toolbar-vector")'),'toolbar');
  await js('document.querySelector(".toolbar-vector").click()');win.showInactive();win.webContents.focus();await sleep(450);
  const id=await js('window.__codenodeStore.getState().selectedId');assert(id);
  const node=`.react-flow__node[data-id="${id}"]`;
  // Start with no outer selection, then enter its editing body using real pointer events.
  await js('window.__codenodeStore.getState().setSelectedIds([])');await click(node+' .wf-vector-stage');
  assert.equal(await js('window.__codenodeStore.getState().selectedIds[0]'),id,'inner pointer identifies the keyboard owner');
  const shape=await js(`window.__codenodeVectorNode(${JSON.stringify(id)}).getState().addFromPreset('rectangle',{x:140,y:140})`);
  await js(`window.__codenodeVectorNode(${JSON.stringify(id)}).getState().selectIds([${JSON.stringify(shape)}])`);
  await key('Delete');assert.equal(await js(`window.__codenodeVectorNode(${JSON.stringify(id)}).getState().objects.some(o=>o.id===${JSON.stringify(shape)})`),false,'inner Delete removes a shape');
  assert.equal(await js('window.__codenodeStore.getState().nodes.length'),1,'inner Delete retains its node');
  await key('Delete');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),1,'second Delete after shape removal cannot delete owner');
  await click(node+' .wf-vector-stage');assert.equal(await js('window.__codenodeStore.getState().selectedIds[0]'),id);
  await key('Delete');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),0,'Del on empty inner canvas deletes the selected outer node');
  await js('document.querySelector(".react-flow__pane").focus()');await key('Z',['control']);await wait(()=>js('window.__codenodeStore.getState().nodes.length===1'),'undo empty-canvas deletion');
  for(const deletionKey of ['Delete','Backspace','X']){
    await click(node+' .wf-vector-label');assert.equal(await js('!!document.activeElement.closest(".vs-scope")'),false,'title takes node-level focus');
    await key(deletionKey);assert.equal(await js('window.__codenodeStore.getState().nodes.length'),0,deletionKey+' deletes node from title');
    await key('Z',['control']);await wait(()=>js('window.__codenodeStore.getState().nodes.length===1'),'undo node deletion');
  }
  await js("document.querySelector('.pp-input').focus()");
  const dragPoint=await js(`(()=>{const r=document.querySelector(${JSON.stringify(node+' .wf-vector-label')}).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragPoint});win.webContents.sendInputEvent({type:'mouseMove',x:dragPoint.x+50,y:dragPoint.y+25});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:dragPoint.x+50,y:dragPoint.y+25});await sleep(220);
  await key('Delete');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),0,'dragging from input focus then Del deletes outer node');await key('Z',['control']);await wait(()=>js('window.__codenodeStore.getState().nodes.length===1'),'undo drag deletion');
  await js(`window.__codenodeStore.getState().addNode({id:'other-node',type:'task',position:{x:30,y:30},data:{label:'任务节点',prompt:''}});window.__codenodeStore.getState().setSelectedIds([${JSON.stringify(id)},'other-node']);`);
  await wait(()=>js("document.querySelector('.status-bar').textContent.includes('选中 2')"),'multi-selection count');
  await js('const p=document.querySelector(".react-flow__pane");p.tabIndex=0;p.focus()');await key('Delete');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),0,'multi-selection Delete');await key('Z',['control']);
  await wait(()=>js('window.__codenodeStore.getState().nodes.length===2'),'multi undo');assert.equal(await js('window.__codenodeStore.getState().nodes.some(n=>n.selected)'),false,'undo clears visual and logical selection together');
  await js(`window.__codenodeStore.getState().onConnect({source:${JSON.stringify(id)},target:'other-node'});const edge=window.__codenodeStore.getState().edges[0];window.__codenodeStore.getState().onEdgesChange([{id:edge.id,type:'select',selected:true}]);window.__codenodeStore.getState().setSelectedIds([]);document.querySelector('.react-flow__pane').focus();`);
  await key('Delete');assert.equal(await js('window.__codenodeStore.getState().edges.length'),0,'wire deletion remains available');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),2);await key('Z',['control']);
  await js("document.querySelector('.pp-input').focus()");await key('Backspace');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),2,'text focus protects graph nodes');
  await click(node+' .wf-vector-label');
  assert.equal(await js("!!document.querySelector('#conversation-panel .goal-control-panel')"),false,'goal form does not occupy chat');
  await js("document.querySelector('[aria-label=\"选择 Agent\"]').click()");assert.equal(await js("!!document.querySelector('.agent-switch-settings')"),false,'no duplicate connection settings');await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  const chatBefore=await js(`({session:window.__codenodeSession.getState().activeId,draft:document.querySelector('.pp-input').value,messages:window.__codenodeSession.getState().messages.length,side:window.__codenodeUi.getState().sideTab})`);
  const goal=await js(`window.codenode.goalCreate(${JSON.stringify(project)},{title:'完善画布编辑体验',objective:'让节点编辑、删除和撤销操作清晰可靠。',criteria:['节点删除与撤销通过','对话内容不被管理表单挤占']})`);assert.equal(goal.ok,true);
  const task=await js(`window.codenode.goalTaskCreate(${JSON.stringify(project)},${JSON.stringify(goal.value.id)},{title:'修正节点删除交互',objective:'区分删除节点与删除内部图形。'})`);assert.equal(task.ok,true);
  await js(`window.codenode.goalTaskUpdate(${JSON.stringify(project)},${JSON.stringify(goal.value.id)},${JSON.stringify(task.value.id)},{status:'blocked'})`);
  await js("document.querySelector('[aria-label=\"切换到总览\"]').click()");await js("document.querySelector('.goal-toolbar button').click()");await wait(()=>js("document.querySelector('.overview-metrics').textContent.includes('1')"),'attention badge');
  await wait(()=>js("!document.querySelector('.workspace-overview-layer').hidden"),'drawer');
  await js(`document.querySelectorAll('.goal-management-section').forEach(d=>d.open=true)`);
  const titleInput=await js("!!document.querySelector('[aria-label=\"Goal 目标编辑\"]')");assert(titleInput);
  await js("(()=>{const p=document.querySelector('[aria-label=\"Goal 目标编辑\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(p,'未保存的目标草稿');p.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await js("document.querySelector('[aria-label=\"切换到对话\"]').click()");assert.equal(await js("document.querySelector('.workspace-overview-layer').hidden"),true);await js("document.querySelector('[aria-label=\"切换到总览\"]').click()");assert.equal(await js("document.querySelector('[aria-label=\"Goal 目标编辑\"]').value"),'未保存的目标草稿','drawer close preserves form draft');
  await key('Delete');assert.equal(await js('window.__codenodeStore.getState().nodes.length'),2,'focused goal control cannot delete graph selection');
  await js(`document.querySelectorAll('.goal-management-section').forEach(d=>d.open=false)`);

  const output=process.env.CODENODE_WORKSPACE_UX_SHOTS||path.resolve(__dirname,'../../out/workspace-ux');fs.mkdirSync(output,{recursive:true});
  const surface=()=>js("JSON.stringify([...document.querySelectorAll('.workspace-overview-layer button,.workspace-overview-layer input,.workspace-overview-layer textarea,.workspace-overview-layer select')].map(n=>[n.getAttribute('aria-label'),n.value||'',n.disabled]))");const before=await surface();
  for(const theme of ['light','dark']){
    win.showInactive();win.focus();await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await sleep(350);assert.equal(await surface(),before);assert.deepEqual(await js(`({session:window.__codenodeSession.getState().activeId,draft:document.querySelector('.pp-input').value,messages:window.__codenodeSession.getState().messages.length,side:window.__codenodeUi.getState().sideTab})`),chatBefore,'goal management and themes preserve chat');
    await sleep(400);const region=undefined;
    const shot=await win.webContents.capturePage(region,{stayHidden:true,stayAwake:true});fs.writeFileSync(path.join(output,theme+'.png'),shot.toPNG());await js("document.querySelector('[aria-label=\"切换到对话\"]').click()");await sleep(300);const conversationShot=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});fs.writeFileSync(path.join(output,'conversation-'+theme+'.png'),conversationShot.toPNG());await js("document.querySelector('[aria-label=\"切换到总览\"]').click()");win.hide();
  }
  await js("document.querySelector('[aria-label=\"切换到对话\"]').click()");assert.equal(await js("document.querySelector('.workspace-overview-layer').hidden"),true,'switch returns to chat');
  await js("document.querySelector('[aria-label=\"切换到总览\"]').click();document.querySelector('.goal-task').click()");await wait(()=>js("!!document.querySelector('#conversation-panel .conversation-goal-binding')"),'bound-task hint');await js("document.querySelector('[aria-label=\"解除目标任务绑定\"]').click()");await wait(()=>js("!document.querySelector('.conversation-goal-binding')"),'unbind removes hint');
  fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify({passed:true,recordedAt:new Date().toISOString(),mode:packageRoot?'packaged':'source',...(packageRoot?{asarSha256:require('node:crypto').createHash('sha256').update(rawFs.readFileSync(path.join(appRoot,'..','app.asar'))).digest('hex')}:{}),checks:['native node/shape Delete separation','Backspace/X and undo','multi-selection count','wire deletion','text and goal-control focus protection','separate overview and conversation pages','overview progress and task binding','overview/conversation preserve forms, messages, canvas and draft','same controls across themes','no redundant Agent settings entry']},null,2)+'\n');
  assert.equal(await js(`JSON.parse(localStorage.getItem('codenode.uiPreferences')).workbenchView`),'overview');
  console.log('WORKSPACE UX: PASS (native pointer/key node vs shape deletion, multi-selection count, undo, text-focus protection, goal drawer/drafts/badge, compact Agent list, both themes)');console.log('PREVIEWS='+output);app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
app.on('will-quit',()=>{if(path.dirname(temp)===fs.realpathSync(os.tmpdir())&&path.basename(temp).startsWith('codenode-workspace-ux-'))try{fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{}});
