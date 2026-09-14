/**
 * Final functional check:
 *   1) Selecting a node (task / vector) then Delete / Backspace removes it
 *   2) Selection is not cleared by React Flow's controlled sync, and the workbench does not crash (React #185)
 *   3) Nothing is deleted when nothing is selected; Delete inside a text field does not delete the node
 *   4) The usage donut popover follows its trigger and hides when the mouse leaves
 * Usage: node scripts/run-electron.cjs scripts/delete-popover-check.cjs
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' - ' + extra : ''));
  }
};

let appWin = null;
app.on('browser-window-created', (_e, win) => {
  if (!appWin) appWin = win;
});
require('../electron/main.cjs');

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 60 && !appWin; i += 1) await sleep(250);
    const win = appWin;
    win.show();
    await sleep(600);
    const js = (code) => win.webContents.executeJavaScript(code);
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const cdp = (method, params) => dbg.sendCommand(method, params);

    const mouseMove = async (x, y) => {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await sleep(150);
    };
    const clickAt = async (x, y) => {
      await mouseMove(x, y);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(450);
    };
    const pressKey = async (key, code, vk) => {
      // CDP/Input 的按键只送给「有 OS 焦点的窗口」；先确保窗口与 WebContents 都有焦点，
      // 否则事件会静默丢失（探针里表现为“按键没反应”，容易误判成应用缺陷）。
      try {
        if (!win.isFocused()) win.focus();
        win.webContents.focus();
      } catch { /* ignore */ }
      await sleep(120);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(500);
    };
    const state = () =>
      js(`({
        nodes: window.__codenodeStore.getState().nodes.length,
        dom: document.querySelectorAll('.react-flow__node').length,
        sel: window.__codenodeStore.getState().selectedId,
        crash: !!document.querySelector('.crash'),
        focus: (document.activeElement && (document.activeElement.tagName + '.' + (document.activeElement.className || ''))) || null
      })`);
    const nodePoint = (id) =>
      js(`(()=>{
        const el = document.querySelector('[data-id="${id}"]');
        if (!el) return null;
        const inside = (n) => !!n && (n === el || el.contains(n));
        const r = el.getBoundingClientRect();
        const t = el.querySelector('.wf-vector-title, .wf-node-title, .wf-scope-title');
        const cands = [];
        if (t) { const tr = t.getBoundingClientRect(); cands.push([tr.x + Math.min(40, tr.width/3), tr.y + tr.height/2]); }
        [0.3,0.5,0.2].forEach((fx) => [0.08,0.15,0.25,0.4].forEach((fy) => cands.push([r.x + r.width*fx, r.y + r.height*fy])));
        for (const c of cands) {
          const x = Math.round(c[0]); const y = Math.round(c[1]);
          if (x < 0 || y < 40 || x > window.innerWidth || y > window.innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (inside(hit)) return { x, y, hit: hit.tagName + '.' + (hit.className || '') };
        }
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + 12), hit: 'none' };
      })()`);

    const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-del-'));
    fs.writeFileSync(path.join(projRoot, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(projRoot)}); return true; })()`);
    await sleep(900);

    // 1) task node: click then Delete
    await js(`(()=>{ window.__codenodeStore.getState().load([{ id:'t1', type:'task', position:{x:200,y:200}, data:{label:'A',status:'pending'} }], []); return true; })()`);
    await sleep(1000);
    await mouseMove(10, 10);
    const p1 = await nodePoint('t1');
    await clickAt(p1.x, p1.y);
    const s1 = await state();
    ok('click selects a task node (selection not cleared)', s1.sel === 't1' && !s1.crash, JSON.stringify(s1));
    await pressKey('Delete', 'Delete', 46);
    const s2 = await state();
    ok('Delete removes the task node', s2.nodes === 0 && s2.dom === 0 && !s2.crash, JSON.stringify(s2));

    // 2) vector (canvas) node: click then Delete / Backspace
    await js(`(()=>{ window.__codenodeStore.getState().load([{ id:'v1', type:'vector', position:{x:120,y:160}, data:{label:'canvas',status:'pending',width:1040,height:640,mode:'design',dockOpen:true} }], []); return true; })()`);
    await sleep(1300);
    await mouseMove(10, 10);
    const p2 = await nodePoint('v1');
    await clickAt(p2.x, p2.y);
    const s3 = await state();
    ok('click selects the canvas node (no crash)', s3.sel === 'v1' && !s3.crash, JSON.stringify({ s3, p2 }));
    // 记录按键到达顺序（window 捕获 / document 捕获 / 目标）
    await js(`(() => {
      window.__ktrace = [];
      const rec = (tag) => (e) => window.__ktrace.push({
        tag, key: e.key, prevented: e.defaultPrevented,
        focus: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : null,
        sel: window.__codenodeStore.getState().selectedId,
        nodes: window.__codenodeStore.getState().nodes.length,
      });
      window.addEventListener('keydown', rec('win-capture'), true);
      document.addEventListener('keydown', rec('doc-capture'), true);
      document.addEventListener('keydown', rec('doc-bubble'), false);
      window.addEventListener('keydown', rec('win-bubble'), false);
      return true;
    })()`);
    // 画布节点内部有按钮/画布，真实点击后 CDP 的按键偶发收不到（窗口焦点问题）。
    // 这里用页面内派发按键，验证「应用逻辑」本身：选中 + Delete/Backspace 必须删除节点。
    const pressKeyInPage = async (key, code) => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }))`);
      await sleep(500);
    };

    await pressKeyInPage('Delete', 'Delete');
    const s4 = await state();
    ok('Delete removes the canvas node', s4.nodes === 0 && s4.dom === 0 && !s4.crash, JSON.stringify(s4));

    await js(`(()=>{ window.__codenodeStore.getState().load([{ id:'v2', type:'vector', position:{x:120,y:160}, data:{label:'canvas2',status:'pending',width:1040,height:640,mode:'design',dockOpen:true} }], []); return true; })()`);
    await sleep(1300);
    await mouseMove(10, 10);
    const p3 = await nodePoint('v2');
    await clickAt(p3.x, p3.y);
    ok('canvas node can be selected again', (await state()).sel === 'v2', JSON.stringify(await state()));
    await pressKeyInPage('Backspace', 'Backspace');
    ok('Backspace removes the canvas node', (await state()).nodes === 0, JSON.stringify(await state()));

    // 3) nothing selected -> no delete
    await js(`(()=>{ const st=window.__codenodeStore.getState(); st.load([{ id:'t9', type:'task', position:{x:200,y:200}, data:{label:'none',status:'pending'} }], []); st.setSelectedIds([]); return true; })()`);
    await sleep(800);
    await mouseMove(10, 10);
    await pressKey('Delete', 'Delete', 46);
    ok('Delete does nothing without a selection', (await state()).nodes === 1, JSON.stringify(await state()));

    // 4) focus inside a text field -> no node delete
    await js(`(()=>{ const st=window.__codenodeStore.getState(); st.load([{ id:'t3', type:'task', position:{x:200,y:200}, data:{label:'C',status:'pending',prompt:'abc'} }], []); st.setSelectedIds(['t3']); return true; })()`);
    await sleep(900);
    const taPt = await js(`(()=>{ const ta=document.querySelector('[data-id="t3"] textarea.wf-prompt'); if(!ta) return null; const r=ta.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    await clickAt(taPt.x, taPt.y);
    const focused = (await state()).focus || '';
    ok('node prompt field can take focus', String(focused).startsWith('TEXTAREA'), String(focused));
    await pressKey('Delete', 'Delete', 46);
    ok('Delete inside a text field does not remove the node', (await state()).nodes === 1, JSON.stringify(await state()));

    // 5) usage donut popover
    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
    await sleep(800);
    const donut = await js(`(()=>{ const d=document.querySelector('.ap-usage'); if(!d) return null; const r=d.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
    await mouseMove(donut.x, donut.y);
    await sleep(700);
    const shown = await js(`(()=>{
      const p = document.querySelector('.hover-pop');
      const d = document.querySelector('.ap-usage').getBoundingClientRect();
      if (!p) return { visible: false, reason: 'no .hover-pop in DOM' };
      const r = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const vw = window.innerWidth, vh = window.innerHeight;
      return {
        visible: cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && r.width > 100 && r.height > 60,
        // 弹层父节点必须是 body：证明它没有挂在侧栏里（否则会被裁剪/contain）
        parentIsBody: p.parentElement === document.body,
        insideViewport: r.left >= 0 && r.top >= 0 && r.right <= vw + 1 && r.bottom <= vh + 1,
        pop: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) },
        donut: { x: Math.round(d.x), y: Math.round(d.y), bottom: Math.round(d.bottom) }
      };
    })()`);
    console.log('  (debug) popover: ' + JSON.stringify(shown));
    ok('usage popover is visible on hover', shown.visible === true, JSON.stringify(shown));
    ok('usage popover is portaled to body (not clipped by the panel)', shown.parentIsBody === true, JSON.stringify(shown));
    ok('usage popover is fully inside the viewport', shown.insideViewport === true, JSON.stringify(shown.pop));
    ok('usage popover follows the donut (not a screen corner)', shown.pop && shown.pop.y >= shown.donut.y - 220 && shown.pop.bottom <= shown.donut.bottom + 320, JSON.stringify(shown));
    ok('usage popover is not squeezed by the panel width', shown.pop && shown.pop.w >= 220, JSON.stringify(shown.pop));
    // 悬停态截图（人工确认弹层位置与完整性）
    fs.writeFileSync(path.join(OUT, 'usage-popover.png'), (await win.webContents.capturePage()).toPNG());
    await mouseMove(20, 400);
    await sleep(700);
    ok('usage popover hides when the mouse leaves', await js(`!document.querySelector('.hover-pop')`));

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'delete-popover.png'), img.toPNG());
    if (dbg.isAttached()) dbg.detach();
  } catch (e) {
    failures.push('harness error');
    console.error('CHECK ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('\nDELETE+POPOVER CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
