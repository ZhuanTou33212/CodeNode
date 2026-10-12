'use strict';
const limits=require('../config/goal.handoff.json');
const {redact}=require('./redaction.cjs');
function excerpt(value,max){const raw=redact(String(value||''));return{value:raw.slice(0,max),truncated:raw.length>max};}

/** Derive reference data from this Goal only; never mutate history or grant authority. */
function build(data,goal,task,freshness){
  /** @type {{schemaVersion:number,source:string,referenceOnly:boolean,currentAttempt:any,predecessors:any[],decisions:any[],omitted:{predecessors:number,decisions:number,traversalIncomplete:boolean}}} */
  const packet={schemaVersion:1,source:'.codenode/goals.json',referenceOnly:true,currentAttempt:null,predecessors:[],decisions:[],omitted:{predecessors:0,decisions:0,traversalIncomplete:false}};
  if(!task)return packet;
  const byId=new Map(goal.tasks.map(t=>[t.id,t])),seen=new Set([task.id]),ancestors=[];
  const queue=[...(task.dependsOn||[])];
  const queued=new Set([task.id,...queue]);
  for(let at=0;at<queue.length;at++){
    const taskId=queue[at];if(seen.has(taskId))continue;
    if(seen.size>limits.maxTraversalTasks){packet.omitted.traversalIncomplete=true;break;}
    seen.add(taskId);const predecessor=byId.get(taskId);
    if(!predecessor){packet.omitted.traversalIncomplete=true;continue;}
    ancestors.push(predecessor);for(const dependency of predecessor.dependsOn||[])if(!queued.has(dependency)){queued.add(dependency);queue.push(dependency);}
  }
  const latest=t=>data.settlements.find(s=>s.goalId===goal.id&&s.taskId===t.id&&(t.runIds||[]).includes(s.runId));
  const outcome=t=>{
    const run=latest(t);if(!run)return null;
    const summary=excerpt(run.summary,limits.summaryChars);
    return{runId:run.runId,status:run.status,finishedAt:run.finishedAt,summary:summary.value,summaryTruncated:summary.truncated};
  };
  packet.currentAttempt=outcome(task);
  for(const predecessor of ancestors.slice(0,limits.maxPredecessors)){
    const evidence=(goal.evidence||[]).filter(e=>e.goalId===goal.id&&e.taskId===predecessor.id&&(predecessor.runIds||[]).includes(e.runId));
    const row={taskId:predecessor.id,title:excerpt(predecessor.title,300).value,direct:(task.dependsOn||[]).includes(predecessor.id),taskStatus:predecessor.status,
      latestRun:outcome(predecessor),evidence:evidence.slice(0,limits.maxEvidencePerTask).map(e=>{
        const check=excerpt(e.check,limits.previewChars),command=excerpt(e.command,limits.previewChars),result=excerpt(e.result,limits.previewChars);
        return{id:e.id,runId:e.runId,criterionId:e.criterionId||null,status:e.status,checkedAt:e.checkedAt,check:check.value,commandPreview:command.value,resultPreview:result.value,truncated:check.truncated||command.truncated||result.truncated,freshness:freshness(e)};
      }),omittedEvidence:Math.max(0,evidence.length-limits.maxEvidencePerTask)};
    if(JSON.stringify({...packet,predecessors:[...packet.predecessors,row]}).length>limits.maxPacketChars-128)break;
    packet.predecessors.push(row);
  }
  packet.omitted.predecessors=ancestors.length-packet.predecessors.length;
  const relevant=data.decisions.filter(d=>d.goalId===goal.id&&(!(d.taskIds||[]).length||(d.taskIds||[]).some(id=>seen.has(id))));
  for(const decision of relevant.slice(0,limits.maxDecisions)){
    const question=excerpt(decision.question,limits.previewChars),answer=excerpt(decision.value,limits.previewChars),reason=excerpt(decision.reason,limits.previewChars);
    const row={id:decision.id,status:decision.status,revision:decision.revision||1,question:question.value,value:answer.value,reason:reason.value,truncated:question.truncated||answer.truncated||reason.truncated};
    if(JSON.stringify({...packet,decisions:[...packet.decisions,row]}).length>limits.maxPacketChars-128)break;
    packet.decisions.push(row);
  }
  packet.omitted.decisions=relevant.length-packet.decisions.length;
  return packet;
}
function fitContext(context,maxTokens,estimate){
  if(!(maxTokens>0))return context;
  if(estimate(JSON.stringify({...context,handoff:undefined}))>maxTokens)throw new Error('Goal 必要上下文超过动态预算，验收条件与规则未裁剪；请拆分资料');
  const packet=context.handoff;
  while(estimate(JSON.stringify(context))>maxTokens){
    if(packet.predecessors.length){packet.predecessors.pop();packet.omitted.predecessors++;}
    else if(packet.decisions.length){packet.decisions.pop();packet.omitted.decisions++;}
    else if(packet.currentAttempt){packet.currentAttempt=null;packet.omitted.currentAttempt=true;}
    else throw new Error('Goal 必要上下文与交接完整性标记超过动态预算，请拆分资料');
  }
  return context;
}
module.exports={build,fitContext};
