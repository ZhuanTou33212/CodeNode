import { useEffect } from 'react';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { saveProject } from '../lib/projectActions';
import RagSettingsPanel from './RagSettingsPanel';


export default function GlobalSettings() {
  const { settingsOpen: open, settingsTab: tab, closeSettings: close, openSettings, theme, toggleTheme, preferences, updatePreferences, resetPreferences, navigationWidth, conversationWidth, setNavigationWidth, setConversationWidth } = useUiStore();
  const sessions = useSessionStore(s => s.sessions);
  const order = useSessionStore(s => s.order);
  const streaming = useSessionStore(s => s.streaming);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (useUiStore.getState().modelManagerOpen) return;
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.global-settings button:not(:disabled), .global-settings input, .global-settings select, .global-settings textarea, .global-settings summary')).filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.querySelector<HTMLButtonElement>('.settings-close')?.focus();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open, close]);
  if (!open) return null;
  return <div className="settings-mask" onClick={close}><section className="global-settings" role="dialog" aria-modal="true" aria-label="全局设置" onClick={event => event.stopPropagation()}>
    <header><strong>设置</strong><button className="settings-close" aria-label="关闭设置" onClick={close}>×</button></header>
    <div className="settings-layout"><nav aria-label="设置分类">{([['general','常规'],['rag','检索'],['archived','已归档聊天']] as const).map(([id,label]) => <button key={id} aria-pressed={tab === id} onClick={() => openSettings(id)}>{label}</button>)}</nav>
    <div className="settings-content">
      {tab === 'general' && <><h2>常规</h2><div className="settings-row"><span>外观</span><button className="settings-theme-toggle" onClick={toggleTheme}>{theme === 'light' ? '日间' : '夜间'} · 切换</button></div><h3>布局</h3><label className="settings-row"><span>最左侧图标栏宽度</span><input aria-label="主导航图标栏宽度" type="range" min="40" max="64" value={preferences.activityBarWidth} onChange={e=>updatePreferences({activityBarWidth:Number(e.target.value)})}/><output>{preferences.activityBarWidth}px</output></label>
      <label className="settings-row"><span>左侧栏宽度</span><input aria-label="左侧栏宽度" type="range" min="180" max="400" value={navigationWidth} onChange={e => setNavigationWidth(Number(e.target.value))}/><output>{navigationWidth}px</output></label>
      <label className="settings-row"><span>对话栏宽度</span><input aria-label="对话栏宽度" type="range" min="320" max="640" value={conversationWidth} onChange={e => setConversationWidth(Number(e.target.value))}/><output>{conversationWidth}px</output></label>
      {([['navigationOpen','默认显示左侧栏'],['conversationOpen','默认显示对话栏'],['autoCollapseSidebars','窄窗口自动收起侧栏']] as const).map(([key,label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={preferences[key]} onChange={e => updatePreferences({[key]:e.target.checked})}/></label>)}
      <h3>画布操作菜单</h3>
      <label className="settings-row"><span>菜单宽度</span><input aria-label="菜单宽度" type="range" min="200" max="360" value={preferences.menuWidth} onChange={e => updatePreferences({menuWidth:Number(e.target.value)})}/><output>{preferences.menuWidth}px</output></label>
      <label className="settings-row"><span>菜单行高</span><input aria-label="菜单行高" type="range" min="28" max="44" value={preferences.menuRowHeight} onChange={e => updatePreferences({menuRowHeight:Number(e.target.value)})}/><output>{preferences.menuRowHeight}px</output></label>
      {([['showShortcuts','显示快捷键提示'],['showGroupLabels','显示分组标题'],['hideDisabledActions','隐藏不可用操作']] as const).map(([key,label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={preferences[key]} onChange={e => updatePreferences({[key]:e.target.checked})}/></label>)}
      <fieldset className="settings-menu-actions"><legend>菜单中显示的操作</legend>{CANVAS_ACTIONS.map(action => <label key={action.id}><input type="checkbox" checked={preferences.visibleActions.includes(action.id)} onChange={e => updatePreferences({visibleActions:e.target.checked ? [...preferences.visibleActions,action.id] : preferences.visibleActions.filter(id => id !== action.id)})}/>{action.label}</label>)}</fieldset>
      <div className="settings-row"><span>界面偏好会自动保存，昼夜主题共用</span><button onClick={resetPreferences}>恢复默认偏好</button></div>
      <div className="settings-row"><span>模型连接</span><button onClick={() => useUiStore.getState().openModelManager()}>管理模型</button></div></>}
      {tab === 'rag' && <><h2>检索</h2><p className="settings-scope">应用于当前项目</p><RagSettingsPanel /></>}
      {tab === 'archived' && <><h2>已归档聊天</h2>{order.filter(id => sessions[id]?.archived).length === 0 && <p>暂无归档聊天</p>}{order.filter(id => sessions[id]?.archived).map(id => <div className="settings-row" key={id}><span>{sessions[id].label}</span><button disabled={streaming} onClick={() => { useSessionStore.getState().setArchived(id, false); void saveProject(); }}>恢复</button></div>)}</>}
    </div></div>
  </section></div>;
}
