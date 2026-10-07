'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-coding-slim-ui-'));
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
let win;
app.on('browser-window-created', (_event, window) => { win = window; });
require(process.env.CODENODE_UI_TEST_PACKAGE
  ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources/app.asar/electron/main.cjs')
  : '../electron/main.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code.includes(';') ? `(async () => { ${code} })()` : `(async () => (${code}))()`)
  .catch(error => { throw new Error(String(error) + '\nRenderer command: ' + code); });
async function waitFor(check, label) {
  console.log('UI check:', label);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error('Timeout: ' + label);
}
app.whenReady().then(async () => {
  try {
    await waitFor(() => win && js('!!window.__codenodeProject').catch(() => false), 'project store');
    win.hide();
    await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false});window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
    await waitFor(() => js('!!document.querySelector(".pp-input")'), 'composer');
    await js(`window.__codenodeSession.getState().newCanvas();window.__codenodeSession.getState().pushUser('保留会话');window.__codenodeUi.getState().setSideOpen(true);window.__codenodeUi.getState().setSideTab('agent')`);
    await sleep(100);
    await js(`const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留输入草稿');input.dispatchEvent(new Event('input',{bubbles:true}))`);
    await sleep(60);
    const snapshot = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input')?.value,model:document.querySelector('.pp-model')?.textContent,sideOpen:window.__codenodeUi.getState().sideOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
    const before = await snapshot();
    await js(`window.__codenodeUi.getState().openSettings('rag')`);
    await waitFor(() => js(`!!document.querySelector('[aria-label="严格答案校验"]')`), 'extension settings');
    await sleep(150);
    assert.equal(await js(`document.querySelector('[aria-label="向量检索扩展"]').value`), 'none');
    assert.equal(await js(`document.querySelector('[aria-label="严格答案校验"]').value`), 'false');
    const select = async (label, value) => {
      await js(`const select=document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}))`);
      await sleep(60);
    };
    await select('本地项目检索', 'false');
    await select('严格答案校验', 'true');
    const controls = await js(`JSON.stringify([...document.querySelectorAll('.dock-rag-settings select')].map(n=>[n.getAttribute('aria-label'),n.value,n.disabled]))`);
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);
      await sleep(100);
      assert.equal(await js(`document.documentElement.dataset.theme`), theme);
      assert.equal(await js(`JSON.stringify([...document.querySelectorAll('.dock-rag-settings select')].map(n=>[n.getAttribute('aria-label'),n.value,n.disabled]))`), controls);
      assert.equal(await snapshot(), before, 'Theme changes must preserve conversation, draft, model and sidebar');
      fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
      win.showInactive();
      await sleep(200);
      const screenshot = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), sleep(5000).then(() => { throw new Error('Screenshot timeout: ' + theme); })]);
      fs.writeFileSync(path.join(__dirname, '../out/coding-slim-settings-' + theme + '.png'), screenshot.toPNG());
      win.hide();
    }
    await js(`document.querySelector('.dock-rag-actions .dock-primary').click()`);
    await waitFor(() => js('!!document.querySelector(".dock-rag-success")'), 'save strict extension');
    const file = path.join(root, '.codenode/agent.properties');
    assert.match(fs.readFileSync(file, 'utf8'), /^rag.enabled=false$/m);
    assert.match(fs.readFileSync(file, 'utf8'), /^agent.grounding.semantic_mode=enforce$/m);
    await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('rag')`);
    await waitFor(() => js(`document.querySelector('[aria-label="严格答案校验"]')?.value==='true'`), 'persisted strict extension');
    assert.equal(await js(`document.querySelector('[aria-label="本地项目检索"]').value`), 'false');
    await select('严格答案校验', 'false');
    await select('本地项目检索', 'true');
    await js(`document.querySelector('.dock-rag-actions .dock-primary').click()`);
    await waitFor(() => js('!!document.querySelector(".dock-rag-success")'), 'disable strict extension');
    assert.match(fs.readFileSync(file, 'utf8'), /^agent.grounding.semantic_mode=off$/m);
    const configured = await js(`window.codenode.agentConfig(${JSON.stringify(root)})`);
    assert.equal(configured.rag.strictValidation, false);
    assert.equal(configured.rag.provider, 'none');
    await js(`window.__codenodeUi.getState().closeSettings()`);
    assert.equal(await snapshot(), before);
    console.log('CODING SLIM SETTINGS UI: PASS (real IPC persistence, explicit extensions, both themes, session/draft/model/sidebar preserved)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', () => {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('codenode-coding-slim-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
