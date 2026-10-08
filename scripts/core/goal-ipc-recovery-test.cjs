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
  register({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},userDataDir:()=>path.join(root,'userdata')});
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
  console.log('GOAL IPC RECOVERY: PASS (real handler recovers interrupted Run/admission, blocks blind retry, and is idempotent)');
}finally{
  const resolved=path.resolve(root);
  if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-goal-ipc-recovery-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
}
main().catch(error=>{console.error(error);process.exitCode=1});
