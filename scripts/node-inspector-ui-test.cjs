'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-node-inspector-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '..');
const output = process.env.CODENODE_NODE_INSPECTOR_OUTPUT || path.join(__dirname, '..', 'release', 'node-inspector');
const userData = path.join(root, 'userData');
process.env.CODENODE_USER_DATA_DIR = userData;
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000,
    webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(moduleRoot, 'electron/preload.cjs') } });
  try {
    fs.mkdirSync(output, { recursive: true });
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(userData,
      [{ id: 'inspector-model', model: 'fixture-model', label: 'Inspector test', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-ui-key' }], 'inspector-model');
    await win.loadFile(path.join(moduleRoot, 'dist/index.html'));
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; !window.__codenodeProject && i < 120; i++) await new Promise(r => setTimeout(r, 50));
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      if (!window.__codenodeSession.getState().current()) window.__codenodeSession.getState().newCanvas();
    })()`);
    const reports = [];
    for (const theme of ['light', 'dark']) {
      const report = await win.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const ui = window.__codenodeUi, graph = window.__codenodeStore, session = window.__codenodeSession;
        ui.setState({ sideTab: 'agent', sideOpen: false });
        if (ui.getState().theme !== ${JSON.stringify(theme)}) ui.getState().toggleTheme();
        await sleep(200);
        const input = document.querySelector('.pp-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'draft stays');
        input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
        const before = { session: session.getState().activeId, draft: input.value,
          model: (await window.codenode.modelsList()).activeId, navigation: ui.getState().navigationOpen };
        const oldCount = graph.getState().nodes.length;
        document.querySelector('.toolbar-vector').click(); await sleep(350);
        const vector = { count: graph.getState().nodes.length, type: graph.getState().nodes.find(n => n.id === graph.getState().selectedId)?.type,
          tab: ui.getState().sideTab, open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel') };
        input.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', shiftKey: true, bubbles: true, cancelable: true }));
        await sleep(70);
        const menu = { exists: !!document.querySelector('.add-menu'), open: ui.getState().sideOpen, tab: ui.getState().sideTab };
        const item = [...document.querySelectorAll('.add-menu-item')].find(el => el.textContent.includes('任务'));
        if (!item) throw Error('Task template not found'); item.click(); await sleep(150);
        const task = { count: graph.getState().nodes.length, type: graph.getState().nodes.find(n => n.id === graph.getState().selectedId)?.type,
          open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel') };
        document.querySelector('.toolbar-dropdown').open = true;
        document.querySelector('[data-action="properties"]').click();
        document.querySelector('.toolbar-dropdown').open = false; await sleep(150);
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        const layout = { panel: rect('.side-panel'), canvas: rect('.workspace-canvas'), conversation: rect('.conversation-right'),
          position: getComputedStyle(document.querySelector('.side-panel')).position, open: ui.getState().sideOpen };
        document.querySelector('.sp-close').click(); await sleep(60);
        document.querySelector('.toolbar-vector').click(); await sleep(300);
        const closed = { open: ui.getState().sideOpen, panel: !!document.querySelector('.side-panel'), tab: ui.getState().sideTab };
        document.querySelector('[data-action="properties"]').click(); await sleep(100);
        const selected = graph.getState().selectedId;
        document.querySelector('.toolbar-vector').click(); await sleep(300);
        const preservedOpen = { open: ui.getState().sideOpen, selectedChanged: selected !== graph.getState().selectedId };
        ui.getState().toggleTheme(); await sleep(80); ui.getState().toggleTheme(); await sleep(80);
        const after = { session: session.getState().activeId, draft: input.value,
          model: (await window.codenode.modelsList()).activeId, navigation: ui.getState().navigationOpen };
        return { theme: ui.getState().theme, oldCount, vector, menu, task, layout, closed, preservedOpen, before, after };
      })()`);
      assert.equal(report.vector.count, report.oldCount + 1);
      assert.equal(report.vector.type, 'vector');
      assert.deepEqual([report.vector.open, report.vector.panel, report.vector.tab], [false, false, 'agent']);
      assert.deepEqual(report.menu, { exists: true, open: false, tab: 'agent' });
      assert.equal(report.task.count, report.oldCount + 2);
      assert.equal(report.task.type, 'task');
      assert.equal(report.task.open, false); assert.equal(report.task.panel, false);
      assert.equal(report.layout.open, true); assert.equal(report.layout.position, 'relative');
      assert.ok(report.layout.panel.width > 100 && report.layout.canvas.width > 100);
      assert.ok(report.layout.panel.right <= report.layout.canvas.left + 1, JSON.stringify(report.layout));
      assert.ok(report.layout.canvas.right <= report.layout.conversation.left + 1, JSON.stringify(report.layout));
      assert.deepEqual(report.closed, { open: false, panel: false, tab: 'node' });
      assert.deepEqual(report.preservedOpen, { open: true, selectedChanged: true });
      assert.deepEqual(report.after, report.before);
      fs.writeFileSync(path.join(output, 'node-inspector-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
      reports.push(report);
    }
    const settings = await win.webContents.executeJavaScript(`(async () => {
      const ui = window.__codenodeUi;
      ui.getState().openSettings('general'); await new Promise(r => setTimeout(r, 100));
      const label = [...document.querySelectorAll('.settings-menu-actions label')].find(el => el.textContent === '节点属性');
      if (!label) throw Error('Properties menu setting missing');
      const checkbox = label.querySelector('input'); checkbox.click(); await new Promise(r => setTimeout(r, 50));
      const hidden = !ui.getState().preferences.visibleActions.includes('properties');
      const savedHidden = !JSON.parse(localStorage.getItem('codenode.uiPreferences')).visibleActions.includes('properties');
      checkbox.click(); ui.getState().closeSettings();
      return { hidden, savedHidden, restored: ui.getState().preferences.visibleActions.includes('properties') };
    })()`);
    assert.deepEqual(settings, { hidden: true, savedHidden: true, restored: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, reports, settings }, null, 2) + '\n');
    console.log('NODE INSPECTOR UI: PASS (new-node button and Shift+A stay closed; manual properties do not overlap canvas; both themes and draft/session/model/navigation preserved; menu visibility persists)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('codenode-node-inspector-')) return;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
