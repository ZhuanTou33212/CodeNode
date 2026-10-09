'use strict';
const fs=require('fs');
const path=require('path');
const os=require('os');
const {randomUUID,createHash}=require('crypto');
const {execFileSync}=require('child_process');
const {atomicWriteFile}=require('./atomicFile.cjs');
const {capture}=require('./backends/workspaceDiff.cjs');
const {redact}=require('./redaction.cjs');
const waitConfig=require('../config/goal.wait.json');
const FILE='goals.json';
const MAX_BYTES=8*1024*1024;
const goalStates=new Set(['active','paused','stopped','completed','archived']);
const taskStates=new Set(['todo','ready','in_progress','waiting','blocked','completed','failed','cancelled']);
const id=()=>randomUUID();
const noChange=Symbol('goalStore.noChange');
function unchanged(value){return{[noChange]:true,value};}
function paths(root){if(typeof root!=='string'||!path.isAbsolute(root)||!fs.statSync(root).isDirectory())throw new Error('需要有效的项目根目录');const dir=path.join(fs.realpathSync(root),'.codenode');return{dir,file:path.join(dir,FILE),lock:path.join(dir,FILE+'.lock')};}
function guard(target){for(const p of [target.dir,target.file,target.lock])try{if(fs.lstatSync(p).isSymbolicLink())throw new Error('Goal 存储路径不能是符号链接')}catch(e){if(e.code!=='ENOENT')throw e;}}
function empty(){return{version:1,revision:0,goals:[],decisions:[],admissions:[],settlements:[],waitObservations:[]};}
function read(root){const target=paths(root);guard(target);try{const stat=fs.statSync(target.file);if(stat.size>MAX_BYTES)throw new Error('Goal 数据超过大小限制');const value=JSON.parse(fs.readFileSync(target.file,'utf8'));if(!value||value.version!==1||!Number.isInteger(value.revision)||!Array.isArray(value.goals)||!Array.isArray(value.decisions)||!Array.isArray(value.admissions)||!Array.isArray(value.settlements))throw new Error('Goal 数据结构无效');return value;}catch(e){if(e.code==='ENOENT')return empty();throw e;}}
function mutate(root,fn){const target=paths(root);guard(target);fs.mkdirSync(target.dir,{recursive:true});let fd;try{fd=fs.openSync(target.lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('Goal 数据正在被另一操作更新，请稍后重试');throw e;}try{const data=read(root);const result=fn(data);if(result&&result[noChange])return{result:result.value,revision:data.revision};data.revision++;const text=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('Goal 数据超过大小限制');const expected=fs.existsSync(target.file)?createHash('sha256').update(fs.readFileSync(target.file)).digest('hex'):'absent';atomicWriteFile(target.file,text,'utf8',{expectedSha256:expected});return{result,revision:data.revision};}finally{if(fd!=null)fs.closeSync(fd);try{fs.unlinkSync(target.lock);}catch{}}}
function findGoal(data,goalId){const goal=data.goals.find(item=>item.id===String(goalId));if(!goal)throw new Error('Goal 不存在');return goal;}
function findTask(goal,taskId){const task=goal.tasks.find(item=>item.id===String(taskId));if(!task)throw new Error('Task 不存在');return task;}
function text(value,label,max=8000){const s=String(value||'').trim();if(!s||s.length>max)throw new Error(label+' 不能为空且不能超过 '+max+' 字符');return s;}
function criteriaList(input,revision){if(!Array.isArray(input)||input.length>100)throw new Error('验收条件必须是最多 100 项的数组');const rows=input.map(item=>typeof item==='string'?{id:id(),text:text(item,'验收条件'),required:true,revision}:{id:String(item.id||id()),text:text(item.text,'验收条件'),required:item.required!==false,revision});if(new Set(rows.map(c=>c.id)).size!==rows.length)throw new Error('验收条件 ID 不能重复');return rows;}
function createGoal(root,input={}){const now=new Date().toISOString();const criteria=criteriaList(input.criteria||[],1);if(!criteria.some(c=>c.required))throw new Error('Goal 必须至少包含一个必需验收条件');const goal={id:id(),title:text(input.title,'Goal 标题',300),objective:text(input.objective||input.title,'Goal 目标',8000),scope:String(input.scope||'').slice(0,8000),exclusions:String(input.exclusions||'').slice(0,8000),criteriaRevision:1,criteria,status:'active',stopReason:null,autoAdvanceAuthorized:waitConfig.autoAdvance.enabledByDefault===true,autoAdvanceUsedRuns:0,budget:{maxTokens:Number.isFinite(input.maxTokens)&&input.maxTokens>0?Math.floor(input.maxTokens):null,maxCostUsd:Number.isFinite(input.maxCostUsd)&&input.maxCostUsd>0?input.maxCostUsd:null,usedTokens:0,knownCostUsd:0,costUnknown:false},context:{rules:[],taskMaterial:[],confirmedExperience:[]},tasks:[],evidence:[],createdAt:now,updatedAt:now};const out=mutate(root,d=>{d.goals.unshift(goal);return goal;});return{...out.result,revision:out.revision};}
function updateGoal(root,goalId,patch={}){if(patch.status==='completed')return completeGoal(root,goalId);return mutate(root,d=>{const g=findGoal(d,goalId);if(patch.status!=null){if(!goalStates.has(patch.status))throw new Error('Goal 状态无效');const transitions={active:['paused','stopped'],paused:['active','stopped'],stopped:['archived'],completed:['archived'],archived:[]};if(patch.status!==g.status&&!transitions[g.status]?.includes(patch.status))throw new Error('Goal 状态不能从 '+g.status+' 切换到 '+patch.status);g.status=patch.status;if(patch.status==='stopped')g.stopReason=text(patch.stopReason||'用户主动停止 Goal','停止原因',2000);else if(patch.status==='active'||patch.status==='paused')g.stopReason=null;}if(patch.autoAdvanceAuthorized!==undefined){if(typeof patch.autoAdvanceAuthorized!=='boolean')throw new Error('自动推进授权必须是布尔值');g.autoAdvanceAuthorized=patch.autoAdvanceAuthorized;}for(const key of ['title','objective','scope','exclusions'])if(patch[key]!=null)g[key]=text(patch[key],'Goal '+key,key==='title'?300:8000);if(patch.criteria!=null){const revision=g.criteriaRevision+1;const criteria=criteriaList(patch.criteria,revision);if(!criteria.some(c=>c.required))throw new Error('Goal 必须至少包含一个必需验收条件');g.criteriaRevision=revision;g.criteria=criteria;for(const e of evidenceFor(d,g.id))if(e.criterionId&&!g.criteria.some(c=>c.id===e.criterionId&&c.revision===e.criterionRevision))e.invalidatedAt=new Date().toISOString();}if(patch.maxTokens!==undefined)g.budget.maxTokens=Number.isFinite(patch.maxTokens)&&patch.maxTokens>0?Math.floor(patch.maxTokens):null;if(patch.maxCostUsd!==undefined)g.budget.maxCostUsd=Number.isFinite(patch.maxCostUsd)&&patch.maxCostUsd>0?patch.maxCostUsd:null;g.updatedAt=new Date().toISOString();return g;}).result;}
function taskGraph(goal){const map=new Map(goal.tasks.map(t=>[t.id,t]));const visit=(task,stack=new Set())=>{if(stack.has(task.id))throw new Error('Task 依赖不能形成循环');stack.add(task.id);for(const dep of task.dependsOn||[]){const d=map.get(dep);if(!d)throw new Error('Task 依赖不存在：'+dep);visit(d,new Set(stack));}};for(const task of goal.tasks)visit(task);}
function safeScope(scopes,label){if(scopes.some(value=>path.isAbsolute(value)||value.split(/[\\/]/).includes('..')))throw new Error('Task '+label+'范围必须是项目相对路径');}
function canvasPoint(value){if(value==null)return null;if(!value||!Number.isFinite(value.x)||!Number.isFinite(value.y)||Math.abs(value.x)>100000||Math.abs(value.y)>100000)throw new Error('Task 画布位置无效');return{x:Math.round(value.x),y:Math.round(value.y)};}
function createTask(root,goalId,input={}){return mutate(root,d=>{
  const g=findGoal(d,goalId);if(g.status!=='active')throw new Error('只有 active Goal 可以新增 Task');
  const now=new Date().toISOString();
  const task={id:id(),title:text(input.title,'Task 标题',300),objective:text(input.objective||input.title,'Task 目标'),status:'todo',dependsOn:Array.isArray(input.dependsOn)?[...new Set(input.dependsOn.map(String))]:[],owner:String(input.owner||'main').slice(0,100),readScope:Array.isArray(input.readScope)?[...new Set(input.readScope.map(String))]:[],writeScope:Array.isArray(input.writeScope)?[...new Set(input.writeScope.map(String))]:[],criteriaIds:Array.isArray(input.criteriaIds)?[...new Set(input.criteriaIds.map(String))]:[],decisionIds:Array.isArray(input.decisionIds)?[...new Set(input.decisionIds.map(String))]:[],canvasPosition:canvasPoint(input.canvasPosition),runIds:[],runReviews:[],pendingReviewRunId:null,createdAt:now,updatedAt:now};
  safeScope(task.readScope,'读取');safeScope(task.writeScope,'写入');
  if(task.criteriaIds.some(cid=>!g.criteria.some(c=>c.id===cid)))throw new Error('Task 引用了不存在的验收条件');
  if(task.decisionIds.some(did=>!d.decisions.some(item=>item.id===did&&item.goalId===g.id)))throw new Error('Task 引用了不存在的业务决定');
  g.tasks.push(task);taskGraph(g);return task;
}).result;}
/** Persist a proposed task graph in one transaction; no partial graph is visible on failure. */
function createTaskBatch(root,goalId,steps,expectedRevision){return mutate(root,d=>{
  const g=findGoal(d,goalId);
  if(Number.isInteger(expectedRevision)&&d.revision!==expectedRevision)throw new Error('Goal 在规划期间被其他会话修改，请刷新任务图后重新确认');
  if(g.status!=='active')throw new Error('只有 active Goal 可以导入任务图');
  if(!Array.isArray(steps)||!steps.length||steps.length>30)throw new Error('一次只能导入 1 至 30 个 Task');
  const keys=steps.map(step=>String(step?.key||''));
  if(keys.some(key=>!key||key.length>80)||new Set(keys).size!==keys.length)throw new Error('规划步骤编号无效或重复');
  const ids=new Map(keys.map(key=>[key,id()]));
  const now=new Date().toISOString(),required=g.criteria.filter(c=>c.required).map(c=>c.id);
  const created=steps.map((step,index)=>{
    const deps=Array.isArray(step.dependsOn)?[...new Set(step.dependsOn.map(String))]:[];
    if(deps.some(dep=>!ids.has(dep)&&!g.tasks.some(t=>t.id===dep)))throw new Error('步骤 '+keys[index]+' 引用了不存在的前置任务');
    const task={id:ids.get(keys[index]),title:text(step.title,'Task 标题',300),objective:text(step.objective||step.title,'Task 目标'),status:'todo',dependsOn:deps.map(dep=>ids.get(dep)||dep),owner:'main',readScope:Array.isArray(step.readScope)?[...new Set(step.readScope.map(String))]:[],writeScope:Array.isArray(step.writeScope)?[...new Set(step.writeScope.map(String))]:[],criteriaIds:required,decisionIds:[],runIds:[],runReviews:[],pendingReviewRunId:null,createdAt:now,updatedAt:now};
    safeScope(task.readScope,'读取');safeScope(task.writeScope,'写入');
    return task;
  });
  g.tasks.push(...created);taskGraph(g);g.updatedAt=now;
  return created;
}).result;}
/** Planned tasks may be removed; completed or attempted tasks retain their audit trail. */
function deletePlannedTask(root,goalId,taskId,expectedRevision){return mutate(root,d=>{
  const g=findGoal(d,goalId),t=findTask(g,taskId);
  if(Number.isInteger(expectedRevision)&&d.revision!==expectedRevision)throw new Error('Goal 已由其他会话更新，请刷新后再删除');
  if(g.status!=='active'||!['todo','ready'].includes(t.status)||t.executionStatus||(t.runIds||[]).length||t.waitCondition||t.autoAdvance||(g.evidence||[]).some(e=>e.taskId===t.id)||d.admissions.some(a=>a.taskId===t.id))throw new Error('已有执行或证据的 Task 不能删除');
  if(d.decisions.some(decision=>decision.goalId===g.id&&(decision.taskIds||[]).includes(t.id)))throw new Error('该 Task 关联业务决定，不能删除');
  if(g.tasks.some(other=>other.id!==t.id&&(other.dependsOn||[]).includes(t.id)))throw new Error('先移除下游依赖连线，再删除这个 Task');
  g.tasks=g.tasks.filter(item=>item.id!==t.id);g.updatedAt=new Date().toISOString();return {id:t.id};
}).result;}
function pendingUnknownSettlement(data,goalId,taskId){return data.settlements.find(item=>item.goalId===goalId&&item.taskId===taskId&&item.status==='unknown')||null;}
function freshUnknownRunReview(root,data,goal,task){const pending=pendingUnknownSettlement(data,goal.id,task.id),snapshot=fingerprint(root);const review=(task.runReviews||[]).find(item=>item.runId===pending?.runId&&item.projectFingerprint===snapshot.hash&&item.projectSnapshotComplete===snapshot.complete);return{pending,snapshot,review};}
function requireUnknownRunReview(root,data,goal,task){
  const {pending,review}=freshUnknownRunReview(root,data,goal,task);
  if(!pending||!review)throw new Error('结果未知的 Task 必须先查看对应 Run 差异并确认复核；项目变更后需要重新查看');
  task.executionStatus='reviewed';task.pendingReviewRunId=null;
}
function buildRunReview(root,data,goal,task,runId){
  const idValue=String(runId||''),settlement=pendingUnknownSettlement(data,goal.id,task.id);
  const admission=data.admissions.find(item=>item.runId===idValue&&item.goalId===goal.id&&item.taskId===task.id);
  if(!idValue||!admission||!settlement||settlement.runId!==idValue||task.executionStatus!=='unknown')throw new Error('该 Run 不是当前等待人工复核的未知结果');
  const runStore=require('./runStore.cjs'),events=runStore.readRun(root,idValue),summary=runStore.summarizeRun(events);
  if(summary.runId!==idValue)throw new Error('找不到该 Run 的持久化记录');
  const persisted=[...events].reverse().find(event=>event.type==='backend_changes'&&event.changes&&typeof event.changes==='object');
  const rawFiles=Array.isArray(persisted?.changes?.files)?persisted.changes.files:events.filter(event=>event.type==='file_change'&&event.fileChange).map(event=>event.fileChange);
  const files=rawFiles.slice(0,200).map(file=>({path:redact(String(file.path||'')).replace(/[\\\r\n\0]/g,' ').slice(0,500),kind:['added','modified','deleted'].includes(String(file.kind||file.action))?String(file.kind||file.action):'changed',before:/^[a-f0-9]{64}$/i.test(String(file.before||''))?String(file.before):null,after:/^[a-f0-9]{64}$/i.test(String(file.after||''))?String(file.after):null}));
  const snapshot=fingerprint(root);
  return{runId:idValue,status:summary.status,state:summary.state,backend:summary.backend,startedAt:summary.startedAt,finishedAt:summary.finishedAt||settlement.finishedAt,stopReason:summary.stopReason||settlement.reason||null,changesAvailable:rawFiles.length>0||!!persisted,changesComplete:persisted?.changes?.complete===true,changeScope:String(persisted?.changes?.scope||'只展示 Run 持久化的变更路径；未保存补丁正文'),totalFiles:rawFiles.length,truncated:rawFiles.length>files.length,files,projectFingerprint:snapshot.hash,projectSnapshotComplete:snapshot.complete};
}
function runReview(root,goalId,taskId,runId){const data=read(root),goal=findGoal(data,goalId),task=findTask(goal,taskId);return buildRunReview(root,data,goal,task,runId);}
function confirmRunReview(root,goalId,taskId,runId,expectedFingerprint){return mutate(root,data=>{
  const goal=findGoal(data,goalId),task=findTask(goal,taskId),view=buildRunReview(root,data,goal,task,runId);
  if(!expectedFingerprint||String(expectedFingerprint)!==view.projectFingerprint)throw new Error('项目文件在查看差异后发生变化，请重新查看 Run 差异');
  const reviewedAt=new Date().toISOString();task.runReviews=(task.runReviews||[]).filter(item=>item.runId!==view.runId);
  task.runReviews.unshift({runId:view.runId,projectFingerprint:view.projectFingerprint,projectSnapshotComplete:view.projectSnapshotComplete,reviewedAt,reviewedBy:'user'});
  task.runReviews=task.runReviews.slice(0,10);task.updatedAt=reviewedAt;goal.updatedAt=reviewedAt;
  return{runId:view.runId,projectFingerprint:view.projectFingerprint,projectSnapshotComplete:view.projectSnapshotComplete,reviewedAt};
}).result;}
function updateTask(root,goalId,taskId,patch={}){return mutate(root,d=>{
  const g=findGoal(d,goalId),t=findTask(g,taskId);
  if(Number.isInteger(patch.expectedRevision)&&d.revision!==patch.expectedRevision)throw new Error('Goal 已由其他会话更新，请刷新后再编辑');
  const contractChange=['title','objective','owner','readScope','writeScope','criteriaIds','decisionIds','dependsOn'].some(key=>patch[key]!=null);
  if(contractChange&&(t.status==='in_progress'||t.status==='completed'||d.admissions.some(a=>a.taskId===t.id&&!a.settledAt)))throw new Error('执行中或已完成的 Task 不能直接修改任务合同；请先结束执行，必要时新增后续 Task');
  if(t.executionStatus==='unknown'&&((patch.status!=null&&!['blocked','cancelled'].includes(patch.status))||(patch.waitCondition&&patch.waitCondition!==null)))requireUnknownRunReview(root,d,g,t);
  for(const key of ['title','objective','owner'])if(patch[key]!=null)t[key]=text(patch[key],'Task '+key,8000);
  if(patch.canvasPosition!==undefined)t.canvasPosition=canvasPoint(patch.canvasPosition);
  for(const key of ['readScope','writeScope','criteriaIds','decisionIds','dependsOn'])if(patch[key]!=null){if(!Array.isArray(patch[key]))throw new Error(key+' 必须是数组');t[key]=[...new Set(patch[key].map(String))];}
  safeScope(t.readScope,'读取');safeScope(t.writeScope,'写入');
  if(t.criteriaIds.some(cid=>!g.criteria.some(c=>c.id===cid)))throw new Error('Task 引用了不存在的验收条件');
  if(t.decisionIds.some(did=>!d.decisions.some(item=>item.id===did&&item.goalId===g.id)))throw new Error('Task 引用了不存在的业务决定');
  if(patch.waitCondition!==undefined){
    if(patch.waitCondition===null)t.waitCondition=null;
    else{
      const w=patch.waitCondition;
      if(!w||typeof w!=='object'||!['external_status','time','user_input','other'].includes(w.kind))throw new Error('等待条件类型无效');
      const provider=String(w.provider||'manual');
      if(!waitConfig.providers.includes(provider))throw new Error('等待状态源无效');
      if((provider==='github-actions'||provider==='agent-eval')&&w.kind!=='external_status')throw new Error('该报告 provider 只支持 external_status 等待');
      const commitSha=String(w.commitSha||'').trim();
      if(commitSha&&!/^[0-9a-f]{40}$/i.test(commitSha))throw new Error('外部报告等待需要完整 40 位 commit SHA');
      let mode,datasetVersion;
      if(provider==='agent-eval'){
        if(!commitSha)throw new Error('Agent Eval 等待需要固定的完整 commit SHA');
        mode=String(w.mode||waitConfig.agentEval.defaultMode);
        if(!waitConfig.agentEval.modes.includes(mode))throw new Error('Agent Eval 模式无效');
        datasetVersion=text(w.datasetVersion||waitConfig.agentEval.defaultDatasetVersion,'评测数据集版本',100);
        if(!/^[A-Za-z0-9._-]+$/.test(datasetVersion))throw new Error('评测数据集版本格式无效');
        if(w.expected&&String(w.expected)!=='success')throw new Error('Agent Eval 等待状态只能是 success');
      }
      t.waitCondition={kind:w.kind,description:text(w.description,'等待条件'),expected:provider==='github-actions'||provider==='agent-eval'?'success':String(w.expected||'').slice(0,1000),nextCheckAt:w.nextCheckAt?new Date(w.nextCheckAt).toISOString():(provider==='github-actions'||provider==='agent-eval'?new Date().toISOString():null),provider,...(commitSha?{commitSha:commitSha.toLowerCase()}:{}),...(provider==='agent-eval'?{mode,datasetVersion}:{}),createdAt:new Date().toISOString(),retryCount:0};
      t.autoAdvance=null;
      t.status='waiting';
    }
  }
  if(patch.status!=null){
    if(!taskStates.has(patch.status))throw new Error('Task 状态无效');
    if(patch.status==='completed'&&!taskProof(root,g,t))throw new Error('Task 缺少当前有效的验收证据，不能标记完成');
    t.status=patch.status;
    if(t.autoAdvance&&['ready','claimed'].includes(t.autoAdvance.status))t.autoAdvance={...t.autoAdvance,status:'superseded',finishedAt:new Date().toISOString(),reason:'task_status_changed_manually'};
  }
  taskGraph(g);t.updatedAt=new Date().toISOString();return t;
}).result;}
function addDecision(root,goalId,input={}){return mutate(root,d=>{const g=findGoal(d,goalId);const decision={id:id(),question:text(input.question,'决定问题'),options:Array.isArray(input.options)?input.options.map(x=>text(x,'决定选项',500)).slice(0,20):[],taskIds:Array.isArray(input.taskIds)?input.taskIds.map(String):[],status:'open',revision:1,createdAt:new Date().toISOString(),resolvedAt:null,value:null,reason:null};if(!decision.options.length)throw new Error('至少需要一个决定选项');for(const taskId of decision.taskIds)findTask(g,taskId);d.decisions.unshift({...decision,goalId:g.id});for(const taskId of decision.taskIds){const t=findTask(g,taskId);if(!t.decisionIds.includes(decision.id))t.decisionIds.push(decision.id);}g.updatedAt=new Date().toISOString();return decision;}).result;}
function resolveDecision(root,decisionId,value,reason=''){return mutate(root,d=>{const decision=d.decisions.find(x=>x.id===String(decisionId));if(!decision)throw new Error('业务决定不存在');const answer=text(value,'决定内容',2000),detail=String(reason||'').slice(0,4000);if(decision.status==='resolved'&&decision.value===answer&&decision.reason===detail)return unchanged(decision);decision.value=answer;decision.reason=detail;decision.status='resolved';decision.revision=(Number(decision.revision)||1)+1;decision.resolvedAt=new Date().toISOString();const g=findGoal(d,decision.goalId);for(const taskId of decision.taskIds){const t=findTask(g,taskId);if(t.status==='blocked'&&t.executionStatus!=='unknown')t.status='todo';}g.updatedAt=decision.resolvedAt;return decision;}).result;}
function evidenceFor(data,goalId){return data.goals.find(g=>g.id===goalId)?.evidence||[];}
function commitOf(root){try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim()||null;}catch{return null;}}
function environment(){return{platform:process.platform,arch:process.arch,node:process.versions.node,app:require('../package.json').version};}
function fingerprint(root){const snap=capture(root);return{complete:snap.complete,hash:createHash('sha256').update(JSON.stringify([...snap.entries].sort())).digest('hex')};}
function taskProof(root,goal,task){const current=fingerprint(root),env=environment();const relevant=(goal.evidence||[]).filter(e=>e.taskId===task.id&&evidenceStatus(goal,e,current.hash,current.complete,env).valid);const required=task.criteriaIds||[];return required.length?required.every(cid=>relevant.some(e=>e.criterionId===cid)):relevant.length>0;}
function goalQualified(root,data,goal){const snap=fingerprint(root),env=environment();const criteria=(goal.criteria||[]).every(c=>!c.required||(goal.evidence||[]).some(e=>e.criterionId===c.id&&evidenceStatus(goal,e,snap.hash,snap.complete,env).valid));const tasks=(goal.tasks||[]).every(t=>t.status==='completed');const decisions=data.decisions.every(x=>x.goalId!==goal.id||x.status==='resolved');const costBudgetClear=goal.budget.maxCostUsd==null||(!goal.budget.costUnknown&&goal.budget.knownCostUsd<goal.budget.maxCostUsd);const budget=(goal.budget.maxTokens==null||goal.budget.usedTokens<goal.budget.maxTokens)&&costBudgetClear;return criteria&&tasks&&decisions&&budget;}
function recordEvidence(root,goalId,input={}){const snap=capture(root);const sourceFingerprint=createHash('sha256').update(JSON.stringify([...snap.entries].sort())).digest('hex');return mutate(root,d=>{const g=findGoal(d,goalId);const criterionId=input.criterionId?String(input.criterionId):null;const criterion=criterionId?g.criteria.find(c=>c.id===criterionId):null;if(criterionId&&!criterion)throw new Error('验收条件不存在');const taskId=input.taskId?String(input.taskId):null;const task=taskId?findTask(g,taskId):null;const e={id:id(),goalId:g.id,taskId,criterionId,criterionRevision:criterion?.revision||null,runId:String(input.runId||''),check:text(input.check||input.command,'证据检查方式'),command:input.command?String(input.command).slice(0,4000):null,status:['passed','failed','not_run','unknown'].includes(input.status)?input.status:'unknown',result:String(input.result||'').slice(0,12000),sourceFingerprint,scanComplete:snap.complete,commit:commitOf(root),environment:environment(),checkedAt:new Date().toISOString(),invalidatedAt:null};if(!e.runId)throw new Error('证据必须关联 Run');g.evidence ||= [];g.evidence.unshift(e);if(task&&!task.runIds.includes(e.runId))task.runIds.push(e.runId);if(task?.executionStatus==='completed'&&taskProof(root,g,task))task.status='completed';g.updatedAt=new Date().toISOString();return e;}).result;}
function recordRunEvidence(root,goalId,taskId,runId,verification){const data=read(root),goal=findGoal(data,goalId),task=taskId?findTask(goal,taskId):null;const criterionIds=task?.criteriaIds?.length?task.criteriaIds:goal.criteria.filter(c=>c.required).map(c=>c.id);const status=verification?.verified===true?'passed':verification?.status==='failed'?'failed':'unknown';const checks=verification?.checks||[];const command=checks.map(c=>c.command).filter(Boolean).join(' && ')||null;const result=verification?JSON.stringify({status:verification.status,scope:verification.scope,files:verification.files,checks}):'没有执行独立代码校验';const targets=criterionIds.length?criterionIds:[null];return targets.map(criterionId=>recordEvidence(root,goalId,{taskId,criterionId,runId,check:'CodeNode 独立代码校验',command,status,result}));}
function evidenceStatus(goal,evidence,hash,scanComplete,currentEnvironment=environment()){if(evidence.invalidatedAt||evidence.status!=='passed'||!evidence.scanComplete)return{valid:false,reason:'证据未通过或已显式失效'};const criterion=goal.criteria.find(c=>c.id===evidence.criterionId);if(evidence.criterionId&&(!criterion||criterion.revision!==evidence.criterionRevision))return{valid:false,reason:'验收条件已修订'};if(JSON.stringify(evidence.environment||null)!==JSON.stringify(currentEnvironment))return{valid:false,reason:'运行环境已变化'};if(!scanComplete||hash!==evidence.sourceFingerprint)return{valid:false,reason:'项目文件指纹变化或扫描不完整'};return{valid:true,reason:''};}
function goalSnapshot(root,g){const snap=capture(root);const hash=createHash('sha256').update(JSON.stringify([...snap.entries].sort())).digest('hex');const env=environment();const evidence=(g.evidence||[]).map(e=>({...e,freshness:evidenceStatus(g,e,hash,snap.complete,env)}));const criteria=g.criteria.map(c=>({...c,evidence:evidence.filter(e=>e.criterionId===c.id&&e.freshness.valid)}));const d=read(root);const openDecisions=d.decisions.filter(x=>x.goalId===g.id&&x.status==='open');const incompleteTasks=g.tasks.filter(t=>t.status!=='completed');const costBudgetUnknown=g.budget.maxCostUsd!=null&&g.budget.costUnknown;const exhausted=(g.budget.maxTokens!=null&&g.budget.usedTokens>=g.budget.maxTokens)||(g.budget.maxCostUsd!=null&&(costBudgetUnknown||g.budget.knownCostUsd>=g.budget.maxCostUsd));const qualified=!openDecisions.length&&!incompleteTasks.length&&criteria.every(c=>!c.required||c.evidence.length>0)&&!exhausted;const now=Date.now();const tasks=g.tasks.map(t=>{const pending=t.executionStatus==='unknown'?pendingUnknownSettlement(d,g.id,t.id):null;return{...t,pendingReviewRunId:pending?.runId||null,waitDue:t.status==='waiting'&&t.waitCondition?.nextCheckAt?Date.parse(t.waitCondition.nextCheckAt)<=now:false};});return{goal:g,criteria,decisions:openDecisions,tasks,evidence,budget:{...g.budget,exhausted,costBudgetUnknown},qualified,complete:g.status==='completed'&&qualified};}
function audit(root,goalId){const d=read(root),g=findGoal(d,goalId);return goalSnapshot(root,g);}
function completeGoal(root,goalId){const preview=audit(root,goalId);if(['stopped','archived'].includes(preview.goal.status))throw new Error('已停止或归档的 Goal 不能完成；请新建 Goal');if(!preview.qualified)throw new Error('Goal 尚未满足完成条件：请处理阻塞决定、未完成 Task、失效证据或预算限制');return mutate(root,d=>{const g=findGoal(d,goalId);g.status='completed';g.stopReason=null;g.completedAt=new Date().toISOString();g.updatedAt=g.completedAt;return g;}).result;}
function canRun(root,goalId,taskId){
  const d=read(root),g=findGoal(d,goalId);
  if(g.status==='stopped'||g.status==='archived'||g.status==='completed')return{decision:'stopped',reason:g.stopReason||'Goal 已停止或完成'};
  if(g.status==='paused')return{decision:'stopped',reason:'Goal 已暂停'};
  if(g.budget.maxCostUsd!=null&&g.budget.costUnknown)return{decision:'needs-user',reason:'存在费用未知的 Run，无法证明仍在费用预算内；请复核或调整预算'};
  if((g.budget.maxTokens!=null&&g.budget.usedTokens>=g.budget.maxTokens)||(g.budget.maxCostUsd!=null&&g.budget.knownCostUsd>=g.budget.maxCostUsd))return{decision:'stopped',reason:'Goal 总预算已用尽'};
  const candidates=taskId?[findTask(g,taskId)]:g.tasks.filter(t=>['todo','ready','failed','waiting'].includes(t.status)||(t.status==='completed'&&!taskProof(root,g,t)));
  for(const t of candidates){
    if(t.executionStatus==='unknown'&&!freshUnknownRunReview(root,d,g,t).review)return{decision:'needs-user',reason:'该 Task 的 Run 结果未知；请先查看差异并确认复核',task:t,runId:pendingUnknownSettlement(d,g.id,t.id)?.runId||null};
    const open=(t.decisionIds||[]).map(decisionId=>d.decisions.find(x=>x.id===decisionId)).filter(x=>x&&x.status==='open');
    if(open.length)continue;
    if((t.dependsOn||[]).some(depId=>findTask(g,depId).status!=='completed'))continue;
    if(t.status==='waiting'&&(!t.waitCondition?.nextCheckAt||Date.parse(t.waitCondition.nextCheckAt)>Date.now()))continue;
    if(['todo','ready','failed','waiting'].includes(t.status)||(t.status==='completed'&&!taskProof(root,g,t)))return{decision:'run',task:t,reason:t.status==='completed'?'Task 验收证据已失效，需要重新执行':'Task 可以运行'};
  }
  if(d.decisions.some(x=>x.goalId===g.id&&x.status==='open'))return{decision:'needs-user',reason:'存在未处理业务决定',decisions:d.decisions.filter(x=>x.goalId===g.id&&x.status==='open')};
  if(g.tasks.some(t=>t.status==='waiting'))return{decision:'wait',reason:'等待条件尚未到达',tasks:g.tasks.filter(t=>t.status==='waiting')};
  const state=audit(root,g.id);
  if(state.complete)return{decision:'complete',reason:'全部必需条件有当前有效证据'};
  if(g.tasks.length)return{decision:'idle',reason:'没有当前可执行任务，或尚缺验收证据'};
  return{decision:'idle',reason:'Goal 尚无 Task'};
}
function admit(root,goalId,taskId,runId,options={}){return mutate(root,d=>{const g=findGoal(d,goalId),t=findTask(g,taskId),normalizedRunId=String(runId||''),claimId=String(options.autoAdvanceClaimId||'');if(!normalizedRunId||normalizedRunId.length>120)throw new Error('Run ID 无效');if(d.admissions.some(a=>a.goalId===g.id&&a.taskId===t.id&&!a.settledAt))throw new Error('该 Task 已有活动 Run');if(d.admissions.some(a=>a.runId===normalizedRunId))throw new Error('Run 已关联其他 admission');if(t.autoAdvance?.status==='claimed'){if(!claimId||claimId!==t.autoAdvance.claimId)throw new Error('该 Task 已由自动推进认领，不能启动另一条 Run');if(g.autoAdvanceAuthorized!==true||g.status!=='active')throw new Error('自动推进授权已撤销或 Goal 不再 active');}else if(claimId)throw new Error('自动推进认领已失效');const verdict=canRun(root,goalId,taskId);if(verdict.decision!=='run')throw new Error('运行资格：'+verdict.decision+'；'+verdict.reason);const now=new Date().toISOString(),a={id:id(),goalId:g.id,taskId:t.id,runId:normalizedRunId,status:'running',createdAt:now,settledAt:null};d.admissions.unshift(a);if(!t.runIds.includes(normalizedRunId))t.runIds.push(normalizedRunId);if(claimId)t.autoAdvance={...t.autoAdvance,status:'started',runId:normalizedRunId,startedAt:now};else if(t.autoAdvance?.status==='ready')t.autoAdvance={...t.autoAdvance,status:'superseded',runId:normalizedRunId,finishedAt:now,reason:'manual_run_started'};t.status='in_progress';t.executionStatus='running';t.updatedAt=now;g.updatedAt=now;return a;}).result;}
function claimAutoAdvance(root,goalId,taskId,claimId){return mutate(root,d=>{const g=findGoal(d,goalId),t=findTask(g,taskId),token=String(claimId||'');if(!/^[A-Za-z0-9_-]{16,120}$/.test(token))throw new Error('自动推进认领编号无效');if(g.autoAdvanceAuthorized!==true)throw new Error('该 Goal 尚未授权自动推进');if(g.status!=='active')throw new Error('只有 active Goal 可以自动推进');const cap=Math.max(1,Math.floor(Number(waitConfig.autoAdvance.maxRunsPerGoal)||1));if((Number(g.autoAdvanceUsedRuns)||0)>=cap)throw new Error('该 Goal 已达到自动推进 Run 上限 '+cap);if(t.autoAdvance?.status!=='ready'||!t.autoAdvance.waitObservationId)throw new Error('Task 没有等待条件释放产生的一次性自动推进标记');if(d.admissions.some(a=>a.goalId===g.id&&a.taskId===t.id&&!a.settledAt))throw new Error('该 Task 已有活动 Run');const verdict=canRun(root,g.id,t.id);if(verdict.decision!=='run')throw new Error('自动推进资格：'+verdict.decision+'；'+verdict.reason);const now=new Date().toISOString();g.autoAdvanceUsedRuns=(Number(g.autoAdvanceUsedRuns)||0)+1;t.autoAdvance={...t.autoAdvance,status:'claimed',claimId:token,claimedAt:now};t.updatedAt=now;g.updatedAt=now;return{goalId:g.id,taskId:t.id,title:t.title,objective:t.objective,claimId:token,waitObservationId:t.autoAdvance.waitObservationId,claimedAt:now,usedRuns:g.autoAdvanceUsedRuns,maxRuns:cap};}).result;}
function releaseAutoAdvanceClaim(root,goalId,taskId,claimId,reason='auto_advance_request_failed'){return mutate(root,d=>{const g=findGoal(d,goalId),t=findTask(g,taskId);if(t.autoAdvance?.status!=='claimed'||t.autoAdvance.claimId!==String(claimId||''))return unchanged(false);const now=new Date().toISOString();t.autoAdvance={...t.autoAdvance,status:'failed',reason:String(reason||'auto_advance_request_failed').slice(0,500),finishedAt:now};t.updatedAt=now;g.updatedAt=now;return true;}).result;}
/** @param {any} root @param {Set<string>|string[]} [activeClaimIds] */
function reconcileAutoAdvanceClaims(root,activeClaimIds=[]){const active=new Set(activeClaimIds instanceof Set?[...activeClaimIds].map(String):Array.isArray(activeClaimIds)?activeClaimIds.map(String):[]);const data=read(root);if(!data.goals.some(g=>g.tasks.some(t=>t.autoAdvance?.status==='claimed'&&!active.has(String(t.autoAdvance.claimId)))))return{count:0,recovered:[]};return mutate(root,d=>{const now=new Date().toISOString(),recovered=[];for(const g of d.goals)for(const t of g.tasks){const claim=t.autoAdvance;if(claim?.status!=='claimed'||active.has(String(claim.claimId)))continue;t.autoAdvance={...claim,status:'failed',reason:'app_restarted_before_admission',finishedAt:now};t.updatedAt=now;g.updatedAt=now;recovered.push({goalId:g.id,taskId:t.id,claimId:claim.claimId});}return recovered.length?{count:recovered.length,recovered}:unchanged({count:0,recovered});}).result;}
function createVerifiedExperienceCandidate(root,data,goal,task,settlement,verification){
  if(settlement.status!=='completed'||verification?.verified!==true||task.status!=='completed')return null;
  const passedTests=(verification.checks||[]).filter(check=>check?.kind==='test'&&check.status==='passed'&&typeof check.command==='string'&&check.command.trim());
  if(!passedTests.length)return null;
  const snapshot=fingerprint(root),env=environment();
  const evidence=(goal.evidence||[]).filter(item=>item.taskId===task.id&&item.runId===settlement.runId&&item.status==='passed'&&evidenceStatus(goal,item,snapshot.hash,snapshot.complete,env).valid);
  if(!evidence.length||!taskProof(root,goal,task))return null;
  if((goal.context.confirmedExperience||[]).some(item=>item.sourceRunId===settlement.runId))return null;
  const files=[...new Set((verification.files||[]).filter(file=>typeof file==='string').map(file=>redact(file).replace(/[\r\n\0]/g,' ').slice(0,300)))].slice(0,8);
  const commands=[...new Set(passedTests.map(check=>redact(check.command).replace(/[\r\n\0]/g,' ').slice(0,1200)))].slice(0,3);
  if(!files.length||!commands.length)return null;
  const content='经验候选：修改 '+JSON.stringify(files)+' 后，运行 '+JSON.stringify(commands)+' 的局部测试并通过。该结论只绑定本次 Run 的文件指纹与验收条件版本；请复核它是否适用于后续同类改动。';
  const item={id:id(),content,source:'Run '+settlement.runId,revision:data.revision+1,createdAt:settlement.finishedAt,confirmed:false,generated:true,
    sourceRunId:settlement.runId,sourceTaskId:task.id,sourceFingerprint:evidence[0].sourceFingerprint,criteriaRevision:goal.criteriaRevision,evidenceIds:evidence.map(entry=>entry.id)};
  goal.context.confirmedExperience.push(item);
  return item;
}
function settle(root,runId,input={}){return mutate(root,d=>{
  const old=d.settlements.find(x=>x.runId===String(runId));if(old)return unchanged(old);
  const admission=d.admissions.find(a=>a.runId===String(runId));if(!admission)throw new Error('Run 没有关联 Goal Task');
  const g=findGoal(d,admission.goalId),t=findTask(g,admission.taskId);
  const status=['completed','failed','cancelled','blocked','waiting'].includes(input.status)?input.status:'failed';
  const record={runId:String(runId),goalId:g.id,taskId:t.id,status,usage:input.usage||null,costUsd:Number.isFinite(input.costUsd)&&input.costUsd>=0?input.costUsd:null,costKnown:input.costKnown===true,finishedAt:new Date().toISOString()};
  d.settlements.unshift(record);admission.status=status;admission.settledAt=record.finishedAt;t.executionStatus=status;t.status=status==='completed'?(taskProof(root,g,t)?'completed':'blocked'):status;t.updatedAt=record.finishedAt;if(t.autoAdvance?.status==='started'&&t.autoAdvance.runId===String(runId))t.autoAdvance={...t.autoAdvance,status:'settled',runStatus:status,finishedAt:record.finishedAt};
  if(record.usage){const prompt=Number(record.usage.prompt_tokens??record.usage.inputTokens??0);const completion=Number(record.usage.completion_tokens??record.usage.outputTokens??0);const tokens=Number(record.usage.total_tokens??record.usage.totalTokens??(prompt+completion));if(Number.isFinite(tokens)&&tokens>0)g.budget.usedTokens+=Math.floor(tokens);}
  if(record.costKnown&&record.costUsd!=null)g.budget.knownCostUsd+=record.costUsd;else g.budget.costUnknown=true;
  createVerifiedExperienceCandidate(root,d,g,t,record,input.verification);
  g.updatedAt=record.finishedAt;if(goalQualified(root,d,g))g.status='completed';return record;
}).result;}
/** @param {any} root @param {Set<string>|string[]} [activeRunIds] */
function reconcileAdmissions(root,activeRunIds=[]){
  const active=new Set(activeRunIds instanceof Set?[...activeRunIds].map(String):Array.isArray(activeRunIds)?activeRunIds.map(String):[]);
  if(!read(root).admissions.some(a=>!a.settledAt&&!active.has(String(a.runId))))return{count:0,recovered:[]};
  const recovered=mutate(root,d=>{
    const now=new Date().toISOString(),records=[];
    for(const admission of d.admissions){
      if(admission.settledAt||active.has(String(admission.runId))||d.settlements.some(s=>s.runId===String(admission.runId)))continue;
      const g=findGoal(d,admission.goalId),t=findTask(g,admission.taskId);
      const record={runId:String(admission.runId),goalId:g.id,taskId:t.id,status:'unknown',reason:'app_restarted_before_goal_settlement',usage:null,costUsd:null,costKnown:false,finishedAt:now};
      d.settlements.unshift(record);admission.status='unknown';admission.settledAt=now;t.executionStatus='unknown';t.pendingReviewRunId=String(admission.runId);t.status='blocked';if(t.autoAdvance?.status==='started'&&t.autoAdvance.runId===String(admission.runId))t.autoAdvance={...t.autoAdvance,status:'unknown',reason:'app_restarted_before_goal_settlement',finishedAt:now};t.updatedAt=now;g.budget.costUnknown=true;g.updatedAt=now;records.push(record);
    }
    return records.length?records:unchanged(records);
  }).result;
  return{count:recovered.length,recovered};
}
function addContext(root,goalId,kind,input={}){if(!['rules','taskMaterial','confirmedExperience'].includes(kind))throw new Error('Project context kind 无效');return mutate(root,d=>{const g=findGoal(d,goalId);const item={id:id(),content:text(input.content,'上下文内容',12000),source:String(input.source||'user').slice(0,500),revision:d.revision+1,createdAt:new Date().toISOString(),confirmed:kind!=='confirmedExperience'};g.context[kind].push(item);g.updatedAt=new Date().toISOString();return item;}).result;}
function confirmExperience(root,goalId,itemId){return mutate(root,d=>{const g=findGoal(d,goalId),item=g.context.confirmedExperience.find(x=>x.id===String(itemId));if(!item)throw new Error('经验候选不存在');if(item.confirmed)return unchanged(item);item.confirmed=true;item.confirmedAt=new Date().toISOString();item.confirmedBy='user';g.updatedAt=item.confirmedAt;return item;}).result;}
function contextForRole(root,goalId,taskId,role){const d=read(root),g=findGoal(d,goalId),t=taskId?findTask(g,taskId):null;const common={goal:{id:g.id,title:g.title,objective:g.objective,scope:g.scope,exclusions:g.exclusions},task:t?{id:t.id,title:t.title,objective:t.objective,readScope:t.readScope,writeScope:t.writeScope,criteriaIds:t.criteriaIds,dependsOn:t.dependsOn,waitCondition:t.waitCondition||null}:null,decisions:d.decisions.filter(x=>x.goalId===g.id&&x.status==='resolved'&&(!t||!x.taskIds.length||x.taskIds.includes(t.id))).map(x=>({id:x.id,revision:x.revision||1,question:x.question,value:x.value,reason:x.reason,resolvedAt:x.resolvedAt})),versions:{criteriaRevision:g.criteriaRevision,contextRevision:d.revision}};const selected=role==='explore'?['rules']:role==='implement'?['rules','taskMaterial','confirmedExperience']:role==='verify'||role==='review'?['rules','taskMaterial']:role==='canvas'?['rules','taskMaterial']:[];common.context=Object.fromEntries(selected.map(k=>[k,g.context[k].filter(x=>x.confirmed!==false)]));return common;}
function releaseWait(g,t,observationId,source,observedAt){t.status='ready';t.waitCondition=null;t.autoAdvance={status:'ready',waitObservationId:String(observationId),source:String(source||'wait'),readyAt:observedAt};t.updatedAt=observedAt;g.updatedAt=observedAt;}
function observeWait(root,goalId,taskId,observation){return mutate(root,d=>{const g=findGoal(d,goalId),t=findTask(g,taskId),idempotency=String(observation.id||'');if(!idempotency)throw new Error('等待观察需要稳定 id');const old=d.waitObservations.find(x=>x.id===idempotency);if(old)return unchanged(old);const now=new Date(),record={id:idempotency,goalId:g.id,taskId:t.id,condition:t.waitCondition||null,observation:redactWait(observation),observedAt:now.toISOString(),matched:observation.matched===true};d.waitObservations.unshift(record);if(t.status==='waiting'&&record.matched)releaseWait(g,t,idempotency,record.observation.source,record.observedAt);else if(t.status==='waiting'&&t.waitCondition&&t.waitCondition.kind!=='user_input'){const retryCount=(Number(t.waitCondition.retryCount)||0)+1,delayMs=Math.min(60000*Math.pow(2,Math.min(retryCount-1,6)),60*60*1000);t.waitCondition.retryCount=retryCount;t.waitCondition.nextCheckAt=new Date(now.getTime()+delayMs).toISOString();t.waitCondition.lastObservation=record.observation;t.updatedAt=record.observedAt;record.nextCheckAt=t.waitCondition.nextCheckAt;record.retryCount=retryCount;}return record;}).result;}
function releaseDueTimeWaits(root,now=Date.now()){const timestamp=Number(now),data=read(root);const due=data.goals.some(g=>g.tasks.some(t=>t.status==='waiting'&&t.waitCondition?.kind==='time'&&Date.parse(t.waitCondition.nextCheckAt||'')<=timestamp));if(!due)return[];return mutate(root,d=>{const released=[];for(const g of d.goals)for(const t of g.tasks){if(t.status!=='waiting'||t.waitCondition?.kind!=='time'||Date.parse(t.waitCondition.nextCheckAt||'')>timestamp)continue;const observedAt=new Date(timestamp).toISOString(),idempotency='time:'+t.id+':'+t.waitCondition.nextCheckAt;let observation=d.waitObservations.find(x=>x.id===idempotency);if(!observation){observation={id:idempotency,goalId:g.id,taskId:t.id,condition:t.waitCondition,observation:{source:'time-scheduler',status:'due',matched:true,revision:String(t.updatedAt)},observedAt,matched:true};d.waitObservations.unshift(observation);}releaseWait(g,t,idempotency,'time-scheduler',observedAt);released.push({goalId:g.id,taskId:t.id,waitObservationId:idempotency});}return released.length?released:unchanged(released);}).result;}
function redactWait(value){
  let detailsUrl=null;try{const parsed=new URL(String(value.detailsUrl||''));if(parsed.protocol==='https:'&&parsed.hostname==='github.com')detailsUrl=parsed.toString().slice(0,1000);}catch{}
  const raw=value.evaluation&&typeof value.evaluation==='object'?value.evaluation:null;
  const evaluation=raw?{mode:String(raw.mode||'').slice(0,20),datasetVersion:String(raw.datasetVersion||'').slice(0,100),model:redact(String(raw.model||'')).slice(0,200),total:Number.isFinite(raw.total)?raw.total:null,run:Number.isFinite(raw.run)?raw.run:null,passed:Number.isFinite(raw.passed)?raw.passed:null,failed:Number.isFinite(raw.failed)?raw.failed:null,skipped:Number.isFinite(raw.skipped)?raw.skipped:null,requiredTotal:Number.isFinite(raw.requiredTotal)?raw.requiredTotal:null,requiredPassed:Number.isFinite(raw.requiredPassed)?raw.requiredPassed:null,requiredMissing:Array.isArray(raw.requiredMissing)?raw.requiredMissing.map(item=>String(item).slice(0,100)).slice(0,50):[],exitCode:Number.isInteger(raw.exitCode)?raw.exitCode:null,dirty:raw.dirty===true,reportFile:path.basename(String(raw.reportFile||'')).slice(0,240)}:null;
  return{source:String(value.source||'').slice(0,300),status:String(value.status||'').slice(0,100),matched:value.matched===true,revision:String(value.revision||'').slice(0,200),runId:String(value.runId||'').slice(0,240),detailsUrl,checkedAt:String(value.checkedAt||'').slice(0,40),workflowCount:Number.isFinite(value.workflowCount)?value.workflowCount:null,...(evaluation?{evaluation}:{})};
}
module.exports={read,createGoal,updateGoal,createTask,createTaskBatch,deletePlannedTask,updateTask,runReview,confirmRunReview,addDecision,resolveDecision,recordEvidence,recordRunEvidence,audit,canRun,admit,claimAutoAdvance,releaseAutoAdvanceClaim,reconcileAutoAdvanceClaims,settle,reconcileAdmissions,addContext,confirmExperience,contextForRole,observeWait,releaseDueTimeWaits,evidenceStatus,environment,fingerprint};
