'use strict';

/**
 * 第三个主题「纯透明无色玻璃」的端到端验收。
 *
 * 验收的不是「看起来像玻璃」，而是三件可测量的事：
 *   1. 三套主题共用同一套 token 键，切换主题不会残留上一套色值，且玻璃主题无色；
 *   2. 玻璃主题下桌面**原样**透出（不是糊、不是灰雾）——窗口背后放高频棋盘格，
 *      取样区的像素分布必须与棋盘格自身高度一致（标准差与结构相关性双重判定）；
 *      一旦用系统材质磨砂，标准差与相关性都会塌掉；
 *   3. 切换主题不重置会话、输入草稿、模型选择与侧栏状态，切回昼夜主题像素层面仍完全不透明。
 *
 * 为什么必须用真实屏幕截图而不是 capturePage：CSS backdrop-filter 模糊不到桌面，
 * 桌面透亮只可能来自窗口层面，因此只有在真实屏幕合成结果里才能判定。
 *
 * 设置 CODENODE_UI_TEST_PACKAGE=<交付包根目录> 时改测包内 asar。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const themesJson = require('../../config/ui.themes.json');

const packageRoot = process.env.CODENODE_UI_TEST_PACKAGE ? path.resolve(process.env.CODENODE_UI_TEST_PACKAGE) : null;
const runtimeAsar = packageRoot ? path.join(packageRoot, 'resources', 'app.asar') : null;
const sourceFile = (relative) => (runtimeAsar ? path.join(runtimeAsar, relative) : path.join(__dirname, '../..', relative));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-glass-theme-ui-'));
const projectDir = path.join(root, 'demo-project');
const projectFile = path.join(projectDir, 'demo.cnode');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(projectFile, JSON.stringify({ graph: { nodes: [], edges: [] }, workspace: { viewport: { x: 0, y: 0, zoom: 1 } }, manifest: { format: 'codenode', formatVersion: '1' } }));
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');

let win = null;
app.on('browser-window-created', (_event, window) => { if (!win) win = window; });
require(sourceFile('electron/main.cjs'));
const windowTheme = require(sourceFile('electron/theme.cjs'));

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

/** Electron 在 getBackgroundColor() 里丢掉 alpha，这里只比对前 6 位十六进制。 */
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
  const samples = [];
  for (let i = 0, k = 0; i + 3 < buf.length; i += 4, k++) {
    const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += lum; sumSq += lum * lum; n++;
    if (k % 3 === 0) samples.push(lum);
  }
  const mean = sum / n;
  return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2), samples };
}

/** 两个取样区的结构相关性：桌面原样透出时高度相关，被磨砂糊掉时趋近 0。 */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(3) : 0;
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
    // ---- 1. token 表：三套主题键集合必须一致（缺键会在切换后残留上一套色值） ----
    const ids = Object.keys(themesJson);
    const packagedThemes = runtimeAsar ? JSON.parse(fs.readFileSync(path.join(runtimeAsar, 'config', 'ui.themes.json'), 'utf8')) : themesJson;
    assert.deepEqual(Object.keys(packagedThemes), ids, '包内主题表必须与源码主题表一致');
    assert.deepEqual(ids, ['light', 'dark', 'glass'], '主题表必须正好是日间/夜间/玻璃三套');
    const reference = Object.keys(themesJson.light).sort();
    for (const id of ids) assert.deepEqual(Object.keys(themesJson[id]).sort(), reference, id + ' 主题 token 键与 light 不一致');
    assert.deepEqual(windowTheme.THEME_IDS, ids, '主进程主题列表必须与色值配置一致');
    // 玻璃主题的底色是「半透明白膜」：既不能是不透明白（那就成了第四套不透明主题），
    // 也不能是全透明（画布上的节点与网格会失去可读底）。
    for (const key of ['--app-background', '--gate-background']) {
      const value = themesJson.glass[key];
      assert.match(value, /rgba\(255,\s*255,\s*255,\s*\.\d+\)/, key + ' 必须是半透明白膜，实际 ' + value);
      const alphas = [...value.matchAll(/rgba\(255,\s*255,\s*255,\s*\.(\d+)\)/g)].map((m) => Number('0.' + m[1]));
      assert.ok(alphas.every((a) => a >= 0.4 && a <= 0.8), key + ' 的白膜不透明度必须落在 0.4–0.8，实际 ' + alphas.join('/'));
    }
    const CHROMATIC_ALLOWED = new Set(['--stage-running', '--stage-done', '--stage-failed', '--stage-blocked', '--menu-danger']);
    for (const [key, value] of Object.entries(themesJson.glass)) {
      if (CHROMATIC_ALLOWED.has(key)) continue;
      const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
      if (!hex) continue;
      const [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16));
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, '玻璃主题必须无色，' + key + '=' + value + ' 带明显色偏');
    }
    console.log('GLASS THEME TOKENS: PASS (三套主题键一致、底色透明、色值无色)');

    await waitFor(async () => win && await win.webContents.executeJavaScript('!!document.querySelector(".gate-actions")').catch(() => false), '启动页');
    const js = (code) => win.webContents.executeJavaScript(code);
    win.setBounds({ x: 200, y: 110, width: 900, height: 620 });

    // ---- 2. 进入工作台（没有工程根目录时应用只渲染启动页，设置面板也在工作台里） ----
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(projectDir)})`);
    await js(`window.__codenodeProject.getState().setProjectFile(${JSON.stringify(projectFile)})`);
    await waitFor(async () => await js('!!document.querySelector(".app") && !!document.querySelector(".toolbar")'), '进入工作台');
    win.showInactive();
    await sleep(400);

    // ---- 3. 设置入口必须是下拉式选择，而不是横排按钮 ----
    await js('window.__codenodeUi.getState().openSettings()');
    await waitFor(async () => await js('!!document.querySelector("[data-theme-select]")'), '主题设置入口');
    const choice = await js(`(() => {
      const select = document.querySelector('[data-theme-select]');
      return { tag: select.tagName, value: select.value, options: [...select.options].map(o => ({ id: o.value, label: o.textContent })), buttons: document.querySelectorAll('.settings-theme-choice [data-theme-option]').length };
    })()`);
    assert.equal(choice.tag, 'SELECT', '主题必须用下拉式选择');
    assert.equal(choice.buttons, 0, '不应再有横排的主题按钮');
    assert.deepEqual(choice.options.map((o) => o.id), ['light', 'dark', 'glass']);
    assert.deepEqual(choice.options.map((o) => o.label), ['日间', '夜间', '透明玻璃']);
    assert.equal(choice.value, await js('window.__codenodeUi.getState().theme'), '下拉框当前值必须等于当前主题');
    await js('window.__codenodeUi.getState().closeSettings()');

    // ---- 4. 昼夜主题行为不变（窗口不透明，底色不透明） ----
    await js(`window.__codenodeUi.getState().setTheme('dark')`); await sleep(250);
    assert.equal(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)', '夜间主题底色不得变化');
    assert.equal(windowBg(), '#14161A', '夜间主题窗口底色必须不透明，实际 ' + JSON.stringify(win.getBackgroundColor()));
    await js(`window.__codenodeUi.getState().setTheme('light')`); await sleep(250);
    assert.notEqual(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)', '日间主题必须有不同底色');
    assert.equal(windowBg(), '#14161A', '日间主题窗口底色同样不透明，实际 ' + JSON.stringify(win.getBackgroundColor()));

    // ---- 5. 切到玻璃主题：窗口底色透明、页面整体透明、持久化 ----
    await js(`window.__codenodeUi.getState().setTheme('glass')`);
    await waitFor(async () => await js('document.documentElement.dataset.theme === "glass"'), '玻璃主题生效');
    await waitFor(async () => windowBg() === '#000000', '主进程切换窗口底色');
    assert.equal(await js('localStorage.getItem("codenode.theme")'), 'glass');
    assert.equal(await js('document.documentElement.style.colorScheme'), 'light', '玻璃主题的原生控件必须按亮色渲染');
    for (const selector of ['.app', 'body', '#root']) {
      const value = await js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`);
      assert.match(value, /rgba\(0, 0, 0, 0\)|transparent/, selector + ' 在玻璃主题下必须透明，实际 ' + value);
    }
    const savedFile = path.join(app.getPath('userData'), 'window-theme.json');
    assert.equal(JSON.parse(fs.readFileSync(savedFile, 'utf8')).theme, 'glass', '主进程必须持久化主题以便下次启动直接建玻璃窗口');
    assert.equal(windowTheme.windowOptions().transparent, true, '窗口必须建窗期就具备透明能力（运行时改不了）');
    assert.equal(windowTheme.backgroundColorFor('glass'), '#00000000', '玻璃主题的窗口底色必须是全透明');
    assert.equal(windowTheme.backgroundColorFor('dark'), '#14161a', '昼夜主题的窗口底色必须不透明');

    // ---- 6. 透亮实测：窗口背后放高频棋盘格，界面必须让它原样透出 ----
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
    const shotPath = (name) => path.join(outDir, 'glass-theme-' + name + (packageRoot ? '-packaged' : '') + '.png');

    // 三次像素测量必须处在同一套布局，否则量到的是界面内容差异而不是不透明度。
    const normalizeLayout = () => js(`window.__codenodeUi.setState({navigationOpen:false,conversationOpen:false,sideOpen:false,dockOpen:false,sideTab:'agent',appPage:'workbench'}); window.__codenodeUi.getState().closeSettings()`);
    await normalizeLayout();
    await sleep(300);

    win.hide();
    await sleep(500);
    const backdropOnly = await captureRegion(region, scale, shotPath('backdrop-reference'));
    assert.ok(backdropOnly.sd > 60, '参照棋盘格必须是高频图案，实际标准差 ' + backdropOnly.sd);

    const measure = async (theme, name) => {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(250);
      backdrop.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
      win.moveTop();
      await sleep(700);
      return captureRegion(region, scale, name);
    };

    const glass = await measure('glass', shotPath('clear-glass'));
    const sdRatio = glass.sd / backdropOnly.sd;
    const structureMatch = correlation(glass.samples, backdropOnly.samples);
    console.log('BACKDROP REFERENCE', { mean: backdropOnly.mean, sd: backdropOnly.sd }, '| GLASS', { mean: glass.mean, sd: glass.sd }, '| sdRatio', sdRatio.toFixed(3), '| structure', structureMatch);
    // 阈值只用来区分「真透」与「磨砂糊成灰」：系统材质会把两项压到 ~0.02 / ~0。
    assert.ok(sdRatio >= 0.18, '玻璃主题不能让桌面失去结构（这就是「灰蒙蒙」）：标准差必须保住 ≥18%，实际 ' + (sdRatio * 100).toFixed(1) + '%（系统材质磨砂会塌到个位数百分比）');
    assert.ok(structureMatch >= 0.4, '玻璃主题必须让桌面结构可辨：与参照棋盘格的结构相关性必须 ≥0.4，实际 ' + structureMatch);
    assert.ok(glass.mean >= backdropOnly.mean - 8, '玻璃主题不应比桌面更暗，实际 ' + glass.mean + ' vs ' + backdropOnly.mean);

    // 对照组：昼夜主题必须完全不透明，否则说明取样区根本不是应用本体
    const dark = await measure('dark', shotPath('dark-control'));
    const light = await measure('light', shotPath('light-control'));
    console.log('DARK CONTROL', { mean: dark.mean, sd: dark.sd }, '| LIGHT CONTROL', { mean: light.mean, sd: light.sd });
    assert.ok(dark.sd <= 20, '夜间主题必须不透明（棋盘格不得透出），实际标准差 ' + dark.sd);
    assert.ok(light.sd <= 20, '日间主题必须不透明（棋盘格不得透出），实际标准差 ' + light.sd);
    assert.ok(Math.abs(dark.mean - backdropOnly.mean) > 40, '对照组必须与棋盘格明显不同，实际 ' + dark.mean);

    // ---- 7. 切换主题不得重置会话 / 草稿 / 模型 / 侧栏 ----
    await js(`window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,sideOpen:true,sideTab:'project',dockOpen:true,dockTab:'runs',appPage:'workbench'})`);
    await js(`window.__codenodeSession.getState().pushUser('玻璃主题下的草稿与侧栏状态')`);
    const snapshot = `JSON.stringify({
      root: window.__codenodeProject.getState().root,
      file: window.__codenodeProject.getState().projectFile,
      messages: window.__codenodeSession.getState().messages.length,
      model: JSON.stringify(window.__codenodeUi.getState().preferences),
      ui: (({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage})=>({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage}))(window.__codenodeUi.getState())
    })`;
    const before = await js(snapshot);
    for (const theme of ['glass', 'light', 'dark', 'glass']) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(160);
    }
    const after = await js(snapshot);
    assert.equal(JSON.parse(after).root, JSON.parse(before).root);
    assert.equal(JSON.parse(after).file, JSON.parse(before).file);
    assert.equal(JSON.parse(after).messages, JSON.parse(before).messages);
    assert.equal(JSON.parse(after).model, JSON.parse(before).model);
    assert.equal(JSON.parse(after).ui.theme, 'glass');
    for (const key of ['navigationOpen', 'conversationOpen', 'sideOpen', 'sideTab', 'dockOpen', 'dockTab', 'appPage']) {
      assert.equal(JSON.parse(after).ui[key], JSON.parse(before).ui[key], '切换主题不得改动 ' + key);
    }

    // ---- 8. 切回夜间：像素层面必须重新完全不透明（透明 → 不透明由页面负责） ----
    await normalizeLayout();
    await sleep(300);
    const darkAgain = await measure('dark', shotPath('dark-after-roundtrip'));
    console.log('DARK AFTER ROUND TRIP', { mean: darkAgain.mean, sd: darkAgain.sd });
    assert.ok(darkAgain.sd <= 20, '玻璃切回夜间后必须完全不透明（棋盘格不得透出），实际标准差 ' + darkAgain.sd);
    assert.ok(Math.abs(darkAgain.mean - backdropOnly.mean) > 40, '切回夜间后必须与棋盘格明显不同，实际 ' + darkAgain.mean);
    assert.equal(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)');
    win.setAlwaysOnTop(false);
    if (backdrop && !backdrop.isDestroyed()) { backdrop.destroy(); backdrop = null; }

    console.log('GLASS THEME UI TEST: PASS' + (packageRoot ? ' (交付包 ' + packageRoot + ')' : ' (源码)'));
    process.exitCode = 0;
    app.quit();
  } catch (error) {
    console.error('GLASS THEME UI TEST: FAIL', error);
    process.exitCode = 1;
    app.quit();
  }
});

app.on('will-quit', () => {
  if (backdrop && !backdrop.isDestroyed()) backdrop.destroy();
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-glass-theme-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
