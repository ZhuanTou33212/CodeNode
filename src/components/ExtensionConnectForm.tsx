import { useState } from 'react';
import setupConfig from '../../config/extension.setup.json';
export default function ExtensionConnectForm({root,initialKind='command',onCancel,onSaved}:{root:string;initialKind?:string;onCancel:()=>void;onSaved:(message:string)=>void}) {
  const [mode,setMode]=useState<'form'|'import'>('form');
  const [kind,setKind]=useState(initialKind);const [transport,setTransport]=useState('stdio');
  const [name,setName]=useState('');const [description,setDescription]=useState('');
  const [command,setCommand]=useState('');const [url,setUrl]=useState('');const [instructions,setInstructions]=useState('');
  const [readOnly,setReadOnly]=useState(false);const [json,setJson]=useState('');
  const [parameters,setParameters]=useState('');const [environment,setEnvironment]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const submit=async(event:React.FormEvent) => {
    event.preventDefault();setError('');
    let input:unknown;
    try {
      if(mode==='import') input=JSON.parse(json);
      else {
        if(!name.trim())throw new Error('请填写扩展名称');
        input={name:name.trim(),kind:kind==='command'?'项目扩展':kind,description:description.trim(),enabled:true,readOnly,
          ...(kind==='skills'?{instructions}:kind==='mcp'&&transport==='http'?{url,transport:'http'}:{command:command.trim()}),
          ...(parameters.trim()?{parameters:JSON.parse(parameters)}:{}),...(kind==='mcp'&&environment.trim()?{env:JSON.parse(environment)}:{})};
      }
    }catch(error){setError(error instanceof Error?error.message:String(error));return;}
    setBusy(true);
    try {
      const result=await window.codenode!.addExtensions(root,input);
      if(!result.ok)throw new Error(result.error||'接入失败');
      const tools=(result.added||[]).reduce((count,item)=>count+item.toolCount,0);
      onSaved('已接入 '+(result.added||[]).map(item=>item.name).join('、')+(tools?'，发现 '+tools+' 个 MCP 工具':''));
    }catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  return <form className="extension-connect" aria-label="接入项目扩展" onSubmit={submit}>
    <div className="extension-connect-head"><div><h3>接入项目扩展</h3><p>保存到当前项目，已有扩展会保留。</p></div><button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
    <div className="extension-connect-modes"><button type="button" disabled={busy} aria-pressed={mode==='form'} onClick={()=>{setMode('form');setError('')}}>填写信息</button><button type="button" disabled={busy} aria-pressed={mode==='import'} onClick={()=>{setMode('import');setError('')}}>粘贴 / 导入配置</button></div>
    {mode==='import'?<><label className="extension-field"><span>扩展配置</span><textarea aria-label="扩展配置" value={json} disabled={busy} onChange={event=>setJson(event.target.value)} placeholder="粘贴扩展 JSON 或 mcpServers 配置" rows={9}/></label><label className="extension-file-import">选择 JSON 文件<input type="file" accept=".json,application/json" disabled={busy} onChange={async event=>{const file=event.target.files?.[0];if(file){try{if(file.size>setupConfig.maxImportBytes)throw Error('配置文件过大');setJson(await file.text());setError('')}catch(error){setError(String(error))}}}}/></label><p className="extension-connect-note">MCP 配置会连接服务并自动发现工具；其他扩展只保存配置。</p></>:
      <><div className="extension-field-grid"><label className="extension-field"><span>扩展类型</span><select aria-label="扩展类型" value={kind} disabled={busy} onChange={event=>setKind(event.target.value)}>{setupConfig.types.map(type=><option value={type.id} key={type.id}>{type.label}</option>)}</select></label><label className="extension-field"><span>名称</span><input aria-label="扩展名称" value={name} disabled={busy} onChange={event=>setName(event.target.value)} placeholder="例如 project-helper"/></label></div>
      <label className="extension-field"><span>用途说明</span><input aria-label="扩展用途" value={description} disabled={busy} onChange={event=>setDescription(event.target.value)} placeholder="告诉 Agent 这个扩展可以做什么"/></label>
      {kind==='mcp'&&<label className="extension-field"><span>连接方式</span><select aria-label="MCP 连接方式" value={transport} disabled={busy} onChange={event=>setTransport(event.target.value)}><option value="stdio">本地启动命令</option><option value="http">HTTP 服务地址</option></select></label>}
      {kind==='skills'?<label className="extension-field"><span>Skill 指令</span><textarea aria-label="Skill 指令" rows={7} value={instructions} disabled={busy} onChange={event=>setInstructions(event.target.value)} placeholder="填写 Agent 执行此任务时应遵循的指令"/></label>:kind==='mcp'&&transport==='http'?<label className="extension-field"><span>服务地址</span><input aria-label="MCP 服务地址" type="url" value={url} disabled={busy} onChange={event=>setUrl(event.target.value)} placeholder="https://example.com/mcp"/></label>:<label className="extension-field"><span>启动命令</span><input aria-label="扩展启动命令" value={command} disabled={busy} onChange={event=>setCommand(event.target.value)} placeholder='例如 node tools/helper.cjs，含空格的路径请加双引号'/></label>}
      {kind==='mcp'&&<p className="extension-connect-note">点击接入后会启动或连接 MCP 服务，自动获取工具名称和参数。</p>}
      {kind!=='skills'&&<details className="extension-advanced"><summary>高级选项</summary><label className="extension-readonly"><input type="checkbox" checked={readOnly} disabled={busy} onChange={event=>setReadOnly(event.target.checked)}/>声明为只读工具</label>{kind==='mcp'&&transport==='stdio'&&<label className="extension-field"><span>环境变量（可选 JSON）</span><textarea aria-label="MCP 环境变量" rows={4} value={environment} disabled={busy} onChange={event=>setEnvironment(event.target.value)} placeholder='例如 {"API_TOKEN":"你的令牌"}'/></label>}{kind==='command'&&<label className="extension-field"><span>参数结构（可选 JSON Schema）</span><textarea rows={4} value={parameters} disabled={busy} onChange={event=>setParameters(event.target.value)} placeholder='留空时使用默认参数结构'/></label>}</details>}
      </>}
    {error&&<p className="extension-connect-error" role="alert">{error}</p>}
    <div className="extension-connect-footer"><span role="status">{busy?'正在接入，请稍候…':''}</span><button type="submit" disabled={busy}>{busy?'接入中…':mode==='import'?'导入并接入':kind==='mcp'?'连接并接入':'保存扩展'}</button></div>
  </form>;
}
