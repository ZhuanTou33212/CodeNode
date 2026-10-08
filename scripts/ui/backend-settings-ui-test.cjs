'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-backend-ui-'));
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userdata');
let win;
app.on('browser-window-created', (_event, window) => { win = window; });
require(process.env.CODENODE_UI_TEST_PACKAGE ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources/app.asar/electron/main.cjs') : '../../electron/main.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(`(async () => { return (${code}); })()`)
  .catch(error => { throw new Error(String(error) + '\nRenderer: ' + code); });
async function waitFor(check, label) {
  console.log('UI check:', label);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error('Timeout: ' + label);
}
app.whenReady().then(async () => {
  try {
    await waitFor(() => win && js('!!window.__codenodeProject').catch(() => false), 'stores');
    win.hide();
    await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})`);
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
    await waitFor(() => js('!!document.querySelector(".pp-input")'), 'composer');
    await js(`window.__codenodeSession.getState().newCanvas()`);
    await js(`window.__codenodeSession.getState().pushUser('保留会话')`);
    await js(`window.__codenodeUi.getState().setSideOpen(true)`);
    await win.webContents.executeJavaScript(`const textarea=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'后端测试草稿');textarea.dispatchEvent(new Event('input',{bubbles:true}))`);
    const view = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model')?.textContent,sideOpen:window.__codenodeUi.getState().sideOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
    await sleep(80); const before = await view();
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await waitFor(() => js('!!document.querySelector("[aria-label=执行后端]")'), 'backend controls');
    await waitFor(() => js('!document.querySelector("[aria-label=执行后端]").disabled'), 'loaded settings');
    const select = async (label, value) => {
      await win.webContents.executeJavaScript(`(() => { const control=document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(80);
    };
    await select('后端配置范围', 'project'); await select('执行后端', 'codex');
    await select('Codex 项目文件权限', 'workspace-write');
    const controls = () => js(`JSON.stringify([...document.querySelectorAll('[data-testid=backend-settings] select,[data-testid=backend-settings] input')].map(n=>[n.getAttribute('aria-label'),n.value,n.disabled]))`);
    const expected = await controls();
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(100);
      assert.equal(await controls(), expected); assert.equal(await view(), before);
      assert.equal(await js('document.documentElement.dataset.theme'), theme);
      fs.mkdirSync(path.join(__dirname, '../../out'), { recursive: true });
      await js(`document.querySelector('[data-testid=backend-settings]').scrollIntoView({block:'start'})`);
      win.showInactive(); await sleep(200);
      const shot = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), sleep(5000).then(() => { throw new Error('Screenshot timed out: ' + theme); })]);
      fs.writeFileSync(path.join(__dirname, '../../out/backend-settings-' + theme + '.png'), shot.toPNG());
      win.hide();
    }
    await js(`[...document.querySelectorAll('[data-testid=backend-settings] button')].find(b=>b.textContent==='保存后端').click()`);
    await waitFor(() => js(`document.querySelector('[data-testid=backend-settings] [role=status]')?.textContent.includes('已保存')`), 'saved');
    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.codenode/backend.json'), 'utf8'));
    assert.equal(persisted.backend, 'codex'); assert.equal(persisted.sandbox, 'workspace-write');
    await js(`window.__codenodeUi.getState().closeSettings()`);
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await waitFor(() => js('document.querySelector("[aria-label=执行后端]")?.value === "codex"'), 'reload persistence');
    assert.equal(await js('document.querySelector("[aria-label=后端配置范围]").value'), 'project');
    await js(`[...document.querySelectorAll('[data-testid=backend-settings] button')].find(b=>b.textContent==='项目跟随本机默认').click()`);
    await waitFor(() => js('document.querySelector("[aria-label=执行后端]")?.value === "builtin"'), 'inherit defaults');
    assert.equal(fs.existsSync(path.join(root, '.codenode/backend.json')), false);
    await js(`window.__codenodeUi.getState().closeSettings()`); assert.equal(await view(), before);
    console.log('BACKEND SETTINGS UI: PASS (real IPC save/reload/inherit, shared controls in both themes, session/draft/model/sidebar preserved)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', () => {
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('codenode-backend-ui-')) fs.rmSync(root, { recursive: true, force: true });
});
