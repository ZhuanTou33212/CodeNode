'use strict';

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

function messages(input) {
  const goal=String(input.objective||'').trim();
  if(!goal||goal.length>8000)throw new Error('请提供不超过 8000 字的规划目标');
  const context=String(input.context||'').slice(0,10000);
  return [
    {role:'system',content:'你是 CodeNode 的只读规划器。只输出一个 JSON 对象，不调用工具，也不声称已修改文件。格式：{"steps":[{"key":"step-1","title":"短标题","objective":"具体任务","acceptance":"可核对的完成条件","dependsOn":[],"writeScope":[]}]}. 依赖只引用同一数组内的 key，形成无环图。任务应是用户能审阅和修改的有限步骤；写入范围使用项目相对路径，不确定时留空。不要把规划当成已经完成的工作。'},
    {role:'user',content:`目标：${goal}\n\n约束与已有上下文：${context||'无'}\n\n请规划 2 至 12 个清晰步骤，必要时可以更少。只返回 JSON。`},
  ];
}
module.exports={parseProposal,messages};
