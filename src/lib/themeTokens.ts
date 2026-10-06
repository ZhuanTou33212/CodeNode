import themes from '../../config/ui.themes.json';
export function themeTokens(theme: 'light' | 'dark'): Record<string,string> {
  return themes[theme];
}
