/**
 * 矢量设计工作室 —— 端到端 UI 验收脚本
 * 用法：先启动 vite dev server，再执行 node scripts/vector-ui-test.cjs
 * 驱动无头 Edge 通过 CDP 操作真实 DOM / React 事件，验证关键验收项。
 */
/* eslint-disable no-console */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.VECTOR_TEST_URL || 'http://localhost:5199';
const PORT = 9333;
const EDGE = process.env.VECTOR_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-vec-'));

let browser = null;
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startBrowser() {
  browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1500,950',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    BASE,
  ], { stdio: 'ignore' });
  // 等待 CDP 就绪
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('Edge CDP 未就绪');
}

async function stopBrowser() {
  if (browser) {
    try {
      browser.kill();
    } catch { /* ignore */ }
    await sleep(400);
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch { /* ignore */ }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails?.text || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面执行出错: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** 轮询直到表达式为真 */
async function waitFor(cdp, expression, timeoutMs = 8000, label = expression) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await cdp.eval(expression);
      if (last) return last;
    } catch (e) {
      last = String(e);
    }
    await sleep(120);
  }
  throw new Error(`等待超时: ${label} (last=${JSON.stringify(last)})`);
}

/** 在 svg 上派发一次指针拖动（从 world 坐标拖动 dx,dy 世界单位）
 *  startSelector：可选，pointerdown 直接派发到该元素（命中对象用），否则按坐标取元素 */
async function dragWorld(cdp, worldFrom, worldTo, button = 0, startSelector = null) {
  return cdp.eval(`(async () => {
    const svg = document.querySelector('.vs-svg');
    if (!svg) return 'no-svg';
    const rect = svg.getBoundingClientRect();
    const st = window.__codenodeVector.getState();
    const toClient = (w) => ({
      x: rect.left + 96 + st.pan.x + w.x * st.zoom,
      y: rect.top + 64 + st.pan.y + w.y * st.zoom,
    });
    const a = toClient(${JSON.stringify(worldFrom)});
    const b = toClient(${JSON.stringify(worldTo)});
    const opts = (x, y, extra = {}) => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: ${button}, buttons: 1, clientX: x, clientY: y, ...extra });
    const at = (x, y) => document.elementFromPoint(x, y) || svg;
    const startEl = ${startSelector ? `document.querySelector(${JSON.stringify(startSelector)})` : 'at(a.x, a.y)'} || at(a.x, a.y) || svg;
    startEl.dispatchEvent(new PointerEvent('pointerdown', opts(a.x, a.y)));
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      const el = at(x, y) || svg;
      el.dispatchEvent(new PointerEvent('pointermove', opts(x, y)));
      await new Promise((r) => setTimeout(r, 16));
    }
    const upEl = at(b.x, b.y) || svg;
    upEl.dispatchEvent(new PointerEvent('pointerup', opts(b.x, b.y)));
    return 'ok';
  })()`);
}

async function clickEl(cdp, selector, index = 0) {
  return cdp.eval(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    if (!els[${index}]) return 'missing:' + ${JSON.stringify(selector)};
    const el = els[${index}];
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return 'ok';
  })()`);
}

async function keyOnWindow(cdp, key, ctrl = false, shift = false) {
  return cdp.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, ctrlKey: ${ctrl}, shiftKey: ${shift}, bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
}

async function main() {
  console.log('▶ 启动无头 Edge…');
  await startBrowser();
  const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  console.log('▶ 页面已连接，等待应用加载…');

  try {
    /* ========== 0. 基础加载 ========== */
    await waitFor(cdp, `document.querySelector('.toolbar') && !!window.__codenodeVector`);
    console.log('— Agent 工作台已加载，矢量 store 已挂载');

    /* ========== 1. 进入矢量设计工作室 ========== */
    await clickEl(cdp, '.toolbar-vector');
    await waitFor(cdp, `!!document.querySelector('.vs-app')`, 6000, '矢量工作室挂载');
    ok('进入矢量设计工作室（全屏模式）', true);

    const objCount = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    await waitFor(cdp, `document.querySelectorAll('.vs-obj').length >= ${objCount}`);
    ok(`演示工程渲染 ${objCount} 个图形对象`, objCount >= 5, `实际 ${objCount}`);
    ok('画布纸张与网格渲染', await cdp.eval(`!!document.querySelector('.vs-paper') && !!document.querySelector('.vs-grid-layer')`));
    ok('标尺渲染', await cdp.eval(`!!document.querySelector('.vs-ruler-top') && !!document.querySelector('.vs-ruler-left')`));

    // 图层页
    await clickEl(cdp, '.vs-right-tabs button:nth-child(2)');
    await waitFor(cdp, `document.querySelectorAll('.vs-layer-list .vs-layer-row').length > 0`, 4000, '图层行');
    const layerRows = await cdp.eval(`document.querySelectorAll('.vs-layer-list .vs-layer-row').length`);
    ok(`图层面板列出 ${layerRows} 行`, layerRows >= 4, `实际 ${layerRows}`);
    // 属性页：先选中一个对象再断言
    await cdp.eval(`(() => { const s = window.__codenodeVector.getState(); s.selectIds([s.objects[0].id]); return 'ok'; })()`);
    await clickEl(cdp, '.vs-right-tabs button:nth-child(1)');
    await waitFor(cdp, `!!document.querySelector('.vs-props')`, 4000, '属性面板');
    ok('右栏属性面板显示（选中对象）', await cdp.eval(`document.querySelector('.vs-props').textContent.includes('变换')`));

    /* ========== 2. 单选对象 → 拖动移动 ========== */
    const alpha = await cdp.eval(`(() => { const o = window.__codenodeVector.getState().objects.find(o=>o.name.includes('Alpha')); return o ? {id:o.id,x:o.x,y:o.y,w:o.width,h:o.height} : null })()`);
    ok('Alpha 对象存在', Boolean(alpha));
    // 干净状态：清空选择 + 关闭吸附（位移断言不受吸附/多选干扰）
    await cdp.eval(`(() => { const st = window.__codenodeVector; st.getState().clearSelection(); st.getState().setTool('select'); if (st.getState().snapOn) st.getState().toggleSnap(); return 'ok'; })()`);
    const alphaCenter = { x: alpha.x + alpha.w / 2, y: alpha.y + alpha.h / 2 };
    // 直接命中 Alpha 元素拖动 +60,+40
    await dragWorld(cdp, { x: alphaCenter.x, y: alphaCenter.y }, { x: alphaCenter.x + 60, y: alphaCenter.y + 40 }, 0, `.vs-obj[data-oid="${alpha.id}"]`);
    const moved = await cdp.eval(`(() => { const o = window.__codenodeVector.getState().objects.find(o=>o.id===${JSON.stringify(alpha.id)}); return {x:o.x,y:o.y} })()`);
    const movedOk = Math.abs(moved.x - (alpha.x + 60)) < 3 && Math.abs(moved.y - (alpha.y + 40)) < 3;
    ok(`拖拽移动 Alpha 到 (+60,+40)`, movedOk, `实际位移 ${moved.x - alpha.x},${moved.y - alpha.y}`);
    ok('撤销一步可回退移动', await cdp.eval(`(() => { const st = window.__codenodeVector; const before = st.getState().objects.find(o=>o.id===${JSON.stringify(alpha.id)}).x; st.getState().undo(); const after = st.getState().objects.find(o=>o.id===${JSON.stringify(alpha.id)}).x; return Math.abs(before - after) > 50; })()`));

    /* ========== 3. 图形创建（矩形工具，拖拽） ========== */
    await clickEl(cdp, '.vs-toolrail button[title="矩形 (R)"]');
    const countBefore = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    const rectWorld = { x: 700, y: 420 };
    await dragWorld(cdp, { x: rectWorld.x, y: rectWorld.y }, { x: rectWorld.x + 160, y: rectWorld.y + 110 });
    await waitFor(cdp, `window.__codenodeVector.getState().objects.length === ${countBefore + 1}`);
    ok('拖拽创建矩形', true);
    const rectInfo = await cdp.eval(`(() => { const s = window.__codenodeVector.getState(); const o = s.objects[s.objects.length-1]; return { type: o.type, w: o.width, h: o.height, sel: s.selectedIds.includes(o.id) } })()`);
    ok('矩形尺寸≈拖拽范围且被选中', rectInfo.type === 'rectangle' && Math.abs(rectInfo.w - 160) < 4 && Math.abs(rectInfo.h - 110) < 4 && rectInfo.sel, JSON.stringify(rectInfo));

    /* ========== 4. 双击编辑文字 ========== */
    const rectObj = await cdp.eval(`(() => { const s = window.__codenodeVector.getState(); const o = s.objects[s.objects.length-1]; return { id: o.id, cx: o.x + o.width/2, cy: o.y + o.height/2 } })()`);
    await cdp.eval(`(() => { const svg = document.querySelector('.vs-svg'); const st = window.__codenodeVector.getState(); const r = svg.getBoundingClientRect(); const p = { x: r.left + 96 + st.pan.x + ${rectObj.cx} * st.zoom, y: r.top + 64 + st.pan.y + ${rectObj.cy} * st.zoom }; const el = document.elementFromPoint(p.x, p.y) || svg; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, view: window })); return 'ok'; })()`);
    await waitFor(cdp, `!!document.querySelector('.vs-foreign-edit .vs-edit-input')`, 5000, '内联编辑框出现');
    ok('双击矩形进入文字编辑', true);
    await cdp.eval(`(() => { const input = document.querySelector('.vs-foreign-edit .vs-edit-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '集合A'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); return 'ok'; })()`);
    await waitFor(cdp, `window.__codenodeVector.getState().objects[window.__codenodeVector.getState().objects.length-1].text === '集合A'`, 4000, '文字写入');
    ok('编辑文字实时写入对象', true);
    ok('文字标签渲染在图形上', await cdp.eval(`[...document.querySelectorAll('.vs-text-label tspan')].some(t => t.textContent === '集合A')`));

    /* ========== 5. 逻辑分析模式 ========== */
    await clickEl(cdp, '.vs-mode-switch button:nth-child(2)');
    await waitFor(cdp, `!!document.querySelector('.vs-logic')`, 6000, '逻辑面板');
    ok('切换到逻辑分析模式', true);
    const setRows = await cdp.eval(`document.querySelectorAll('.vs-set-row.on').length`);
    ok(`默认 3 个集合参与分析（实际 ${setRows}）`, setRows === 3, `rows=${setRows}`);
    const statsRows = await cdp.eval(`document.querySelectorAll('.vs-region-row').length`);
    ok(`区域统计表生成（${statsRows} 行）`, statsRows >= 1);
    const relations = await cdp.eval(`document.querySelectorAll('.vs-relation-row').length`);
    ok(`两两关系列出（${relations} 条）`, relations >= 1);
    const expr = await cdp.eval(`document.querySelector('.vs-expr-value')?.textContent`);
    ok(`表达式非空：${expr}`, Boolean(expr && !expr.includes('—')));

    // 切到并集验证画布高亮（三集交集为空集属正常）
    await clickEl(cdp, '.vs-op', 0);
    await waitFor(cdp, `document.querySelector('.vs-expr-value')?.textContent.includes('∪')`, 4000, '并集');
    await sleep(200);
    const unionArea = await cdp.eval(`Number((document.querySelector('.vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    ok(`并集结果区 ${unionArea.toLocaleString()} px² 且画布高亮`, unionArea > 500 && (await cdp.eval(`!!document.querySelector('.vs-logic-highlight')`)));
    await clickEl(cdp, '.vs-op', 2);
    await waitFor(cdp, `document.querySelector('.vs-expr-value')?.textContent.includes('−')`, 4000, '差集');
    await clickEl(cdp, '.vs-op', 4);
    await waitFor(cdp, `document.querySelector('.vs-expr-value')?.textContent.includes('ᶜ')`, 4000, '补集');
    ok('差集/补集表达式正常', true);

    /* ========== 6. 实时联动：逻辑模式移动图形 → 结果变化 ========== */
    await clickEl(cdp, '.vs-op', 0); // 并集
    await sleep(250);
    const uBefore = await cdp.eval(`Number((document.querySelector('.vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    const beta = await cdp.eval(`(() => { const o = window.__codenodeVector.getState().objects.find(o=>o.name.includes('Beta')); return { id: o.id, cx: o.x + o.width/2, cy: o.y + o.height/2 } })()`);
    const betaBefore = await cdp.eval(`window.__codenodeVector.getState().objects.find(o=>o.id===${JSON.stringify(beta.id)}).x`);
    // 真实指针拖动 Beta 向左 130px（保持在画布可视区内）
    await cdp.eval(`(() => { const st = window.__codenodeVector; st.getState().clearSelection(); if (st.getState().snapOn) st.getState().toggleSnap(); return 'ok'; })()`);
    await dragWorld(cdp, { x: beta.cx, y: beta.cy }, { x: beta.cx - 130, y: beta.cy }, 0, `.vs-obj[data-oid="${beta.id}"]`);
    await sleep(600);
    const uAfter = await cdp.eval(`Number((document.querySelector('.vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    const betaAfter = await cdp.eval(`window.__codenodeVector.getState().objects.find(o=>o.id===${JSON.stringify(beta.id)}).x`);
    ok(`真实拖拽移动 Beta (-130)`, betaBefore - betaAfter > 120, `实际 ${betaBefore - betaAfter}`);
    ok('并集结果面积随移动实时更新', uAfter !== uBefore, `${uBefore} → ${uAfter}`);
    await cdp.eval(`window.__codenodeVector.getState().undo()`);
    await sleep(200);

    /* ========== 7. 图层操作：多选 → 分组 → 解组 ========== */
    await clickEl(cdp, '.vs-mode-switch button:nth-child(1)'); // 回图像模式
    await waitFor(cdp, `!!document.querySelector('.vs-right')`, 5000);
    const gres = await cdp.eval(`(() => { const st = window.__codenodeVector; st.getState().selectIds(st.getState().objects.slice(0,2).map(o=>o.id)); st.getState().groupSelected('测试组'); const s2 = st.getState(); const g = s2.groups[s2.groups.length-1]; return g ? { name: g.name, n: g.memberIds.length, grouped: s2.objects.filter(o=>o.groupId===g.id).length } : null })()`);
    ok('多选编组成功', gres && gres.n === 2 && gres.grouped === 2, JSON.stringify(gres));
    await clickEl(cdp, '.vs-right-tabs button:nth-child(2)');
    await waitFor(cdp, `document.querySelector('.vs-layer-name b')?.textContent === '测试组'`, 4000, '组头行');
    ok('图层面板显示组头（可折叠）', true);
    const ungroupOk = await cdp.eval(`(() => { const st = window.__codenodeVector; st.getState().selectIds(st.getState().objects.slice(0,2).map(o=>o.id)); st.getState().ungroupSelected(); const s2 = st.getState(); return s2.groups.length === 0 && s2.objects.every(o=>!o.groupId); })()`);
    ok('取消分组恢复独立图层', ungroupOk);

    // 显隐/锁定/重命名
    const visOk = await cdp.eval(`(() => { const st = window.__codenodeVector; const id = st.getState().objects[0].id; st.getState().toggleVisible([id]); const v1 = !st.getState().objects[0].visible; st.getState().toggleVisible([id]); return v1 && st.getState().objects[0].visible; })()`);
    ok('图层显隐切换', visOk);
    const lockOk = await cdp.eval(`(() => { const st = window.__codenodeVector; const id = st.getState().objects[1].id; st.getState().toggleLocked([id]); const l1 = st.getState().objects[1].locked; st.getState().toggleLocked([id]); return l1 && !st.getState().objects[1].locked; })()`);
    ok('图层锁定切换', lockOk);
    await cdp.eval(`(() => { const st = window.__codenodeVector; st.getState().renameLayer(st.getState().objects[0].id, '改名图形'); return 'ok'; })()`);
    ok('图层重命名', await cdp.eval(`window.__codenodeVector.getState().objects[0].name === '改名图形'`));
    // 层级移动：置底第一个对象 → 变最上层（数组末尾）
    const orderOk = await cdp.eval(`(() => { const st = window.__codenodeVector; const first = st.getState().objects[0].id; st.getState().selectIds([first]); const before = st.getState().objects.map(o=>o.id); st.getState().reorderObjects([...before.slice(1), first], ''); return st.getState().objects[st.getState().objects.length-1].id === first; })()`);
    ok('层级重排（底层移到最上层）', orderOk);

    /* ========== 8. 快捷键 ========== */
    const n1 = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    await cdp.eval(`(() => { const s = window.__codenodeVector.getState(); s.selectIds([s.objects[0].id]); return 'ok'; })()`);
    await keyOnWindow(cdp, 'Delete');
    await sleep(150);
    const n2 = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    ok('Delete 删除选中图形', n2 === n1 - 1, `${n1}→${n2}`);
    await keyOnWindow(cdp, 'z', true);
    await sleep(150);
    const n3 = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    ok('Ctrl+Z 撤销恢复', n3 === n1);
    await keyOnWindow(cdp, 'z', true, true);
    await sleep(150);
    const n4 = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    ok('Ctrl+Shift+Z 重做再次删除', n4 === n1 - 1);

    /* ========== 9. 保存 → 刷新恢复 ========== */
    await cdp.eval(`window.__codenodeVector.getState().saveProject()`);
    const saved = await cdp.eval(`JSON.parse(localStorage.getItem('codenode.vector.project.v2')).objects.length`);
    ok(`项目保存到 localStorage（${saved} 个对象）`, saved === n4);
    await cdp.eval(`location.reload()`);
    await waitFor(cdp, `!!document.querySelector('.toolbar') && !!window.__codenodeVector`, 10000, '刷新后工作台');
    await clickEl(cdp, '.toolbar-vector');
    await waitFor(cdp, `!!document.querySelector('.vs-app')`, 6000, '再次进入');
    const restored = await cdp.eval(`window.__codenodeVector.getState().objects.length`);
    ok(`刷新后项目自动恢复（${restored} 个对象）`, restored === n4, `restored=${restored}`);
    ok('恢复后图形可见', await cdp.eval(`document.querySelectorAll('.vs-obj').length >= ${Math.max(1, restored - 1)}`));

    /* ========== 10. 主题切换 + 返回工作台 ========== */
    await clickEl(cdp, '.vs-top-actions .vs-icon-btn:last-child');
    ok('深浅主题切换', await cdp.eval(`document.querySelector('.vs-app').classList.contains('vs-light')`));
    await clickEl(cdp, '.vs-btn-back');
    await waitFor(cdp, `document.querySelector('.toolbar') && !document.querySelector('.vs-app')`, 6000, '返回工作台');
    ok('返回 Agent 工作台（工作台未被破坏）', await cdp.eval(`document.querySelectorAll('.toolbar-group button').length > 5`));
    await clickEl(cdp, '.toolbar-vector');
    await waitFor(cdp, `!!document.querySelector('.vs-app')`, 6000, '再次进入');
    ok('工作台 ↔ 矢量工作室往返切换', true);
  } catch (e) {
    failed += 1;
    failures.push(`脚本异常: ${e.message}`);
    console.error('脚本异常:', e.message);
  }

  /* ========== 控制台错误汇总 ========== */
  await sleep(600);
  const realErrors = cdp.errors.filter((t) => !t.includes('favicon') && !t.includes('DevTools') && !t.includes('404'));
  ok('页面无未捕获异常 / console.error', cdp.exceptions.length === 0 && realErrors.length === 0,
    `exceptions=${cdp.exceptions.length} errors=${realErrors.slice(0, 3).join(' | ')}`);

  console.log(`\n════ 结果：通过 ${passed} / 失败 ${failed} ════`);
  if (failures.length) {
    console.log('失败项：', failures.join('\n  - '));
  }
  cdp.close();
  await stopBrowser();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  await stopBrowser();
  process.exit(1);
});
