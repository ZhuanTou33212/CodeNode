import {useEffect,useRef,useState} from 'react';
import {useUiStore} from '../store/uiStore';
import {useProjectStore} from '../store/projectStore';
import {useSessionStore} from '../store/sessionStore';
import {useTrellisStore} from '../store/trellisStore';
import type {TrellisCliInfo,TrellisConnectPlan} from '../lib/trellisCliTypes';
export default function TrellisConnectPanel({root,active}:{root:string;active:boolean}){
  const [info,setInfo]=useState<TrellisCliInfo|null>(null),[developer,setDeveloper]=useState(''),[plan,setPlan]=useState<TrellisConnectPlan|null>(null),[preview,setPreview]=useState<{source:string;content:string;truncated:boolean}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const streaming=useSessionStore(s=>s.streaming);
  const dirty=useRef(false);
  useEffect(()=>{if(!active)return;let alive=true;const probe=()=>{setBusy(true);void window.codenode!.trellisCliInfo().then(value=>{if(alive){setInfo(value);if(!dirty.current)setDeveloper(value.settings.developer);setMessage('')}}).catch(error=>{if(alive)setMessage(String(error))}).finally(()=>{if(alive)setBusy(false)})};probe();window.addEventListener('codenode-trellis-cli-settings',probe);return()=>{alive=false;window.removeEventListener('codenode-trellis-cli-settings',probe)}},[root,active]);
  const act=async(operation:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await operation()}catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}};
  const prepare=()=>void act(async()=>{const result=await window.codenode!.trellisConnectPrepare(root,{developer});if(useProjectStore.getState().root!==root)return;if(!result.ok||!result.value)throw Error(result.error||'接入预览失败');setPlan(result.value);setPreview(null)});
  const apply=()=>void act(async()=>{if(!plan)return;const result=await window.codenode!.trellisConnectApply(root,plan.id);if(!result.ok||!result.value)throw Error(result.error||'接入失败');if(useProjectStore.getState().root===root)await useTrellisStore.getState().refresh(root,useSessionStore.getState().memoryConversationId)});
  const read=(source:string)=>void act(async()=>{if(!plan)return;const result=await window.codenode!.trellisConnectRead(root,plan.id,source);if(!result.ok||!result.value)throw Error(result.error||'预览读取失败');setPreview(result.value)});
  return <div className="task-connect">
    <p className="task-connect-status">{busy&&!info?'检测中…':info?.supported?'本机 Trellis 已就绪':'尚未连接本机工具'}</p>
    {info?.supported&&<label>开发者<input aria-label="接入开发者名称" value={developer} disabled={busy||streaming} onChange={event=>{dirty.current=true;setDeveloper(event.target.value)}} placeholder="名称"/></label>}
    <div className="task-connect-actions">{info?.supported?<><button className="task-connect-primary" disabled={busy||streaming||!developer.trim()} onClick={prepare}>生成接入预览</button><button className="task-connect-secondary" disabled={busy||streaming} onClick={()=>useUiStore.getState().openSettings('general')}>配置本机 Trellis</button></>:<button className="task-connect-primary" disabled={busy||streaming} onClick={()=>useUiStore.getState().openSettings('general')}>配置本机 Trellis</button>}</div>
    {!plan&&<details className="task-connect-help"><summary>连接帮助</summary><p>已安装？在设置中选择 CLI 或已构建的本地仓库。尚未安装？请先安装 Trellis，再连接。</p>{info?.entry&&<p>入口：{info.entry}</p>}{info?.version&&<p>{info.version}</p>}{info?.error&&<p>检测详情：{info.error}</p>}</details>}
    {plan&&<section aria-label="Trellis 接入预览"><h3>确认接入</h3><p>{plan.developer} · {plan.files.length} 个文件 · {(plan.totalBytes/1024).toFixed(1)} KB</p><p>将创建 .trellis 项目资料，现有配置保持不变。</p><details><summary>查看文件与接入范围</summary><p>仅导入项目资料，不修改其他 Agent 配置或 Git 记录。接入后请补充项目规范。</p><div className="task-connect-files">{plan.files.map(file=><button key={file.source} disabled={busy} onClick={()=>read(file.source)}>{file.source}</button>)}</div></details>{preview&&<article><strong>{preview.source}</strong>{preview.truncated&&<p>仅预览前 64 KiB。</p>}<pre>{preview.content}</pre></article>}{!!plan.diagnostics.length&&<details><summary>资料检查 · {plan.diagnostics.length} 项</summary>{plan.diagnostics.map((item,index)=><p key={index}>{item.source}：{item.error}</p>)}</details>}<button className="task-connect-primary" disabled={busy||streaming} onClick={apply}>确认导入项目资料</button></section>}
    {message&&<p role="alert">{message}</p>}
  </div>;
}