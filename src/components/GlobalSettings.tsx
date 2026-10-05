import { useEffect } from 'react';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { saveProject } from '../lib/projectActions';
import RagSettingsPanel from './RagSettingsPanel';
import { ExtensionsPanel } from './WorkbenchDock';

export default function GlobalSettings() {
  const { settingsOpen: open, settingsTab: tab, closeSettings: close, openSettings, theme, toggleTheme } = useUiStore();
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
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.global-settings button:not(:disabled), .global-settings input, .global-settings select')).filter(el => el.getClientRects().length);
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
    <div className="settings-layout"><nav aria-label="设置分类">{([['general','常规'],['rag','检索'],['extensions','扩展'],['archived','已归档聊天']] as const).map(([id,label]) => <button key={id} aria-pressed={tab === id} onClick={() => openSettings(id)}>{label}</button>)}</nav>
    <div className="settings-content">
      {tab === 'general' && <><h2>常规</h2><div className="settings-row"><span>外观</span><button onClick={toggleTheme}>{theme === 'light' ? '日间' : '夜间'} · 切换</button></div><div className="settings-row"><span>模型连接</span><button onClick={() => useUiStore.getState().openModelManager()}>管理模型</button></div></>}
      {tab === 'rag' && <><h2>检索</h2><p className="settings-scope">应用于当前项目</p><RagSettingsPanel /></>}
      {tab === 'extensions' && <><h2>扩展</h2><p className="settings-scope">当前项目的工具与扩展</p><ExtensionsPanel /></>}
      {tab === 'archived' && <><h2>已归档聊天</h2>{order.filter(id => sessions[id]?.archived).length === 0 && <p>暂无归档聊天</p>}{order.filter(id => sessions[id]?.archived).map(id => <div className="settings-row" key={id}><span>{sessions[id].label}</span><button disabled={streaming} onClick={() => { useSessionStore.getState().setArchived(id, false); void saveProject(); }}>恢复</button></div>)}</>}
    </div></div>
  </section></div>;
}
