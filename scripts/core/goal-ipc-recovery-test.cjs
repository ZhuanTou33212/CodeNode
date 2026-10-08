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
  console.log('GOAL IPC RECOVERY: PASS (real handler recovers interrupted Run/admission and checks GitHub CI; both paths are idempotent)');
}finally{
  const resolved=path.resolve(root);
  if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-goal-ipc-recovery-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
}
main().catch(error=>{console.error(error);process.exitCode=1});
