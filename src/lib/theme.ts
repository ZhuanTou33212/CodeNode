import themes from '../../config/ui.themes.json';

/** 主题标识：日间 / 夜间 / 透明玻璃（纯透明无色玻璃，桌面穿透）。 */
export type Theme = 'light' | 'dark' | 'glass';

/** 主题顺序即设置面板里的选项顺序；三套主题共用同一套控件结构与布局。 */
export const THEMES: readonly Theme[] = ['light', 'dark', 'glass'] as const;

export const THEME_LABELS: Record<Theme, string> = {
  light: '日间',
  dark: '夜间',
  glass: '透明玻璃',
};

/** 设置入口的补充说明；「透明玻璃」依赖窗口材质（Windows 亚克力）透出桌面。 */
export const THEME_HINTS: Record<Theme, string> = {
  light: '明亮配色',
  dark: '低眩光石墨灰磨砂',
  glass: '纯透明无色玻璃 · 桌面透亮',
};

/** 主题选择的持久化键位于 localStorage；主进程另存一份用于启动时决定窗口材质。 */
export const THEME_STORAGE_KEY = 'codenode.theme';
export const DEFAULT_THEME: Theme = 'dark';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function normalizeTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

/**
 * 页面 color-scheme：玻璃主题是亮色玻璃，原生控件（滚动条、下拉、输入光标）
 * 必须按亮色渲染，否则在亮玻璃上会出现黑底控件。
 */
export function themeColorScheme(theme: Theme): 'light' | 'dark' {
  return theme === 'dark' ? 'dark' : 'light';
}

/** 主题色值集中在 config/ui.themes.json；几何与交互不随主题变化。 */
export function themeTokens(theme: Theme): Record<string, string> {
  return (themes as Record<Theme, Record<string, string>>)[theme];
}
