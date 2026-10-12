'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const store=require('../../electron/goalStore.cjs'),handoff=require('../../electron/goalHandoff.cjs'),limits=require('../../config/goal.handoff.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-handoff-'));
try{
  fs.writeFileSync(path.join(root,'source.txt'),'baseline');
  const goal=store.createGoal(root,{title:'Handoff goal',criteria:['final source verified']});
  const a=store.createTask(root,goal.id,{title:'Investigate'}),b=store.createTask(root,goal.id,{title:'Implement',dependsOn:[a.id]}),current=store.createTask(root,goal.id,{title:'Verify',dependsOn:[b.id],criteriaIds:[goal.criteria[0].id]});
  const unrelated=store.createTask(root,goal.id,{title:'Unrelated branch'});
  const passed={verified:true,status:'passed',files:['source.txt'],checks:[{kind:'test',status:'passed',command:'node source-test.cjs',exitCode:0}]};
  for(const task of [a,b]){const runId='run-'+task.id;store.admit(root,goal.id,task.id,runId);store.recordRunEvidence(root,goal.id,task.id,runId,passed);store.settle(root,runId,{status:'completed',summary:'Result for '+task.title,verification:passed});}
  store.admit(root,goal.id,unrelated.id,'unrelated-run');store.settle(root,'unrelated-run',{status:'failed',summary:'UNRELATED_BRANCH_MUST_NOT_LEAK'});
  const decision=store.addDecision(root,goal.id,{question:'Keep investigated API?',options:['yes'],taskIds:[a.id]});store.resolveDecision(root,decision.id,'yes','Confirmed by owner');
  const open=store.addDecision(root,goal.id,{question:'Final delivery choice?',options:['A','B']});
  const foreign=store.createGoal(root,{title:'Foreign goal',criteria:['foreign criterion']});const foreignTask=store.createTask(root,foreign.id,{title:'Foreign task'});store.admit(root,foreign.id,foreignTask.id,'foreign-run');store.settle(root,'foreign-run',{status:'failed',summary:'FOREIGN_GOAL_MUST_NOT_LEAK'});
  const context=store.contextForRole(root,goal.id,current.id,'implement');
  assert.deepEqual(context.handoff.predecessors.map(t=>t.taskId),[b.id,a.id]);assert.equal(context.handoff.predecessors[0].direct,true);assert.equal(context.handoff.predecessors[1].direct,false);
  assert.match(context.handoff.predecessors[0].latestRun.summary,/Implement/);assert.equal(context.handoff.predecessors[0].evidence[0].freshness.valid,true);
  assert.equal(context.handoff.referenceOnly,true);assert.equal(JSON.stringify(context).includes('MUST_NOT_LEAK'),false);
  assert.equal(context.handoff.decisions.find(d=>d.id===decision.id).value,'yes');assert.equal(context.handoff.decisions.find(d=>d.id===open.id).status,'open');
  assert.equal(context.criteria[0].text,'final source verified');assert.equal(context.criteria[0].appliesToTask,true);
  assert.equal(store.contextForRole(root,goal.id,a.id,'explore').criteria[0].appliesToTask,false,'overall criteria do not silently bind a stage');
  const revision=store.read(root).revision;store.contextForRole(root,goal.id,current.id,'review');assert.equal(store.read(root).revision,revision,'derived handoff does not rewrite history');
  fs.appendFileSync(path.join(root,'source.txt'),'changed');
  const stale=store.contextForRole(root,goal.id,current.id,'verify');assert.equal(stale.handoff.predecessors[0].taskStatus,'completed');assert.equal(stale.handoff.predecessors[0].evidence[0].freshness.valid,false,'historic completion is not proof of current validity');
  assert.match(stale.handoff.predecessors[0].evidence[0].freshness.reason,/指纹/);

  const data=store.read(root),g=data.goals.find(x=>x.id===goal.id),t=g.tasks.find(x=>x.id===current.id);
  data.settlements.unshift({goalId:g.id,taskId:b.id,runId:'new-failed-run',status:'failed',summary:'Latest failure password=do-not-expose',finishedAt:new Date().toISOString()});g.tasks.find(x=>x.id===b.id).runIds.push('new-failed-run');
  const latest=handoff.build(data,g,t,()=>({valid:false,reason:'fixture stale'}));assert.equal(latest.predecessors[0].latestRun.status,'failed');assert.match(latest.predecessors[0].latestRun.summary,/Latest failure/);assert.equal(JSON.stringify(latest).includes('do-not-expose'),false);
  data.settlements.unshift({goalId:g.id,taskId:t.id,runId:'current-unknown',status:'unknown',summary:'Unknown side effect',finishedAt:new Date().toISOString()});t.runIds.push('current-unknown');
  assert.equal(handoff.build(data,g,t,()=>({valid:false})).currentAttempt.status,'unknown');
  const large=structuredClone(g);large.tasks=[];large.evidence=[];const target={...t,id:'target',dependsOn:[],runIds:[]};
  const records={...data,settlements:[],decisions:[]};
  for(let i=0;i<50;i++){const id='large-'+i;target.dependsOn.push(id);large.tasks.push({...a,id,dependsOn:[],runIds:['r'+i]});records.settlements.push({goalId:g.id,taskId:id,runId:'r'+i,status:'completed',summary:'x'.repeat(6000)});}
  large.tasks.push(target);const bounded=handoff.build(records,large,target,()=>({valid:true}));assert.ok(bounded.omitted.predecessors>0);assert.ok(JSON.stringify(bounded).length<=limits.maxPacketChars);assert.equal(bounded.predecessors[0].latestRun.summaryTruncated,true);
  large.tasks[0].dependsOn=['target'];assert.equal(handoff.build(records,large,target,()=>({valid:true})).predecessors.some(p=>p.taskId==='target'),false,'cyclic data cannot duplicate the current task or loop forever');
  const fitted={criteria:[{id:'required',text:'FULL_REQUIRED_CRITERION'}],handoff:structuredClone(bounded)};
  handoff.fitContext(fitted,800,text=>text.length);assert.equal(fitted.criteria[0].text,'FULL_REQUIRED_CRITERION');assert.ok(JSON.stringify(fitted).length<=800);assert.ok(fitted.handoff.omitted.predecessors>bounded.omitted.predecessors);
  assert.throws(()=>handoff.fitContext({criteria:[{text:'必需条件'.repeat(1000)}],handoff:structuredClone(bounded)},50,text=>text.length),/必要上下文/,'required acceptance text must not be silently shortened');
  delete require.cache[require.resolve('../../electron/goalStore.cjs')];assert.equal(require('../../electron/goalStore.cjs').contextForRole(root,goal.id,current.id,'implement').handoff.predecessors[0].latestRun.runId,'run-'+b.id,'handoff is derived from persisted records after reload');
  console.log('GOAL HANDOFF: PASS (ancestors, latest outcome, evidence freshness, criteria, decisions, scope isolation, redaction, bounded packets and reload)');
}finally{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codenode-goal-handoff-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
