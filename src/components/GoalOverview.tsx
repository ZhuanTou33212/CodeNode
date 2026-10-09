import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import GoalControlPanel from './side/GoalControlPanel';
export default function GoalOverview(){
 const root=useProjectStore(s=>s.root),{goals,selectedGoalId,select}=useGoalControlStore();
 const active=goals.filter(g=>g.status==='active').length;
 const tasks=goals.flatMap(g=>g.tasks||[]),blocked=tasks.filter(t=>['blocked','failed'].includes(t.status)||t.executionStatus==='unknown').length;
 const completed=tasks.filter(t=>t.status==='completed').length;
 const detail=goals.find(g=>g.id===selectedGoalId);
 return <section className="goal-overview" aria-label="目标总览">
  <header><div><span className="overview-eyebrow">{root?.split(/[\\/]/).pop()||'当前项目'}</span><h1>项目总览</h1><p>掌握目标进度，处理待办，查看验收结果。</p></div><button onClick={()=>select(null,null)}>＋ 创建目标</button></header>
  <div className="overview-metrics"><div><strong>{goals.filter(g=>g.status!=='archived').length}</strong><span>项目目标</span></div><div><strong>{active}</strong><span>进行中</span></div><div><strong>{blocked}</strong><span>需要处理</span></div><div><strong>{completed}</strong><span>已完成任务</span></div></div>
  <div className="overview-layout"><nav className="overview-goal-list" aria-label="项目目标列表"><h2>全部目标</h2>{!goals.length&&<p>还没有目标。创建一个目标，定义任务与验收条件。</p>}{goals.map(g=><button key={g.id} aria-current={selectedGoalId===g.id?'true':undefined} onClick={()=>select(g.id,null)}><strong>{g.title}</strong><span>{g.status==='active'?'进行中':g.status==='completed'?'已完成':g.status==='paused'?'已暂停':g.status==='archived'?'已归档':'已停止'} · {g.tasks.length} 个任务</span><small>{g.objective}</small></button>)}</nav>
  <article className="overview-goal-detail"><div className="overview-detail-heading"><h2>{detail?'目标详情':'创建目标'}</h2><span>任务与独立验收</span></div><GoalControlPanel key={root||'no-project'}/></article></div>
 </section>;
}
export function WorkbenchViewSwitcher(){
 const {preferences,updatePreferences}=useUiStore();
 return <nav className="workbench-view-switch" aria-label="工作台视图"><button aria-current={preferences.workbenchView==='overview'?'page':undefined} aria-label="切换到总览" onClick={()=>updatePreferences({workbenchView:'overview'})}>总览</button><button aria-current={preferences.workbenchView==='conversation'?'page':undefined} aria-label="切换到对话" onClick={()=>updatePreferences({workbenchView:'conversation'})}>对话</button></nav>;
}
