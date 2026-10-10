import { useEffect } from 'react';
import { CANVAS_ACTIONS } from '../lib/uiPreferences';
import { useUiStore } from '../store/uiStore';
import ArchivedChatsSettings from './ArchivedChatsSettings';
import RagSettingsPanel from './RagSettingsPanel';
import EditingSettingsPanel from './EditingSettingsPanel';
import AgentExecutionSettings from './AgentExecutionSettings';
import BackendSettingsPanel from './BackendSettingsPanel';
import SchedulingSettingsPanel from './SchedulingSettingsPanel';
import outputUi from '../../config/ui.output.json';
import CostSettingsPanel from './CostSettingsPanel';
import TrellisCliSettings from './TrellisCliSettings';


export default function GlobalSettings() {
  const { settingsOpen: open, settingsTab: tab, closeSettings: close, openSettings, theme, toggleTheme, preferences, updatePreferences, resetPreferences, navigationWidth, conversationWidth, setNavigationWidth, setConversationWidth } = useUiStore();
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
    <div className="settings-layout"><nav aria-label="设置分类">{([['general','常规'],['layout','界面'],['agents','Agent 连接'],['execution','执行'],['trellis','Trellis'],['costs','成本与模型'],['rag','检索'],['editing','安全编辑'],['archived','已归档聊天']] as const).map(([id,label]) => <button key={id} aria-pressed={tab === id} onClick={() => openSettings(id)}>{label}</button>)}</nav>
    <div className="settings-content" key={tab}>
      {tab === 'general' && <><h2>常规</h2>
        <section className="settings-group"><div className="settings-row"><span>主题</span><button className="settings-theme-toggle" onClick={toggleTheme}>{theme==='light'?'日间':'夜间'} · 切换</button></div>
        <label className="settings-row"><span>默认工作台</span><select aria-label="工作台页面" value={preferences.workbenchView} onChange={e=>updatePreferences({workbenchView:e.target.value as 'overview'|'conversation'})}><option value="overview">总览</option><option value="conversation">对话</option></select></label>
        </section>
        <section className="settings-group"><label className="settings-row"><span>自动保存</span><input aria-label="自动保存项目" type="checkbox" checked={preferences.autoSaveEnabled} onChange={e=>updatePreferences({autoSaveEnabled:e.target.checked})}/></label>
        <details className="settings-advanced"><summary>保存选项</summary><label className="settings-row"><span>保存延迟</span><input aria-label="自动保存延迟" type="range" min="500" max="5000" step="100" disabled={!preferences.autoSaveEnabled} value={preferences.autoSaveDelayMs} onChange={e=>updatePreferences({autoSaveDelayMs:Number(e.target.value)})}/><output>{(preferences.autoSaveDelayMs/1000).toFixed(1)}秒</output></label></details></section>
        <section className="settings-group"><label className="settings-row"><span>逐字显示回复</span><input aria-label="逐字显示 Agent 回复" type="checkbox" checked={preferences.typewriterEnabled} onChange={event=>updatePreferences({typewriterEnabled:event.target.checked})}/></label>
        <details className="settings-advanced"><summary>显示选项</summary><label className="settings-row"><span>显示速度</span><input aria-label="回复显示速度" type="range" min={outputUi.charactersPerSecond.min} max={outputUi.charactersPerSecond.max} step="10" value={preferences.typewriterCharsPerSecond} disabled={!preferences.typewriterEnabled} onChange={event=>updatePreferences({typewriterCharsPerSecond:Number(event.target.value)})}/><output>{preferences.typewriterCharsPerSecond} 字/秒</output></label></details></section>
        <footer className="settings-save-note">设置自动保存</footer>
      </>}
      {tab === 'layout' && <><h2>界面</h2><section className="settings-group"><h3>侧栏</h3><label className="settings-row"><span>图标栏宽度</span><input aria-label="主导航图标栏宽度" type="range" min="40" max="64" value={preferences.activityBarWidth} onChange={e=>updatePreferences({activityBarWidth:Number(e.target.value)})}/><output>{preferences.activityBarWidth}px</output></label>
      <label className="settings-row"><span>左侧栏宽度</span><input aria-label="左侧栏宽度" type="range" min="180" max="400" value={navigationWidth} onChange={e => setNavigationWidth(Number(e.target.value))}/><output>{navigationWidth}px</output></label>
      <label className="settings-row"><span>对话栏宽度</span><input aria-label="对话栏宽度" type="range" min="320" max="640" value={conversationWidth} onChange={e => setConversationWidth(Number(e.target.value))}/><output>{conversationWidth}px</output></label>
      {([['navigationOpen','显示左侧栏'],['conversationOpen','显示对话栏'],['autoCollapseSidebars','窄窗口收起侧栏']] as const).map(([key,label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={preferences[key]} onChange={e => updatePreferences({[key]:e.target.checked})}/></label>)}
</section><details className="settings-advanced settings-group"><summary>画布菜单</summary>
      <label className="settings-row"><span>菜单宽度</span><input aria-label="菜单宽度" type="range" min="200" max="360" value={preferences.menuWidth} onChange={e => updatePreferences({menuWidth:Number(e.target.value)})}/><output>{preferences.menuWidth}px</output></label>
      <label className="settings-row"><span>菜单行高</span><input aria-label="菜单行高" type="range" min="28" max="44" value={preferences.menuRowHeight} onChange={e => updatePreferences({menuRowHeight:Number(e.target.value)})}/><output>{preferences.menuRowHeight}px</output></label>
      {([['showShortcuts','显示快捷键提示'],['showGroupLabels','显示分组标题'],['hideDisabledActions','隐藏不可用操作']] as const).map(([key,label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={preferences[key]} onChange={e => updatePreferences({[key]:e.target.checked})}/></label>)}
      <fieldset className="settings-menu-actions"><legend>菜单中显示的操作</legend>{CANVAS_ACTIONS.map(action => <label key={action.id}><input type="checkbox" checked={preferences.visibleActions.includes(action.id)} onChange={e => updatePreferences({visibleActions:e.target.checked ? [...preferences.visibleActions,action.id] : preferences.visibleActions.filter(id => id !== action.id)})}/>{action.label}</label>)}</fieldset>
</details><div className="settings-reset"><button onClick={resetPreferences}>恢复默认偏好</button></div></>}
      {tab === 'agents' && <><div className="settings-page-title"><h2>Agent 连接</h2><button onClick={()=>useUiStore.getState().openModelManager()}>管理模型</button></div><BackendSettingsPanel /></>}
      {tab === 'execution' && <><h2>执行</h2><AgentExecutionSettings /><details className="settings-advanced settings-group"><summary>并发与任务额度</summary><SchedulingSettingsPanel /></details></>}
      {tab === 'trellis' && <><h2>Trellis</h2><TrellisCliSettings /></>}
      {tab === 'rag' && <><h2>检索</h2><p className="settings-scope">应用于当前项目</p><RagSettingsPanel /></>}
      {tab === 'editing' && <><h2>安全编辑与校验</h2><EditingSettingsPanel /></>}
      {tab === 'costs' && <><h2>成本与模型</h2><CostSettingsPanel /></>}
      {tab === 'archived' && <ArchivedChatsSettings/>}
    </div></div>
  </section></div>;
}
