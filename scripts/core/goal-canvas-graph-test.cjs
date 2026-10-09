'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const store=require('../../electron/goalStore.cjs');
const proposal=require('../../electron/goalPlanProposal.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-canvas-'));
try{
  const created=store.createGoal(root,{title:'改善登录',objective:'让登录可靠',criteria:['登录测试通过']});
  const revision=store.read(root).revision;
  const steps=proposal.parseProposal(JSON.stringify({steps:[
    {key:'inspect',title:'检查登录代码',objective:'定位现状',acceptance:'找到入口和失败路径',dependsOn:[],writeScope:[]},
    {key:'fix',title:'修复登录',objective:'解决问题',acceptance:'行为符合预期',dependsOn:['inspect'],writeScope:['src']},
  ]})).steps;
  assert.equal(store.read(root).goals.find(g=>g.id===created.id).tasks.length,0,'planning is read only');
  const batch=store.createTaskBatch(root,created.id,steps,revision);
  assert.equal(batch.length,2);assert.deepEqual(batch[1].dependsOn,[batch[0].id]);
  assert.deepEqual(batch[0].criteriaIds,[],'intermediate tasks do not claim the whole Goal acceptance');
  assert.deepEqual(batch[1].criteriaIds,[created.criteria[0].id],'final task carries overall Goal acceptance');
  assert.equal(store.canRun(root,created.id,batch[1].id).decision,'idle','dependency waits for predecessor');
  assert.throws(()=>store.createTaskBatch(root,created.id,steps,revision),/其他会话修改/,'stale review cannot overwrite newer Goal');
  const before=store.read(root).revision;
  assert.throws(()=>store.createTaskBatch(root,created.id,[{key:'a',title:'A',dependsOn:['b']},{key:'b',title:'B',dependsOn:['a']}],before),/循环/);
  assert.equal(store.read(root).revision,before,'failed graph import is atomic');
  assert.throws(()=>store.deletePlannedTask(root,created.id,batch[0].id,before),/下游依赖/);
  assert.throws(()=>store.updateTask(root,created.id,batch[1].id,{dependsOn:[],expectedRevision:before-1}),/其他会话更新/);
  store.updateTask(root,created.id,batch[1].id,{dependsOn:[],expectedRevision:before});
  assert.throws(()=>store.deletePlannedTask(root,created.id,batch[0].id,before),/其他会话更新/);
  store.deletePlannedTask(root,created.id,batch[0].id,store.read(root).revision);
  assert.equal(store.read(root).goals.find(g=>g.id===created.id).tasks.length,1);
  const remaining=store.read(root).goals.find(g=>g.id===created.id).tasks[0];
  store.admit(root,created.id,remaining.id,'goal-canvas-run');
  assert.throws(()=>store.deletePlannedTask(root,created.id,remaining.id,store.read(root).revision),/已有执行或证据/);
  assert.throws(()=>store.updateTask(root,created.id,remaining.id,{title:'changed'}),/执行中或已完成/);
  store.settle(root,'goal-canvas-run',{status:'completed',summary:'要解决的问题：登录失败。\n做了什么：检查了入口。\n结果与验证：未验证。'});
  assert.match(store.audit(root,created.id).tasks[0].lastRun.summary,/登录失败/,'clickable Goal node can show the settled Run summary');
  const milestone=store.createGoal(root,{title:'Milestone evidence',criteria:['最终验收通过']});
  const phase=store.createTaskBatch(root,milestone.id,[{key:'read',title:'调查',objective:'确认入口',dependsOn:[]},{key:'verify',title:'最终验收',objective:'检查结果',dependsOn:['read']}],store.read(root).revision);
  store.admit(root,milestone.id,phase[0].id,'milestone-read-run');
  const verified={status:'passed',verified:true,files:[],checks:[{kind:'test',status:'passed',command:'node --check index.js'}]};
  store.recordRunEvidence(root,milestone.id,phase[0].id,'milestone-read-run',verified);
  store.settle(root,'milestone-read-run',{status:'completed',verification:verified,summary:'确认了入口'});
  const milestoneView=store.audit(root,milestone.id);
  assert.equal(milestoneView.tasks[0].status,'completed');
  assert.equal(milestoneView.criteria[0].evidence.length,0,'phase evidence cannot satisfy final Goal criterion');
  assert.equal(store.canRun(root,milestone.id,phase[1].id).decision,'run');
  assert.throws(()=>proposal.parseProposal('{"steps":[{"key":"x","title":"X","objective":"X","acceptance":"ok","dependsOn":["missing"]}]}'),/不存在的依赖/);
  assert.throws(()=>proposal.parseProposal('{"steps":[{"key":"x","title":"X","objective":"X","acceptance":"ok","dependsOn":[],"writeScope":["../outside"]}]}'),/写入范围无效/);
  const joined=proposal.withGoalAcceptanceStep({steps:[
    {key:'read',title:'读取',objective:'读文件',acceptance:'已读',dependsOn:[]},
    {key:'tests',title:'测试',objective:'跑测试',acceptance:'已通过',dependsOn:[]},
    {key:'final',title:'总验收',objective:'核对',acceptance:'均通过',dependsOn:['read']},
  ]});
  assert.deepEqual(joined.steps[2].dependsOn,['read','tests'],'final acceptance depends on every branch');
  console.log('GOAL CANVAS GRAPH: PASS (proposal validation, atomic import, dependency gate, CAS, deletion audit)');
}finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('codenode-goal-canvas-'));
  fs.rmSync(root,{recursive:true,force:true});
}
