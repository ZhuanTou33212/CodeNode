'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {EventEmitter}=require('node:events');
const goals=require('../../electron/goalStore.cjs'),runs=require('../../electron/runStore.cjs'),agentIpc=require('../../electron/ipc/agent.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-scheduler-'));
const handlers=new Map(),sent=[];
const runtime=agentIpc.register({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},userDataDir:()=>path.join(root,'userdata')});
/** @type {any} */
const sender=new EventEmitter();sender.id=7001;sender.mainFrame={};sender.isDestroyed=()=>false;sender.send=(channel,data)=>sent.push({channel,data});
const event={sender,senderFrame:sender.mainFrame};
const invoke=(name,...args)=>handlers.get(name)(event,...args);
const dispatches=()=>sent.filter(x=>x.channel==='goal:scheduler-dispatch').map(x=>x.data);
const getGoal=id=>goals.read(root).goals.find(g=>g.id===id);
const verification={verified:true,status:'passed',checks:[{kind:'test',status:'passed',command:'node --test fixture.test.cjs',exitCode:0}],files:['source.txt']};
const make=(title,count=2)=>{const g=goals.createGoal(root,{title,criteria:['final acceptance']});let prior=null;for(let i=0;i<count;i++){const task=goals.createTask(root,g.id,{title:'stage '+i,dependsOn:prior?[prior]:[]});prior=task.id;}return getGoal(g.id);};
async function tick(ready=true){await invoke('goal:scheduler-bind',root,ready);await runtime.scheduler.tick();}
async function claim(g){await invoke('goal:execution-start',root,g.id);await tick();const d=dispatches().at(-1);assert.equal(d.goalId,g.id);return d;}
async function admit(d){agentIpc.activeRequests.set(d.requestId,new AbortController());goals.admit(root,d.goalId,d.taskId,d.requestId,{autoAdvanceClaimId:d.claimId});await invoke('goal:auto-advance-release',root,d.goalId,d.taskId,d.claimId,'unit_admitted');}
async function finish(d){goals.recordRunEvidence(root,d.goalId,d.taskId,d.requestId,verification);goals.settle(root,d.requestId,{status:'completed',verification});agentIpc.activeRequests.delete(d.requestId);}

async function main(){try{
  fs.writeFileSync(path.join(root,'source.txt'),'baseline');
  assert.equal((await handlers.get('goal:scheduler-bind')({sender,senderFrame:{}},root,true)).ok,false,'subframes cannot bind a scheduler');
  assert.equal((await invoke('goal:execution-start',root,'missing')).ok,false,'an unbound window cannot start execution');
  await tick();
  for(let i=0;i<15;i++){await invoke('goal:scheduler-bind',null,false);await invoke('goal:scheduler-bind',root,true);}
  assert.equal(sender.listenerCount('destroyed'),1,'repeated project attachment does not accumulate lifecycle listeners');
  const graph=make('Persisted graph',3);goals.updateTask(root,graph.id,graph.tasks[2].id,{criteriaIds:[graph.criteria[0].id]});
  const first=await claim(graph),executionId=getGoal(graph.id).execution.id;
  const duplicateCount=dispatches().length;await runtime.scheduler.tick();assert.equal(dispatches().length,duplicateCount,'a claimed task cannot be dispatched twice');
  const wrongSender={...event,sender:{...sender,id:7002}};
  const stolen=await handlers.get('agent:chat')(wrongSender,{projectRoot:root,goalId:first.goalId,taskId:first.taskId,requestId:first.requestId,autoAdvanceClaimId:first.claimId,prompt:'must not run'});
  assert.equal(stolen.ok,false);assert.match(stolen.error,/窗口/,'claim ownership is bound to the main window');
  await admit(first);await runtime.scheduler.tick();assert.equal(dispatches().length,duplicateCount,'an active run prevents another graph task');
  await finish(first);
  delete require.cache[require.resolve('../../electron/goalStore.cjs')];
  assert.equal(require('../../electron/goalStore.cjs').read(root).goals.find(g=>g.id===graph.id).execution.id,executionId,'execution identity survives a store reload');
  await tick(false);assert.equal(dispatches().length,duplicateCount,'a renderer not ready to accept a turn receives no dispatch');
  await tick();const second=dispatches().at(-1);assert.equal(second.taskId,graph.tasks[1].id);await admit(second);
  fs.appendFileSync(path.join(root,'source.txt'),'stage two changes');await finish(second);await tick();
  const third=dispatches().at(-1);assert.equal(third.taskId,graph.tasks[2].id,'completed predecessor stages are not rerun when later work changes source');await admit(third);await finish(third);await tick();
  assert.equal(getGoal(graph.id).execution.status,'waiting');assert.match(getGoal(graph.id).execution.reason,/验收证据/);
  const awaitingCount=dispatches().length;await tick();assert.equal(dispatches().length,awaitingCount,'insufficient acceptance evidence does not retry the model');
  goals.recordEvidence(root,graph.id,{taskId:third.taskId,criterionId:graph.criteria[0].id,runId:'independent-final',check:'independent acceptance',status:'passed',result:'fixture accepted'});await tick();
  assert.equal(getGoal(graph.id).execution.status,'completed');assert.deepEqual(getGoal(graph.id).execution.attemptedTaskIds,graph.tasks.map(t=>t.id));

  const stopBefore=make('Stop before admission'),queued=await claim(stopBefore);await invoke('goal:execution-stop',root,stopBefore.id);
  assert.throws(()=>goals.admit(root,queued.goalId,queued.taskId,queued.requestId,{autoAdvanceClaimId:queued.claimId}),/授权已停止/);
  await invoke('goal:auto-advance-release',root,queued.goalId,queued.taskId,queued.claimId,'stopped');const stopCount=dispatches().length;await tick();assert.equal(dispatches().length,stopCount);
  const stopDuring=make('Stop while running'),running=await claim(stopDuring);await admit(running);await invoke('goal:execution-stop',root,stopDuring.id);await runtime.scheduler.tick();
  assert.equal(getGoal(stopDuring.id).execution.status,'stopping');assert.equal(agentIpc.activeRequests.get(running.requestId).signal.aborted,false,'stopping future stages preserves the current run');
  await finish(running);await tick();assert.equal(getGoal(stopDuring.id).execution.status,'stopped');assert.equal(getGoal(stopDuring.id).tasks[1].status,'todo');
  for(const status of ['paused','stopped']){
    const controlled=make('Preserve '+status,1),d=await claim(controlled);await admit(d);
    goals.recordEvidence(root,controlled.id,{criterionId:controlled.criteria[0].id,runId:'prior-acceptance-'+status,check:'independent acceptance',status:'passed',result:'fixture accepted'});
    goals.updateGoal(root,controlled.id,{status,stopReason:'user control'});await finish(d);
    assert.equal(getGoal(controlled.id).status,status,'run settlement cannot overwrite explicit Goal lifecycle control');await tick();
    if(status==='paused'){goals.updateGoal(root,controlled.id,{status:'active'});await tick();assert.equal(getGoal(controlled.id).execution.status,'completed');}
    else assert.equal(getGoal(controlled.id).execution.status,'stopped');
  }
  const detached=make('Project attachment loss'),dropped=await claim(detached),other=path.join(root,'other-project');fs.mkdirSync(other);
  await invoke('goal:scheduler-bind',other,true);await runtime.scheduler.tick();assert.equal(getGoal(detached.id).tasks[0].autoAdvance.reason,'renderer_detached_before_dispatch');
  assert.equal(getGoal(detached.id).tasks[0].runIds.length,0,'project switching cannot execute the queued request against a new root');await tick();assert.equal(getGoal(detached.id).execution.status,'blocked');

  const changed=make('Concurrent graph edit'),changing=await claim(changed);await admit(changing);await finish(changing);goals.updateTask(root,changed.id,changed.tasks[1].id,{objective:'new contract'});await tick();
  assert.equal(getGoal(changed.id).execution.status,'blocked');assert.match(getGoal(changed.id).execution.reason,/另一会话修改/);

  const waiting=make('Main timer wait');goals.updateTask(root,waiting.id,waiting.tasks[0].id,{waitCondition:{kind:'time',description:'time fixture',nextCheckAt:new Date(Date.now()+180).toISOString()}});
  await invoke('goal:execution-start',root,waiting.id);await tick(false);const waitCount=dispatches().length;
  await new Promise(resolve=>setTimeout(resolve,350));await runtime.scheduler.tick();
  assert.equal(getGoal(waiting.id).tasks[0].status,'ready','the main-process timer releases time waits without renderer refresh');
  await tick();assert.equal(dispatches().length,waitCount,'waiting continuation still requires Goal authorization');
  assert.equal(getGoal(waiting.id).execution.actionRequired,true,'fulfilled waits without authorization are surfaced as an actionable pause');
  goals.updateGoal(root,waiting.id,{autoAdvanceAuthorized:true});await tick();const resumed=dispatches().at(-1);assert.equal(resumed.taskId,waiting.tasks[0].id);await admit(resumed);await finish(resumed);await tick();
  const downstream=dispatches().at(-1);assert.equal(downstream.taskId,waiting.tasks[1].id,'wait release continues the remaining graph');await admit(downstream);await finish(downstream);await tick();
  assert.equal(getGoal(waiting.id).execution.actionRequired,true);await invoke('goal:execution-stop',root,waiting.id);await tick();assert.equal(getGoal(waiting.id).execution.actionRequired,false,'an explicit stop clears continuation action prompts');

  const failed=make('No automatic retry'),failing=await claim(failed);await admit(failing);goals.settle(root,failing.requestId,{status:'failed'});agentIpc.activeRequests.delete(failing.requestId);await tick();
  assert.equal(getGoal(failed.id).execution.status,'blocked');const failCount=dispatches().length;await tick();assert.equal(dispatches().length,failCount);

  const revoked=make('Revoke waiting authorization',1);goals.updateTask(root,revoked.id,revoked.tasks[0].id,{waitCondition:{kind:'time',description:'revocation fixture',nextCheckAt:new Date(Date.now()+100).toISOString()}});
  goals.updateGoal(root,revoked.id,{autoAdvanceAuthorized:true});await invoke('goal:execution-start',root,revoked.id);goals.releaseDueTimeWaits(root,Date.now()+500);await tick();
  const revokedClaim=dispatches().at(-1);goals.updateGoal(root,revoked.id,{autoAdvanceAuthorized:false});
  assert.throws(()=>goals.admit(root,revokedClaim.goalId,revokedClaim.taskId,revokedClaim.requestId,{autoAdvanceClaimId:revokedClaim.claimId}),/授权已撤销/);
  const revokedChat=await invoke('agent:chat',{projectRoot:root,goalId:revokedClaim.goalId,taskId:revokedClaim.taskId,requestId:revokedClaim.requestId,autoAdvanceClaimId:revokedClaim.claimId,prompt:'must not run'});
  assert.equal(revokedChat.ok,false);assert.match(revokedChat.error,/授权已撤销/);await invoke('goal:auto-advance-release',root,revokedClaim.goalId,revokedClaim.taskId,revokedClaim.claimId,'unit_revoked');await tick();
  const cap=require('../../config/goal.wait.json').autoAdvance.maxRunsPerGoal,capped=make('Waiting continuation cap',cap+1);
  for(const task of capped.tasks)goals.updateTask(root,capped.id,task.id,{waitCondition:{kind:'time',description:'cap fixture',nextCheckAt:new Date(Date.now()+100).toISOString()}});
  goals.updateGoal(root,capped.id,{autoAdvanceAuthorized:true});await invoke('goal:execution-start',root,capped.id);goals.releaseDueTimeWaits(root,Date.now()+500);
  for(let i=0;i<cap;i++){await tick();const d=dispatches().at(-1);assert.equal(d.taskId,capped.tasks[i].id);await admit(d);await finish(d);}
  const capCount=dispatches().length;await tick();assert.equal(dispatches().length,capCount);assert.equal(getGoal(capped.id).autoAdvanceUsedRuns,cap);assert.equal(getGoal(capped.id).execution.status,'blocked');assert.match(getGoal(capped.id).execution.reason,/尝试次数/);
  const contractGoal=goals.createGoal(root,{title:'Acceptance contract race',criteria:['old scope']}),contractHash=require('../../electron/goalExecution.cjs').contract(contractGoal);
  goals.updateGoal(root,contractGoal.id,{criteria:[{id:contractGoal.criteria[0].id,text:'new scope',required:true}]});
  assert.throws(()=>goals.recordEvidence(root,contractGoal.id,{criterionId:contractGoal.criteria[0].id,expectedGoalContract:contractHash,runId:'old-scope-command',check:'independent command',status:'passed',result:'old command passed'}),/合同已变化/);
  assert.equal(goals.audit(root,contractGoal.id).criteria[0].evidence.length,0,'old approval cannot certify a revised criterion');
  const freshContract=require('../../electron/goalExecution.cjs').contract(getGoal(contractGoal.id));
  goals.recordEvidence(root,contractGoal.id,{criterionId:contractGoal.criteria[0].id,expectedGoalContract:freshContract,runId:'current-scope-command',check:'independent command',status:'passed',result:'current command passed'});
  goals.updateGoal(root,contractGoal.id,{scope:'another source scope'});assert.equal(goals.audit(root,contractGoal.id).qualified,false,'accepted evidence becomes stale when the approved Goal scope changes');

  const frequentPoll=make('Polling cannot starve the main timer',1),pollCount=dispatches().length;
  await invoke('goal:scheduler-bind',root,true);await invoke('goal:execution-start',root,frequentPoll.id);
  const pollDeadline=Date.now()+3000;
  while(dispatches().length===pollCount&&Date.now()<pollDeadline){await invoke('goal:audit',root,frequentPoll.id);await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(dispatches().length,pollCount+1,'frequent status IPC calls cannot postpone the main-process dispatch timer');
  const polled=dispatches().at(-1);await invoke('goal:execution-stop',root,frequentPoll.id);await invoke('goal:auto-advance-release',root,polled.goalId,polled.taskId,polled.claimId,'unit_cleanup');
  const crashed=make('Crash before admission'),unadmitted=await claim(crashed);runtime.close();
  assert.equal(sender.listenerCount('destroyed'),0,'shutdown releases lifecycle listeners');
  const childCode=`const path=require('node:path');const root=${JSON.stringify(root)};const handlers=new Map();const runtime=require(${JSON.stringify(path.resolve('electron/ipc/agent.cjs'))}).register({ipcMain:{handle:(n,f)=>handlers.set(n,f)},userDataDir:()=>path.join(root,'userdata')});(async()=>{const result=await handlers.get('goal:list')({},root);const goal=result.value.goals.find(g=>g.id===${JSON.stringify(crashed.id)});console.log(JSON.stringify({status:goal.tasks[0].autoAdvance.status,reason:goal.tasks[0].autoAdvance.reason}));runtime.close();})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const recovered=JSON.parse(cp.execFileSync(process.execPath,['-e',childCode],{encoding:'utf8',windowsHide:true}));assert.equal(recovered.status,'failed');assert.equal(recovered.reason,'app_restarted_before_admission');
  await invoke('goal:auto-advance-release',root,unadmitted.goalId,unadmitted.taskId,unadmitted.claimId,'unit_cleanup');

  const unknownRoot=path.join(root,'unknown');fs.mkdirSync(unknownRoot);fs.writeFileSync(path.join(unknownRoot,'source.txt'),'unknown work');
  const unknown=goals.createGoal(unknownRoot,{title:'Unknown run restart',criteria:['acceptance']});const unknownTask=goals.createTask(unknownRoot,unknown.id,{title:'unknown stage'});goals.startExecution(unknownRoot,unknown.id);const unknownClaim=goals.claimExecutionTask(unknownRoot,unknown.id,unknownTask.id,'unknown-claim-12345678');
  runs.startRun(unknownRoot,'unknown-scheduler-run',{backend:'builtin',prompt:'interrupted'});goals.admit(unknownRoot,unknown.id,unknownTask.id,'unknown-scheduler-run',{autoAdvanceClaimId:unknownClaim.claimId});
  const unknownCode=childCode.replace(JSON.stringify(root),JSON.stringify(unknownRoot)).replace(JSON.stringify(crashed.id),JSON.stringify(unknown.id)).replace('goal.tasks[0].autoAdvance.status','goal.tasks[0].executionStatus').replace('goal.tasks[0].autoAdvance.reason','goal.tasks[0].status');
  const unknownRecovered=JSON.parse(cp.execFileSync(process.execPath,['-e',unknownCode],{encoding:'utf8',windowsHide:true}));assert.equal(unknownRecovered.status,'unknown');assert.equal(unknownRecovered.reason,'blocked');
  console.log('GOAL SCHEDULER: PASS (main timers, dependency continuation, persisted intent, window ownership, readiness, stop, contract changes, explicit acceptance, restart and no blind retry)');
}finally{runtime.close();for(const requestId of agentIpc.activeRequests.keys())if(String(requestId).startsWith('auto-'))agentIpc.activeRequests.delete(requestId);const resolved=path.resolve(root);assert.equal(fs.realpathSync(path.dirname(resolved)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codenode-goal-scheduler-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
