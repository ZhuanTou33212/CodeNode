'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const goal=require('../../electron/goalStore.cjs');
const runStore=require('../../electron/runStore.cjs');
const {register}=require('../../electron/ipc/agent.cjs');

async function main(){
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-ipc-recovery-'));
try{
  const handlers=new Map();
  let ciFetchCalls=0;
  const ciSha='1234567890abcdef1234567890abcdef12345678';
  register({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},userDataDir:()=>path.join(root,'userdata'),githubActionsFetch:async url=>{
    ciFetchCalls++;assert.equal(new URL(url).searchParams.get('head_sha'),ciSha);
    return{ok:true,status:200,json:async()=>({workflow_runs:[{id:77,workflow_id:5,head_sha:ciSha,status:'completed',conclusion:'success',updated_at:'2026-10-01T00:00:00Z'}]})};
  }});
  const current=goal.createGoal(root,{title:'Restart acceptance',criteria:['verify after restart']});
  const task=goal.createTask(root,current.id,{title:'Interrupted task',criteriaIds:[current.criteria[0].id]});
  runStore.startRun(root,'goal-ipc-interrupted',{backend:'builtin',prompt:'interrupted task'});
  goal.admit(root,current.id,task.id,'goal-ipc-interrupted');
  const list=handlers.get('goal:list');
  assert.equal(typeof list,'function');
  const result=await list({},root);
  assert.equal(result.ok,true);
  assert.deepEqual(result.value.recoveredAdmissions,{count:1,recovered:result.value.settlements.filter(x=>x.runId==='goal-ipc-interrupted')});
  assert.equal(result.value.goals.find(x=>x.id===current.id).tasks.find(x=>x.id===task.id).status,'blocked');
  assert.equal(runStore.summarizeRun(runStore.readRun(root,'goal-ipc-interrupted')).status,'interrupted');
  const revision=goal.read(root).revision;
  const duplicate=await list({},root);
  assert.equal(duplicate.value.recoveredAdmissions.count,0,'startup reconciliation is idempotent');
  assert.equal(goal.read(root).revision,revision,'a repeated Goal refresh does not rewrite settled recovery state');

  const ciRoot=path.join(root,'ci-project');fs.mkdirSync(ciRoot);
  const git=(args)=>require('node:child_process').execFileSync('git',args,{cwd:ciRoot,encoding:'utf8',windowsHide:true});
  git(['init']);git(['config','user.name','CodeNode CI Test']);git(['config','user.email','codenode-ci@example.invalid']);
  fs.writeFileSync(path.join(ciRoot,'baseline.txt'),'ci wait fixture\n');git(['add','baseline.txt']);git(['commit','-m','fixture']);git(['remote','add','origin','https://github.com/example/project.git']);
  const ciGoal=goal.createGoal(ciRoot,{title:'CI wait IPC',criteria:['GitHub Actions succeeds']});
  const ciTask=goal.createTask(ciRoot,ciGoal.id,{title:'Wait for current commit CI'});
  goal.updateTask(ciRoot,ciGoal.id,ciTask.id,{waitCondition:{kind:'external_status',provider:'github-actions',description:'CI for exact commit',expected:'success',commitSha:ciSha}});
  const waitResult=await handlers.get('goal:wait-check')({},ciRoot,ciGoal.id,ciTask.id);
  assert.equal(waitResult.ok,true);assert.equal(waitResult.value.status,'success');assert.equal(waitResult.value.matched,true);
  assert.equal(goal.read(ciRoot).goals.find(g=>g.id===ciGoal.id).tasks.find(t=>t.id===ciTask.id).status,'ready');
  assert.equal(ciFetchCalls,1,'the real Goal IPC handler uses the read-only provider once');

  const scheduledGoal=goal.createGoal(ciRoot,{title:'Scheduled wait and authorized continuation',criteria:['matched external result']});
  goal.updateGoal(ciRoot,scheduledGoal.id,{autoAdvanceAuthorized:true});
  const scheduledTask=goal.createTask(ciRoot,scheduledGoal.id,{title:'Continue after CI'});
  goal.updateTask(ciRoot,scheduledGoal.id,scheduledTask.id,{waitCondition:{kind:'external_status',provider:'github-actions',description:'Poll exact commit without model runs',expected:'success',commitSha:ciSha,nextCheckAt:new Date(Date.now()-1000).toISOString()}});
  const scheduledList=await list({},ciRoot);
  assert.equal(scheduledList.ok,true);
  const scheduledReady=scheduledList.value.goals.find(item=>item.id===scheduledGoal.id).tasks.find(item=>item.id===scheduledTask.id);
  assert.equal(scheduledReady.status,'ready');assert.equal(scheduledReady.autoAdvance.status,'ready','scheduled external observation creates one claimable marker');
  assert.equal(ciFetchCalls,2,'periodic Goal refresh performs the due read-only provider check');
  const claimHandler=handlers.get('goal:auto-advance-claim');
  const autoClaim=await claimHandler({},ciRoot,scheduledGoal.id,scheduledTask.id);
  assert.equal(autoClaim.ok,true);assert.equal(autoClaim.value.title,'Continue after CI');
  assert.equal((await claimHandler({},ciRoot,scheduledGoal.id,scheduledTask.id)).ok,false,'concurrent claims cannot start a duplicate automatic Run');
  const autoChat=await handlers.get('agent:chat')({}, {projectRoot:ciRoot,goalId:scheduledGoal.id,taskId:scheduledTask.id,requestId:'wrong-request-id',autoAdvanceClaimId:autoClaim.value.claimId,prompt:'must not dispatch'});
  assert.equal(autoChat.ok,false);assert.match(autoChat.error,/不匹配/,'the main chat handler binds a claim to its exact project, Goal, Task, and requestId');
  const releaseHandler=handlers.get('goal:auto-advance-release');
  assert.equal((await releaseHandler({},ciRoot,scheduledGoal.id,scheduledTask.id,autoClaim.value.claimId,'ui_test_release')).value,true);
  assert.equal(goal.read(ciRoot).goals.find(item=>item.id===scheduledGoal.id).tasks.find(item=>item.id===scheduledTask.id).autoAdvance.status,'failed');
  assert.equal((await claimHandler({},ciRoot,scheduledGoal.id,scheduledTask.id)).ok,false,'a failed one-shot claim is not retried');

  const evalSha='abcdef0123456789abcdef0123456789abcdef01';
  const evalGoal=goal.createGoal(root,{title:'Agent Eval wait IPC',criteria:['Agent Eval report is complete']});
  const evalTask=goal.createTask(root,evalGoal.id,{title:'Wait for Agent Eval'});
  goal.updateTask(root,evalGoal.id,evalTask.id,{waitCondition:{kind:'external_status',provider:'agent-eval',description:'Real report for the exact commit',expected:'success',commitSha:evalSha,datasetVersion:'agent-eval-v1',mode:'offline'}});
  const reports=path.join(root,'docs','eval-reports');fs.mkdirSync(reports,{recursive:true});
  const startedAt=new Date(Date.now()+1000).toISOString();
  fs.writeFileSync(path.join(reports,`agent-eval-${evalSha.slice(0,7)}-offline-20261009-123456.json`),JSON.stringify({
    datasetVersion:'agent-eval-v1',mode:'offline',git:{commit:evalSha.slice(0,7),fullCommit:evalSha,dirty:false},startedAt,
    finishedAt:new Date(Date.parse(startedAt)+1000).toISOString(),model:'scripted-test',exitCode:0,
    taskSet:[{id:'required-probe',required:true}],tasks:[{id:'required-probe',required:true,status:'pass'}],
    totals:{total:1,run:1,passed:1,failed:0,skipped:0,requiredFailed:0,successRate:1},harness:{selfChecks:[{pass:true}]},
  }));
  const evalResult=await handlers.get('goal:wait-check')({},root,evalGoal.id,evalTask.id);
  assert.equal(evalResult.ok,true);assert.equal(evalResult.value.matched,true);assert.equal(evalResult.value.observation.source,'agent-eval');
  assert.equal(evalResult.value.observation.evaluation.requiredPassed,1);
  assert.equal(goal.read(root).goals.find(item=>item.id===evalGoal.id).tasks.find(item=>item.id===evalTask.id).status,'ready');
  console.log('GOAL IPC RECOVERY: PASS (interrupted Run recovery, exact-SHA GitHub Actions and Agent Eval report waits)');
}finally{
  const resolved=path.resolve(root);
  if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-goal-ipc-recovery-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
}
main().catch(error=>{console.error(error);process.exitCode=1});
