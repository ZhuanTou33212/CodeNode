'use strict';

/**
 * 第三个主题「纯透明无色玻璃」的端到端验收。
 *
 * 验收的不是「看起来像玻璃」，而是三件可测量的事：
 *   1. 三套主题共用同一套 token 键，切换主题不会残留上一套色值；
 *   2. 玻璃主题下页面真的透明 —— 窗口背后换成亮黄/深藏青两种底色后，
 *      同一块屏幕区域的亮度必须跟着大幅变化（不透明主题必须基本不变）；
 *   3. 切换主题不重置会话、输入草稿、模型选择与侧栏状态，且昼夜主题行为不变。
 *
 * 为什么必须用真实屏幕截图而不是 capturePage：CSS backdrop-filter 模糊不到桌面
 * （实测 blur 面板与纯 tint 面板的屏幕像素完全一致），桌面透亮只可能来自窗口材质，
 * 因此只有在真实屏幕合成结果里才能判定。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, nativeTheme, screen } = require('electron');

const themesJson = require('../../config/ui.themes.json');

/** 设置 CODENODE_UI_TEST_PACKAGE=<交付包根目录> 时，改测包内 asar 的 main/preload/theme/色值。 */
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

/** Electron 在 getBackgroundColor() 里丢掉 alpha，这里只比对不透明的 6 位十六进制。 */
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
  let n = 0, sum = 0, sumSq = 0, opaque = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += lum; sumSq += lum * lum; n++;
    if (buf[i + 3] === 255) opaque++;
  }
  const mean = sum / n;
  return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2), opaqueRatio: +(opaque / n).toFixed(3), buf, n };
}

function changedRatio(a, b) {
  let changed = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    const la = 0.114 * a[i] + 0.587 * a[i + 1] + 0.299 * a[i + 2];
    const lb = 0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2];
    if (Math.abs(la - lb) > 12) changed++;
  }
  return +(changed / (a.length / 4)).toFixed(3);
}

async function grabScreen(scale) {
  const display = screen.getPrimaryDisplay();
  const physical = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
  assert.ok(sources.length, '需要一块可捕获的屏幕');
  return sources[0].thumbnail;
}

async function measureWithBackdrop(region, scale, color, file) {
  backdrop.setBackgroundColor(color);
  await sleep(750);
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
    assert.equal(themesJson.glass['--app-background'], 'transparent', '玻璃主题的应用底色必须是 transparent');
    assert.equal(themesJson.glass['--gate-background'], 'transparent', '玻璃主题的启动页底色必须是 transparent');
    // 「无色」是这套皮肤的定义：除语义状态色外，任何色值都不得带可见色偏。
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

    // ---- 3. 设置入口：三选一，选中态可读 ----
    await js('window.__codenodeUi.getState().openSettings()');
    await waitFor(async () => await js('!!document.querySelector(".settings-theme-choice")'), '主题设置入口');
    const choices = await js(`Array.from(document.querySelectorAll('.settings-theme-choice [data-theme-option]')).map(b=>({id:b.dataset.themeOption,label:b.textContent,checked:b.getAttribute('aria-checked')}))`);
    assert.deepEqual(choices.map((c) => c.id), ['light', 'dark', 'glass']);
    assert.deepEqual(choices.map((c) => c.label), ['日间', '夜间', '透明玻璃']);
    assert.equal(choices.filter((c) => c.checked === 'true').length, 1, '必须恰好有一个主题处于选中态');
    await js('window.__codenodeUi.getState().closeSettings()');

    // ---- 4. 昼夜主题行为不变 ----
    await js(`window.__codenodeUi.getState().setTheme('dark')`); await sleep(200);
    assert.equal(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)', '夜间主题底色不得变化');
    assert.equal(windowBg(), '#14161A', '夜间主题窗口底色必须保持不透明');
    await js(`window.__codenodeUi.getState().setTheme('light')`); await sleep(200);
    assert.notEqual(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)', '日间主题必须有不同底色');

    // ---- 5. 切到玻璃主题：窗口材质、页面透明、持久化 ----
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

    // ---- 6. 透亮实测：换个窗口背后的底色，看屏幕像素跟不跟着变 ----
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const region = sampleRegion(scale);
    backdrop = new BrowserWindow({ ...win.getBounds(), show: false, frame: false, focusable: false, skipTaskbar: true, backgroundColor: '#ffff00' });
    await backdrop.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');
    backdrop.showInactive();
    // 屏上可能有别的窗口，这里把被测窗口提到最上层，保证取样区就是应用本体。
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    await sleep(500);

    const outDir = path.join(__dirname, '../../out');
    fs.mkdirSync(outDir, { recursive: true });
    const shot = (name) => path.join(outDir, 'glass-theme-' + name + (packageRoot ? '-packaged' : '') + '.png');
    console.log('MEASURE CONTEXT', JSON.stringify({ target: packageRoot || 'source', winBounds: win.getBounds(), visible: win.isVisible(), minimized: win.isMinimized(), scale, region, display: display.size }));
    const glassBright = await measureWithBackdrop(region, scale, '#ffff00', shot('bright-backdrop'));
    const glassDark = await measureWithBackdrop(region, scale, '#000814', shot('dark-backdrop'));
    const glassDelta = Math.abs(glassBright.mean - glassDark.mean);
    const glassChanged = changedRatio(glassBright.buf, glassDark.buf);
    console.log('GLASS TRANSPARENCY', JSON.stringify({ bright: glassBright.mean, dark: glassDark.mean, delta: +glassDelta.toFixed(2), changedRatio: glassChanged }));

    await js(`window.__codenodeUi.getState().setTheme('dark')`); await sleep(400);
    const darkBright = await measureWithBackdrop(region, scale, '#ffff00');
    const darkDark = await measureWithBackdrop(region, scale, '#000814');
    const darkDelta = Math.abs(darkBright.mean - darkDark.mean);
    const darkChanged = changedRatio(darkBright.buf, darkDark.buf);
    console.log('DARK CONTROL', JSON.stringify({ bright: darkBright.mean, dark: darkDark.mean, delta: +darkDelta.toFixed(2), changedRatio: darkChanged }));

    // 深色主题必须完全不透明，否则说明测的根本不是窗口本体（顺序/几何错误），玻璃结论也就无效。
    assert.ok(darkDark.mean < 60, '对照组必须是暗色不透明窗口，实际亮度 ' + darkDark.mean);
    assert.ok(darkChanged < 0.02, '对照组不应随背后底色变化，实际变化像素比例 ' + darkChanged);
    // 玻璃主题必须显著透光。
    assert.ok(glassDelta > 45, '玻璃主题必须随背后底色明显变化，实际亮度差 ' + glassDelta);
    assert.ok(glassChanged > 0.5, '玻璃主题大部分像素应当是透光的，实际 ' + glassChanged);
    win.setAlwaysOnTop(false);

    // ---- 7. 切换主题不得重置会话 / 草稿 / 模型 / 侧栏 ----
    await js(`window.__codenodeUi.setState({navigationOpen:true,conversationOpen:true,sideOpen:true,sideTab:'project',dockOpen:true,dockTab:'runs',appPage:'workbench'})`);
    await js(`window.__codenodeSession.getState().pushUser('玻璃主题下的草稿与侧栏状态')`);
    const before = await js(`JSON.stringify({
      root: window.__codenodeProject.getState().root,
      file: window.__codenodeProject.getState().projectFile,
      messages: window.__codenodeSession.getState().messages.length,
      model: JSON.stringify(window.__codenodeUi.getState().preferences),
      ui: (({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage})=>({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage}))(window.__codenodeUi.getState())
    })`);
    for (const theme of ['glass', 'light', 'dark', 'glass']) {
      await js(`window.__codenodeUi.getState().setTheme(${JSON.stringify(theme)})`);
      await sleep(160);
    }
    const after = await js(`JSON.stringify({
      root: window.__codenodeProject.getState().root,
      file: window.__codenodeProject.getState().projectFile,
      messages: window.__codenodeSession.getState().messages.length,
      model: JSON.stringify(window.__codenodeUi.getState().preferences),
      ui: (({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage})=>({theme,navigationOpen,conversationOpen,sideOpen,sideTab,dockOpen,dockTab,appPage}))(window.__codenodeUi.getState())
    })`);
    assert.equal(JSON.parse(after).root, JSON.parse(before).root);
    assert.equal(JSON.parse(after).file, JSON.parse(before).file);
    assert.equal(JSON.parse(after).messages, JSON.parse(before).messages);
    assert.equal(JSON.parse(after).model, JSON.parse(before).model);
    assert.equal(JSON.parse(after).ui.theme, 'glass');
    for (const key of ['navigationOpen', 'conversationOpen', 'sideOpen', 'sideTab', 'dockOpen', 'dockTab', 'appPage']) {
      assert.equal(JSON.parse(after).ui[key], JSON.parse(before).ui[key], '切换主题不得改动 ' + key);
    }

    // ---- 8. 切回夜间：材质必须撤销，不能留下半透明窗口 ----
    await js(`window.__codenodeUi.getState().setTheme('dark')`); await sleep(300);
    assert.equal(windowBg(), '#14161A');
    assert.equal(nativeTheme.themeSource, 'system', '离开玻璃主题必须恢复系统原生主题设置');
    assert.equal(await js('getComputedStyle(document.querySelector(".app")).backgroundColor'), 'rgb(23, 25, 29)');

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
