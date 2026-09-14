/**
 * 打包产物前端校验：直接用 Electron 的 asar 感知 fs 从 app.asar 内加载 dist/index.html，
 * 确认「桌面快捷方式启动的那个 exe」看到的界面就是新版（左侧 tab 面板 + Agent 常驻输入框）。
 *
 * 用法：node scripts/run-electron.cjs scripts/packaged-ui-check.cjs
 * 前置：npm run dist:win（生成 release/win-unpacked/resources/app.asar）
 */
'use strict';
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};

let appWin = null;
app.on('browser-window-created', (_e, win) => {
  if (!appWin) appWin = win;
});
// 先加载应用主进程，注册 IPC handler（project:list / models:list 等），
// 保证渲染进程拿到的 API 与正式启动一致
require('../electron/main.cjs');

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-packaged-'));
  let win = null;
  try {
    if (!fs.existsSync(ASAR)) throw new Error('未找到打包产物：' + ASAR + '（先跑 npm run dist:win）');

    const indexInAsar = path.join(ASAR, 'dist', 'index.html');
    const rawHtml = fs.readFileSync(indexInAsar, 'utf8'); // 走 Electron 的 asar 感知 fs
    console.log('asar 内入口可读: ' + rawHtml.length + ' 字节');

    // asar 内 .js/.css 用相对路径引用，file:// 读不到；把同一份 asar 内资源实体化到临时目录，
    // 保证加载的就是「打包产物里的那一份」而不是源码 dist。
    const assetsDir = path.join(ASAR, 'dist', 'assets');
    const assetNames = fs.readdirSync(assetsDir);
    const distTmp = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(distTmp, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distTmp, 'index.html'), rawHtml);
    for (const name of assetNames) {
      fs.copyFileSync(path.join(assetsDir, name), path.join(distTmp, 'assets', name));
    }
    console.log('打包前端资源: ' + assetNames.join(', '));

    // 注册最小 file 协议旁路（Electron 默认已能读 asar，这里仅兜底根路径）
    protocol.handle('asset', (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      return new Response(fs.readFileSync(path.join(distTmp, rel)), {
        headers: { 'content-type': rel.endsWith('.css') ? 'text/css' : 'text/javascript' },
      });
    });
    void pathToFileURL;

    win = new BrowserWindow({
      width: 1180,
      height: 760,
      show: false,
      webPreferences: { sandbox: true, preload: path.join(ROOT, 'electron', 'preload.cjs') },
    });
    await win.loadFile(path.join(distTmp, 'index.html'));
    await sleep(700);

    const js = (code) => win.webContents.executeJavaScript(code);

    // 打包后的 App 同样走门禁页；注入临时工程进入工作台
    const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-packaged-proj-'));
    fs.writeFileSync(path.join(projRoot, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(projRoot)}); return true; })()`);
    await sleep(800);

    ok('工作台已渲染', await js(`!!document.querySelector('.canvas-wrap')`));
    ok('画布上已无悬浮会话面板/输入条', await js(`!document.querySelector('.cs-sidebar') && !document.querySelector('.prompt-bar')`));

    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
    await sleep(500);
    const geom = await js(`(function(){
      const el = document.querySelector('.side-panel');
      const r = el.getBoundingClientRect();
      const c = document.querySelector('.canvas-wrap').getBoundingClientRect();
      const compt = document.querySelector('.pp-composer');
      const cr = compt.getBoundingClientRect();
      return {
        tabs: [...document.querySelectorAll('.sp-tab')].map(function(b){return b.textContent.trim();}),
        side: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) },
        canvasX: Math.round(c.x),
        composerInside: cr.bottom <= r.bottom + 1,
        composerH: Math.round(cr.height),
        bodyH: Math.round(document.querySelector('.ap-body').getBoundingClientRect().height),
        hasInput: !!document.querySelector('.pp-composer .pp-input'),
        hasSend: !!document.querySelector('.pp-send')
      };
    })()`);
    console.log('GEOM: ' + JSON.stringify(geom));
    ok('四个标签齐全', geom.tabs.join('/') === 'Agent/节点/项目/预览', geom.tabs.join('/'));
    ok('面板贴左、画布在其右侧', geom.side.x <= 1 && geom.side.right <= geom.canvasX + 1, JSON.stringify(geom));
    ok('Agent 输入框常驻面板底部', geom.hasInput && geom.hasSend && geom.composerInside, JSON.stringify(geom));
    ok('对话区占据主要高度', geom.bodyH > geom.composerH, `body=${geom.bodyH} composer=${geom.composerH}`);

    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('project'); return true; })()`);
    await sleep(400);
    ok('项目标签含文件树与过滤框', await js(`!!document.querySelector('.pm-tree') && !!document.querySelector('.pm-search')`));

    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'out', 'packaged-ui.png'), img.toPNG());
    console.log('  shot → out/packaged-ui.png');
  } catch (e) {
    failures.push('harness error');
    console.error('PACKAGED UI CHECK ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    try {
      if (win) win.destroy();
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch { /* 清理失败无所谓 */ }
    console.log('\nPACKAGED UI CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
