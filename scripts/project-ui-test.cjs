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
