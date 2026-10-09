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
  return <div className="task-connect"><h3>使用本机 Trellis 接入</h3><p>{busy&&!info?'正在检测本机安装…':info?.supported?'已检测到 '+info.version:'未找到可用的 Trellis CLI'}</p>{info?.entry&&<small>{info.entry}</small>}
    {info?.supported?<><label>开发者名称<input aria-label="接入开发者名称" value={developer} disabled={busy||streaming} onChange={event=>{dirty.current=true;setDeveloper(event.target.value)}} placeholder="例如：alice"/></label><button disabled={busy||streaming||!developer.trim()} onClick={prepare}>生成接入预览</button></>:<p>如果已经安装但未检测到，可在设置中指定路径；本地源码仓库需要先完成构建。尚未安装时可按 Trellis 官方说明安装，再重新检测。</p>}
    {info&&!info.supported&&info.error&&<p className="settings-scope">{info.error}</p>}
    <button disabled={busy||streaming} onClick={()=>useUiStore.getState().openSettings('general')}>配置本机 Trellis</button>
    {plan&&<section aria-label="Trellis 接入预览"><h3>确认接入当前项目</h3><p>开发者：{plan.developer} · 将创建 .trellis · {plan.files.length} 个文件 · {(plan.totalBytes/1024).toFixed(1)} KB</p><p>仅导入项目资料，不覆盖已有 .trellis，也不修改 AGENTS.md、其他 Agent 配置或 Git 记录。规范模板接入后需按项目补充。</p><details><summary>查看生成的文件</summary><div className="task-connect-files">{plan.files.map(file=><button key={file.source} disabled={busy} onClick={()=>read(file.source)}>{file.source}</button>)}</div></details>{preview&&<article><strong>{preview.source}</strong>{preview.truncated&&<p>仅预览文件前 64 KiB。</p>}<pre>{preview.content}</pre></article>}{plan.diagnostics.map((item,index)=><p role="status" key={index}>{item.source}：{item.error}</p>)}<button disabled={busy||streaming} onClick={apply}>确认导入项目资料</button></section>}
    {message&&<p role="alert">{message}</p>}
  </div>;
}
