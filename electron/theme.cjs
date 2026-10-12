'use strict';
/**
 * 主题 → 原生窗口透明能力。第三个主题「透明玻璃」的透亮来自这里：
 * CSS 的 backdrop-filter 模糊不到桌面，桌面透亮只能由窗口层面决定。
 *
 * 实测结论（Windows 11 23H2 / Electron 44，探针数据见 docs/theme-glass.md）：
 * - `transparent: true` + 全透明底色 + **不设系统材质** = 桌面逐像素原样透出
 *   （高频棋盘格背景实测标准差 123.51 == 桌面自身 123.51，锐度零损失）；
 * - 一旦设 `backgroundMaterial: 'acrylic'`，同一块区域糊成一片灰雾
 *   （标准差塌到 2.35）—— 这正是「灰蒙蒙」的来源，因此玻璃主题不再使用任何系统材质；
 * - `transparent` 是**建窗期**选项，运行时改不了，所以窗口一律按透明能力创建，
 *   昼夜主题用不透明底色 + 不透明页面盖住即可，视觉与改动前一致；
 * - 代价：`transparent: true` 会让窗口失去 DWM 外阴影（实测外扩 10dip 亮度差 8.57 → 0），
 *   `hasShadow` 补不回来。这是三套主题共担的一处损失，换来玻璃主题可随时切换而无需重建窗口。
 *
 * 透亮之外的可读性由渲染层负责：文字面用不透明感更强的白色薄膜，画布保持全透明。
 */
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');

/** 主题 ID 直接取自色值配置，避免主进程与渲染层各维护一份列表。 */
const THEME_IDS = Object.keys(require('../config/ui.themes.json'));
const GLASS = 'glass';
const DEFAULT_THEME = THEME_IDS.includes('dark') ? 'dark' : THEME_IDS[0];
/** 昼夜主题的窗口底色；玻璃主题让窗口底色全透明。 */
const OPAQUE_BACKGROUND = '#14161a';
const TRANSPARENT_BACKGROUND = '#00000000';

function isTheme(value) { return typeof value === 'string' && THEME_IDS.includes(value); }
function normalizeTheme(value) { return isTheme(value) ? value : DEFAULT_THEME; }

function storeFile() { return path.join(app.getPath('userData'), 'window-theme.json'); }

function readTheme() {
  try {
    const saved = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return normalizeTheme(saved && saved.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

function writeTheme(theme) {
  try { atomicWriteFile(storeFile(), JSON.stringify({ version: 1, theme: normalizeTheme(theme) }, null, 2) + '\n'); } catch { /* 存不下不影响本次切换 */ }
}

/** 窗口底色：只有玻璃主题透明，昼夜主题保持不透明深色。 */
function backgroundColorFor(theme) {
  return normalizeTheme(theme) === GLASS ? TRANSPARENT_BACKGROUND : OPAQUE_BACKGROUND;
}

/**
 * 建窗参数：启动时就要用对底色，否则玻璃主题会先闪一下不透明深色。
 * `transparent` 必须建窗时给，所以恒为 true。
 * @returns {{ theme: string, transparent: true, backgroundColor: string }}
 */
function windowOptions() {
  const theme = readTheme();
  return { theme, transparent: true, backgroundColor: backgroundColorFor(theme) };
}

/**
 * 把主题对应的窗口底色施加到某个窗口上；返回实际生效的主题。
 *
 * 实测（probe8）：`setBackgroundColor('#00000000')` 在透明窗口上确实生效，玻璃主题因此能
 * 实时变透明；但反向「透明 → 不透明」在 Windows 上不生效，且 getBackgroundColor() 的回报
 * 不可信（同一调用先后回报 #FFFFFF / #000000）。所以这里只在需要透明时动窗口，
 * 昼夜主题交给页面自己画不透明底色——两者视觉等价，也避免留下不可信状态。
 */
function applyToWindow(win, theme) {
  const next = normalizeTheme(theme);
  if (!win || win.isDestroyed()) return next;
  if (next === GLASS) {
    try { win.setBackgroundColor(TRANSPARENT_BACKGROUND); } catch { /* 保持上一次底色，界面仍可用 */ }
  }
  return next;
}

/** 记住每个窗口当前主题，IPC 到达时改的就是发起方那个窗口。 */
const bindings = new WeakMap();

function bindWindow(win, theme) {
  const state = { theme: normalizeTheme(theme) };
  const binding = {
    current: () => state.theme,
    set(next) { state.theme = applyToWindow(win, next); return state.theme; },
  };
  bindings.set(win, binding);
  return binding;
}

function register() {
  ipcMain.handle('theme:apply', (event, theme) => {
    if (isTheme(theme)) writeTheme(theme);
    const win = BrowserWindow.fromWebContents(event.sender);
    const binding = win ? bindings.get(win) : null;
    // 主进程的持久化以渲染层上报为准（渲染层才是主题状态的唯一来源）。
    if (binding) return { theme: binding.set(theme), persisted: isTheme(theme) };
    return { theme: applyToWindow(win, theme), persisted: isTheme(theme) };
  });
}

module.exports = {
  THEME_IDS, GLASS, DEFAULT_THEME, OPAQUE_BACKGROUND, TRANSPARENT_BACKGROUND,
  isTheme, normalizeTheme, readTheme, writeTheme, backgroundColorFor, windowOptions, applyToWindow, bindWindow, register,
};
