/**
 * 渲染冒烟测试：加载构建产物，注入一个临时工程后校验工作台基本结构。
 * 用法：node scripts/run-electron.cjs scripts/smoke.cjs
 *
 * 注意：本脚本作为主进程入口运行，但会先 require 应用自己的 electron/main.cjs
 * 注册 IPC handler，因此渲染进程拿到的 API 与正式启动一致。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let appWin = null;
app.on('browser-window-created', (_e, win) => {
  if (!appWin) appWin = win;
});
require('../electron/main.cjs');

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 60 && !appWin; i += 1) await sleep(250);
    if (!appWin) throw new Error('未捕获到应用窗口');
    const win = appWin;

    // 临时工程：门禁页要求先有工程才会渲染工作台
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-smoke-'));
    fs.writeFileSync(path.join(root, 'demo.cnode'), JSON.stringify({ name: 'demo', nodes: [], edges: [] }));

    const js = (code) => win.webContents.executeJavaScript(code);
    await js('1');
    await sleep(400);
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)}); return true; })()`);
    await sleep(900);

    const result = await js(`({
      title: document.title,
      rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      hasToolbar: !!document.querySelector('.toolbar'),
      hasCanvas: !!document.querySelector('.react-flow'),
      hasCanvasWrap: !!document.querySelector('.canvas-wrap'),
      // 左侧项目管理栏已并入侧栏 tab 面板：默认收起时只有入口角标
      hasSidePanelBadge: !!document.querySelector('.side-badge'),
      hasLegacyOverlay: !!document.querySelector('.cs-sidebar') || !!document.querySelector('.prompt-bar'),
      hasControls: !!document.querySelector('.react-flow__controls'),
      hasMiniMap: !!document.querySelector('.react-flow__minimap'),
      addMenuHidden: !document.querySelector('.add-menu')
    })`);
    console.log('SMOKE: ' + JSON.stringify(result));
    const fail =
      !result.hasToolbar ||
      !result.hasCanvas ||
      !result.hasCanvasWrap ||
      !result.hasSidePanelBadge ||
      result.hasLegacyOverlay ||
      result.hasControls ||
      result.hasMiniMap ||
      !result.addMenuHidden ||
      result.rootChildren <= 0;
    console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('SMOKE ERROR: ' + (e && e.stack ? e.stack : e));
    app.exit(2);
  }
});
