'use strict';

/**
 * 第三套主题「无色玻璃」的端到端验收 —— 重点不是「像不像玻璃」，而是**界面必须不透明**。
 *
 * 用户明确要求：主界面不允许做成透明玻璃。所以这条用例的核心断言是像素级的：
 * 窗口背后放高频棋盘格，三套主题的取样区标准差都必须 ≤20（棋盘格自身 ~123），
 * 任何一套漏出桌面内容都会立刻失败。
 *
 * 其余断言：三套 token 键一致、第三套无色（RGB 极差 ≤12）、设置里是下拉框、
 * 窗口底色始终不透明、切换主题不重置会话/草稿/模型/侧栏。
 *
 * 设置 CODENODE_UI_TEST_PACKAGE=<交付包根目录> 时改测包内 asar。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const themesJson = require('../../config/ui.themes.json');
const THIRD_THEME = 'bright';

const packageRoot = process.env.CODENODE_UI_TEST_PACKAGE ? path.resolve(process.env.CODENODE_UI_TEST_PACKAGE) : null;
const runtimeAsar = packageRoot ? path.join(packageRoot, 'resources', 'app.asar') : null;
const sourceRoot = (relative) => (runtimeAsar ? path.join(runtimeAsar, relative) : path.join(__dirname, '../..', relative));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-bright-theme-ui-'));
const projectDir = path.join(root, 'demo-project');
const projectFile = path.join(projectDir, 'demo.cnode');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(projectFile, JSON.stringify({ graph: { nodes: [], edges: [] }, workspace: { viewport: { x: 0, y: 0, zoom: 1 } }, manifest: { format: 'codenode', formatVersion: '1' } }));
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');

let win = null;
app.on('browser-window-created', (_event, window) => { if (!win) win = window; });
require(sourceRoot('electron/main.cjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(80);
  }
  throw new Error('等待超时：' + label);
}

let backdrop = null;

function windowBg() { return String(win.getBackgroundColor() || '').slice(0, 7).toUpperCase(); }

/** 窗口在屏幕上的取样区域（物理像素），避开标题栏与边框。 */
function sampleRegion(scale) {
  const b = win.getBounds();
  const insetX = Math.round(46 * scale);
  const insetTop = Math.round(72 * scale);
  return {
    x: Math.round(b.x * scale) + insetX,
    y: Math.round(b.y * scale) + insetTop,
    width: Math.round(b.width * scale) - insetX * 2,
    height: Math.round(b.height * scale) - insetTop - Math.round(54 * scale),
  };
}

function luminanceStats(image) {
  const buf = image.toBitmap();
  let n = 0, sum = 0, sumSq = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += lum; sumSq += lum * lum; n++;
  }
  const mean = sum / n;
  return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2) };
}

async function grabScreen(scale) {
  const display = screen.getPrimaryDisplay();
  const physical = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
  assert.ok(sources.length, '需要一块可捕获的屏幕');
  return sources[0].thumbnail;
}

async function captureRegion(region, scale, file) {
  const shot = await grabScreen(scale);
  const crop = shot.crop(region);
  if (file) fs.writeFileSync(file, crop.toPNG());
  return luminanceStats(crop);
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    // ---- 1. token 表：三套主题键集合必须一致，且第三套无色 ----
    const ids = Object.keys(themesJson);
    const packagedThemes = runtimeAsar ? JSON.parse(fs.readFileSync(path.join(runtimeAsar, 'config', 'ui.themes.json'), 'utf8')) : themesJson;
    assert.deepEqual(Object.keys(packagedThemes), ids, '包内主题表必须与源码主题表一致');
    assert.deepEqual(ids, ['light', 'dark', THIRD_THEME], '主题表必须是日间/夜间/无色玻璃三套');
    const referenceKeys = Object.keys(themesJson.light).sort();
    for (const id of ids) assert.deepEqual(Object.keys(themesJson[id]).sort(), referenceKeys, id + ' 主题 token 键与 light 不一致');
    const CHROMATIC_ALLOWED = new Set(['--stage-running', '--stage-done', '--stage-failed', '--stage-blocked', '--menu-danger']);
    for (const [key, value] of Object.entries(themesJson[THIRD_THEME])) {
      if (CHROMATIC_ALLOWED.has(key)) continue;
      const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
      if (!hex) continue;
      const [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16));
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, '无色玻璃主题必须无色，' + key + '=' + value + ' 带明显色偏');
    }
    // 不透明底线：底色必须有不透明的兜底色，不能是「全透明 + 只靠叠加」。
    for (const key of ['--bg', '--glass-base']) {
      assert.match(themesJson[THIRD_THEME][key], /^#[0-9a-f]{6}$/i, '无色玻璃主题的 ' + key + ' 必须是不透明色，实际 ' + themesJson[THIRD_THEME][key]);
    }
    console.log('BRIGHT THEME TOKENS: PASS (三套主题键一致、第三套无色、底色不透明)');

    await waitFor(async () => win && await win.webContents.executeJavaScript('!!document.querySelector(".gate-actions")').catch(() => false), '启动页');
    const js = (code) => win.webContents.executeJavaScript(code);
    win.setBounds({ x: 200, y: 110, width: 900, height: 620 });

    // ---- 2. 进入工作台 ----
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(projectDir)})`);
    await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
    await waitFor(async () => await js('!!document.querySelector(".app") && !!document.querySelector(".toolbar")'), '进入工作台');
    win.showInactive();
    await sleep(400);

    // ---- 3. 设置入口是下拉框，三个选项 ----
    await js('window.__codenodeUi.getState().openSettings()');
    await waitFor(async () => await js('!!document.querySelector("[data-theme-select]")'), '主题设置入口');
    const choice = await js(`(() => {
      const select = document.querySelector('[data-theme-select]');
      return { tag: select.tagName, value: select.value, options: [...select.options].map(o => ({ id: o.value, label: o.textContent })), buttons: document.querySelectorAll('.settings-theme-choice').length };
    })()`);
    assert.equal(choice.tag, 'SELECT', '主题必须用下拉式选择');
    assert.equal(choice.buttons, 0, '不应再有横排的主题按钮');
    assert.deepEqual(choice.options.map((o) => o.id), ['light', 'dark', THIRD_THEME]);
    assert.deepEqual(choice.options.map((o) => o.label), ['日间', '夜间', '无色玻璃']);
    await js('window.__codenodeUi.getState().closeSettings()');

    // ---- 4. 窗口本身必须不是透明窗口，底色始终保持不透明深色 ----
    for (const theme of ['light', 'dark', THIRD_THEME]) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(200);
      assert.equal(await js('window.__codenodeUi.getState().theme'), theme);
      assert.equal(windowBg(), '#14161A', theme + ' 主题下窗口底色必须始终不透明，实际 ' + JSON.stringify(win.getBackgroundColor()));
    }

    // ---- 5. 像素级不透明：三套主题都不允许把背后的棋盘格透出来 ----
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const region = sampleRegion(scale);
    const checkerboard = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body style="margin:0;width:100vw;height:100vh;background-image:repeating-linear-gradient(45deg,#000 0 8px,#fff 8px 16px)"></body>');
    backdrop = new BrowserWindow({ ...win.getBounds(), show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#000000' });
    await backdrop.loadURL(checkerboard);
    backdrop.setAlwaysOnTop(true, 'screen-saver');
    backdrop.showInactive();
    await sleep(500);

    const outDir = path.join(__dirname, '../../out');
    fs.mkdirSync(outDir, { recursive: true });
    const shotPath = (name) => path.join(outDir, 'bright-theme-' + name + (packageRoot ? '-packaged' : '') + '.png');

    // 三次像素测量必须处在同一套布局，否则量到的是界面内容差异而不是不透明度。
    await js(`window.__codenodeUi.setState({navigationOpen:false,conversationOpen:false,sideOpen:false,dockOpen:false,sideTab:'agent',appPage:'workbench'}); window.__codenodeUi.getState().closeSettings()`);
    await sleep(300);

    win.hide();
    await sleep(500);
    const backdropOnly = await captureRegion(region, scale, shotPath('backdrop-reference'));
    assert.ok(backdropOnly.sd > 60, '参照棋盘格必须是高频图案，实际标准差 ' + backdropOnly.sd);

    const opaqueOf = async (theme) => {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(250);
      backdrop.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
      win.moveTop();
      await sleep(700);
      return captureRegion(region, scale, shotPath(theme));
    };

    for (const theme of ['light', 'dark', THIRD_THEME]) {
      const shot = await opaqueOf(theme);
      console.log('OPACITY', theme, { mean: shot.mean, sd: shot.sd }, '| backdrop sd', backdropOnly.sd);
      assert.ok(shot.sd <= 20, theme + ' 主题必须完全不透明（背后的棋盘格不得透出），实际标准差 ' + shot.sd);
      assert.ok(Math.abs(shot.mean - backdropOnly.mean) > 40, theme + ' 主题必须与背后的棋盘格明显不同，实际均值 ' + shot.mean);
    }
    win.setAlwaysOnTop(false);

    // ---- 6. 切换主题不得重置会话 / 草稿 / 模型 / 侧栏 ----
    await js(`window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,sideOpen:true,sideTab:'project',dockOpen:true,dockTab:'runs',appPage:'workbench'})`);
    await js(`window.__codenodeSession.getState().pushUser('无色玻璃主题下的草稿与侧栏状态')`);
    const snapshot = `JSON.stringify({
      root: window.__codenodeProject.getState().root,
      file: window.__codenodeProject.getState().projectFile,
      messages: window.__codenodeSession.getState().messages.length,
      model: JSON.stringify(window.__codenodeUi.getState().preferences),
      ui: (({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage})=>({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage}))(window.__codenodeUi.getState())
    })`;
    const before = await js(snapshot);
    for (const theme of [THIRD_THEME, 'light', 'dark', THIRD_THEME]) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(160);
    }
    const after = await js(snapshot);
    assert.equal(JSON.parse(after).root, JSON.parse(before).root);
    assert.equal(JSON.parse(after).file, JSON.parse(before).file);
    assert.equal(JSON.parse(after).messages, JSON.parse(before).messages);
    assert.equal(JSON.parse(after).model, JSON.parse(before).model);
    assert.equal(JSON.parse(after).ui.theme, THIRD_THEME);
    for (const key of ['navigationOpen', 'conversationOpen', 'sideOpen', 'sideTab', 'dockOpen', 'dockTab', 'appPage']) {
      assert.equal(JSON.parse(after).ui[key], JSON.parse(before).ui[key], '切换主题不得改动 ' + key);
    }

    // ---- 7. 主题选择持久化 ----
    assert.equal(await js(`localStorage.getItem('codenode.theme')`), THIRD_THEME);
    if (backdrop && !backdrop.isDestroyed()) { backdrop.destroy(); backdrop = null; }

    console.log('BRIGHT THEME UI TEST: PASS (三套主题全部不透明；切换保留会话/草稿/模型/侧栏)' + (packageRoot ? ' [交付包 ' + packageRoot + ']' : ' [源码]'));
    process.exitCode = 0;
    app.quit();
  } catch (error) {
    console.error('BRIGHT THEME UI TEST: FAIL', error);
    process.exitCode = 1;
    app.quit();
  }
});

app.on('will-quit', () => {
  if (backdrop && !backdrop.isDestroyed()) backdrop.destroy();
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-bright-theme-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
