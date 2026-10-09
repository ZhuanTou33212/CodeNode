'use strict';
const fs=require('node:fs'),path=require('node:path');

function projectOutline(root) {
  const entries=[],skip=new Set(['.git','.codenode','.cache','node_modules','release','out','dist']);
  const visit=(dir,prefix,depth)=>{
    if(depth>2||entries.length>=100)return;
    let children;try{children=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const child of children.sort((a,b)=>a.name.localeCompare(b.name))){
      if(entries.length>=100)break;
      if(skip.has(child.name)||child.name.startsWith('.stage-')||child.isSymbolicLink())continue;
      const rel=prefix?prefix+'/'+child.name:child.name;
      entries.push(rel+(child.isDirectory()?'/':''));
      if(child.isDirectory())visit(path.join(dir,child.name),rel,depth+1);
    }
  };
  visit(root,'',0);return entries.join('\n').slice(0,9000);
}

/** A model proposal is untrusted data. It never writes a Goal or runs a Task. */
function parseProposal(content) {
  const raw=String(content||'').trim();
  const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
  if(first<0||last<=first||last-first>50000)throw new Error('规划模型没有返回有效的任务图 JSON');
  let value;try{value=JSON.parse(raw.slice(first,last+1));}catch{throw new Error('规划模型返回的 JSON 无法解析，请重试');}
  if(!value||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>30)throw new Error('规划需包含 1 至 30 个步骤');
  const steps=value.steps.map((step,index)=>{
    const key=String(step?.key||`step-${index+1}`).trim(),title=String(step?.title||'').trim(),objective=String(step?.objective||title).trim();
    const acceptance=String(step?.acceptance||'').trim();
    if(!key||key.length>80||!title||title.length>300||!objective||objective.length>8000||!acceptance||acceptance.length>1000)throw new Error('步骤编号、标题、任务内容或完成条件无效');
    const dependsOn=Array.isArray(step.dependsOn)?[...new Set(step.dependsOn.map(String))]:[];
    if(dependsOn.length>30)throw new Error('步骤依赖过多');
    const writeScope=Array.isArray(step.writeScope)?[...new Set(step.writeScope.map(String).filter(Boolean))]:[];
    if(writeScope.length>30||writeScope.some(scope=>scope.length>500||/^[a-zA-Z]:[\\/]/.test(scope)||scope.startsWith('/')||scope.split(/[\\/]/).includes('..')))throw new Error('步骤写入范围无效');
    return {key,title,objective,acceptance,dependsOn,writeScope};
  });
  const keys=new Set(steps.map(step=>step.key));
  if(keys.size!==steps.length)throw new Error('规划步骤编号重复');
  const byKey=new Map(steps.map(step=>[step.key,step]));
  const visiting=new Set(),seen=new Set();
  const visit=(key)=>{if(visiting.has(key))throw new Error('规划步骤存在循环依赖');if(seen.has(key))return;visiting.add(key);for(const dep of byKey.get(key).dependsOn){if(!keys.has(dep))throw new Error('规划步骤引用了不存在的依赖：'+dep);visit(dep);}visiting.delete(key);seen.add(key);};
  for(const key of keys)visit(key);
  return {steps};
}

function withGoalAcceptanceStep(proposal) {
  const steps=proposal.steps.map(step=>({...step,dependsOn:[...step.dependsOn]}));
  if(steps.length<2)return {steps};
  const final=steps[steps.length-1],prior=steps.slice(0,-1);
  if(prior.some(step=>step.dependsOn.includes(final.key)))throw new Error('目标的最后一步必须是验收节点，请重新规划');
  const depended=new Set(prior.flatMap(step=>step.dependsOn));
  const leaves=prior.filter(step=>!depended.has(step.key)).map(step=>step.key);
  final.dependsOn=[...new Set([...final.dependsOn,...leaves])];
  return {steps};
}

function messages(input) {
  const goal=String(input.objective||'').trim();
  if(!goal||goal.length>8000)throw new Error('请提供不超过 8000 字的规划目标');
  const context=String(input.context||'').slice(0,10000);
  return [
    {role:'system',content:'你是 CodeNode 的只读规划器。只输出一个 JSON 对象，不调用工具，也不声称已修改文件。格式：{"steps":[{"key":"step-1","title":"短标题","objective":"具体任务","acceptance":"可核对的完成条件","dependsOn":[],"writeScope":[]}]}. 依赖只引用同一数组内的 key，形成无环图。任务应是用户能审阅和修改的有限步骤；写入范围使用项目相对路径，不确定时留空。最后一步应负责独立验收整个目标，依赖前面所有分支的末端任务。不要把规划当成已经完成的工作。'},
    {role:'user',content:`目标：${goal}\n\n约束与已有上下文：${context||'无'}\n\n请规划 2 至 12 个清晰步骤，必要时可以更少。只返回 JSON。`},
  ];
}
module.exports={parseProposal,withGoalAcceptanceStep,messages,projectOutline};
