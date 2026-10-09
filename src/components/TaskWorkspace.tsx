import { useEffect, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useTrellisStore } from '../store/trellisStore';
import TrellisWritePanel from './TrellisWritePanel';
import { useUiStore } from '../store/uiStore';
import TrellisConnectPanel from './TrellisConnectPanel';
const labels:Record<string,string>={planning:'待规划',in_progress:'进行中',completed:'已完成',blocked:'受阻',cancelled:'已取消'};
export default function TaskWorkspace({hidden}:{hidden:boolean}) {
  const root=useProjectStore(s=>s.root),conversation=useSessionStore(s=>s.memoryConversationId),streaming=useSessionStore(s=>s.streaming);
  const {root:storeRoot,project:rawProject,context:rawContext,viewed,loading,busy,error,refresh,view,bind}=useTrellisStore();
  const project=storeRoot===root?rawProject:null,context=storeRoot===root?rawContext:null;
  const navigationOpen=useUiStore(s=>s.navigationOpen),navigationWidth=useUiStore(s=>s.navigationWidth);
  const [search,setSearch]=useState(''),[section,setSection]=useState('materials'),[document,setDocument]=useState('');
  useEffect(()=>{if(root)void refresh(root,conversation)},[root,conversation,streaming,refresh]);
  useEffect(()=>{setSearch('');setSection('materials');setDocument('')},[root]);
  const task=project?.tasks.find(task=>task.taskPath===viewed),docs=context?.documents||[];
  const selected=docs.find(doc=>doc.source===document)||docs.find(doc=>doc.source.endsWith('/prd.md'))||docs[0];
  const bound=project?.selectedTask===viewed;
  return <section className="task-workspace" aria-label="任务工作区" hidden={hidden} inert={hidden} style={{'--task-nav-width':navigationWidth+'px'} as CSSProperties}>
    <aside hidden={!navigationOpen} className="task-navigation" aria-label="任务列表"><div className="task-nav-heading"><h2>任务</h2><span>{project?.tasks.length||0}</span></div><p className="task-project-name">{root?.replace(/\\/g,'/').split('/').pop()}</p><input aria-label="搜索任务" placeholder="搜索任务名称或 ID" value={search} onChange={event=>setSearch(event.target.value)}/><div className="task-list">{project?.tasks.filter(task=>(task.title+' '+task.id).toLowerCase().includes(search.toLowerCase())).map(task=><button key={task.taskPath} className="task-list-item" aria-label={'查看任务 '+task.title} aria-current={viewed===task.taskPath?'true':undefined} onClick={()=>void view(task.taskPath)}><strong>{task.title}</strong><span>{labels[task.status]||task.status}{project.selectedTask===task.taskPath?' · 当前对话':''}</span></button>)}</div><button className="task-refresh" disabled={loading||busy} onClick={()=>root&&void refresh(root,conversation)}>刷新任务</button></aside>
    <main className="task-detail"><header className="task-page-heading"><div><span className="task-eyebrow">项目任务 · Trellis</span><h1>{task?.title||'项目任务'}</h1><p>{task?(labels[task.status]||task.status)+' · '+task.id:'在这里管理需求、规范、运行证据和工作日志'}</p></div>{(task||project?.selectedTask)&&<button className="task-bind" disabled={busy||loading||streaming} onClick={()=>void bind(!task||bound?null:task.taskPath)}>{!task?'解除失效绑定':bound?'解除对话绑定':'绑定到当前对话'}</button>}</header>
      {error&&<p role="alert" className="task-diagnostic">{error}</p>}
      {project&&!project.detected&&<div className="task-empty"><span aria-hidden="true">☷</span><h2>这个项目还没有接入 Trellis</h2><p>打开一个已有 Trellis 的项目，即可在这里查看任务和规范。</p>{root&&<TrellisConnectPanel key={root} root={root} active={!hidden}/>}</div>}
      {project?.detected&&!project.tasks.length&&<div className="task-empty"><h2>还没有可读取的任务</h2><p>请在 Trellis 中创建任务，或检查结构诊断后刷新。</p></div>}
      {loading&&!context&&<p role="status">正在读取任务资料…</p>}{project?.diagnostics.map((item,index)=><p className="task-diagnostic" role="alert" key={index}>{item.source}：{item.error}</p>)}
      {context&&task&&<><nav className="task-sections" aria-label="任务内容"><button aria-pressed={section==='materials'} onClick={()=>setSection('materials')}>需求与规范</button><button aria-pressed={section==='runs'} onClick={()=>setSection('runs')}>运行与证据 <span>{context.runs.length}</span></button><button aria-pressed={section==='actions'} onClick={()=>setSection('actions')}>状态与工作日志</button></nav>
      {!context.ready&&<div className="task-diagnostic" role="alert"><strong>任务资料需要修复</strong>{context.diagnostics.map((item,index)=><p key={index}>{item.source}：{item.error}</p>)}</div>}
      <div className="task-materials" hidden={section!=='materials'}><nav aria-label="任务资料">{docs.map(doc=><button key={doc.source} aria-current={selected?.source===doc.source?'true':undefined} onClick={()=>setDocument(doc.source)}><strong>{doc.source.endsWith('/prd.md')?'需求说明 · PRD':doc.source.split('/').pop()}</strong><small>{doc.source}</small></button>)}</nav><article className="task-document"><header><h2>{selected?.source.endsWith('/prd.md')?'需求说明':selected?.source.split('/').pop()}</h2><p>{selected?.source}</p></header><pre>{selected?.content}</pre><details><summary>资料版本与角色范围</summary><p>SHA-256：{selected?.fingerprint}</p><p>适用阶段：{selected?.stages.join('、')}</p></details></article></div>
      <section className="task-runs" hidden={section!=='runs'} aria-label="运行与证据"><h2>关联运行</h2><p>阶段结束不自动完成任务；局部检查不代表全部需求验收通过。</p>{!context.runs.length&&<div className="task-empty"><h3>尚未执行</h3><p>绑定当前对话后可发送任务，或生成画布流程。</p></div>}{context.runs.map(run=><article key={run.runId}><h3>{run.runId}</h3><p>{run.status} · 检查：{run.verification?.status||'未执行'} · {run.evidenceFresh?'证据版本一致':'尚无有效版本证据'}</p>{!!run.sourcesChanged.length&&<p role="alert">任务资料已变化：{run.sourcesChanged.join('、')}</p>}{run.verification&&<pre>{JSON.stringify(run.verification,null,2)}</pre>}</article>)}</section>
      <div hidden={section!=='actions'}>{root&&<TrellisWritePanel key={root+task.taskPath} root={root} context={context} disabled={busy||loading||streaming} reload={()=>void refresh(root!,conversation)}/>}</div></>}
    </main>
  </section>;
}
