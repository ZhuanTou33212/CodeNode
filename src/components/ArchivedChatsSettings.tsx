import { useEffect,useRef,useState } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useProjectStore } from '../store/projectStore';
import { saveProject } from '../lib/projectActions';
type DeleteSelection={ids:string[];labels:string[]};
export default function ArchivedChatsSettings(){
  const {sessions,order,streaming,setArchived,deleteArchivedSessions}=useSessionStore();
  const [selected,setSelected]=useState<string[]>([]);
  const [pending,setPending]=useState<DeleteSelection|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const projectRoot=useProjectStore(s=>s.root),projectFile=useProjectStore(s=>s.projectFile);
  const archived=order.filter(id=>sessions[id]?.archived),allSelected=archived.length>0&&archived.every(id=>selected.includes(id));
  const all=useRef<HTMLInputElement>(null),cancel=useRef<HTMLButtonElement>(null);
  useEffect(()=>{setPending(null);setSelected([]);setError('')},[projectRoot,projectFile]);
  useEffect(()=>{if(pending)cancel.current?.focus()},[pending]);
  useEffect(()=>{if(all.current)all.current.indeterminate=selected.length>0&&!allSelected},[selected,allSelected]);
  useEffect(()=>{if(!busy)setSelected(current=>{const next=current.filter(id=>sessions[id]?.archived);return next.length===current.length?current:next})},[sessions,busy]);
  const ask=(ids:string[])=>{setPending({ids:[...ids],labels:ids.map(id=>sessions[id]?.label||'此聊天')});setError('')};
  const remove=async()=>{
    if(!pending||busy||streaming)return;
    const ids=pending.ids,state=useSessionStore.getState();
    const originals=Object.fromEntries(ids.map(id=>[id,state.sessions[id]])),plans=Object.fromEntries(ids.filter(id=>state.plansBySessionId[id]).map(id=>[id,state.plansBySessionId[id]]));
    const project=useProjectStore.getState(),key=project.root+'|'+project.projectFile;
    if(!deleteArchivedSessions(ids)){setError('所选聊天的状态已变化，请等运行结束后重新选择');return;}
    setBusy(true);setError('');
    const saved=await saveProject();
    if(!saved){
      const current=useProjectStore.getState();
      if(current.root+'|'+current.projectFile===key)useSessionStore.setState(next=>{
        const restored={...next.sessions,...originals},updated=[...state.order.filter(id=>!!restored[id]),...next.order.filter(id=>!state.order.includes(id))];
        return {sessions:restored,order:updated,plansBySessionId:{...next.plansBySessionId,...plans},...(!next.activeId?{messages:state.messages,memoryConversationId:state.memoryConversationId,memoryTaskEpoch:state.memoryTaskEpoch}: {})};
      });
      setError('删除未能保存，所选聊天已全部保留。请检查保存错误后重试');
    }else{setSelected(current=>current.filter(id=>!ids.includes(id)));setPending(null);}
    setBusy(false);
  };
  return <><h2>已归档聊天</h2>{!archived.length?<p className="archive-empty">暂无归档聊天</p>:<div className="archive-bulk-toolbar"><label><input ref={all} type="checkbox" aria-label="全选归档聊天" checked={allSelected} disabled={busy||streaming} onChange={event=>setSelected(event.target.checked?[...archived]:[])}/>全选</label><span aria-live="polite">已选 {selected.length} / {archived.length}</span>{selected.length>0&&<button disabled={busy} onClick={()=>setSelected([])}>取消选择</button>}<button className="archive-delete" aria-label="删除选中的归档聊天" disabled={!selected.length||busy||streaming} onClick={()=>ask(selected)}>删除所选（{selected.length}）</button></div>}
  {archived.map(id=><div className="settings-row archived-chat-row" key={id}><label className="archived-chat-choice"><input type="checkbox" aria-label={'选择 '+sessions[id].label} checked={selected.includes(id)} disabled={busy||streaming} onChange={event=>setSelected(current=>event.target.checked?[...current,id]:current.filter(item=>item!==id))}/><span>{sessions[id].label}</span></label><div className="archived-chat-actions"><button disabled={streaming||busy} onClick={()=>{setArchived(id,false);void saveProject()}}>恢复</button><button className="archive-delete" disabled={streaming||busy} aria-label={'删除 '+sessions[id].label} onClick={()=>ask([id])}>删除</button></div></div>)}
  {pending&&<div className="archive-delete-mask"><section className="archive-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-delete-title" aria-describedby="archive-delete-description" onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();if(!busy)setPending(null)}
    if(event.key==='Tab'){event.stopPropagation();const controls=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];if(!controls.length){event.preventDefault();return}const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
  }}><h3 id="archive-delete-title">{pending.ids.length>1?'永久删除 '+pending.ids.length+' 个聊天？':'永久删除聊天？'}</h3><p id="archive-delete-description">{pending.ids.length>1?'所选 '+pending.ids.length+' 个聊天（'+pending.labels.slice(0,3).join('、')+(pending.ids.length>3?'等':'')+'）':'“'+pending.labels[0]+'”'}的聊天记录及关联画布将从项目中删除，无法通过恢复归档找回。</p>{error&&<p className="archive-delete-error" role="alert">{error}</p>}<div><button ref={cancel} disabled={busy} onClick={()=>setPending(null)}>取消</button><button className="archive-delete" disabled={busy||streaming} onClick={()=>void remove()}>{busy?'删除中…':'永久删除'}</button></div></section></div>}</>;
}
