import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { newProject, openProject, openProjectFile, openRecentProject, saveProject } from '../lib/projectActions';
import { readRecentProjects, projectNameOf, forgetRecentProject } from '../lib/recentProjects';

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
  const [revision, refresh] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, { name?: string; pinned?: boolean; hidden?: boolean }>>(() => { try { return JSON.parse(localStorage.getItem('codenode.projectNavigation') || '{}'); } catch { return {}; } });
  const changeMeta = (key: string, patch: { name?: string; pinned?: boolean; hidden?: boolean }) => setMeta(current => { const next = { ...current, [key]: { ...current[key], ...patch } }; localStorage.setItem('codenode.projectNavigation', JSON.stringify(next)); return next; });
  useEffect(() => {
    const dismiss = (event: Event) => document.querySelectorAll<HTMLDetailsElement>('.project-actions[open], .project-row-menu[open]').forEach(menu => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) menu.open = false; });
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, []);
  const act = async (operation: () => Promise<void>) => {
    setError('');
    try { await operation(); const state = useProjectStore.getState(); changeMeta(state.projectFile || state.root || '', { hidden: false }); } catch (cause) { setError(cause instanceof Error ? cause.message : '打开项目失败'); }
  };
  const recent = readRecentProjects().filter(item => item.root !== root);
  const projects = [{ root: root || '', file: file || undefined, name: projectNameOf(root || file || '当前项目') }, ...recent].filter(item => !meta[item.file || item.root]?.hidden).sort((a,b) => Number(!!meta[b.file || b.root]?.pinned)-Number(!!meta[a.file || a.root]?.pinned));
  void revision;
  if (!open) return <><button className="project-nav-toggle" aria-label="展开项目导航" onClick={toggle}>☰</button><button className="global-settings-trigger settings-collapsed" aria-label="全局设置" onClick={() => useUiStore.getState().openSettings()}>⚙</button></>;
  return <aside className="project-navigation" aria-label="项目与会话">
    <div className="project-nav-head"><strong>CodeNode</strong><button aria-label="收起项目导航" onClick={toggle}>☰</button></div>
    <button className="project-nav-new" disabled={streaming} onClick={() => { useSessionStore.getState().newCanvas(); useUiStore.getState().setSideTab('agent'); }}>＋ 新对话</button>
    <div className="project-nav-title"><span>项目</span><details className="project-actions"><summary aria-label="项目操作">＋</summary><div><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(newProject); }}>新建项目</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProject); }}>打开项目</button><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void act(openProjectFile); }}>打开工程文件</button></div></details></div>
    <div className="project-nav-scroll">
      {projects.map(project => {
        const key = project.file || project.root, current = project.root === root;
        const name = meta[key]?.name || project.name;
        const folded = collapsed[key] ?? !current;
        return <section className="project-group" key={key}>
          <div className="project-group-row">
            <button className="project-group-name" aria-expanded={!folded} title={project.root} onClick={() => { setCollapsed(state => ({ ...state, [key]: !folded })); if (!current) void act(() => openRecentProject(project)); }}><span>{folded ? '›' : '⌄'}</span><span>▱</span><span>{name}</span>{meta[key]?.pinned && <small>置顶</small>}</button>
            <button className="project-new-chat" aria-label={`在 ${name} 新建聊天`} disabled={streaming} onClick={() => void act(async () => { if (!current) await openRecentProject(project); useSessionStore.getState().newCanvas(); useUiStore.getState().setSideTab('agent'); })}>＋</button>
            <details className="project-row-menu"><summary aria-label={`${name} 项目菜单`}>⋯</summary><div onClick={event => event.currentTarget.parentElement?.removeAttribute('open')}>
              <button onClick={() => changeMeta(key, { pinned: !meta[key]?.pinned })}>{meta[key]?.pinned ? '取消置顶' : '置顶'}</button>
              <button onClick={() => setRenaming(key)}>编辑名称</button>
              {current && <button disabled={streaming} onClick={() => { order.filter(id => !sessions[id]?.archived).forEach(id => useSessionStore.getState().setArchived(id, true)); void saveProject(); }}>归档聊天</button>}
              <button onClick={() => { changeMeta(key, { hidden: true }); forgetRecentProject(project); refresh(value => value+1); }}>从侧栏移除</button>
            </div></details>
          </div>
          {renaming === key && <input className="project-rename" aria-label="项目显示名称" autoFocus defaultValue={name} onKeyDown={event => { if(event.key === 'Enter') { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); } if(event.key === 'Escape') setRenaming(null); }} onBlur={event => { changeMeta(key, { name: event.currentTarget.value.trim() || project.name }); setRenaming(null); }} />}
          {current && !folded && <div className="project-nav-sessions">{order.map(id => {
            const session = sessions[id]; if (!session || session.archived) return null;
            return <div key={id} className="project-session-row"><button className={id === activeId ? 'active' : ''} aria-current={id === activeId ? 'page' : undefined} onClick={() => { useSessionStore.getState().switchSession(id); useUiStore.getState().setSideTab('agent'); }} title={session.prompt || session.label}>{session.prompt && !session.prompt.startsWith('#') ? session.prompt : session.label}</button><button className="session-archive" aria-label={`归档 ${session.label}`} title="归档聊天" disabled={streaming} onClick={() => { useSessionStore.getState().setArchived(id, true); void saveProject(); }}>▣</button></div>;
          })}</div>}
        </section>;
      })}
    </div>
    <button className="global-settings-trigger" onClick={() => useUiStore.getState().openSettings()}>⚙ 设置</button>
    {error && <div className="project-nav-error" role="alert">{error}</div>}
  </aside>;
}
