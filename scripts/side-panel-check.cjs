/**
 * 右侧统一侧栏（节点属性 / 项目树 / 文件预览）——端到端 UI 校验
 *
 * 用法：
 *   npx vite build
 *   node scripts/run-electron.cjs scripts/side-panel-check.cjs --codenode-user-data-dir=<临时目录>
 *
 * 关键点：本脚本作为 Electron 主进程入口运行，但会先 require 应用自己的
 * electron/main.cjs 注册全部 IPC handler，再在真实应用窗口上做断言，
 * 因此渲染进程拿到的 API 与正式启动完全一致。
 *
 * 覆盖：默认收起不挤压画布 / 打开后与画布并排 / 三个标签页（含文件树与预览）/
 * 宽度夹取与容器查询 / 窄窗口自动收起并改浮层 / 底部 dock 让位。
 * 截图输出到 out/side-*.png 供人工确认。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

let appWin = null;
app.on('browser-window-created', (_e, win) => {
  if (!appWin) appWin = win;
});

// 先加载应用主进程：注册 IPC handler、装配窗口
require('../electron/main.cjs');

const runChecks = require('./lib/side-panel-checks.cjs');

app.whenReady().then(async () => {
  try {
    if (!appWin) {
      for (let i = 0; i < 60 && !appWin; i += 1) await sleep(250);
    }
    if (!appWin) throw new Error('未捕获到应用窗口');
    const win = appWin;

    await win.webContents.executeJavaScript('1'); // 确保渲染进程已就绪
    await sleep(400);

    const js = async (code) => {
      try {
        return await win.webContents.executeJavaScript(code);
      } catch (e) {
        const oneLine = String(code).replace(/\s+/g, ' ').slice(0, 180);
        throw new Error(`executeJavaScript failed: ${e && e.message}\n    code: ${oneLine}\n    cause: ${e && e.cause ? e.cause : '(none)'}`);
      }
    };
    const shot = async (w, name) => {
      try {
        const image = await w.webContents.capturePage();
        fs.writeFileSync(path.join(OUT_DIR, name + '.png'), image.toPNG());
        console.log('  shot → out/' + name + '.png');
      } catch (e) {
        console.log('  (screenshot skipped: ' + e.message + ')');
      }
    };

    console.log('SIDE PANEL CHECK:');
    await runChecks({ win, js, sleep, ok, shot });
  } catch (e) {
    failures.push('harness error');
    console.error('SIDE PANEL CHECK ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('\nSIDE PANEL CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
