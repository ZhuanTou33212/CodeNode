'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
delete process.env.CODENODE_TEST;
delete process.env.CODENODE_TEST_ALLOW_HIGH;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-agent-compact-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '..');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
fs.writeFileSync(path.join(root, '.codenode/agent.properties'), 'agent.intent.enabled=false\nagent.intent_action_review=off\nediting.autoVerify=false\nediting.blockOnFailure=false\n');
let mainWindow;
app.on('browser-window-created', (_event, win) => { mainWindow = win; win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));
const { installScriptedModel } = require('./lib/scripted-model.cjs');
let scripted;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const until = Date.now() + 6000;
  while (!mainWindow && Date.now() < until) await sleep(30);
  if (!mainWindow) { console.error('Main window unavailable'); app.exit(1); return; }
  const win = mainWindow;
  win.setSize(1280, 900); win.webContents.setBackgroundThrottling(false);
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async (expression, label) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await js(expression)) return; await sleep(40); }
    throw new Error('UI wait timeout: ' + label);
  };
  try {
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(path.join(root, 'userData'), [{ id: 'compact-fixture', model: 'fixture-model', label: '测试模型', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-test-key' }], 'compact-fixture');
    await wait('!!window.__codenodeProject', 'project store');
    await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false});window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
    await wait('!!document.querySelector(".pp-input")', 'composer');
    await js(`window.__toolRequests=[];window.codenode.onToolRequest(request=>window.__toolRequests.push(request.type));window.__codenodeSession.getState().newCanvas()`);
    scripted = installScriptedModel([
      { toolCalls: [
        { name: 'write_file', args: { path: 'src/a.ts', content: 'export const value = 1;\n' } },
        { name: 'read_file', args: { path: 'src/a.ts' } },
        { name: 'edit_file', args: { path: 'src/a.ts', oldText: 'value = 1', newText: 'value = 2' } },
        { name: 'write_file', args: { path: 'notes.md', content: '# 已完成\n' } },
        { name: 'workbench_edit', args: { operations: [{ action: 'create', id: 'compact-node', type: 'task', name: '自动创建' }] } },
      ] },
      { content: '已编辑两个文件并创建节点。' },
    ], { loopLast: false });
    await js(`window.__codenodeChat.getState().send('编辑两个文件，并在画布创建一个节点')`);
    await wait('document.querySelector(".file-changes-summary")?.textContent.includes("已编辑 2 个文件")', 'distinct changed files');
    assert.equal(await js('window.__toolRequests.length'), 0, 'Ordinary tool calls must not open confirmation dialogs');
    assert.equal(await js('!!document.querySelector(".tool-dialog")'), false);
    assert.match(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'), /value = 2/);
    assert.equal(await js('window.__codenodeStore.getState().nodes.some(node=>node.id==="compact-node")'), true);
    await js(`window.__codenodeSession.setState(state=>({messages:state.messages.map(message=>message.role==='assistant'?{...message,reasoning:'private-thinking-should-not-appear'}:message)}))`);
    await sleep(60);
    assert.equal(await js('!!document.querySelector(".task-trace,.chat-section-toggle,.chat-tool,.chat-reasoning")'), false);
    assert.equal(await js('document.body.textContent.includes("private-thinking-should-not-appear")'), false);
    await js(`const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留输入草稿');input.dispatchEvent(new Event('input',{bubbles:true}))`);
    await sleep(60);
    const snapshot = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model').textContent,sideOpen:window.__codenodeUi.getState().sideOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
    const before = await snapshot();
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(60);
      assert.equal(await snapshot(), before);
      await js('document.querySelector(".file-changes-summary").click()');
      await wait('document.querySelectorAll(".file-changes-item").length===2', 'file list');
      await js('document.querySelector(".file-changes-item summary").click()');
      assert.ok(await js('document.querySelector(".file-changes-item pre").textContent.includes("export const value")'));
      win.showInactive(); await sleep(120);
      const screenshot = await win.webContents.capturePage();
      fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../out/agent-compact-' + theme + '.png'), screenshot.toPNG());
      win.hide();
      await js('document.querySelector(".file-changes-summary").click()');
    }
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await wait(`!!document.querySelector('[aria-label="普通工具自动执行"]')`, 'execution setting');
    await sleep(120);
    assert.equal(await js(`document.querySelector('[aria-label="普通工具自动执行"]').checked`), true);
    await js(`document.querySelector('[aria-label="普通工具自动执行"]').click()`);
    await wait(`!document.querySelector('[aria-label="普通工具自动执行"]').checked&&!document.querySelector('[aria-label="普通工具自动执行"]').disabled`, 'persist manual mode');
    assert.match(fs.readFileSync(path.join(root, '.codenode/agent.properties'), 'utf8'), /^tools.confirm_writes=true$/m);
    await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('general')`);
    await sleep(150);
    assert.equal(await js(`document.querySelector('[aria-label="普通工具自动执行"]').checked`), false);
    await js(`document.querySelector('[aria-label="普通工具自动执行"]').click()`);
    await wait(`document.querySelector('[aria-label="普通工具自动执行"]').checked&&!document.querySelector('[aria-label="普通工具自动执行"]').disabled`, 'restore auto mode');
    await js(`window.__codenodeUi.getState().closeSettings()`);
    scripted.restore(); scripted = null;
    scripted = installScriptedModel([{ toolCalls: [{ name: 'workbench_edit', args: { operations: [{ action: 'delete', nodeId: 'compact-node' }] } }] }, { content: '未删除节点。' }], { loopLast: false });
    await js(`void (window.__pendingHigh=window.__codenodeChat.getState().send('删除刚创建的节点'))`);
    await wait('!!document.querySelector(".tool-dialog")', 'deletion confirmation retained');
    await js(`[...document.querySelectorAll('.tool-dialog button')].find(button=>button.textContent.trim()==='取消').click()`);
    await Promise.race([js('window.__pendingHigh'), sleep(5000).then(() => { throw new Error('Cancel did not settle HIGH confirmation'); })]);
    assert.equal(await js('window.__codenodeStore.getState().nodes.some(node=>node.id==="compact-node")'), true);
    console.log('COMPACT AGENT UI: PASS (real agent/tools, zero ordinary prompts, distinct files/diffs, hidden internals, both themes/state retention, persisted settings, deletion approval retained)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { scripted?.restore(); }
});
app.on('will-quit', () => {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('codenode-agent-compact-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
