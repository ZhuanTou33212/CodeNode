'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const store=require('../../electron/goalStore.cjs'),budget=require('../../electron/goalBudget.cjs'),runBudget=require('../../electron/goalRunBudget.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-progression-'));
try{
  fs.writeFileSync(path.join(root,'source.txt'),'baseline');
  const proof=(g,t,runId)=>store.recordEvidence(root,g.id,{taskId:t.id,criterionId:g.criteria[0].id,runId,check:'independent fixture acceptance',status:'passed',result:'accepted'});
  const capped=store.createGoal(root,{title:'Exactly at budget',criteria:['accepted'],maxTokens:10,maxCostUsd:0.3});const task=store.createTask(root,capped.id,{title:'Finish',criteriaIds:[capped.criteria[0].id]});
  store.admit(root,capped.id,task.id,'exact-cap');proof(capped,task,'exact-cap');store.settle(root,'exact-cap',{status:'completed',usage:{total_tokens:10},costKnown:true,costUsd:0.1+0.2});
  const complete=store.audit(root,capped.id);assert.equal(complete.budget.exhausted,true);assert.equal(complete.budget.withinLimits,true);assert.equal(complete.complete,true,'verified work at the exact ceiling is complete without additional headroom');
  const pending=store.createGoal(root,{title:'No next run at ceiling',criteria:['accepted'],maxTokens:10});const p=store.createTask(root,pending.id,{title:'Used up'}),next=store.createTask(root,pending.id,{title:'Still required'});store.admit(root,pending.id,p.id,'pending-cap');store.settle(root,'pending-cap',{status:'failed',usage:{total_tokens:10},costKnown:true,costUsd:0});assert.equal(store.canRun(root,pending.id,next.id).decision,'stopped');assert.equal(store.audit(root,pending.id).qualified,false);
  for(const [name,usage,cost,known]of [['token-over',11,0,true],['cost-over',1,0.31,true],['unknown-cost',1,null,false]]){
    const g=store.createGoal(root,{title:name,criteria:['accepted'],maxTokens:10,maxCostUsd:0.3}),t=store.createTask(root,g.id,{title:'Finish',criteriaIds:[g.criteria[0].id]});store.admit(root,g.id,t.id,name);proof(g,t,name);store.settle(root,name,{status:'completed',usage:{total_tokens:usage},costKnown:known,costUsd:cost});assert.equal(store.audit(root,g.id).qualified,false,name+' cannot complete');
  }
  assert.equal(budget.evaluate({maxTokens:null,maxCostUsd:0.3,usedTokens:0,knownCostUsd:0.3001,costUnknown:false}).overLimit,true,'material overspend is not rounded away');
  const goalConfig={limits:{maxTotalTokens:600000,maxTotalRetries:4,maxCostUsd:0.5},costPrices:{main:{in:1,out:2}}};
  const requestBudget=runBudget.apply(goalConfig,{tokenAllowance:250,costAllowance:0.2});
  assert.equal(goalConfig.limits.maxTotalTokens,250);assert.equal(requestBudget.limit,250);assert.equal(requestBudget.costSnapshot().limitUsd,0.2);
  assert.equal(requestBudget.outputAllowance(180,32000),70,'model output limit shrinks to the remaining Goal allowance');
  requestBudget.reserveRequest('main',180,70,goalConfig.costPrices)({total_tokens:250});assert.equal(requestBudget.remaining(),0);
  assert.throws(()=>requestBudget.outputAllowance(1,1),{code:'BUDGET_EXCEEDED'});
  const unknownBudgetGoal=store.createGoal(root,{title:'Unknown token cannot qualify',criteria:['accepted'],maxTokens:100}),unknownBudgetTask=store.createTask(root,unknownBudgetGoal.id,{title:'No usage report',criteriaIds:[unknownBudgetGoal.criteria[0].id]});store.admit(root,unknownBudgetGoal.id,unknownBudgetTask.id,'uncounted-completion');proof(unknownBudgetGoal,unknownBudgetTask,'uncounted-completion');store.settle(root,'uncounted-completion',{status:'completed'});assert.equal(store.audit(root,unknownBudgetGoal.id).budget.tokenBudgetUnknown,true);assert.equal(store.audit(root,unknownBudgetGoal.id).qualified,false,'a passing criterion cannot complete under an unknown capped token total');
  const unknownUsage=store.createGoal(root,{title:'Reconcile unknown tokens',criteria:['finish'],maxTokens:100}),knownTask=store.createTask(root,unknownUsage.id,{title:'Known result'}),unknownTask=store.createTask(root,unknownUsage.id,{title:'External result'});
  store.admit(root,unknownUsage.id,knownTask.id,'known-token-result');store.settle(root,'known-token-result',{status:'failed',usage:{total_tokens:40}});
  store.admit(root,unknownUsage.id,unknownTask.id,'unknown-token-result');store.settle(root,'unknown-token-result',{status:'failed',usage:{used:64,size:100}});
  assert.equal(store.audit(root,unknownUsage.id).budget.tokenBudgetUnknown,true);assert.equal(store.canRun(root,unknownUsage.id,unknownTask.id).decision,'needs-user');
  store.updateGoal(root,unknownUsage.id,{maxTokens:200});assert.equal(store.read(root).goals.find(g=>g.id===unknownUsage.id).budget.tokenUnknown,true,'changing a cap cannot silently clear unknown historical use');
  assert.throws(()=>store.reconcileTokenUsage(root,unknownUsage.id,60,''),/不能为空/);
  assert.throws(()=>store.reconcileTokenUsage(root,unknownUsage.id,39,'核对'),/不能低于已有/);
  const reconciled=store.reconcileTokenUsage(root,unknownUsage.id,64,'读取 ACP provider usage_update used=64');assert.equal(reconciled.totalTokens,64);assert.equal(store.canRun(root,unknownUsage.id,unknownTask.id).decision,'run');
  store.admit(root,unknownUsage.id,unknownTask.id,'budget-snapshot');assert.equal(store.read(root).admissions.find(a=>a.runId==='budget-snapshot').tokenAllowance,136);assert.throws(()=>store.updateGoal(root,unknownUsage.id,{maxTokens:500}),/活动 Run/);store.settle(root,'budget-snapshot',{status:'failed',usage:{total_tokens:0}});
  const unknownCost=store.createGoal(root,{title:'Reconcile unknown ACP cost',criteria:['accepted'],maxCostUsd:0.5}),costTask=store.createTask(root,unknownCost.id,{title:'No cumulative cost frame'});
  store.admit(root,unknownCost.id,costTask.id,'unknown-cost-reconcile');store.settle(root,'unknown-cost-reconcile',{status:'failed',costKnown:false});
  assert.equal(store.audit(root,unknownCost.id).budget.costBudgetUnknown,true);assert.equal(store.canRun(root,unknownCost.id,costTask.id).decision,'needs-user');
  store.updateGoal(root,unknownCost.id,{maxCostUsd:0.75});assert.equal(store.read(root).goals.find(g=>g.id===unknownCost.id).budget.costUnknown,true);
  assert.throws(()=>store.reconcileGoalCost(root,unknownCost.id,0.02,''),/不能为空/);
  assert.equal(store.reconcileGoalCost(root,unknownCost.id,0.02,'读取 ACP 账单 USD 累计值').totalCostUsd,0.02);
  assert.equal(store.canRun(root,unknownCost.id,costTask.id).decision,'run');
  const costFloor=store.createGoal(root,{title:'Reconcile cumulative cost floor',criteria:['accepted'],maxCostUsd:0.2}),costKnownTask=store.createTask(root,costFloor.id,{title:'Known USD run'}),costUnknownTask=store.createTask(root,costFloor.id,{title:'Unknown USD run'});
  store.admit(root,costFloor.id,costKnownTask.id,'known-usd');store.settle(root,'known-usd',{status:'failed',costKnown:true,costUsd:0.08});
  store.admit(root,costFloor.id,costUnknownTask.id,'unknown-usd');store.settle(root,'unknown-usd',{status:'failed',costKnown:false});
  assert.throws(()=>store.reconcileGoalCost(root,costFloor.id,0.07,'provider statement'),/不能低于已有/);
  assert.equal(store.reconcileGoalCost(root,costFloor.id,0.11,'provider statement').totalCostUsd,0.11);

  const waiting=store.createGoal(root,{title:'Unobserved due wait',criteria:['accepted']});const w=store.createTask(root,waiting.id,{title:'Wait'});store.updateTask(root,waiting.id,w.id,{waitCondition:{kind:'external_status',provider:'manual',description:'CI success',expected:'success',nextCheckAt:new Date(Date.now()-1000).toISOString()}});
  assert.equal(store.canRun(root,waiting.id,w.id).decision,'wait','an elapsed polling deadline is not evidence that the external condition matched');assert.throws(()=>store.admit(root,waiting.id,w.id,'unobserved-run'),/运行资格：wait/);
  store.observeWait(root,waiting.id,w.id,{id:'observed-ci',matched:true,source:'user-observation',status:'success'});assert.equal(store.canRun(root,waiting.id,w.id).decision,'run');

  const branches=store.createGoal(root,{title:'Independent branch progress',criteria:['accepted']});const a=store.createTask(root,branches.id,{title:'Needs proof'}),dependent=store.createTask(root,branches.id,{title:'Depends on proof',dependsOn:[a.id]}),free=store.createTask(root,branches.id,{title:'Independent work'});
  store.startExecution(root,branches.id);store.claimExecutionTask(root,branches.id,a.id,'branch-a-claim-12345678');store.admit(root,branches.id,a.id,'branch-a',{autoAdvanceClaimId:'branch-a-claim-12345678'});store.settle(root,'branch-a',{status:'completed'});
  const independent=store.advanceExecution(root,branches.id);assert.equal(independent.task.id,free.id,'completed-but-unverified work only holds dependent branches');assert.notEqual(independent.task.id,dependent.id);
  store.claimExecutionTask(root,branches.id,free.id,'free-claim-123456789');store.admit(root,branches.id,free.id,'free-run',{autoAdvanceClaimId:'free-claim-123456789'});store.recordEvidence(root,branches.id,{taskId:free.id,runId:'free-run',check:'stage check',status:'passed'});store.settle(root,'free-run',{status:'completed'});
  assert.equal(store.advanceExecution(root,branches.id).decision,'waiting');store.recordEvidence(root,branches.id,{taskId:a.id,runId:'branch-a-proof',check:'stage check',status:'passed'});assert.equal(store.advanceExecution(root,branches.id).task.id,dependent.id);
  store.stopExecution(root,branches.id);

  for(const hold of ['authorization','cap']){
    const g=store.createGoal(root,{title:'Local hold '+hold,criteria:['accepted']}),held=store.createTask(root,g.id,{title:'Held wait'}),other=store.createTask(root,g.id,{title:'Independent direct stage'});store.updateTask(root,g.id,held.id,{waitCondition:{kind:'time',description:'time',nextCheckAt:new Date(Date.now()-1000).toISOString()}});store.startExecution(root,g.id);store.releaseDueTimeWaits(root);
    if(hold==='cap'){store.updateGoal(root,g.id,{autoAdvanceAuthorized:true});const data=store.read(root);data.goals.find(x=>x.id===g.id).autoAdvanceUsedRuns=require('../../config/goal.wait.json').autoAdvance.maxRunsPerGoal;fs.writeFileSync(path.join(root,'.codenode','goals.json'),JSON.stringify(data));}
    assert.equal(store.advanceExecution(root,g.id).task.id,other.id,'a local '+hold+' hold does not block unrelated explicitly started work');store.stopExecution(root,g.id);
  }
  console.log('GOAL PROGRESSION: PASS (completion/admission budget boundary, unknown cost, unobserved waits, independent branches and dependency proof gates)');
}finally{const resolved=path.resolve(root);assert.equal(fs.realpathSync(path.dirname(resolved)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codenode-goal-progression-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
