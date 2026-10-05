import { useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { newProject, openProject, openProjectFile, openRecentProject } from '../lib/projectActions';
import { readRecentProjects, projectNameOf } from '../lib/recentProjects';

/** Project/session navigation is independent of the conversation/inspector. */
export default function ProjectNavigation() {
  const root = useProjectStore(s => s.root);
  const file = useProjectStore(s => s.projectFile);
  const sessions = useSessionStore(s => s.sessions);
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
  if (!open) return <button className="project-nav-toggle" aria-label="展开项目导航" onClick={toggle}>☰</button>;
  return <aside className="project-navigation" aria-label="项目与会话">
    <div className="project-nav-head"><strong>CodeNode</strong><button aria-label="收起项目导航" onClick={toggle}>☰</button></div>
    <button className="project-nav-new" onClick={() => { useSessionStore.getState().newCanvas(); useUiStore.getState().setSideTab('agent'); }}>＋ 新对话</button>
    <div className="project-nav-title"><span>项目</span><button aria-label="打开项目目录" title="打开项目目录" onClick={() => void act(openProject)}>＋</button></div>
    <div className="project-nav-scroll">
      <div className="project-nav-current" title={root || ''}>▱ {projectNameOf(root || file || '当前项目')}</div>
      <div className="project-nav-sessions">{order.map(id => {
        const session = sessions[id]; if (!session) return null;
        return <button key={id} className={id === activeId ? 'active' : ''} aria-current={id === activeId ? 'page' : undefined} onClick={() => { useSessionStore.getState().switchSession(id); useUiStore.getState().setSideTab('agent'); }} title={session.label}>{session.label}</button>;
      })}</div>
      {recent.map(item => <button className="project-nav-recent" key={item.file || item.root} title={item.root} onClick={() => void act(() => openRecentProject(item))}>▱ {item.name}</button>)}
    </div>
    {error && <div className="project-nav-error" role="alert">{error}</div>}
    <div className="project-nav-foot">
      <button onClick={() => void act(newProject)}>新建项目</button>
      <button onClick={() => void act(openProjectFile)}>打开工程文件</button>
      <button onClick={() => useUiStore.getState().setSideTab('project')}>项目文件</button>
    </div>
  </aside>;
}
