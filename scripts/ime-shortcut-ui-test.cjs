'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-ime-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '..');
const userData = path.join(root, 'userData');
process.env.CODENODE_USER_DATA_DIR = userData;
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(moduleRoot, 'electron/preload.cjs') } });
  try {
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(userData,
      [{ id: 'ime-model', model: 'fixture-model', label: 'IME test', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-ui-key' }], 'ime-model');
    await win.loadFile(path.join(moduleRoot, 'dist/index.html'));
    const reports = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async fn => { for (let i = 0; i < 120; i++) { if (fn()) return; await sleep(50); } throw Error('UI not ready'); };
      await wait(() => window.__codenodeProject);
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      const session = window.__codenodeSession;
      if (!session.getState().current()) session.getState().newCanvas();
      window.__codenodeStore.getState().load([], []);
      await wait(() => document.querySelector('.pp-composer textarea') && document.querySelector('.react-flow__pane'));
      await sleep(300);
      const input = document.querySelector('.pp-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'IME draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      const ui = window.__codenodeUi;
      const initial = { session: session.getState().activeId, draft: input.value,
        navigation: ui.getState().navigationOpen, side: ui.getState().sideTab,
        model: (await window.codenode.modelsList()).activeId };
      const key = (target, type, values = {}) => {
        const event = new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...values });
        target.dispatchEvent(event); return event.defaultPrevented;
      };
      const panTransform = () => document.querySelector('.react-flow__viewport').style.transform;
      const drag = async () => {
        const pane = document.querySelector('.react-flow__pane');
        const rect = pane.getBoundingClientRect(), x = rect.left + 50, y = rect.top + 50;
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: x, clientY: y }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: x + 60, clientY: y + 35 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0, clientX: x + 60, clientY: y + 35 }));
        await sleep(70);
      };
      const results = [];
      for (const theme of ['light', 'dark']) {
        if (ui.getState().theme !== theme) ui.getState().toggleTheme(); await sleep(100);
        const checks = [];
        for (const values of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
          for (const target of [input, document.querySelector('.react-flow__pane')]) {
            window.dispatchEvent(new Event('blur'));
            input.blur(); target.focus();
            checks.push({ values, target: target.tagName, prevented: key(target, 'keydown', values) });
            await sleep(30);
            const before = panTransform(); await drag();
            checks[checks.length - 1].panned = before !== panTransform();
            key(target, 'keyup', values);
          }
        }
        input.focus();
        const textSpace = key(input, 'keydown'); key(input, 'keyup');
        input.blur(); const pane = document.querySelector('.react-flow__pane');
        const bareSpace = key(pane, 'keydown'); await sleep(40);
        const beforePan = panTransform(); await drag();
        const bareSpacePanned = beforePan !== panTransform();
        window.dispatchEvent(new Event('blur')); await sleep(40);
        const beforeBlurDrag = panTransform(); await drag();
        const blurPanned = beforeBlurDrag !== panTransform();
        key(pane, 'keyup');
        key(pane, 'keydown'); await sleep(40);
        input.focus();
        // Hidden test windows have no native OS focus; explicitly deliver the focus notification.
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        input.blur(); await sleep(40);
        const beforeFocusDrag = panTransform(); await drag();
        const focusPanned = beforeFocusDrag !== panTransform(); key(pane, 'keyup');
        key(pane, 'keydown'); await sleep(40);
        key(pane, 'keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true }); await sleep(40);
        const beforeModifierDrag = panTransform(); await drag();
        const modifierPanned = beforeModifierDrag !== panTransform();
        key(pane, 'keyup'); key(pane, 'keyup', { key: 'Meta', code: 'MetaLeft' });
        const preserved = { session: session.getState().activeId, draft: input.value,
          navigation: ui.getState().navigationOpen, side: ui.getState().sideTab,
          model: (await window.codenode.modelsList()).activeId };
        results.push({ theme, checks, textSpace, bareSpace, bareSpacePanned, blurPanned, focusPanned, modifierPanned, initial, preserved });
      }
      window.__codenodeStore.getState().load([{ id: 'ime-vector', type: 'vector', position: { x: 50, y: 50 },
        data: { label: 'IME vector', status: 'pending', width: 900, height: 600, mode: 'design', dockOpen: true } }], []);
      await wait(() => document.querySelector('.vs-svg') && window.__codenodeVectorNode);
      await sleep(150);
      const svg = document.querySelector('.vs-svg');
      const vector = window.__codenodeVectorNode('ime-vector');
      const vectorDrag = async () => {
        const rect = svg.getBoundingClientRect(), x = rect.left + 80, y = rect.top + 80;
        for (const [type, dx, dy, buttons] of [['pointerdown', 0, 0, 1], ['pointermove', 60, 35, 1], ['pointerup', 60, 35, 0]]) {
          svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
            button: 0, buttons, clientX: x + dx, clientY: y + dy }));
        }
        await sleep(50);
      };
      const vectorChecks = [];
      for (const theme of ['light', 'dark']) {
        if (ui.getState().theme !== theme) ui.getState().toggleTheme(); await sleep(80);
        input.blur();
        for (const values of [{ metaKey: true }, { isComposing: true }, {}]) {
          window.dispatchEvent(new Event('blur'));
          const prevented = key(svg, 'keydown', values); await sleep(40);
          const before = JSON.stringify(vector.getState().pan); await vectorDrag();
          vectorChecks.push({ theme, values, prevented, panned: before !== JSON.stringify(vector.getState().pan) });
          key(svg, 'keyup', values);
        }
      }
      return { reports: results, vectorChecks };
    })()`);
    for (const report of reports.reports) {
      for (const check of report.checks) {
        assert.equal(check.prevented, false, JSON.stringify(check));
        assert.equal(check.panned, false, JSON.stringify(check));
      }
      assert.equal(report.textSpace, false, 'Space in composer must remain text input');
      assert.equal(report.bareSpace, true, 'bare Space should activate canvas panning');
      assert.equal(report.bareSpacePanned, true, 'bare Space + drag should move the viewport');
      assert.equal(report.blurPanned, false, 'blur must release panning');
      assert.equal(report.focusPanned, false, 'text focus must release panning');
      assert.equal(report.modifierPanned, false, 'adding a modifier must release panning');
      assert.deepEqual(report.preserved, report.initial, 'theme switch must preserve session, draft, model and sidebar');
    }
    for (const check of reports.vectorChecks) {
      const bareSpace = Object.keys(check.values).length === 0;
      assert.equal(check.prevented, bareSpace, JSON.stringify(check));
      assert.equal(check.panned, bareSpace, JSON.stringify(check));
    }
    console.log('IME SHORTCUT UI: PASS (both themes; modified/composing Space passes through; bare Space pans; blur/focus/modifier reset; state preserved). OS input-method popup requires manual verification.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('codenode-ime-ui-')) return;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
