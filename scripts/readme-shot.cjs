/**
 * 一次性脚本：生成 README 首图（真实应用界面截图，非手绘/mock）。
 *
 * 用法：node scripts/run-electron.cjs out/readme-shot.cjs
 * 产物：docs/screenshots/codenode-canvas.png
 *
 * 做法：① 往 localStorage 种一条「最近打开」= 仓库自带示例工程 workflow.cnode；
 *       ② 重载渲染层，点该条目走**真实**打开工程链路（openRecentProject）；
 *       ③ 断言画布有真实节点且已离开启动门禁页，再截图。
 * 退出码 0 = 截图内容是工作台本体。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(ROOT, 'workflow.cnode');

let win = null;
app.on('browser-window-created', (_e, w) => {
  if (!win) win = w;
});
require('../electron/main.cjs');

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 80 && !win; i += 1) await sleep(250);
    if (!win) throw new Error('未拿到应用窗口');
    win.show();
    try {
      win.setSize(1600, 1000);
    } catch {
      /* 尺寸设置失败不影响截图 */
    }
    await sleep(1500);
    const js = (code) => win.webContents.executeJavaScript(code);

    if (!fs.existsSync(DEMO)) throw new Error('缺少示例工程：' + DEMO);

    // ① 种「最近打开」（真实链路入口），然后重载让门禁页读到它
    const seed = JSON.stringify([
      { root: ROOT, file: DEMO, name: path.basename(DEMO), openedAt: Date.now() },
    ]);
    await js(`(()=>{ localStorage.setItem('codenode.recentProjects', ${JSON.stringify(seed)}); return true; })()`);
    await win.webContents.reload();
    await sleep(2000);

    // ② 点最近列表里的 .cnode 条目 → 走真实打开链路
    const clicked = await js(`(()=>{
      const items = [...document.querySelectorAll('.gate-recent-item')];
      const hit = items.find((i) => i.textContent.includes('.cnode'));
      if (!hit) return 'no-item';
      hit.click();
      return 'clicked';
    })()`);
    console.log('gate-recent click → ' + clicked);
    await sleep(4000);

    await js(`(()=>{ const u = window.__codenodeUi && window.__codenodeUi.getState(); if (u && u.setSideTab) u.setSideTab('agent'); return true; })()`);
    await sleep(1200);

    // ③ 断言截图内容是工作台本体：节点真实存在，且落在可见视口内（不是拉到画布外）
    const geom = await js(`(()=>{
      const wrap = document.querySelector('.canvas-wrap');
      const nodes = [...document.querySelectorAll('.react-flow__node')];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inView = nodes.filter((n) => {
        const r = n.getBoundingClientRect();
        return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && r.width > 40 && r.height > 20;
      }).length;
      return {
        w: vw,
        h: vh,
        gate: !!document.querySelector('.gate-card'),
        workspace: !!wrap,
        nodes: nodes.length,
        inView,
        edges: document.querySelectorAll('.react-flow__edge').length,
        sideTabs: [...document.querySelectorAll('.sp-tab, .side-tab')].map((e) => e.textContent.trim())
      };
    })()`);
    console.log('GEOM ' + JSON.stringify(geom));

    fs.mkdirSync(DEST, { recursive: true });
    const raw = await win.webContents.capturePage();
    const img = raw.getSize().width > 1600 ? raw.resize({ width: 1600 }) : raw;
    const file = path.join(DEST, 'codenode-canvas.png');
    fs.writeFileSync(file, img.toPNG());
    const size = img.getSize();
    console.log(
      'SHOT ' + file + ' ' + size.width + 'x' + size.height + ' ' + fs.statSync(file).size + ' bytes'
    );

    const ok = geom.nodes > 0 && geom.inView === geom.nodes && !geom.gate;
    console.log(ok ? 'READY: 画布有 ' + geom.nodes + ' 个节点 / ' + geom.edges + ' 条连线' : 'NOT READY');
    app.exit(ok ? 0 : 3);
  } catch (e) {
    console.error('SHOT ERROR: ' + (e && e.stack ? e.stack : e));
    app.exit(1);
  }
});
