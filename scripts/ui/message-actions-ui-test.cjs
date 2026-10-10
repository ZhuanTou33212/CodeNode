'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {app,BrowserWindow,clipboard}=require('electron');app.disableHardwareAcceleration();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-message-actions-')),project=path.join(temp,'project');fs.mkdirSync(project);
process.env.CODENODE_USER_DATA_DIR=path.join(temp,'userdata');process.env.CODENODE_HOME=path.join(temp,'home');process.env.CODENODE_SOUL_FILE=path.join(temp,'soul.md');
const appRoot=process.env.CODENODE_PACKAGED_ASAR||path.resolve(__dirname,'../..');
app.on('browser-window-created',(_event,win)=>win.hide());require(path.join(appRoot,'electron/main.cjs'));
const feedback=require(path.join(appRoot,'electron/feedbackStore.cjs')),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const originalClipboard=clipboard.readText();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,preload:path.join(appRoot,'electron/preload.cjs')}});
 const js=code=>win.webContents.executeJavaScript(code),wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await sleep(70)}throw Error('UI wait: '+code)};
 const text='完整回答：中文和 Unicode 🐱\n第二行可以复制。';
 const load=async()=>{await js(`window.__codenodeSession.getState().initProject();window.__codenodeSession.setState({memoryConversationId:'feedback-conversation',activeId:'feedback-session',messages:[{role:'user',content:'用户问题'},{role:'assistant',content:${JSON.stringify(text)},feedbackInput:'用户问题',status:'done',tools:[]}]});window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)});window.__codenodeUi.getState().updatePreferences({typewriterEnabled:false,workbenchView:"conversation",autoCollapseSidebars:false,conversationOpen:true});`);await wait(`document.querySelector('.cs-msg-agent .cs-msg-text')?.textContent===${JSON.stringify(text)}`)};
 const click=label=>js(`[...document.querySelectorAll('.cs-msg-agent button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
 try{
  await win.loadFile(path.join(appRoot,'dist/index.html'));await load();await js(`window.__codenodeUi.setState({appPage:"workbench",sideTab:"agent",conversationOpen:true,conversationAutoHidden:false})`);win.showInactive();await sleep(120);
  for(const theme of ['light','dark']){
   await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
   await sleep(80);
   assert.equal(await js(`getComputedStyle(document.querySelector('.cs-msg-text')).userSelect`),'text');
   await js(`(()=>{const n=document.querySelector('.cs-msg-agent .cs-msg-text');const r=document.createRange();r.selectNodeContents(n);const s=window.getSelection();s.removeAllRanges();s.addRange(r)})()`);assert.equal(await js('window.getSelection().toString()'),text);
   await js(`document.querySelector('[aria-label="复制回答"]').click()`);await wait(`document.querySelector('[aria-label="复制回答"]').textContent==='已复制'`);assert.equal(await clipboard.readText(),text);
  }
  await click('有帮助');await wait(`document.querySelector('.cs-msg-agent button[aria-pressed=true]')?.textContent==='有帮助'`);assert.match(feedback.contextText(project,'feedback-conversation'),/表达方式/);
  await click('需改进');await wait(`!!document.querySelector('[aria-label="回答改进意见"]')`);assert.equal(await js(`document.querySelector('.cs-feedback-editor button[type=submit]').disabled`),true);
  await js(`(()=>{const n=document.querySelector('[aria-label="回答改进意见"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'直接给出步骤，不要重复提问');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('保存意见');await wait(`document.querySelector('.cs-msg-agent button[aria-pressed=true]')?.textContent==='需改进'`);
  assert.match(feedback.contextText(project,'feedback-conversation'),/直接给出步骤/);assert.equal(feedback.contextText(project,'other-conversation'),'');
  await win.reload();await wait('!!window.__codenodeSession');await load();await wait(`document.querySelector('.cs-msg-agent button[aria-pressed=true]')?.textContent==='需改进'`);
  await click('有帮助');await wait(`document.querySelector('.cs-msg-agent button[aria-pressed=true]')?.textContent==='有帮助'`);assert.doesNotMatch(feedback.contextText(project,'feedback-conversation'),/直接给出步骤/);
  await js(`document.querySelector('.cs-msg-user button').click()`);await sleep(80);assert.equal(await clipboard.readText(),'用户问题');
  const feedbackPath=feedback.feedbackFile(project),saved=fs.readFileSync(feedbackPath);fs.unlinkSync(feedbackPath);fs.mkdirSync(feedbackPath);
  try{await click('需改进');await wait(`!!document.querySelector('[aria-label="回答改进意见"]')`);await js(`(()=>{const n=document.querySelector('[aria-label="回答改进意见"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'模拟无法保存');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('保存意见');await wait(`document.querySelector('.cs-feedback-note')?.textContent.includes('EISDIR')`);assert.equal(await js(`document.querySelector('.cs-msg-agent button[aria-pressed=true]').textContent`),'有帮助','failed save never changes persisted vote');}finally{fs.rmdirSync(feedbackPath);fs.writeFileSync(feedbackPath,saved);}
  console.log('MESSAGE ACTIONS UI: PASS (selected text, full Unicode clipboard, both themes, persisted feedback state, correction form, bounded same-conversation context, vote replacement and reload)');
 }finally{win.destroy();await clipboard.writeText(await originalClipboard)}
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
app.on('quit',()=>{try{fs.rmSync(temp,{recursive:true,force:true})}catch{}});
