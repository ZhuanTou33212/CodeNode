'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {check}=require('../../electron/goalWaitProviders/agentEval.cjs');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-agent-eval-wait-'));
const commit='abcdef0123456789abcdef0123456789abcdef01';
const reportDir=path.join(root,'docs','eval-reports');
fs.mkdirSync(reportDir,{recursive:true});
const now=Date.now();
function report({startedAt=new Date(now).toISOString(),mode='model',datasetVersion='agent-eval-v1',fullCommit=commit,dirty=false,exitCode=0,passIds=['read','edit'],selfChecks=true}={}){
  const taskSet=[{id:'read',required:true},{id:'edit',required:true},{id:'optional',required:false}];
  const tasks=[{id:'read',status:passIds.includes('read')?'pass':'fail',required:true},{id:'edit',status:passIds.includes('edit')?'pass':'fail',required:true},{id:'optional',status:'pass',required:false}];
  const passed=tasks.filter(item=>item.status==='pass').length;
  const requiredFailed=tasks.filter(item=>item.required&&item.status!=='pass').length;
  return{datasetVersion,mode,git:{commit:fullCommit.slice(0,7),fullCommit,dirty},startedAt,finishedAt:new Date(Date.parse(startedAt)+1000).toISOString(),model:'eval-test-model',exitCode,taskSet,tasks,totals:{total:tasks.length,run:tasks.length,passed,failed:tasks.length-passed,skipped:0,requiredFailed,successRate:passed/tasks.length},harness:{selfChecks:[{name:'fixture',pass:selfChecks}]}};
}
function writeReport(name,value){fs.writeFileSync(path.join(reportDir,name),JSON.stringify(value,null,2));}
function filename(stamp){return`agent-eval-${commit.slice(0,7)}-model-${stamp}.json`;}
try{
  const configuredAt=new Date(now-5000).toISOString();
  const condition={commitSha:commit,mode:'model',datasetVersion:'agent-eval-v1',createdAt:configuredAt};
  writeReport(filename('20261009-000001'),report());
  const success=check(root,condition);
  assert.equal(success.matched,true);assert.equal(success.status,'success');assert.equal(success.revision,commit);
  assert.equal(success.evaluation.requiredPassed,2);assert.equal(success.evaluation.requiredTotal,2);

  const wrongSha=check(root,{...condition,commitSha:'abcdef1123456789abcdef0123456789abcdef01'});
  assert.equal(wrongSha.matched,false,'reports must bind the exact full SHA, not the short filename prefix');

  writeReport(filename('20261009-000002'),report({startedAt:new Date(now-10000).toISOString()}));
  const stale=check(root,{...condition,createdAt:new Date(now+2000).toISOString()});
  assert.equal(stale.status,'not_found','a report that finished before the wait was configured cannot release it');

  writeReport(filename('20261009-000003'),report({startedAt:new Date(now+1000).toISOString(),passIds:['read'],exitCode:1}));
  const failed=check(root,condition);
  assert.equal(failed.matched,false);assert.equal(failed.status,'required_tasks_incomplete');
  assert.deepEqual(failed.evaluation.requiredMissing,['edit']);

  writeReport(`agent-eval-${commit.slice(0,7)}-offline-20261009-000004.json`,report({mode:'offline'}));
  const offline=check(root,{...condition,mode:'offline'});
  assert.equal(offline.status,'success','offline and model evaluations are separate experiment dimensions');

  writeReport(filename('20261009-000005'),report({startedAt:new Date(now+2000).toISOString(),dirty:true}));
  const dirty=check(root,condition);
  assert.equal(dirty.status,'dirty_worktree');assert.equal(dirty.matched,false);

  const staleRoot=path.join(root,'stale');fs.mkdirSync(path.join(staleRoot,'docs','eval-reports'),{recursive:true});
  const staleDir=path.join(staleRoot,'docs','eval-reports');
  fs.writeFileSync(path.join(staleDir,filename('20261009-000006')),JSON.stringify(report({startedAt:new Date(now-10000).toISOString()})));
  const absent=check(staleRoot,{...condition,createdAt:new Date(now).toISOString()});
  assert.equal(absent.status,'not_found');assert.equal(absent.matched,false);
  console.log('AGENT EVAL WAIT: PASS (exact commit/mode/dataset, post-configuration reports only, required task set, clean tree, fail-closed report status)');
}finally{
  const resolved=path.resolve(root),temp=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)===temp&&path.basename(resolved).startsWith('codenode-agent-eval-wait-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
