'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('@typescript/typescript6');

function load(file){const source=fs.readFileSync(file,'utf8');const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const loaded={exports:{}};const localRequire=id=>id==='./goalTaskPriority'?load(path.join(path.dirname(file),'goalTaskPriority.ts')):require(path.resolve(path.dirname(file),id));new Function('exports','require','module',compiled)(loaded.exports,localRequire,loaded);return loaded.exports;}
const {goalAttention}=load(path.join(__dirname,'../../src/lib/goalAttention.ts'));

const active=goalAttention([{id:'active',title:'Active goal',status:'active',budget:{maxTokens:1000,tokenUnknown:true,maxCostUsd:0.5,costUnknown:true},decisions:[{id:'decision',status:'open',question:'Choose deployment region'}],tasks:[
  {id:'unknown',title:'Interrupted task',status:'blocked',executionStatus:'unknown'},
  {id:'failed',title:'Failed task',status:'failed'},
  {id:'cancelled',title:'Cancelled task',status:'cancelled'},
  {id:'blocked',title:'Blocked task',status:'blocked'},
  {id:'due',title:'Due wait',status:'waiting',waitDue:true,waitCondition:{description:'CI finished'}},
  {id:'future',title:'Future wait',status:'waiting',waitDue:false,waitCondition:{description:'Service ready'}},
],execution:{id:'execution',status:'blocked',actionRequired:true,currentTaskId:'unknown',reason:'Task requires review'}}]);
assert.deepEqual(active.map(item=>item.action),[
  'reconcile-token-usage','reconcile-cost-usage','review-run','resolve-decision','retry-task','retry-task','resolve-task','check-wait','view-wait',
]);
assert.deepEqual(active.map(item=>item.priority),[0,0,0,1,1,1,1,2,3],'risk priority is deterministic and puts capped unknowns and Run review first');
assert.equal(active.find(item=>item.action==='resolve-decision').taskId,null);
assert.equal(active.find(item=>item.action==='review-run').taskId,'unknown');
assert.equal(active.find(item=>item.id==='cancelled').label,'已取消');
assert.equal(active.filter(item=>item.action==='review-execution').length,0,'task/decision blockers suppress duplicate execution attention');
assert(active.every(item=>item.owner==='user'&&item.goalId==='active'&&item.key));
assert.equal(new Set(active.map(item=>item.key)).size,active.length);

const global=goalAttention([
  {id:'stale',title:'Stale goal',status:'completed',complete:false,tasks:[],decisions:[]},
  {id:'execution-review',title:'Execution review',status:'active',tasks:[],decisions:[],execution:{id:'blocked-exec',status:'blocked',reason:'Review the execution'}} ,
  {id:'execution-continue',title:'Continue',status:'active',tasks:[],decisions:[],execution:{id:'wait-exec',status:'waiting',actionRequired:true,reason:'Waiting for approval'}},
  {id:'archived',title:'Archived',status:'archived',budget:{maxTokens:100,tokenUnknown:true},tasks:[{id:'archived-task',title:'Old',status:'failed'}],decisions:[]},
  {id:'uncapped',title:'Uncapped unknown usage',status:'active',budget:{tokenUnknown:true,costUnknown:true},tasks:[],decisions:[]},
]);
assert.deepEqual(global.map(item=>item.action),['revalidate-goal','review-execution','continue-goal']);
assert.deepEqual(global.map(item=>item.priority),[0,1,2]);
assert.equal(global.some(item=>item.goalId==='archived'),false);
assert.equal(global.some(item=>item.goalId==='uncapped'),false,'uncapped unknown usage does not create a blocking reconciliation task');
assert.equal(global[1].taskId,null);
const ranked=goalAttention([{id:'ranked',title:'Priority within risk',status:'active',tasks:[{id:'low',title:'Low',status:'failed',priority:'low'},{id:'urgent',title:'Urgent',status:'failed',priority:'urgent'},{id:'unknown-low',title:'Unknown',status:'blocked',executionStatus:'unknown',priority:'low'}]}]);assert.deepEqual(ranked.map(item=>item.id),['unknown-low','urgent','low'],'risk categories take precedence over Task priority');
console.log('GOAL ATTENTION: PASS (shared overview/editor action types, owner, waiting, blockers, reconciliation and archive filtering)');
