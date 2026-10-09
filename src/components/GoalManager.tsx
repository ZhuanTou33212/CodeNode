import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import GoalControlPanel from './side/GoalControlPanel';

export default function GoalManager() {
  const root=useProjectStore(s=>s.root);
  const appPage=useUiStore(s=>s.appPage);
  const conversationOpen=useUiStore(s=>s.conversationOpen);
  const theme=useUiStore(s=>s.theme);
  const goals=useGoalControlStore(s=>s.goals);
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState({left:8,top:64});
  const button=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLElement>(null);
  const attention=goals.reduce((n,g)=>n+(g.decisions||[]).filter(d=>d.status==='open').length+(g.tasks||[]).filter(t=>['blocked','failed'].includes(t.status)||t.executionStatus==='unknown'||t.status==='waiting'&&t.waitDue).length,0);
  useEffect(()=>setOpen(false),[root,appPage,conversationOpen]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const r=document.querySelector('#conversation-panel')?.getBoundingClientRect();if(r)setPosition({left:Math.max(8,r.left>=392?r.left-388:r.right-Math.min(380,innerWidth-16)),top:r.top+8});};
    place();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="关闭目标管理"]')?.focus();
    const dismiss=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!document.querySelector('.agent-switch-menu,.global-settings,.mm-dialog,.tool-dialog')){e.preventDefault();setOpen(false);button.current?.focus();}};
    document.addEventListener('keydown',dismiss);return()=>document.removeEventListener('keydown',dismiss);
  },[open]);
  return <>
    <button ref={button} className="goal-manager-trigger" aria-label="打开目标管理" aria-expanded={open} aria-controls="goal-management-panel" title={attention?`${attention} 项待处理事项`:'管理目标、任务与验收'} onClick={()=>setOpen(!open)}>目标{attention>0&&<span className="goal-attention-count">{attention}</span>}</button>
    {createPortal(<div className={`glass-theme theme-${theme} goal-management-layer`}><aside ref={panel} id="goal-management-panel" className="goal-management-drawer" hidden={!open} role="dialog" aria-label="目标管理" style={{...position,maxHeight:`calc(100vh - ${position.top+12}px)`}}>
      <header><div><strong>目标管理</strong><small>目标、任务与独立验收</small></div><button aria-label="关闭目标管理" onClick={()=>{setOpen(false);button.current?.focus();}}>×</button></header>
      <div className="goal-management-scroll"><GoalControlPanel key={root||'no-project'}/></div>
    </aside></div>,document.body)}
  </>;
}

export function GoalBinding() {
  const {goals,selectedGoalId,selectedTaskId,select}=useGoalControlStore();
  const goal=goals.find(g=>g.id===selectedGoalId),task=goal?.tasks.find(t=>t.id===selectedTaskId);
  if(!task)return null;
  return <div className="conversation-goal-binding"><span title={goal?.title+' · '+task.title}>目标 · {goal?.title} / {task.title}</span><button aria-label="解除目标任务绑定" title="解除绑定" onClick={()=>select(selectedGoalId,null)}>×</button></div>;
}
