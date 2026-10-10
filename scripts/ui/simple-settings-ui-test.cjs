'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-simple-settings-')),project=path.join(temp,'project');fs.mkdirSync(project);
process.env.CODENODE_USER_DATA_DIR=path.join(temp,'userdata');process.env.CODENODE_HOME=path.join(temp,'home');process.env.CODENODE_SOUL_FILE=path.join(temp,'soul.md');
const appRoot=process.env.CODENODE_PACKAGED_ASAR||path.resolve(__dirname,'../..');
app.on('browser-window-created',(_event,win)=>win.hide());require(path.join(appRoot,'electron/main.cjs'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false,preload:path.join(appRoot,'electron/preload.cjs')}});
 let frame=null;win.webContents.on('paint',(_e,_d,img)=>{frame=img.toPNG()});win.webContents.startPainting();
 const js=code=>win.webContents.executeJavaScript(code),wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await sleep(80)}throw Error('UI wait: '+code)};
 const open=async tab=>{await js(`window.__codenodeUi.getState().openSettings(${JSON.stringify(tab)})`);await wait(`document.querySelector('.settings-layout nav [aria-pressed=true]')?.textContent===${JSON.stringify({general:'常规',layout:'界面',agents:'Agent 连接',execution:'执行',trellis:'Trellis'}[tab])}`)};
 try{
  await win.loadFile(path.join(appRoot,'dist/index.html'));await js(`window.__codenodeSession.getState().initProject();window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);await wait('!!document.querySelector(".pp-input")');
  const state=()=>js(`JSON.stringify({session:window.__codenodeSession.getState().activeId,conversation:window.__codenodeSession.getState().memoryConversationId,model:document.querySelector('.pp-model')?.textContent,navigation:window.__codenodeUi.getState().navigationOpen})`),before=await state();
  await open('general');
  assert.equal(await js(`!!document.querySelector('.backend-settings-panel')`),false);assert.equal(await js(`!!document.querySelector('[aria-label="主导航图标栏宽度"]')`),false);assert.equal(await js(`!!document.querySelector('.trellis-cli-settings')`),false);
  const snapshot=()=>js(`JSON.stringify([...document.querySelectorAll('.settings-content input,.settings-content select,.settings-content button,.settings-content summary')].filter(n=>n.getClientRects().length).map(n=>[n.tagName,n.getAttribute('aria-label'),n.classList.contains('settings-theme-toggle')?'theme':n.textContent]))`),controls=await snapshot();
  const shots=path.resolve(__dirname,'../../release/simple-settings-previews');fs.mkdirSync(shots,{recursive:true});win.showInactive();
  for(const theme of ['light','dark']){await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(150);assert.equal(await snapshot(),controls);assert.equal(await state(),before);const bounds=await js(`(()=>{const n=document.querySelector('.settings-content');return {scroll:n.scrollHeight,height:n.clientHeight,rows:[...n.querySelectorAll('.settings-row')].filter(n=>n.getClientRects().length).length}})()`);assert.equal(bounds.rows,4);assert.ok(bounds.scroll<=bounds.height+1,'general fits without scrolling');frame=null;win.webContents.invalidate();await sleep(450);assert.ok(frame);fs.writeFileSync(path.join(shots,theme+'.png'),frame);}
  await js(`document.querySelector('[aria-label="自动保存项目"]').click()`);assert.equal(await js(`JSON.parse(localStorage.getItem('codenode.uiPreferences')).autoSaveEnabled`),false);await js(`document.querySelector('[aria-label="自动保存项目"]').click()`);
  await open('layout');await wait(`!!document.querySelector('[aria-label="主导航图标栏宽度"]')`);await js(`const n=document.querySelector('[aria-label="主导航图标栏宽度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'56');n.dispatchEvent(new Event('input',{bubbles:true}));`);assert.equal(await js(`window.__codenodeUi.getState().preferences.activityBarWidth`),56);
  await open('agents');await wait('!!document.querySelector(".backend-settings-panel")');assert.equal(await js(`!!document.querySelector('.trellis-cli-settings')`),false);
  await open('execution');await wait(`!!document.querySelector('[aria-label="普通工具自动执行"]')`);await js(`document.querySelector('.settings-advanced').open=true`);await wait(`!!document.querySelector('[aria-label="子任务与模型请求并发上限"]')`);
  await open('trellis');await wait(`!!document.querySelector('[aria-label="Trellis CLI 路径"]')`);
  await open('general');assert.equal(await js(`document.querySelectorAll('.settings-advanced[open]').length`),0);assert.equal(await state(),before);await js(`window.__codenodeUi.getState().closeSettings()`);
  await win.reload();await wait('!!window.__codenodeProject');await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);await wait('!!document.querySelector(".pp-input")');await open('layout');assert.equal(await js(`document.querySelector('[aria-label="主导航图标栏宽度"]').value`),'56');
  console.log('SIMPLE SETTINGS UI: PASS (four default general rows, no scrolling, separate categories, unchanged theme controls/session/model/sidebar, preference persistence, advanced settings accessible, both-theme screenshots)');
 }finally{win.destroy()}
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
app.on('quit',()=>{try{fs.rmSync(temp,{recursive:true,force:true})}catch{}});
