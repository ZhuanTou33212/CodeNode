import type { CSSProperties } from 'react';
import { useUiStore } from '../store/uiStore';
function RailIcon({kind}:{kind:'home'|'files'|'plugins'|'settings'|'sidebar'|'tasks'}) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='tasks'&&<><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m6 9 1 1 2-2m3 1h5m-11 6 1 1 2-2m3 1h5"/></>}
    <g visibility={kind==='tasks'?'hidden':undefined}>
    {kind==='home'?<><path d="m3 10 9-7 9 7"/><path d="M5 9v11h5v-6h4v6h5V9"/></>:kind==='files'?<><path d="M3 7h7l2 2h9v11H3Z"/><path d="M3 7V4h7l2 3"/></>:kind==='plugins'?<><path d="M8 5V3h3v2h5v5h2v3h-2v6H5v-6H3v-3h2V5Z"/></>:kind==='sidebar'?<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>:<><path d="m9 3-1 3-3 1 1 3-1 3 3 1 1 3h4l1-3 3-1-1-3 1-3-3-1-1-3Z"/><circle cx="11" cy="10" r="3"/></>}
    </g>
  </svg>;
}
export default function ActivityBar() {
  const {appPage,setAppPage,setPluginView,navigationOpen,toggleNavigation,preferences,sideTab,setSideTab,openSettings}=useUiStore();
  return <nav className="activity-bar" aria-label="主导航" style={{'--activity-bar-width':preferences.activityBarWidth+'px'} as CSSProperties}>
    <button className="toolbar-navigation-toggle" title={(navigationOpen?'隐藏':'显示')+'侧边栏 (Ctrl+B)'} aria-label={(navigationOpen?'隐藏':'显示')+'侧边栏'} aria-expanded={navigationOpen} onClick={toggleNavigation}><RailIcon kind="sidebar"/></button>
    <div className="activity-bar-links">
      <button title="工作台" aria-label="工作台" aria-current={appPage==='workbench'&&!['project','preview'].includes(sideTab)?'page':undefined} onClick={()=>{setAppPage('workbench');setSideTab('agent')}}><RailIcon kind="home"/></button>
      <button title="文件" aria-label="文件" aria-current={appPage==='workbench'&&['project','preview'].includes(sideTab)?'page':undefined} onClick={()=>{setAppPage('workbench');setSideTab('project')}}><RailIcon kind="files"/></button>
      <button title="插件" aria-label="插件" aria-current={appPage==='plugins'?'page':undefined} onClick={()=>setPluginView('plugins')}><RailIcon kind="plugins"/></button>
      <button title="任务" aria-label="任务" aria-current={appPage==='tasks'?'page':undefined} onClick={()=>setAppPage('tasks')}><RailIcon kind="tasks"/></button>
    </div>
    <div className="activity-bar-footer"><button className="global-settings-trigger" title="设置" aria-label="全局设置" onClick={()=>openSettings()}><RailIcon kind="settings"/></button></div>
  </nav>;
}
