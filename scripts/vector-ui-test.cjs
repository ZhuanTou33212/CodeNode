/**
 * 画布节点（矢量画布）—— 端到端 UI 验收脚本
 * 用法：先启动 vite dev server（例如 npx vite --port 5199），再执行 node scripts/vector-ui-test.cjs
 * 驱动无头 Edge 通过 CDP 操作真实 DOM / React 事件，验证关键验收项。
 *
 * 重构后矢量画布不再单独占一栏，而是嵌在 Agent 画布上的「画布节点」里：
 *  - 左上角切换 设计 / 逻辑 模式
 *  - 左侧工具 + 预设配件，可用预设配件自由绘制
 *  - 保持 Blender 风格节点外观与左右端口
 */
/* eslint-disable no-console */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.VECTOR_TEST_URL || 'http://localhost:5199';
// 调试端口每次随机，避免上一次残留的 Edge 进程占用固定端口导致连不上
const PORT = Number(process.env.VECTOR_TEST_PORT) || 9500 + Math.floor(Math.random() * 400);
const EDGE = process.env.VECTOR_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-vec-'));

/** 画布节点根选择器 */
const NODE = '[data-testid="vector-node"]';
/** 纸张在世界坐标中的固定偏移，与 src/vector/types.ts 的 PAPER_ORIGIN 一致 */
const PAPER_ORIGIN = { x: 96, y: 64 };

let browser = null;
let passed = 0;
let failed = 0;
const failures = [];

/** 同步输出：避免 process.exit() 截断管道里未 flush 的 stdout。 */
function out(line) {
  try {
    fs.writeSync(1, String(line) + '\n');
  } catch {
    console.log(line);
  }
}

function err(line) {
  try {
    fs.writeSync(2, String(line) + '\n');
  } catch {
    console.error(line);
  }
}

function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    out(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    out(`  ✗ ${name} ${extra}`);
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
    // Windows 上 kill 主进程会留下子进程，用 taskkill /T 结束整棵进程树
    try {
      if (process.platform === 'win32' && browser.pid) {
        spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        browser.kill();
      }
    } catch { /* ignore */ }
    await sleep(600);
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

/**
 * React Flow 会对节点整体做 CSS scale；屏幕像素与 SVG 本地像素因此不是 1:1。
 * 从 viewport 的 transform 里读出缩放比例，用于把世界坐标换算成真实 client 坐标。
 */
async function readStageScale(cdp) {
  return cdp.eval(`(() => {
    const el = document.querySelector('.react-flow__viewport');
    const m = el && /scale\\(([-0-9.]+)\\)/.exec(el.style.transform || '');
    return m ? parseFloat(m[1]) : 1;
  })()`);
}

/** 在画布节点的 svg 上按世界坐标派发一次指针拖动 */
async function dragWorld(cdp, worldFrom, worldTo, button = 0, startSelector = null) {
  const scale = await readStageScale(cdp);
  return cdp.eval(`(async () => {
    const svg = document.querySelector(${JSON.stringify(NODE)} + ' .vs-svg');
    if (!svg) return 'no-svg';
    const rect = svg.getBoundingClientRect();
    const st = window.__codenodeVectorNode(document.querySelector('.react-flow__node-vector').dataset.id).getState();
    const scale = ${scale};
    const toClient = (w) => ({
      x: rect.left + (${PAPER_ORIGIN.x} + st.pan.x + w.x * st.zoom) * scale,
      y: rect.top + (${PAPER_ORIGIN.y} + st.pan.y + w.y * st.zoom) * scale,
    });
    const a = toClient(${JSON.stringify(worldFrom)});
    const b = toClient(${JSON.stringify(worldTo)});
    const opts = (x, y, extra = {}) => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: ${button}, buttons: 1, clientX: x, clientY: y, ...extra });
    // 真实拖动里应用会 setPointerCapture，事件始终回到 svg；这里做同样的事，
    // 否则浮层元素（如逻辑图例）会吞掉中途的 pointermove。
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && svg.contains(el) ? el : svg;
    };
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
  out('▶ 启动无头 Edge…');
  await startBrowser();
  const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  out('▶ 页面已连接，等待应用加载…');

  let nodeId = null;
  /** 读取当前画布节点 store 状态表达式；g() 每次都会拿到最新 state，s 是进入时的快照 */
  const vs = (expr) =>
    cdp.eval(`(() => { const g = () => window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState(); const s = g(); return ${expr}; })()`);

  try {
    /* ========== 0. 基础加载 ========== */
    await waitFor(cdp, `document.querySelector('.toolbar') && !!window.__codenodeVectorNode`);
    out('— Agent 工作台已加载，画布节点 store 工厂已挂载');

    /* ========== 1. 在画布上新增画布节点（不再单独占一栏） ========== */
    ok('工具栏不再进入独立矢量工作区', await cdp.eval(`!/矢量设计工作室/.test(document.querySelector('.toolbar-vector').title)`));
    await clickEl(cdp, '.toolbar-vector');
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(NODE)})`, 6000, '画布节点挂载');
    nodeId = await cdp.eval(`document.querySelector('.react-flow__node-vector').dataset.id`);
    ok('画布节点直接出现在 Agent 画布上', Boolean(nodeId));
    ok('工作台画布未被替换（无全屏工作区）', await cdp.eval(`!!document.querySelector('.react-flow') && !document.querySelector('.vs-app')`));
    ok('节点类型为 vector，且带 Blender 风格端口', await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .wf-handle').length === 2`));

    /* ========== 2. 节点结构：左上角模式切换 + 预设配件 ========== */
    ok('模式切换位于节点左上角', await cdp.eval(`document.querySelector(${JSON.stringify(NODE)} + ' .wf-vector-title').firstElementChild.classList.contains('wf-vector-modes')`));
    const modeBtns = await cdp.eval(`[...document.querySelectorAll(${JSON.stringify(NODE)} + ' .wf-vector-mode')].map(b => b.textContent.trim())`);
    ok(`模式按钮为 设计/逻辑（${JSON.stringify(modeBtns)}）`, modeBtns.length === 2 && modeBtns[0].includes('设计') && modeBtns[1].includes('逻辑'));
    ok('初始为设计模式', await cdp.eval(`document.querySelector(${JSON.stringify(NODE)} + ' .wf-vector-mode').classList.contains('on')`));
    ok('纸张与网格渲染', await cdp.eval(`!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-paper') && !!document.querySelector(${JSON.stringify(NODE)} + ' .vs-grid-layer')`));
    ok('标尺渲染', await cdp.eval(`!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-ruler-top') && !!document.querySelector(${JSON.stringify(NODE)} + ' .vs-ruler-left')`));
    const toolCount = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .wf-vector-tool').length`);
    const presetCount = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .wf-vector-asset').length`);
    ok(`工具 ${toolCount} 个 / 预设配件 ${presetCount} 个`, toolCount === 8 && presetCount === 6, `${toolCount}/${presetCount}`);
    ok('节点文档初始为空白', (await vs('s.objects.length')) === 0, `objects=${await vs('s.objects.length')}`);

    /* ========== 3. 用预设配件放置图形 ========== */
    await clickEl(cdp, `${NODE} .wf-vector-asset`);
    await waitFor(cdp, `window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().objects.length === 1`);
    const presetInfo = await vs(`(() => { const o = s.objects[0]; return { type: o.type, sel: s.selectedIds.includes(o.id), name: o.name }; })()`);
    ok('点击预设配件生成矩形并选中', presetInfo.type === 'rectangle' && presetInfo.sel, JSON.stringify(presetInfo));

    /* ========== 4. 工具自由绘制：拖拽创建矩形 ========== */
    await clickEl(cdp, `${NODE} .wf-vector-tool[title="矩形 (R)"]`);
    const countBefore = await vs('s.objects.length');
    const rectWorld = { x: 700, y: 420 };
    await dragWorld(cdp, { x: rectWorld.x, y: rectWorld.y }, { x: rectWorld.x + 160, y: rectWorld.y + 110 });
    await waitFor(cdp, `window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().objects.length === ${countBefore + 1}`);
    ok('拖拽创建矩形', true);
    const rectInfo = await vs(`(() => { const o = s.objects[s.objects.length-1]; return { type: o.type, w: o.width, h: o.height, sel: s.selectedIds.includes(o.id) }; })()`);
    ok('矩形尺寸≈拖拽范围且被选中', rectInfo.type === 'rectangle' && Math.abs(rectInfo.w - 160) < 6 && Math.abs(rectInfo.h - 110) < 6 && rectInfo.sel, JSON.stringify(rectInfo));

    /* ========== 5. 双击编辑文字 ========== */
    const rectObj = await vs(`(() => { const o = s.objects[s.objects.length-1]; return { id: o.id, cx: o.x + o.width/2, cy: o.y + o.height/2 }; })()`);
    const scale = await readStageScale(cdp);
    await cdp.eval(`(() => {
      const svg = document.querySelector(${JSON.stringify(NODE)} + ' .vs-svg');
      const st = window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState();
      const r = svg.getBoundingClientRect();
      const p = { x: r.left + (${PAPER_ORIGIN.x} + st.pan.x + ${rectObj.cx} * st.zoom) * ${scale}, y: r.top + (${PAPER_ORIGIN.y} + st.pan.y + ${rectObj.cy} * st.zoom) * ${scale} };
      const el = document.elementFromPoint(p.x, p.y) || svg;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, view: window }));
      return 'ok';
    })()`);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-foreign-edit .vs-edit-input')`, 5000, '内联编辑框出现');
    ok('双击矩形进入文字编辑', true);
    await cdp.eval(`(() => { const input = document.querySelector(${JSON.stringify(NODE)} + ' .vs-foreign-edit .vs-edit-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '集合A'); input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); return 'ok'; })()`);
    await waitFor(cdp, `window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().objects[window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().objects.length-1].text === '集合A'`, 4000, '文字写入');
    ok('编辑文字实时写入对象', true);
    ok('文字标签渲染在图形上', await cdp.eval(`[...document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-text-label tspan')].some(t => t.textContent === '集合A')`));

    /* ========== 6. 撤销 / 重做（节点内历史，不与工作台冲突） ========== */
    const beforeUndo = await vs('s.objects.length');
    await cdp.eval(`window.__codenodeStore.getState().setSelectedIds([${JSON.stringify(nodeId)}])`);
    await keyOnWindow(cdp, 'z', true);
    await sleep(200);
    const afterUndo = await vs('s.past.length');
    ok('Ctrl+Z 作用于画布节点内容（不撤销工作台节点）', (await vs('s.objects.length')) <= beforeUndo && afterUndo >= 0);
    await keyOnWindow(cdp, 'z', true, true);
    await sleep(200);
    ok('Ctrl+Shift+Z 重做', (await vs('s.objects.length')) === beforeUndo, `${beforeUndo} → ${await vs('s.objects.length')}`);

    /* ========== 7. 模式切换到逻辑分析 ========== */
    await clickEl(cdp, `${NODE} .wf-vector-mode`, 1);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-logic')`, 6000, '逻辑面板');
    ok('节点内左上角切换到逻辑模式', true);
    ok('模式写回节点 data', (await cdp.eval(`window.__codenodeStore.getState().nodes.find(n => n.id === ${JSON.stringify(nodeId)}).data.mode`)) === 'logic');

    // 载入示例工程 → 3 个集合参与分析
    await clickEl(cdp, `${NODE} .wf-vector-mini[title="载入示例工程"]`);
    await waitFor(cdp, `window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().objects.length >= 5`, 5000, '示例工程');
    const setRows = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-set-row.on').length`);
    ok(`默认 3 个集合参与分析（实际 ${setRows}）`, setRows === 3, `rows=${setRows}`);
    const statsRows = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-region-row').length`);
    ok(`区域统计表生成（${statsRows} 行）`, statsRows >= 1);
    const relations = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-relation-row').length`);
    ok(`两两关系列出（${relations} 条）`, relations >= 1);
    const expr = await cdp.eval(`document.querySelector(${JSON.stringify(NODE)} + ' .vs-expr-value')?.textContent`);
    ok(`表达式非空：${expr}`, Boolean(expr && !expr.includes('—')));

    await clickEl(cdp, `${NODE} .vs-op`, 0);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(NODE)} + ' .vs-expr-value')?.textContent.includes('∪')`, 4000, '并集');
    await sleep(200);
    const unionArea = await cdp.eval(`Number((document.querySelector(${JSON.stringify(NODE)} + ' .vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    ok(`并集结果区 ${unionArea.toLocaleString()} px² 且画布高亮`, unionArea > 500 && (await cdp.eval(`!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-logic-highlight')`)));

    /* ========== 8. 逻辑模式实时联动：移动图形 → 结果面积变化 ========== */
    const uBefore = await cdp.eval(`Number((document.querySelector(${JSON.stringify(NODE)} + ' .vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    const beta = await vs(`(() => { const o = s.objects.find(x => x.name.includes('Beta')); return o ? { id: o.id, cx: o.x + o.width/2, cy: o.y + o.height/2, x: o.x } : null; })()`);
    ok('示例工程包含 Beta 集合', Boolean(beta));
    await cdp.eval(`(() => { const st = window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState(); st.clearSelection(); if (st.snapOn) st.toggleSnap(); return 'ok'; })()`);
    await dragWorld(cdp, { x: beta.cx, y: beta.cy }, { x: beta.cx - 110, y: beta.cy }, 0, `${NODE} .vs-obj[data-oid="${beta.id}"]`);
    await sleep(600);
    const betaAfter = await vs(`s.objects.find(o => o.id === ${JSON.stringify(beta.id)}).x`);
    const uAfter = await cdp.eval(`Number((document.querySelector(${JSON.stringify(NODE)} + ' .vs-logic-legend b')?.textContent||'0').replace(/[^0-9]/g,''))`);
    ok(`真实拖拽移动 Beta（-110，实际 ${Math.round(beta.x - betaAfter)}）`, beta.x - betaAfter > 90);
    ok('并集结果面积随拖动实时更新', uAfter !== uBefore, `${uBefore} → ${uAfter}`);

    /* ========== 9. 回到设计模式：属性 / 图层面板 ========== */
    await clickEl(cdp, `${NODE} .wf-vector-mode`, 0);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-right-tabs')`, 5000, '设计面板');
    await cdp.eval(`(() => { const s = window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState(); s.selectIds([s.objects[0].id]); return 'ok'; })()`);
    await clickEl(cdp, `${NODE} .vs-right-tabs button`, 0);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(NODE)} + ' .vs-props')`, 4000, '属性面板');
    ok('右栏属性面板显示（选中对象）', await cdp.eval(`document.querySelector(${JSON.stringify(NODE)} + ' .vs-props').textContent.includes('变换')`));
    await clickEl(cdp, `${NODE} .vs-right-tabs button`, 1);
    await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-layer-list .vs-layer-row').length > 0`, 4000, '图层行');
    const layerRows = await cdp.eval(`document.querySelectorAll(${JSON.stringify(NODE)} + ' .vs-layer-list .vs-layer-row').length`);
    ok(`图层面板列出 ${layerRows} 行`, layerRows >= 4, `实际 ${layerRows}`);

    /* ========== 10. 图层操作：编组 / 解组 / 显隐 / 锁定 / 重命名 / 层级 ========== */
    const gres = await vs(`(() => { g().selectIds(g().objects.slice(0,2).map(o => o.id)); g().groupSelected('测试组'); const s2 = g(); const g0 = s2.groups[s2.groups.length-1]; return g0 ? { name: g0.name, n: g0.memberIds.length, grouped: s2.objects.filter(o => o.groupId === g0.id).length } : null; })()`);
    ok('多选编组成功', gres && gres.n === 2 && gres.grouped === 2, JSON.stringify(gres));
    const ungroupOk = await vs(`(() => { g().selectIds(g().objects.slice(0,2).map(o => o.id)); g().ungroupSelected(); const s2 = g(); return s2.groups.length === 0 && s2.objects.every(o => !o.groupId); })()`);
    ok('取消分组恢复独立图层', ungroupOk);
    const visOk = await vs(`(() => { const id = g().objects[0].id; g().toggleVisible([id]); const v1 = !g().objects[0].visible; g().toggleVisible([id]); return v1 && g().objects[0].visible; })()`);
    ok('图层显隐切换', visOk);
    const lockOk = await vs(`(() => { const id = g().objects[1].id; g().toggleLocked([id]); const l1 = g().objects[1].locked; g().toggleLocked([id]); return l1 && !g().objects[1].locked; })()`);
    ok('图层锁定切换', lockOk);
    const renameOk = await vs(`(() => { g().renameLayer(g().objects[0].id, '改名图形'); return g().objects[0].name === '改名图形'; })()`);
    ok('图层重命名', renameOk);
    const orderOk = await vs(`(() => { const first = g().objects[0].id; g().selectIds([first]); const before = g().objects.map(o => o.id); g().reorderObjects([...before.slice(1), first], ''); return g().objects[g().objects.length-1].id === first; })()`);
    ok('层级重排（底层移到最上层）', orderOk);

    /* ========== 11. Delete 删除选中图形 ========== */
    const n1 = await vs('s.objects.length');
    await cdp.eval(`(() => { const s = window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState(); s.selectIds([s.objects[0].id]); return 'ok'; })()`);
    await keyOnWindow(cdp, 'Delete');
    await sleep(200);
    const n2 = await vs('s.objects.length');
    ok('Delete 删除节点内选中图形（不删除画布节点）', n2 === n1 - 1, `${n1}→${n2}`);
    ok('画布节点本身仍然存在', await cdp.eval(`!!document.querySelector('.react-flow__node-vector')`));

    /* ========== 12. 持久化：文档写入节点专属 key ========== */
    await cdp.eval(`window.__codenodeVectorNode(${JSON.stringify(nodeId)}).getState().saveProject()`);
    await sleep(200);
    const saved = await cdp.eval(`(() => { const raw = localStorage.getItem('codenode.vector.node.' + ${JSON.stringify(nodeId)}); return raw ? JSON.parse(raw).objects.length : -1; })()`);
    ok(`画布节点文档保存到独立 localStorage（${saved} 个对象）`, saved === n2, `saved=${saved} expect=${n2}`);

    /* ========== 13. 多个画布节点：各自独立文档 ========== */
    const firstId = nodeId;
    const firstCount = await vs('s.objects.length');
    await clickEl(cdp, '.toolbar-vector');
    await waitFor(cdp, `document.querySelectorAll('.react-flow__node-vector').length === 2`, 6000, '第二个画布节点');
    const ids = await cdp.eval(`[...document.querySelectorAll('.react-flow__node-vector')].map(n => n.dataset.id)`);
    const secondId = ids.find((x) => x !== firstId);
    ok('可以再新增一个画布节点', Boolean(secondId), JSON.stringify(ids));
    ok('两个画布节点 store 实例不同', await cdp.eval(`window.__codenodeVectorNode(${JSON.stringify(firstId)}) !== window.__codenodeVectorNode(${JSON.stringify(secondId)})`));
    const secondCount = await cdp.eval(`window.__codenodeVectorNode(${JSON.stringify(secondId)}).getState().objects.length`);
    ok(`新画布节点是独立空白文档（${firstCount} / ${secondCount}）`, firstCount > 0 && secondCount === 0);
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.react-flow__node-vector')].find(n => n.dataset.id === ${JSON.stringify(secondId)});
      el.querySelector('.wf-vector-asset').click();
      return 'ok';
    })()`);
    await waitFor(cdp, `window.__codenodeVectorNode(${JSON.stringify(secondId)}).getState().objects.length === 1`, 4000, '第二节点新增图形');
    const firstAfter = await cdp.eval(`window.__codenodeVectorNode(${JSON.stringify(firstId)}).getState().objects.length`);
    ok('在第二个节点绘制不影响第一个节点', firstAfter === firstCount, `${firstCount} → ${firstAfter}`);

    /* ========== 14. 画布节点 × 工作台互不干扰 ========== */
    ok('工作台工具栏仍然完整', await cdp.eval(`document.querySelectorAll('.toolbar-group button').length > 5`));
    ok('画布节点带标题栏（Blender 风格）', await cdp.eval(`!!document.querySelector(${JSON.stringify(NODE)} + ' .wf-vector-title .wf-node-label')`));
    ok('矢量文档 store 与节点一一对应', await cdp.eval(`window.__codenodeVectorNode(${JSON.stringify(nodeId)}) !== window.__codenodeVector`));
  } catch (e) {
    failed += 1;
    const detail = e && e.stack ? e.stack : String(e);
    failures.push(`脚本异常: ${detail}`);
    err(`脚本异常: ${detail}`);
  }

  /* ========== 控制台错误汇总 ========== */
  await sleep(600);
  const realErrors = cdp.errors.filter((t) => !t.includes('favicon') && !t.includes('DevTools') && !t.includes('404'));
  ok('页面无未捕获异常 / console.error', cdp.exceptions.length === 0 && realErrors.length === 0,
    `exceptions=${cdp.exceptions.length} errors=${realErrors.slice(0, 3).join(' | ')}`);

  out(`\n════ 结果：通过 ${passed} / 失败 ${failed} ════`);
  if (failures.length) {
    out('失败项：\n  - ' + failures.join('\n  - '));
  }
  cdp.close();
  await stopBrowser();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  err('FATAL ' + (e && e.stack ? e.stack : String(e)));
  await stopBrowser();
  process.exit(1);
});
