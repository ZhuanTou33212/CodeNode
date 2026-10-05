'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog } = require('electron');
const cnode = require('../electron/cnode.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-project-ui-'));
const projectFile = path.join(root, 'created.cnode');
const invalidFile = path.join(root, 'invalid.cnode');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
let win = null;
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
  try {
    await waitFor(async () => win && await win.webContents.executeJavaScript('!!document.querySelector(".gate-actions")').catch(() => false), '启动页');
    win.hide();
    await win.webContents.executeJavaScript('document.querySelectorAll(".gate-actions .gate-btn")[1].click()');
    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".app") && !!window.__codenodeProject.getState().root'), '新建后进入工作台');
    assert.equal(fs.existsSync(projectFile), true);
    assert.equal(cnode.decodeCnode(fs.readFileSync(projectFile)).ok, true);
    const opened = await win.webContents.executeJavaScript('({root:window.__codenodeProject.getState().root,file:window.__codenodeProject.getState().projectFile})');
    assert.equal(opened.root, root);
    assert.equal(opened.file, projectFile);
    await win.webContents.executeJavaScript('document.querySelector(".side-badge").click()');
    await waitFor(async () => await win.webContents.executeJavaScript('!!document.querySelector(".pp-input") || !!document.querySelector(".crash")'), 'Agent 侧栏');
    const agentView = await win.webContents.executeJavaScript(`(() => { const panel=document.querySelector('.side-panel'); const input=document.querySelector('.pp-input'); return { crash:document.querySelector('.crash')?.textContent, panel:panel?.getBoundingClientRect().toJSON(), input:input?.getBoundingClientRect().toJSON(), text:panel?.textContent }; })()`);
    console.log('AGENT VIEW', JSON.stringify(agentView));
    assert.ok(!agentView.crash, agentView.crash);
    assert.ok(agentView.panel?.width >= 260 && agentView.input?.height > 0, 'Agent panel and composer must be visible');
    if (process.env.CODENODE_WORKBENCH_UI_TEST === '1') {
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".canvas-welcome")'), true);
      const modelWidth = await win.webContents.executeJavaScript(`document.querySelector('.pp-model').getBoundingClientRect().width`);
      assert.ok(modelWidth >= 250, 'model selector must have its own readable row');
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".canvas-welcome button").length'), 0);
      assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".project-navigation")'), true);
      const originalSession = await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId');
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-new").click()');
      await sleep(100);
      assert.notEqual(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), originalSession);
      await win.webContents.executeJavaScript('document.querySelector(".project-nav-sessions button").click()');
      await sleep(100);
      assert.equal(await win.webContents.executeJavaScript('window.__codenodeSession.getState().activeId'), originalSession);
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
      assert.ok(await win.webContents.executeJavaScript('document.querySelector(".pp-model").textContent.includes("高")'));
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
      await win.webContents.executeJavaScript('document.querySelector(".toolbar-theme").click()');
      await waitFor(async () => await win.webContents.executeJavaScript('document.documentElement.dataset.theme==="light"'), '日间主题');
      await sleep(250);
      assert.equal(await win.webContents.executeJavaScript('localStorage.getItem("codenode.theme")'), 'light');
      const material = await win.webContents.executeJavaScript(`(() => { const panel=getComputedStyle(document.querySelector('.side-panel')); return {background:panel.backgroundColor,blur:panel.backdropFilter}; })()`);
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
      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('.mm-connect-dialog input[type=password]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'synthetic-ui-key');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mm-connect-dialog button')).find(b=>b.textContent==='获取模型').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice").length===2'), '实时模型列表');
      assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mm-connect-dialog input[type=password]").value'), '');
      await win.webContents.executeJavaScript('document.querySelectorAll(".mm-choice")[1].click()');
      await sleep(80);
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mm-connect-dialog button')).find(b=>b.textContent==='连接并使用').click()`);
      await waitFor(async () => await win.webContents.executeJavaScript('!Array.from(document.querySelectorAll(".mm-connect-dialog button")).some(b=>b.textContent==="连接并使用")'), '保存连接');
      const stored = JSON.parse(fs.readFileSync(modelFile,'utf8'));
      assert.equal(stored.activeId, 'deepseek:beta');
      assert.deepEqual(stored.models.find(model=>model.id==='legacy'), locked);
      assert.equal(fs.readFileSync(modelFile,'utf8').includes('synthetic-ui-key'), false);
      const usable = require('../electron/modelStore.cjs').readUsableModels(app.getPath('userData'), {});
      assert.equal(usable.models.find(model=>model.id==='deepseek:beta').apiKey, 'synthetic-ui-key');
      assert.equal(usable.models.find(model=>model.id==='legacy').apiKeyError, true);
      const providerEntries = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("select[aria-label=供应商] option")).map(o=>o.value)');
      assert.ok(providerEntries.includes('kimi') && providerEntries.includes('minimax') && providerEntries.includes('custom'), '主流供应商和兼容入口必须出现在 UI');
      win.setSize(500, 740);
      await sleep(200);
      const narrow = await win.webContents.executeJavaScript(`(() => { const dialog=document.querySelector('.mm-connect-dialog'); const input=dialog.querySelector('input[type=password]'); const a=dialog.getBoundingClientRect(), b=input.getBoundingClientRect(); return {width:a.width, window:innerWidth, inputWidth:b.width, overflow:dialog.scrollWidth>dialog.clientWidth}; })()`);
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
