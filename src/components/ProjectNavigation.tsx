import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { newProject, openProject, openProjectFile, openRecentProject, saveProject } from '../lib/projectActions';
import { readRecentProjects, projectNameOf } from '../lib/recentProjects';

/** Project/session navigation is independent of the conversation/inspector. */
export default function ProjectNavigation() {
  const root = useProjectStore(s => s.root);
  const file = useProjectStore(s => s.projectFile);
  const sessions = useSessionStore(s => s.sessions);
  const streaming = useSessionStore(s => s.streaming);
  const order = useSessionStore(s => s.order);
  const activeId = useSessionStore(s => s.activeId);
  const open = useUiStore(s => s.navigationOpen);
  const toggle = useUiStore(s => s.toggleNavigation);
  const [error, setError] = useState('');
  const act = async (operation: () => Promise<void>) => {
    setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : '打开项目失败'); }
  };
  const recent = readRecentProjects().filter(item => item.root !== root);
  if (!open) return <><button className="project-nav-toggle" aria-label="展开项目导航" onClick={toggle}>☰</button><button className="global-settings-trigger settings-collapsed" aria-label="全局设置" onClick={() => useUiStore.getState().openSettings()}>⚙</button></>;
  return <aside className="project-navigation" aria-label="项目与会话">
    <div className="project-nav-head"><strong>CodeNode</strong><button aria-label="收起项目导航" onClick={toggle}>☰</button></div>
    <button className="project-nav-new" onClick={() => { useSessionStore.getState().newCanvas(); useUiStore.getState().setSideTab('agent'); }}>＋ 新对话</button>
    <div className="project-nav-title"><span>项目</span><details className="project-actions"><summary aria-label="项目操作">＋</summary><div><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(newProject); }}>新建项目</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProject); }}>打开项目</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProjectFile); }}>打开工程文件</button></div></details></div>
    <div className="project-nav-scroll">
      <div className="project-nav-current" title={root || ''}>▱ {projectNameOf(root || file || '当前项目')}</div>
      <div className="project-nav-sessions">{order.map(id => {
        const session = sessions[id]; if (!session || session.archived) return null;
        return <div key={id} className="project-session-row"><button className={id === activeId ? 'active' : ''} aria-current={id === activeId ? 'page' : undefined} onClick={() => { useSessionStore.getState().switchSession(id); useUiStore.getState().setSideTab('agent'); }} title={session.label}>{session.label}</button><button className="session-archive" aria-label={`归档 ${session.label}`} title="归档聊天" disabled={streaming} onClick={() => { useSessionStore.getState().setArchived(id, true); void saveProject(); }}>▣</button></div>;
      })}</div>
      {recent.map(item => <button className="project-nav-recent" key={item.file || item.root} title={item.root} onClick={() => void act(() => openRecentProject(item))}>▱ {item.name}</button>)}
    </div>
    <button className="global-settings-trigger" onClick={() => useUiStore.getState().openSettings()}>⚙ 设置</button>
    {error && <div className="project-nav-error" role="alert">{error}</div>}
  </aside>;
}
