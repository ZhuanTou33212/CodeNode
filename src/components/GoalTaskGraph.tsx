import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { useGoalControlStore, type GoalItem } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUsageStore } from '../store/usageStore';
import { useChatStore } from '../store/chatStore';
import { useUiStore } from '../store/uiStore';
import './goalTaskGraph.css';

type Task = { id: string; title: string; objective: string; status: string; updatedAt:string; dependsOn: string[]; writeScope: string[]; criteriaIds?:string[]; runIds: string[]; executionStatus?: string; canvasPosition?: { x: number; y: number } | null; lastRun?:{runId:string;status:string;summary:string;finishedAt:string}|null };
const labels: Record<string,string> = { todo:'待办',ready:'可执行',in_progress:'执行中',waiting:'等待中',blocked:'需处理',completed:'已完成',failed:'失败',cancelled:'已取消' };

function GoalTaskNode({ data, selected }: NodeProps) {
  const item=data as { title:string; objective:string; status:string };
  return <div className={`goal-graph-node status-${item.status}${selected?' is-selected':''}`} title={item.objective}>
    <Handle type="target" position={Position.Left}/>
    <div className="goal-graph-node-head"><span className="goal-graph-kind" aria-hidden="true">◈</span><span className="goal-graph-title"><small>目标任务</small><strong>{item.title}</strong></span></div>
    <p className="goal-graph-description">{item.objective}</p>
    <div className="goal-graph-node-foot"><span className="goal-graph-status-dot" aria-hidden="true"/>{labels[item.status]||item.status}</div>
    <Handle type="source" position={Position.Right}/>
  </div>;
}
const nodeTypes={goalTask:GoalTaskNode};

function taskNodes(tasks: Task[]): Node[] {
  const byId=new Map(tasks.map(task=>[task.id,task]));
  const depth=new Map<string,number>(),visiting=new Set<string>();
  const level=(id:string):number=>{if(depth.has(id))return depth.get(id)!;if(visiting.has(id))return 0;visiting.add(id);const task=byId.get(id);const value=task?.dependsOn?.length?Math.max(...task.dependsOn.map(dep=>level(dep)))+1:0;visiting.delete(id);depth.set(id,value);return value;};
  const rows=new Map<number,number>();
  return tasks.map(task=>{const x=level(task.id),row=rows.get(x)||0;rows.set(x,row+1);return {id:task.id,type:'goalTask',deletable:false,position:task.canvasPosition||{x:x*300+30,y:row*148+35},data:{title:task.title,objective:task.objective,status:task.status}};});
}

function goalContract(goal: GoalItem): string {
  return JSON.stringify({objective:goal.objective,scope:goal.scope,exclusions:goal.exclusions,criteriaRevision:goal.criteriaRevision,
    tasks:goal.tasks.map((task:Task&{readScope?:string[];criteriaIds?:string[]})=>({id:task.id,title:task.title,objective:task.objective,dependsOn:task.dependsOn,readScope:task.readScope,writeScope:task.writeScope,criteriaIds:task.criteriaIds}))});
}

export default function GoalTaskGraph({goal,root,autoPropose=false,onAutoProposeConsumed}:{goal:GoalItem;root:string;autoPropose?:boolean;onAutoProposeConsumed?:()=>void}) {
  const select=useGoalControlStore(s=>s.select),selectedTaskId=useGoalControlStore(s=>s.selectedTaskId),refresh=useGoalControlStore(s=>s.refresh);
  const revision=useGoalControlStore(s=>s.revision);
  const modelId=useUsageStore(s=>s.modelId);
  const [nodes,setNodes]=useState<Node[]>(()=>taskNodes(goal.tasks as Task[]));
  const [busy,setBusy]=useState(false),[running,setRunning]=useState(false),[message,setMessage]=useState('');
  const [proposal,setProposal]=useState<GoalPlanStep[]|null>(null),[proposalRevision,setProposalRevision]=useState(0);
  const [newTitle,setNewTitle]=useState(''),[draftTitle,setDraftTitle]=useState(''),[draftObjective,setDraftObjective]=useState(''),[draftScope,setDraftScope]=useState(''),[draftCriteriaIds,setDraftCriteriaIds]=useState<string[]>([]);
  const stopAfterCurrent=useRef(false);
  const autoProposed=useRef(new Set<string>());
  const task=(goal.tasks as Task[]).find(item=>item.id===selectedTaskId);
  const editable=goal.status==='active'&&!running;
  useEffect(()=>setNodes(taskNodes(goal.tasks as Task[])),[goal.tasks]);
  useEffect(()=>{setDraftTitle(task?.title||'');setDraftObjective(task?.objective||'');setDraftScope((task?.writeScope||[]).join(', '));setDraftCriteriaIds(task?.criteriaIds||[]);},[task?.id,task?.updatedAt]);
  useEffect(()=>{setProposal(null);setMessage('');stopAfterCurrent.current=true;},[root,goal.id]);
  const edges=useMemo<Edge[]>(()=>goal.tasks.flatMap((item:Task)=>(item.dependsOn||[]).map(dep=>({id:`${dep}:${item.id}`,source:dep,target:item.id,animated:item.status==='in_progress',deletable:editable&&!busy}))),[goal.tasks,editable,busy]);
  const mutate=async(action:()=>Promise<{ok:boolean;error?:string}>,success:string)=>{
    if(!editable||!window.codenode)return;
    setBusy(true);setMessage('');
    try{const result=await action();if(useProjectStore.getState().root!==root)return;if(!result.ok)throw new Error(result.error||'更新失败');await refresh(root);setMessage(success);}catch(error){if(useProjectStore.getState().root===root){setMessage(String((error as Error).message||error));await refresh(root);}}finally{setBusy(false);}
  };
  const connect=(connection:Connection)=>{
    if(!editable||busy)return;
    const {source,target}=connection;if(!source||!target||source===target)return;
    const task=(goal.tasks as Task[]).find(item=>item.id===target);
    if(!task||task.status==='completed'||task.status==='in_progress'||task.dependsOn.includes(source))return;
    void mutate(()=>window.codenode!.goalTaskUpdate(root,goal.id,target,{dependsOn:[...task.dependsOn,source],expectedRevision:revision}),'依赖已保存');
  };
  const disconnect=(removed:Edge[])=>{
    if(!editable||busy)return;
    if(new Set(removed.map(edge=>edge.target)).size>1){setMessage('一次请只编辑一个任务的依赖连线，避免部分修改');return;}
    void mutate(async()=>{
      const byTarget=new Map<string,string[]>();
      for(const edge of removed)byTarget.set(edge.target,[...(byTarget.get(edge.target)||[]),edge.source]);
      for(const [targetId,sources] of byTarget){const target=(goal.tasks as Task[]).find(item=>item.id===targetId);if(!target)continue;
        const result=await window.codenode!.goalTaskUpdate(root,goal.id,target.id,{dependsOn:target.dependsOn.filter(id=>!sources.includes(id)),expectedRevision:revision});
        if(!result.ok)return result;
      }
      return {ok:true};
    },'依赖已移除');
  };
  const propose=async()=>{
    if(!editable||busy||!window.codenode)return;
    setBusy(true);setMessage('正在用 CodeNode 规划模型生成任务图；生成后可检查再保存。');
    const baseRevision=useGoalControlStore.getState().revision;
    try{const result=await window.codenode.goalPlanPropose(root,{kind:'goal',goalId:goal.id,modelId});
      if(useProjectStore.getState().root!==root)return;
      if(!result.ok||!result.value)throw new Error(result.error||'规划失败');
      setProposal(result.value.steps);setProposalRevision(baseRevision);setMessage(`已生成 ${result.value.steps.length} 个待审阅步骤，尚未修改 Goal。`);
    }catch(error){if(useProjectStore.getState().root===root)setMessage(String((error as Error).message||error));}
    finally{setBusy(false);}
  };
  useEffect(()=>{
    if(!autoPropose||autoProposed.current.has(goal.id))return;
    autoProposed.current.add(goal.id);onAutoProposeConsumed?.();void propose();
  },[autoPropose,goal.id]);
  const applyProposal=()=>{if(!proposal)return;void mutate(async()=>{
    const result=await window.codenode!.goalTaskBatchCreate(root,goal.id,proposal.map(step=>({ ...step,objective:`${step.objective}\n完成条件：${step.acceptance}` })),proposalRevision);
    if(result.ok)setProposal(null);return result;
  },'规划步骤已加入 Goal，可继续编辑节点和连线');};
  const runGoal=async()=>{
    if(!editable||busy||!window.codenode||!goal.tasks.length)return;
    if(useChatStore.getState().inflight.size()) {setMessage('另一个 Agent 正在运行，请等待结束后启动 Goal。');return;}
    setRunning(true);stopAfterCurrent.current=false;setMessage('正在按依赖顺序执行 Goal Task。');
    useUiStore.getState().updatePreferences({workbenchView:'conversation'});
    const attempted=new Set<string>();
    const initialContract=goalContract(goal);
    try{
      for(let index=0;index<goal.tasks.length&&!stopAfterCurrent.current;index++){
        if(useProjectStore.getState().root!==root)break;
        const before=await window.codenode.goalList(root);
        const currentGoal=before.value?.goals?.find((item:{id:string})=>item.id===goal.id) as GoalItem|undefined;
        if(!before.ok||!currentGoal||goalContract(currentGoal)!==initialContract){setMessage('Goal 的任务或验收范围已由另一会话修改，已停止后续阶段；请刷新后重新启动。');break;}
        const gate=await window.codenode.goalCanRun(root,goal.id);
        if(!gate.ok||gate.value?.decision!=='run'||!gate.value.task){setMessage(gate.value?.reason||gate.error||'当前没有可执行任务');break;}
        const next=gate.value.task as Task;
        if(attempted.has(next.id)){setMessage('任务尚未通过验收，本轮已停止继续执行；请查看节点结果。');break;}
        attempted.add(next.id);select(goal.id,next.id);
        const result=await useChatStore.getState().send(next.objective,{projectRoot:root,goalId:goal.id,taskId:next.id});
        if(useProjectStore.getState().root!==root)break;
        await refresh(root);
        const latest=await window.codenode.goalList(root);
        const current=latest.value?.goals?.find((item:{id:string})=>item.id===goal.id)?.tasks?.find((item:{id:string})=>item.id===next.id);
        if(!latest.ok||current?.status!=='completed') {setMessage(result.reply?'任务结果需复核或补充验收证据，已停止后续任务。':'任务没有完成，已停止后续任务。');break;}
      }
      const audit=await window.codenode.goalAudit(root,goal.id);
      if(audit.ok&&audit.value?.qualified&&useProjectStore.getState().root===root){
        const alreadyCompleted=audit.value.goal?.status==='completed';
        const completed=alreadyCompleted?{ok:true}:await window.codenode.goalUpdate(root,goal.id,{status:'completed'});
        setMessage(completed.ok?'Goal 的必需验收条件已满足，目标已完成。':completed.error||'目标尚待确认');
        await refresh(root);
      }
    }catch(error){setMessage(String((error as Error).message||error));}
    finally{setRunning(false);stopAfterCurrent.current=false;}
  };

  return <section className="goal-task-graph" aria-label="Goal 任务图">
    <div className="goal-task-graph-toolbar"><strong>任务图</strong><span>连线表示前置依赖；点击节点查看和编辑 Task。</span>
      <button type="button" disabled={!editable||busy} onClick={()=>void propose()}>让 Agent 规划任务</button>
      <button type="button" disabled={!editable||busy||!goal.tasks.length} onClick={()=>void runGoal()}>开始执行 Goal</button>
      {running&&<button type="button" onClick={()=>{stopAfterCurrent.current=true;setMessage('当前任务结束后停止后续阶段。');}}>停止后续阶段</button>}
    </div>
    <div className="goal-task-graph-canvas" data-testid="goal-task-graph-canvas">
      <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.5}
        nodesConnectable={editable&&!busy} nodesDraggable={editable&&!busy} edgesReconnectable={false}
        onNodesChange={(changes:NodeChange[])=>setNodes(current=>applyNodeChanges(changes.filter(change=>change.type!=='remove'),current))}
        onNodeClick={(_,node)=>select(goal.id,node.id)}
        onNodeDragStop={(_,node)=>{const current=(goal.tasks as Task[]).find(item=>item.id===node.id);if(current)void mutate(()=>window.codenode!.goalTaskUpdate(root,goal.id,node.id,{canvasPosition:node.position,expectedRevision:revision}),'位置已保存');}}
        onConnect={connect} onEdgesDelete={disconnect}>
        <Background gap={18} size={1}/><Controls showInteractive={false}/>
      </ReactFlow>
      </ReactFlowProvider>
    </div>
    {proposal&&<div className="goal-graph-proposal" aria-label="待确认的任务规划"><strong>规划预览 · {proposal.length} 步</strong><ol>{proposal.map(step=><li key={step.key}><b>{step.title}</b><span>{step.objective}</span><small>验收：{step.acceptance} · 前置：{step.dependsOn.join('、')||'无'}</small></li>)}</ol><button type="button" disabled={busy} onClick={applyProposal}>确认加入 Goal</button><button type="button" onClick={()=>setProposal(null)}>放弃规划</button></div>}
    <div className="goal-graph-create"><input aria-label="新 Task 标题" value={newTitle} onChange={event=>setNewTitle(event.target.value)} placeholder="手动增加一个任务"/><button type="button" disabled={!editable||busy||!newTitle.trim()} onClick={()=>void mutate(async()=>{const result=await window.codenode!.goalTaskCreate(root,goal.id,{title:newTitle.trim(),objective:newTitle.trim(),dependsOn:task?[task.id]:[],criteriaIds:[]});if(result.ok)setNewTitle('');return result;},'Task 已加入任务图')}>增加节点</button></div>
    {task&&<div className="goal-graph-editor" aria-label="选中任务编辑"><strong>{task.title} · {labels[task.status]||task.status}</strong><label>任务名称<input value={draftTitle} disabled={!editable||busy||task.status==='completed'||task.status==='in_progress'} onChange={event=>setDraftTitle(event.target.value)}/></label><label>任务内容<textarea value={draftObjective} disabled={!editable||busy||task.status==='completed'||task.status==='in_progress'} onChange={event=>setDraftObjective(event.target.value)} rows={3}/></label><label>写入范围（项目相对路径，逗号分隔）<input value={draftScope} disabled={!editable||busy||task.status==='completed'||task.status==='in_progress'} onChange={event=>setDraftScope(event.target.value)}/></label><fieldset className="goal-graph-criteria" disabled={!editable||busy||task.status==='completed'||task.status==='in_progress'}><legend>本节点负责的 Goal 验收条件</legend>{goal.criteria.map((criterion:{id:string;text:string})=><label key={criterion.id}><input type="checkbox" checked={draftCriteriaIds.includes(criterion.id)} onChange={event=>setDraftCriteriaIds(current=>event.target.checked?[...current,criterion.id]:current.filter(id=>id!==criterion.id))}/>{criterion.text}</label>)}<small>未勾选时，本节点的证据只证明当前阶段，不计入 Goal 总体验收。</small></fieldset><div><button type="button" disabled={!editable||busy||task.status==='completed'||task.status==='in_progress'||!draftTitle.trim()||!draftObjective.trim()} onClick={()=>void mutate(()=>window.codenode!.goalTaskUpdate(root,goal.id,task.id,{title:draftTitle,objective:draftObjective,writeScope:draftScope.split(',').map(item=>item.trim()).filter(Boolean),criteriaIds:draftCriteriaIds,expectedRevision:revision}),'节点内容已保存')}>保存节点</button><button type="button" disabled={!editable||busy||!['todo','ready'].includes(task.status)||!!task.executionStatus||!!task.runIds?.length} onClick={()=>void mutate(async()=>{const result=await window.codenode!.goalTaskDeletePlanned(root,goal.id,task.id,revision);if(result.ok)select(goal.id,null);return result;},'未执行的节点已删除')}>删除未执行节点</button></div></div>}
    {task&&<section className="goal-graph-outcome" aria-label="本阶段执行说明"><strong>这个阶段做了什么</strong>{task.lastRun?<><small>Run {task.lastRun.runId} · {labels[task.lastRun.status]||task.lastRun.status} · {new Date(task.lastRun.finishedAt).toLocaleString()}</small>{task.lastRun.summary?<pre>{task.lastRun.summary}</pre>:<p>该 Run 没有留下可展示的文字总结，请核对运行记录与验收证据。</p>}</>:<p>尚未执行。完成后会显示 Agent 的阶段总结和独立验收记录。</p>}{goal.evidence.filter((item:{taskId?:string})=>item.taskId===task.id).slice(0,5).map((item:{id:string;check:string;status:string;freshness?:{valid:boolean;reason?:string}})=><p key={item.id}>验收：{item.check} · {item.status==='passed'&&item.freshness?.valid?'当前有效':item.freshness?.reason||item.status}</p>)}</section>}
    {message&&<p role="status" className="goal-graph-message">{message}</p>}
  </section>;
}

