'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'codenode-coding-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname,"../..");
const userData = path.join(root,'userData');
process.env.CODENODE_USER_DATA_DIR=userData;
process.env.CODENODE_HOME=path.join(root,'home');
process.env.CODENODE_SOUL_FILE=path.join(root,'soul.md');
app.on('browser-window-created',(_event,win)=>{win.show=()=>{};win.hide();});
require(path.join(moduleRoot,'electron/main.cjs'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,backgroundThrottling:false,preload:path.join(moduleRoot,'electron/preload.cjs')}});
  try {
    require(path.join(moduleRoot,'electron/modelStore.cjs')).writeModels(userData,[{id:'coding-ui-model',model:'fixture-model',label:'校验模型',apiBase:'http://127.0.0.1:12345',apiKey:'synthetic-ui-key'}],'coding-ui-model');
    await win.loadFile(path.join(moduleRoot,'dist/index.html'));
    const setup=await win.webContents.executeJavaScript(`(async()=>{
      const wait=async(fn)=>{const until=Date.now()+6000;while(Date.now()<until){const value=fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('UI wait timed out');};
      await wait(()=>window.__codenodeProject);
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      const session=window.__codenodeSession;
      if(!session.getState().current())session.getState().newCanvas();
      await new Promise(resolve=>setTimeout(resolve,120));
      await wait(()=>document.querySelector('.pp-composer textarea'));
      const input=document.querySelector('.pp-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'draft-preserved');input.dispatchEvent(new Event('input',{bubbles:true}));
      session.setState({messages:[{role:'assistant',content:'校验状态',status:'done'}]});
      session.getState().streamDelta({kind:'code_verification',codeVerification:{status:'partial',verified:false,files:['src/demo.ts'],checks:[{kind:'syntax',status:'passed'},{kind:'test',status:'not_run'}],checkedAt:new Date().toISOString()}});
      await wait(()=>document.querySelector('.code-verification'));
      window.__codenodeUi.getState().openSettings('editing');
      const checkbox=await wait(()=>document.querySelector('.editing-settings input[aria-label="自动执行局部校验"]'));
      await new Promise(resolve=>setTimeout(resolve,200));
      if(checkbox.checked)checkbox.click();
      const number=document.querySelector('.editing-settings input[aria-label="单项校验超时"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(number,'23');number.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
      document.querySelector('.editing-settings button').click();
      await wait(()=>document.querySelector('.editing-settings [role="status"]')?.textContent.includes('已保存'));
      const saved=await window.codenode.agentConfig(${JSON.stringify(root)});
      const model=await window.codenode.modelsList();
      window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('editing');
      await wait(()=>document.querySelector('.editing-settings input[aria-label="单项校验超时"]')?.value==='23');
      return{saved:saved.editing,activeId:session.getState().activeId,modelId:model.activeId,draft:document.querySelector('.pp-composer textarea').value,
        card:document.querySelector('.code-verification').textContent,checks:session.getState().messages.at(-1).codeVerification.checks.map(check=>check.status),navigation:window.__codenodeUi.getState().navigationOpen,side:window.__codenodeUi.getState().sideTab};
    })()`);
    assert.equal(setup.saved.autoVerify,false);assert.equal(setup.saved.timeoutSeconds,23);assert.equal(setup.draft,'draft-preserved');assert.equal(setup.modelId,'coding-ui-model');
    assert.match(setup.card,/仅部分校验完成/);assert.doesNotMatch(setup.card,/所选局部校验通过/);assert.ok(setup.checks.includes('not_run'));
    const themes=[];
    for(const theme of ['light','dark']){
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const ui=window.__codenodeUi;
        ui.getState().openSettings('general');await new Promise(resolve=>setTimeout(resolve,60));
        if(ui.getState().theme!==${JSON.stringify(theme)})document.querySelector('.settings-theme-toggle').click();
        ui.getState().openSettings('editing');await new Promise(resolve=>setTimeout(resolve,250));
        const model=await window.codenode.modelsList();
        const controls=[...document.querySelectorAll('.editing-settings input')].map(input=>({label:input.getAttribute('aria-label'),type:input.type,value:input.value,checked:input.checked}));
        return{theme:ui.getState().theme,controls,activeId:window.__codenodeSession.getState().activeId,modelId:model.activeId,
          draft:document.querySelector('.pp-composer textarea').value,card:document.querySelector('.code-verification').textContent,navigation:ui.getState().navigationOpen,side:ui.getState().sideTab};
      })()`);
      assert.equal(result.theme,theme);assert.equal(result.activeId,setup.activeId);assert.equal(result.modelId,setup.modelId);assert.equal(result.draft,setup.draft);
      assert.equal(result.navigation,setup.navigation);assert.equal(result.side,setup.side);assert.equal(result.card,setup.card);
      themes.push(result);
      const visible=await win.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('.editing-settings');const checkbox=panel.querySelector('input[type="checkbox"]');return panel.getBoundingClientRect().height>0&&checkbox.getBoundingClientRect().width<30;})()`);
      assert.equal(visible,true,'Settings and compact checkbox controls are rendered');
    }
    assert.deepEqual(themes[0].controls,themes[1].controls,'Themes share controls and saved values');
    const properties=fs.readFileSync(path.join(root,'.codenode/agent.properties'),'utf8');assert.match(properties,/editing.autoVerify=false/);assert.match(properties,/editing.timeoutSeconds=23/);
    console.log('CODING SETTINGS UI: PASS (real IPC persistence, reopen, identical themes, report states, draft/session/model/sidebar preserved)');
  }finally{win.destroy();}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
app.on('quit',()=>{try{if(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('codenode-coding-ui-'))fs.rmSync(root,{recursive:true,force:true});}catch{}});
