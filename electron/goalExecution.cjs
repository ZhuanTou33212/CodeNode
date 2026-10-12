'use strict';
const {createHash}=require('node:crypto');
const waitConfig=require('../config/goal.wait.json');

// Runtime status, canvas positions and evidence do not change the authorized graph.
function contract(goal){
  return createHash('sha256').update(JSON.stringify({objective:goal.objective,scope:goal.scope,exclusions:goal.exclusions,criteria:goal.criteria,
    tasks:goal.tasks.map(t=>({id:t.id,title:t.title,objective:t.objective,owner:t.owner,dependsOn:t.dependsOn,readScope:t.readScope,writeScope:t.writeScope,criteriaIds:t.criteriaIds,decisionIds:t.decisionIds}))})).digest('hex');
}

function plan(data,goal,canRun,audit){
  const execution=goal.execution;
  if(!execution||['stopped','blocked','completed'].includes(execution.status))return{decision:'idle',reason:'没有可推进的执行记录'};
  const active=data.admissions.some(a=>a.goalId===goal.id&&!a.settledAt);
  if(execution.status==='stopping')return active?{decision:'idle',reason:'当前任务结束后停止'}:{decision:'stopped',reason:'用户已停止后续阶段'};
  if(goal.status==='paused')return{decision:'waiting',reason:'Goal 已暂停'};
  if(['stopped','archived'].includes(goal.status))return{decision:'stopped',reason:'Goal 已停止或归档'};
  if(contract(goal)!==execution.contract)return{decision:'blocked',reason:'Goal 的任务或验收范围已由另一会话修改，请检查后重新开始'};
  if(active)return{decision:'idle',reason:'当前任务正在运行'};
  const current=goal.tasks.find(t=>t.id===execution.currentTaskId);
  let pendingWaitReason=null,pendingBlockedReason=null;
  if(current?.autoAdvance?.source==='goal-execution'&&current.autoAdvance.executionId===execution.id){
    if(['claimed','started'].includes(current.autoAdvance.status))return{decision:'idle',reason:'当前任务已认领，等待运行结算'};
    if(current.autoAdvance.status==='failed')return{decision:'blocked',reason:'任务未成功派发，请检查后重新开始'};
  }
  if(current?.executionStatus==='unknown')return{decision:'blocked',reason:'当前 Run 结果未知，请先复核'};
  if(current&&['failed','cancelled'].includes(current.status))return{decision:'blocked',reason:'当前任务失败或已取消，请复核后重新开始'};
  if(current?.status==='blocked'){
    if(current.executionStatus!=='completed')return{decision:'blocked',actionRequired:true,reason:'当前任务需要复核'};
    pendingWaitReason='任务执行已结束，等待本阶段或逐条验收证据';
  }
  const waited=new Set(execution.waitedTaskIds||[]);
  const waiting=goal.tasks.filter(t=>t.status==='waiting');
  const waitingTaskIds=waiting.map(t=>t.id);
  for(const task of goal.tasks){
    if(['completed','waiting','in_progress','blocked','cancelled'].includes(task.status))continue;
    if((execution.attemptedTaskIds||[]).includes(task.id))return{decision:'blocked',reason:'本次执行已尝试该任务，不会自动重试'};
    const gate=canRun(task.id);
    if(gate.decision==='run'){
      const releasedDuringExecution=task.autoAdvance?.waitObservationId&&Date.parse(task.autoAdvance.readyAt)>=Date.parse(execution.startedAt);
      if((waited.has(task.id)||releasedDuringExecution)&&goal.autoAdvanceAuthorized!==true){pendingWaitReason='等待条件已满足；请授权等待后自动推进或重新开始执行';continue;}
      if((waited.has(task.id)||releasedDuringExecution)&&(Number(goal.autoAdvanceUsedRuns)||0)>=Math.max(1,Math.floor(Number(waitConfig.autoAdvance.maxRunsPerGoal)||1))){pendingBlockedReason='等待后自动推进尝试次数已达到 Goal 上限';continue;}
      return{decision:'run',reason:'按依赖执行下一任务',task,waitingTaskIds};
    }
    if(gate.decision==='needs-user'&&gate.reason==='存在未处理业务决定')continue;
    if(['needs-user','stopped'].includes(gate.decision))return{decision:'blocked',reason:gate.reason};
  }
  if(pendingBlockedReason)return{decision:'blocked',reason:pendingBlockedReason};
  if(pendingWaitReason)return{decision:'waiting',actionRequired:true,reason:pendingWaitReason,waitingTaskIds};
  if(waiting.length)return{decision:'waiting',reason:'等待条件尚未满足',waitingTaskIds};
  const checked=audit();
  if(checked.qualified)return{decision:'completed',reason:'全部必需验收条件已满足'};
  if(checked.budget?.exhausted)return{decision:'blocked',reason:checked.budget.tokenBudgetUnknown?'存在 Token 用量未知的 Run，请复核后记录累计用量':checked.budget.costBudgetUnknown?'存在费用未知的 Run，请复核费用或调整预算':'Goal 总预算已用尽，请检查后调整预算'};
  return{decision:'waiting',actionRequired:true,reason:'等待业务决定、未完成任务或有效验收证据'};
}
module.exports={contract,plan};
