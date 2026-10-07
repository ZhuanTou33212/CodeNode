import defaults from '../../config/ui.defaults.json';
import outputUi from '../../config/ui.output.json';
export const CANVAS_ACTIONS = defaults.menuActions;
export interface UiPreferences {
  menuWidth: number; menuRowHeight: number; showShortcuts: boolean; showGroupLabels: boolean;
  hideDisabledActions: boolean; navigationOpen: boolean; conversationOpen: boolean; autoCollapseSidebars: boolean;
  visibleActions: string[];
  activityBarWidth: number;
  autoSaveEnabled: boolean;
  autoSaveDelayMs: number;
  preferenceVersion: number;
  typewriterEnabled: boolean;
  typewriterCharsPerSecond: number;
}
export const UI_PREFERENCES_KEY = 'codenode.uiPreferences';
const { menuActions: _menuActions, ...defaultPreferences } = defaults;
export const DEFAULT_UI_PREFERENCES: UiPreferences = { ...defaultPreferences, visibleActions: CANVAS_ACTIONS.map(action => action.id) };
export function normalizeUiPreferences(value: unknown): UiPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<UiPreferences> : {};
  const next = { ...DEFAULT_UI_PREFERENCES };
  for (const key of ['showShortcuts','showGroupLabels','hideDisabledActions','navigationOpen','conversationOpen','autoCollapseSidebars','autoSaveEnabled','typewriterEnabled'] as const) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key];
  }
  const bound = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max,Math.max(min,Math.round(value))) : fallback;
  next.activityBarWidth = bound(raw.activityBarWidth,40,64,next.activityBarWidth);
  next.autoSaveDelayMs = bound(raw.autoSaveDelayMs,500,5000,next.autoSaveDelayMs);
  next.menuWidth = bound(raw.menuWidth,200,360,next.menuWidth);
  next.menuRowHeight = bound(raw.menuRowHeight,28,44,next.menuRowHeight);
  next.typewriterCharsPerSecond = bound(raw.typewriterCharsPerSecond,outputUi.charactersPerSecond.min,outputUi.charactersPerSecond.max,next.typewriterCharsPerSecond);
  next.visibleActions = Array.isArray(raw.visibleActions) ? [...new Set(raw.visibleActions.filter(id => typeof id === 'string' && CANVAS_ACTIONS.some(action => action.id === id)))] : [...next.visibleActions];
  if(Array.isArray(raw.visibleActions)&&raw.visibleActions.length&&Number(raw.preferenceVersion||0)<2&&!next.visibleActions.includes('workflow'))next.visibleActions.push('workflow');
  if(Array.isArray(raw.visibleActions)&&raw.visibleActions.length&&Number(raw.preferenceVersion||0)<3&&!next.visibleActions.includes('properties'))next.visibleActions.push('properties');
  return next;
}
export function loadUiPreferences(): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || 'null');
    const preferences = normalizeUiPreferences(saved);
    if (saved && typeof saved === 'object' && 'nightPalette' in saved) {
      try { localStorage.setItem(UI_PREFERENCES_KEY,JSON.stringify(preferences)); } catch {}
    }
    return preferences;
  }
  catch { return normalizeUiPreferences(null); }
}
