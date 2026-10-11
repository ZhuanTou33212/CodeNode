'use strict';
/**
 * 主题 → 原生窗口材质。第三个主题「透明玻璃」的“透亮”只能来自这里：
 * CSS 的 backdrop-filter 模糊不到桌面（实测 I≡J，见 docs/theme-glass.md），
 * 必须由主进程把窗口底色换成系统亚克力材质。
 *
 * 实测结论（Windows 11 23H2 / Electron 44）：
 * - 只把窗口底色设为全透明并不会透出桌面，必须同时设置系统背景材质；
 * - `backgroundMaterial: 'acrylic'` 在**有边框**窗口上同样生效 —— 因此不必改成无边框、
 *   不必重建窗口，昼夜主题的窗口外观与行为完全不变；
 * - 底色与材质都能在运行时切换（O_runtime_to_acrylic ≡ N_acrylic_light），
 *   所以切换主题不会重置会话、草稿或侧栏状态；
 * - 材质明暗跟随 nativeTheme.themeSource：dark 是石墨灰，light 才是无色的明亮玻璃，
 *   因此玻璃主题强制 light，离开玻璃主题时恢复 system。
 */
const { app, ipcMain, nativeTheme, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');

/** 主题 ID 直接取自色值配置，避免主进程与渲染层各维护一份列表。 */
const THEME_IDS = Object.keys(require('../config/ui.themes.json'));
const GLASS = 'glass';
const DEFAULT_THEME = THEME_IDS.includes('dark') ? 'dark' : THEME_IDS[0];
/** 昼夜主题的不透明窗口底色；玻璃主题不支持系统材质时的兜底底色。 */
const OPAQUE_BACKGROUND = '#14161a';
const FALLBACK_GLASS_BACKGROUND = '#e9ebec';
const TRANSPARENT_BACKGROUND = '#00000000';

/** 只有 Windows（DWM 亚克力）能真正透出桌面；其它平台退化为不透明亮色玻璃。 */
function systemMaterialSupported() { return process.platform === 'win32'; }

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

/**
 * 建窗参数：启动时就要用对底色，否则玻璃主题会先闪一下不透明深色。
 * @returns {{ theme: string, backgroundColor: string, backgroundMaterial?: 'none' | 'auto' | 'acrylic' | 'mica' | 'tabbed' }}
 */
function windowOptions() {
  const theme = readTheme();
  const glass = theme === GLASS;
  return {
    theme,
    backgroundColor: glass ? (systemMaterialSupported() ? TRANSPARENT_BACKGROUND : FALLBACK_GLASS_BACKGROUND) : OPAQUE_BACKGROUND,
    backgroundMaterial: glass && systemMaterialSupported() ? 'acrylic' : undefined,
  };
}

/** 把主题对应的窗口材质施加到某个窗口上；返回实际生效的主题。 */
function applyToWindow(win, theme) {
  const next = normalizeTheme(theme);
  try { nativeTheme.themeSource = next === GLASS ? 'light' : 'system'; } catch {}
  if (!win || win.isDestroyed()) return next;
  try {
    const glass = next === GLASS;
    if (glass && systemMaterialSupported()) {
      win.setBackgroundColor(TRANSPARENT_BACKGROUND);
      win.setBackgroundMaterial('acrylic');
    } else {
      if (systemMaterialSupported()) win.setBackgroundMaterial('none');
      win.setBackgroundColor(glass ? FALLBACK_GLASS_BACKGROUND : OPAQUE_BACKGROUND);
    }
  } catch { /* 材质不可用时保持上一次底色，界面仍可用 */ }
  return next;
}

/**
 * DWM 的亚克力材质在最大化/还原之后可能被系统丢弃，因此这些时机要重新施加一次。
 * 只对当前处于玻璃主题的窗口生效，昼夜主题不产生任何额外调用。
 */
const bindings = new WeakMap();

function bindWindow(win, theme) {
  const state = { theme: normalizeTheme(theme) };
  const reapply = () => { if (state.theme === GLASS) applyToWindow(win, state.theme); };
  for (const event of ['show', 'focus', 'restore', 'maximize', 'unmaximize', 'resize']) win.on(event, reapply);
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
  THEME_IDS, GLASS, DEFAULT_THEME, OPAQUE_BACKGROUND, TRANSPARENT_BACKGROUND, FALLBACK_GLASS_BACKGROUND,
  isTheme, normalizeTheme, readTheme, writeTheme, windowOptions, applyToWindow, bindWindow, register,
  systemMaterialSupported,
};
