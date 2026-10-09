import { useEffect, useRef, useState } from 'react';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import GoalControlPanel from './side/GoalControlPanel';
const stateName:Record<string,string>={active:'进行中',completed:'已完成',paused:'已暂停',stopped:'已停止',archived:'已归档'};
export default function GoalOverview(){
 const root=useProjectStore(s=>s.root),{goals,selectedGoalId,select,refresh,error,pendingDraft,clearDraft}=useGoalControlStore();
 const [editor,setEditor]=useState(false),[creating,setCreating]=useState(false);
 const [autoPlanGoalId,setAutoPlanGoalId]=useState<string|null>(null);
 const editorRef=useRef<HTMLElement>(null),returnFocus=useRef<HTMLElement|null>(null);
 const detail=goals.find(g=>g.id===selectedGoalId);
 const visible=goals.filter(g=>g.status!=='archived');
 const attention=visible.flatMap(g=>[
  ...(g.decisions||[]).filter(d=>d.status==='open').map(d=>({goal:g,id:d.id,taskId:null as string|null,text:d.question,label:'待决定'})),
  ...(g.tasks||[]).filter(t=>['blocked','failed'].includes(t.status)||t.executionStatus==='unknown').map(t=>({goal:g,id:t.id,taskId:t.id as string|null,text:t.title,label:t.executionStatus==='unknown'?'待复核':t.status==='failed'?'执行失败':'有阻塞'})),
 ]);
 const openEditor=(goalId:string|null,taskId:string|null=null)=>{returnFocus.current=document.activeElement as HTMLElement;setCreating(!goalId);if(goalId)select(goalId,taskId);setEditor(true);};
 const close=()=>{setEditor(false);setAutoPlanGoalId(null);clearDraft();returnFocus.current?.focus();};
 useEffect(()=>{setEditor(false);setCreating(false);},[root]);
 useEffect(()=>{if(pendingDraft!==null&&root)openEditor(null);},[pendingDraft,root]);
 useEffect(()=>{
  if(!editor)return;
  editorRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭目标编辑"]')?.focus();
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Tab'){const controls=Array.from(editorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,summary')||[]).filter(n=>n.getClientRects().length);const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}if(e.key==='Escape'&&!document.querySelector('.tool-dialog,.global-settings,.mm-dialog')){e.preventDefault();setEditor(false);returnFocus.current?.focus();}};
  document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
 },[editor]);
 return <section className="goal-overview" aria-label="目标总览">
  <header className="overview-project-header"><span>{root?.split(/[\\/]/).pop()||'当前项目'}</span><div><button className="overview-refresh" aria-label="刷新目标总览" title="刷新目标" onClick={()=>void refresh(root)}>↻</button><button className="overview-create" onClick={()=>openEditor(null)}>＋ 新建目标</button></div></header>
  <div className="overview-brief"><div className="overview-brief-icon" aria-hidden="true">✦</div><div><span>项目简报</span><h1>{attention.length?'有一些事项需要你处理':visible.length?'继续推进你的目标':'从一个目标开始'}</h1><p>{attention.length?`${attention.length} 项待处理事项，先处理决定或阻塞，再继续推进。`:visible.length?`${visible.filter(g=>g.status==='active').length} 个目标正在进行，任务与验收进度都在这里。`:'描述你想完成的事，CodeNode 会帮你管理任务和验收。'}</p></div></div>
  {!!attention.length&&<section className="overview-attention"><h2>需要你处理 <span>{attention.length}</span></h2>{attention.slice(0,6).map(item=><button key={item.goal.id+item.id} onClick={()=>openEditor(item.goal.id,item.taskId)}><span className="overview-attention-label">{item.label}</span><span><strong>{item.text}</strong><small>{item.goal.title}</small></span><span aria-hidden="true">›</span></button>)}</section>}
  <section className="overview-goals"><div className="overview-list-heading"><h2>全部目标{visible.length>0&&<span>{visible.length}</span>}</h2></div>
   {visible.length===0?<div className="overview-empty"><p>还没有目标</p><span>可以从一个功能、一项修复或一个项目计划开始。</span><button onClick={()=>openEditor(null)}>创建第一个目标</button></div>:<div className="overview-goal-list" aria-label="项目目标列表">{visible.map(g=>{const done=g.tasks.filter(t=>t.status==='completed').length;return <button key={g.id} data-goal-id={g.id} onClick={()=>openEditor(g.id)}><span className={'overview-state-dot status-'+g.status}/><span className="overview-row-copy"><strong>{g.title}</strong><small>{g.objective}</small></span><span className="overview-row-progress">{done}/{g.tasks.length} 任务</span><span className="overview-row-status">{stateName[g.status]||g.status}</span><span aria-hidden="true">›</span></button>;})}</div>}
  </section>
  {error&&<p role="status">{error}</p>}
  <div className="overview-editor-mask" hidden={!editor} onPointerDown={e=>{if(e.target===e.currentTarget)close();}}><section ref={editorRef} className={`overview-goal-editor${creating?'':' with-goal-graph'}`} role="dialog" aria-modal="true" aria-label={creating?'新建目标':'目标详情'}>
   <header><div><h2>{creating?'新建目标':detail?.title||'目标详情'}</h2><span>{creating?'先写清目标与完成标准':'任务、决定与验收'}</span></div><button aria-label="关闭目标编辑" onClick={close}>×</button></header>
   <div className="overview-editor-scroll"><GoalControlPanel key={root||'no-project'} creating={creating} autoPlanGoalId={autoPlanGoalId} onAutoPlanConsumed={()=>setAutoPlanGoalId(null)} onCreated={goalId=>{if(pendingDraft!==null)setAutoPlanGoalId(goalId);clearDraft();setCreating(false);setEditor(true);}}/></div>
  </section></div>
 </section>;
}
export function WorkbenchViewSwitcher(){
 const {preferences,updatePreferences}=useUiStore();
 return <nav className="workbench-view-switch" aria-label="工作台视图"><button aria-current={preferences.workbenchView==='overview'?'page':undefined} aria-label="切换到总览" onClick={()=>updatePreferences({workbenchView:'overview'})}>总览</button><button aria-current={preferences.workbenchView==='conversation'?'page':undefined} aria-label="切换到对话" onClick={()=>updatePreferences({workbenchView:'conversation'})}>对话</button></nav>;
}
