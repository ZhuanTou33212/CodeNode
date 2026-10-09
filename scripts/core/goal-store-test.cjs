'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const goal = require('../../electron/goalStore.cjs');
const runStore = require('../../electron/runStore.cjs');
const waitConfig = require('../../config/goal.wait.json');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-goal-store-'));
try {
  fs.writeFileSync(path.join(root, 'source.txt'), 'baseline\n');
  assert.throws(() => goal.createGoal(root, { title: 'No acceptance' }), /必需验收条件/);

  const created = goal.createGoal(root, { title: 'Release quality', criteria: ['tests pass'], maxTokens: 500 });
  assert.throws(() => goal.updateGoal(root, created.id, { criteria: [] }), /必需验收条件/);
  const criterionId = created.criteria[0].id;

  const restartGoal = goal.createGoal(root, { title: 'Restart recovery', criteria: ['rechecked'] });
  const restartTask = goal.createTask(root, restartGoal.id, { title: 'Interrupted work', criteriaIds: [restartGoal.criteria[0].id] });
  runStore.startRun(root,'run-before-restart',{backend:'builtin',prompt:'interrupted Goal task'});
  goal.admit(root, restartGoal.id, restartTask.id, 'run-before-restart');
  const restartDecision=goal.addDecision(root,restartGoal.id,{question:'continue after restart?',options:['continue'],taskIds:[restartTask.id]});
  runStore.appendEvent(root,'run-before-restart','backend_changes',{changes:{complete:true,scope:'fixture workspace',files:[{path:'source.txt',kind:'modified',before:'b'.repeat(64),after:'a'.repeat(64)}]}});
  assert.equal(goal.reconcileAdmissions(root, new Set(['run-before-restart'])).count, 0, 'a live Run is not reconciled as interrupted');
  assert.deepEqual(runStore.recoverInterrupted(root,new Set()),['run-before-restart']);
  assert.equal(runStore.summarizeRun(runStore.readRun(root,'run-before-restart')).status,'interrupted');
  const recovered = goal.reconcileAdmissions(root, new Set());
  assert.equal(recovered.count, 1);
  assert.equal(recovered.recovered[0].status, 'unknown');
  assert.equal(goal.read(root).goals.find(g => g.id === restartGoal.id).tasks[0].status, 'blocked');
  assert.equal(goal.read(root).goals.find(g => g.id === restartGoal.id).budget.costUnknown, true);
  assert.equal(goal.reconcileAdmissions(root, new Set()).count, 0, 'restart reconciliation is idempotent');
  assert.equal(goal.canRun(root,restartGoal.id,restartTask.id).decision,'needs-user','run admission check reports that an unknown Task needs review');
  goal.resolveDecision(root,restartDecision.id,'continue');
  assert.equal(goal.read(root).goals.find(g=>g.id===restartGoal.id).tasks[0].status,'blocked','resolving a business decision cannot bypass unknown Run review');
  assert.throws(()=>goal.updateTask(root,restartGoal.id,restartTask.id,{status:'todo'}),/必须先查看对应 Run 差异/,'unknown Run cannot be requeued through the storage API without a review');
  assert.throws(()=>goal.updateTask(root,restartGoal.id,restartTask.id,{status:'ready'}),/必须先查看对应 Run 差异/,'unknown Run cannot bypass review through a ready status');
  assert.throws(()=>goal.updateTask(root,restartGoal.id,restartTask.id,{waitCondition:{kind:'time',description:'retry later'}}),/必须先查看对应 Run 差异/,'unknown Run cannot bypass review by entering a timed wait');
  const initialReview=goal.runReview(root,restartGoal.id,restartTask.id,'run-before-restart');
  assert.equal(initialReview.status,'interrupted');assert.equal(initialReview.files[0].path,'source.txt');assert.equal(initialReview.changesComplete,true);
  assert.throws(()=>goal.confirmRunReview(root,restartGoal.id,restartTask.id,'different-run',initialReview.projectFingerprint),/不是当前等待人工复核/,'review cannot be transferred to another Run');
  goal.confirmRunReview(root,restartGoal.id,restartTask.id,'run-before-restart',initialReview.projectFingerprint);
  fs.writeFileSync(path.join(root,'source.txt'),'changed after review\n');
  assert.throws(()=>goal.updateTask(root,restartGoal.id,restartTask.id,{status:'todo'}),/必须先查看对应 Run 差异/,'workspace changes after review invalidate the requeue authorization');
  const refreshedReview=goal.runReview(root,restartGoal.id,restartTask.id,'run-before-restart');
  goal.confirmRunReview(root,restartGoal.id,restartTask.id,'run-before-restart',refreshedReview.projectFingerprint);
  goal.updateTask(root, restartGoal.id, restartTask.id, { status: 'todo' });
  assert.equal(goal.read(root).goals.find(g=>g.id===restartGoal.id).tasks[0].executionStatus,'reviewed');
  assert.equal(goal.canRun(root, restartGoal.id, restartTask.id).decision, 'run', 'manual review can explicitly requeue an unknown Run');

  const unknownCostGoal=goal.createGoal(root,{title:'Cost gate',criteria:['cost audited'],maxCostUsd:10});
  const unknownCostTask=goal.createTask(root,unknownCostGoal.id,{title:'External task',criteriaIds:[unknownCostGoal.criteria[0].id]});
  goal.admit(root,unknownCostGoal.id,unknownCostTask.id,'run-cost-unknown');
  goal.settle(root,'run-cost-unknown',{status:'failed',usage:{total_tokens:12},costKnown:false});
  assert.equal(goal.canRun(root,unknownCostGoal.id,unknownCostTask.id).decision,'needs-user','unknown cost cannot silently pass a configured USD cap');
  assert.equal(goal.audit(root,unknownCostGoal.id).budget.costBudgetUnknown,true);

  const first = goal.createTask(root, created.id, { title: 'Implement', criteriaIds: [criterionId], writeScope: ['src'] });
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'run');
  const admission = goal.admit(root, created.id, first.id, 'run-failed');
  assert.equal(admission.status, 'running');
  assert.throws(() => goal.admit(root, created.id, first.id, 'duplicate'), /已有活动 Run/);
  goal.settle(root, 'run-failed', { status: 'failed', usage: { total_tokens: 20 } });
  const settledRevision=goal.read(root).revision;
  goal.settle(root, 'run-failed', { status: 'failed', usage: { total_tokens: 20 } });
  assert.equal(goal.read(root).revision,settledRevision,'duplicate settlement does not mutate the revision or double-count usage');
  const afterFailedRun=goal.read(root).goals.find(g=>g.id===created.id);
  assert.equal(afterFailedRun.budget.usedTokens, 20);
  assert.equal(afterFailedRun.tasks.find(t=>t.id===first.id).status, 'failed');

  assert.throws(() => goal.updateTask(root, created.id, first.id, { status: 'completed' }), /缺少当前有效的验收证据/);
  const second = goal.createTask(root, created.id, { title: 'Verify', criteriaIds: [criterionId], dependsOn: [first.id] });
  assert.equal(goal.canRun(root, created.id, second.id).decision, 'idle', 'dependencies block downstream work');
  assert.throws(() => goal.updateTask(root, created.id, first.id, { dependsOn: [second.id] }), /循环/);
  assert.throws(() => goal.createTask(root, created.id, { title: 'Escape', writeScope: ['../outside'] }), /项目相对路径/);

  const waitTask = goal.createTask(root, created.id, { title: 'Wait' });
  goal.updateTask(root, created.id, waitTask.id, { waitCondition: { kind: 'external_status', description: 'service online', expected: 'ready' } });
  assert.equal(goal.canRun(root, created.id, waitTask.id).decision, 'wait');
  const ciTask=goal.createTask(root,created.id,{title:'Wait for GitHub CI'});
  const ciSha='0123456789abcdef0123456789abcdef01234567';
  goal.updateTask(root,created.id,ciTask.id,{waitCondition:{kind:'external_status',provider:'github-actions',description:'Checks for this commit',expected:'success',commitSha:ciSha}});
  assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t=>t.id===ciTask.id).waitCondition.provider,'github-actions');
  assert.throws(()=>goal.updateTask(root,created.id,ciTask.id,{waitCondition:{kind:'external_status',provider:'github-actions',description:'bad ref',commitSha:'HEAD'}}),/40 位 commit SHA/);
  const ciPending=goal.observeWait(root,created.id,ciTask.id,{id:'ci-pending',source:'github-actions',status:'in_progress',matched:false,revision:ciSha,runId:'42',detailsUrl:'https://github.com/example/repo/actions/runs/42',checkedAt:new Date().toISOString(),workflowCount:1});
  const ciStored=goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t=>t.id===ciTask.id);
  assert.equal(ciPending.observation.source,'github-actions');assert.equal(ciStored.waitCondition.lastObservation.runId,'42');
  assert(Date.parse(ciStored.waitCondition.nextCheckAt)>Date.now(),'GitHub Actions polling uses the existing backoff');
  goal.observeWait(root,created.id,ciTask.id,{id:'ci-success',source:'github-actions',status:'success',matched:true,revision:ciSha,runId:'42',detailsUrl:'https://github.com/example/repo/actions/runs/42'});
  assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t=>t.id===ciTask.id).status,'ready','verified CI success releases only its waiting Task');
  const stillWaiting = { id: 'gateway-revision-3', source: 'monitor', status: 'starting', revision: '3', matched: false };
  goal.observeWait(root, created.id, waitTask.id, stillWaiting);
  const backoffRevision=goal.read(root).revision;
  goal.observeWait(root, created.id, waitTask.id, stillWaiting);
  assert.equal(goal.read(root).revision,backoffRevision,'duplicate unmatched observation is idempotent');
  const backedOffTask=goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t=>t.id===waitTask.id);
  assert(Date.parse(backedOffTask.waitCondition.nextCheckAt)>Date.now(),'an unmet external condition receives a future retry time');
  assert.equal(goal.canRun(root, created.id, waitTask.id).decision, 'wait','unmet condition does not immediately relaunch a model run');
  const observation = { id: 'gateway-revision-4', source: 'monitor', status: 'ready', revision: '4', matched: true };
  const observed = goal.observeWait(root, created.id, waitTask.id, observation);
  assert.equal(observed.matched, true);
  const observedRevision=goal.read(root).revision;
  assert.deepEqual(goal.observeWait(root, created.id, waitTask.id, observation), observed, 'wait observations are idempotent by stable ID');
  assert.equal(goal.read(root).revision,observedRevision,'duplicate wait observation does not advance project context revision');
  assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t => t.id === waitTask.id).status, 'ready');

  const timeTask=goal.createTask(root,created.id,{title:'Time wait'});
  goal.updateTask(root,created.id,timeTask.id,{waitCondition:{kind:'time',description:'wait until release time',nextCheckAt:new Date(Date.now()-1000).toISOString()}});
  const released=goal.releaseDueTimeWaits(root);
  assert.equal(released.length,1);assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t=>t.id===timeTask.id).status,'ready');
  const revisionAfterRelease=goal.read(root).revision;
  assert.deepEqual(goal.releaseDueTimeWaits(root),[]);assert.equal(goal.read(root).revision,revisionAfterRelease,'time release is idempotent');

  const autoGoal=goal.createGoal(root,{title:'Explicitly authorized wait continuation',criteria:['one bounded run']});
  assert.equal(autoGoal.autoAdvanceAuthorized,false,'automatic model runs are off by default');
  assert.equal(autoGoal.autoAdvanceUsedRuns,0);
  const autoTask=goal.createTask(root,autoGoal.id,{title:'Continue after wait'});
  goal.updateTask(root,autoGoal.id,autoTask.id,{waitCondition:{kind:'time',description:'release once',nextCheckAt:new Date(Date.now()-1000).toISOString()}});
  goal.releaseDueTimeWaits(root);
  const readyAutoTask=goal.read(root).goals.find(item=>item.id===autoGoal.id).tasks.find(item=>item.id===autoTask.id);
  assert.equal(readyAutoTask.autoAdvance.status,'ready','only a matched wait release creates the one-shot marker');
  assert.throws(()=>goal.claimAutoAdvance(root,autoGoal.id,autoTask.id,'auto-claim-disabled-001'),/尚未授权/);
  goal.updateGoal(root,autoGoal.id,{autoAdvanceAuthorized:true});
  const autoClaim=goal.claimAutoAdvance(root,autoGoal.id,autoTask.id,'auto-claim-authorized-001');
  assert.equal(autoClaim.usedRuns,1);
  assert.throws(()=>goal.admit(root,autoGoal.id,autoTask.id,'auto-run-without-claim'),/自动推进认领/,'a pending auto claim cannot be bypassed by another run');
  goal.updateGoal(root,autoGoal.id,{autoAdvanceAuthorized:false});
  assert.throws(()=>goal.admit(root,autoGoal.id,autoTask.id,'auto-run-after-revocation',{autoAdvanceClaimId:autoClaim.claimId}),/授权已撤销/,'revoking authorization before admission blocks the claimed start');
  goal.updateGoal(root,autoGoal.id,{autoAdvanceAuthorized:true});
  goal.admit(root,autoGoal.id,autoTask.id,'auto-run-authorized',{autoAdvanceClaimId:autoClaim.claimId});
  goal.settle(root,'auto-run-authorized',{status:'failed',usage:{total_tokens:1},costKnown:true,costUsd:0});
  const autoSettled=goal.read(root).goals.find(item=>item.id===autoGoal.id).tasks.find(item=>item.id===autoTask.id);
  assert.equal(autoSettled.autoAdvance.status,'settled');assert.equal(autoSettled.autoAdvance.runStatus,'failed');
  assert.throws(()=>goal.claimAutoAdvance(root,autoGoal.id,autoTask.id,'auto-claim-retry-001'),/没有等待条件释放/,'failed automatic runs are never retried from the same wait');

  const pausedAutoGoal=goal.createGoal(root,{title:'Paused auto continuation',criteria:['remain paused']});goal.updateGoal(root,pausedAutoGoal.id,{autoAdvanceAuthorized:true});
  const pausedAutoTask=goal.createTask(root,pausedAutoGoal.id,{title:'Do not start while paused'});
  goal.updateTask(root,pausedAutoGoal.id,pausedAutoTask.id,{waitCondition:{kind:'time',description:'pause gate',nextCheckAt:new Date(Date.now()-1000).toISOString()}});goal.releaseDueTimeWaits(root);goal.updateGoal(root,pausedAutoGoal.id,{status:'paused'});
  assert.throws(()=>goal.claimAutoAdvance(root,pausedAutoGoal.id,pausedAutoTask.id,'auto-claim-paused-001'),/active Goal/,'paused Goals block automatic starts');
  goal.updateGoal(root,pausedAutoGoal.id,{status:'active'});
  const pausedReleasedClaim=goal.claimAutoAdvance(root,pausedAutoGoal.id,pausedAutoTask.id,'auto-claim-resumed-001');
  goal.releaseAutoAdvanceClaim(root,pausedAutoGoal.id,pausedAutoTask.id,pausedReleasedClaim.claimId,'test_no_dispatch');

  const budgetAutoGoal=goal.createGoal(root,{title:'Budget auto continuation',criteria:['respect token budget'],maxTokens:1});goal.updateGoal(root,budgetAutoGoal.id,{autoAdvanceAuthorized:true});
  const budgetTask=goal.createTask(root,budgetAutoGoal.id,{title:'Consume budget'});goal.admit(root,budgetAutoGoal.id,budgetTask.id,'auto-budget-consumer');goal.settle(root,'auto-budget-consumer',{status:'failed',usage:{total_tokens:1},costKnown:true,costUsd:0});
  const budgetWait=goal.createTask(root,budgetAutoGoal.id,{title:'Wait behind exhausted budget'});goal.updateTask(root,budgetAutoGoal.id,budgetWait.id,{waitCondition:{kind:'time',description:'budget gate',nextCheckAt:new Date(Date.now()-1000).toISOString()}});goal.releaseDueTimeWaits(root);
  assert.throws(()=>goal.claimAutoAdvance(root,budgetAutoGoal.id,budgetWait.id,'auto-claim-budget-001'),/自动推进资格：stopped.*预算已用尽/,'exhausted Goal budgets block automatic starts');

  const abandonedAutoGoal=goal.createGoal(root,{title:'Restart before auto admission',criteria:['no blind retry']});goal.updateGoal(root,abandonedAutoGoal.id,{autoAdvanceAuthorized:true});
  const abandonedAutoTask=goal.createTask(root,abandonedAutoGoal.id,{title:'Claim interrupted before send'});goal.updateTask(root,abandonedAutoGoal.id,abandonedAutoTask.id,{waitCondition:{kind:'time',description:'release then restart',nextCheckAt:new Date(Date.now()-1000).toISOString()}});goal.releaseDueTimeWaits(root);
  goal.claimAutoAdvance(root,abandonedAutoGoal.id,abandonedAutoTask.id,'auto-claim-restart-001');
  assert.equal(goal.reconcileAutoAdvanceClaims(root,new Set()).count,1,'an unadmitted persisted claim becomes terminal after restart');
  assert.equal(goal.read(root).goals.find(item=>item.id===abandonedAutoGoal.id).tasks.find(item=>item.id===abandonedAutoTask.id).autoAdvance.status,'failed');

  const capGoal=goal.createGoal(root,{title:'Auto run cap',criteria:['stop at configured cap']});goal.updateGoal(root,capGoal.id,{autoAdvanceAuthorized:true});
  for(let index=0;index<waitConfig.autoAdvance.maxRunsPerGoal;index++){
    const cappedTask=goal.createTask(root,capGoal.id,{title:'Capped wait '+index});
    goal.updateTask(root,capGoal.id,cappedTask.id,{waitCondition:{kind:'time',description:'one release',nextCheckAt:new Date(Date.now()-1000).toISOString()}});
    goal.releaseDueTimeWaits(root);
    const token='auto-claim-cap-'+String(index).padStart(4,'0');
    goal.claimAutoAdvance(root,capGoal.id,cappedTask.id,token);
    goal.releaseAutoAdvanceClaim(root,capGoal.id,cappedTask.id,token,'test_no_dispatch');
  }
  const overCapTask=goal.createTask(root,capGoal.id,{title:'Beyond cap'});
  goal.updateTask(root,capGoal.id,overCapTask.id,{waitCondition:{kind:'time',description:'one release',nextCheckAt:new Date(Date.now()-1000).toISOString()}});goal.releaseDueTimeWaits(root);
  assert.throws(()=>goal.claimAutoAdvance(root,capGoal.id,overCapTask.id,'auto-claim-cap-overflow'),/Run 上限/);

  const unknownAutoGoal=goal.createGoal(root,{title:'Unknown auto result',criteria:['human review required']});goal.updateGoal(root,unknownAutoGoal.id,{autoAdvanceAuthorized:true});
  const unknownAutoTask=goal.createTask(root,unknownAutoGoal.id,{title:'Interrupted auto run'});
  goal.updateTask(root,unknownAutoGoal.id,unknownAutoTask.id,{waitCondition:{kind:'time',description:'release before interruption',nextCheckAt:new Date(Date.now()-1000).toISOString()}});goal.releaseDueTimeWaits(root);
  const unknownClaim=goal.claimAutoAdvance(root,unknownAutoGoal.id,unknownAutoTask.id,'auto-claim-interrupted-001');
  runStore.startRun(root,'auto-run-interrupted',{backend:'builtin',prompt:'one authorized auto run'});
  goal.admit(root,unknownAutoGoal.id,unknownAutoTask.id,'auto-run-interrupted',{autoAdvanceClaimId:unknownClaim.claimId});
  goal.reconcileAdmissions(root,new Set());
  const unknownAuto=goal.read(root).goals.find(item=>item.id===unknownAutoGoal.id).tasks.find(item=>item.id===unknownAutoTask.id);
  assert.equal(unknownAuto.executionStatus,'unknown');assert.equal(unknownAuto.autoAdvance.status,'unknown');
  assert.throws(()=>goal.claimAutoAdvance(root,unknownAutoGoal.id,unknownAutoTask.id,'auto-claim-unknown-retry'),/没有等待条件释放/,'an unknown Run requires the existing manual review path and is never auto-retried');

  goal.addDecision(root, created.id, { question: 'Choose deployment', options: ['A', 'B'], taskIds: [first.id] });
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'needs-user');
  const decision = goal.read(root).decisions[0];
  const resolvedDecision=goal.resolveDecision(root, decision.id, 'A', 'approved');
  assert.equal(resolvedDecision.revision,2);
  const decisionRevision=goal.read(root).revision;
  goal.resolveDecision(root, decision.id, 'A', 'approved');
  assert.equal(goal.read(root).revision,decisionRevision,'repeating the same business decision is idempotent');
  assert.equal(goal.canRun(root, created.id, first.id).decision, 'run');

  const generatedGoal=goal.createGoal(root,{title:'Generate reviewed experience',criteria:['related test passes']});
  const generatedTask=goal.createTask(root,generatedGoal.id,{title:'Update a source module',criteriaIds:[generatedGoal.criteria[0].id]});
  fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.writeFileSync(path.join(root,'src','module.cjs'),'module.exports=1;\n');
  goal.admit(root,generatedGoal.id,generatedTask.id,'run-experience-candidate');
  const verifiedRun={verified:true,status:'passed',files:['src/module.cjs'],checks:[{kind:'test',status:'passed',command:'node --test src/module.test.cjs',exitCode:0}]};
  const generatedEvidence=goal.recordRunEvidence(root,generatedGoal.id,generatedTask.id,'run-experience-candidate',verifiedRun);
  goal.settle(root,'run-experience-candidate',{status:'completed',verification:verifiedRun});
  let generatedContext=goal.read(root).goals.find(g=>g.id===generatedGoal.id).context.confirmedExperience;
  assert.equal(generatedContext.length,1,'a verified Goal Run automatically creates one reviewable experience candidate');
  assert.equal(generatedContext[0].generated,true);
  assert.equal(generatedContext[0].confirmed,false,'generated experience is never auto-confirmed');
  assert.equal(generatedContext[0].sourceRunId,'run-experience-candidate');
  assert.deepEqual(generatedContext[0].evidenceIds,generatedEvidence.map(item=>item.id));
  assert.match(generatedContext[0].content,/node --test src\/module\.test\.cjs/);
  assert.equal(goal.contextForRole(root,generatedGoal.id,generatedTask.id,'implement').context.confirmedExperience.length,0,'implementers cannot see an unreviewed generated suggestion');
  const generatedRevision=goal.read(root).revision;
  goal.settle(root,'run-experience-candidate',{status:'completed',verification:verifiedRun});
  assert.equal(goal.read(root).revision,generatedRevision,'duplicate settlement does not generate duplicate experience or advance revision');
  goal.confirmExperience(root,generatedGoal.id,generatedContext[0].id);
  generatedContext=goal.contextForRole(root,generatedGoal.id,generatedTask.id,'implement').context.confirmedExperience;
  assert.equal(generatedContext[0].sourceRunId,'run-experience-candidate','confirmed experience preserves provenance');

  const noTestGoal=goal.createGoal(root,{title:'No automatic learning without tests',criteria:['syntax is valid']});
  const noTestTask=goal.createTask(root,noTestGoal.id,{title:'Syntax only',criteriaIds:[noTestGoal.criteria[0].id]});
  goal.admit(root,noTestGoal.id,noTestTask.id,'run-no-test-experience');
  const syntaxOnly={verified:true,status:'passed',files:['src/module.cjs'],checks:[{kind:'syntax',status:'passed'}]};
  goal.recordRunEvidence(root,noTestGoal.id,noTestTask.id,'run-no-test-experience',syntaxOnly);
  goal.settle(root,'run-no-test-experience',{status:'completed',verification:syntaxOnly});
  assert.equal(goal.read(root).goals.find(g=>g.id===noTestGoal.id).context.confirmedExperience.length,0,'a syntax-only result does not create a test-method suggestion');

  const staleSuggestionGoal=goal.createGoal(root,{title:'No suggestion from stale evidence',criteria:['related test passes']});
  const staleSuggestionTask=goal.createTask(root,staleSuggestionGoal.id,{title:'Update a stale module',criteriaIds:[staleSuggestionGoal.criteria[0].id]});
  const staleModule=path.join(root,'src','stale-module.cjs');fs.writeFileSync(staleModule,'module.exports=1;\n');
  const staleVerification={...verifiedRun,files:['src/stale-module.cjs']};
  goal.admit(root,staleSuggestionGoal.id,staleSuggestionTask.id,'run-stale-experience-candidate');
  goal.recordRunEvidence(root,staleSuggestionGoal.id,staleSuggestionTask.id,'run-stale-experience-candidate',staleVerification);
  fs.appendFileSync(staleModule,'module.exports=2;\n');
  goal.settle(root,'run-stale-experience-candidate',{status:'completed',verification:staleVerification});
  const staleSuggestion=goal.read(root).goals.find(g=>g.id===staleSuggestionGoal.id);
  assert.equal(staleSuggestion.tasks[0].status,'blocked','stale evidence keeps the Task blocked');
  assert.equal(staleSuggestion.context.confirmedExperience.length,0,'stale evidence cannot produce a generated experience candidate');

  goal.addContext(root, created.id, 'rules', { content: 'Use the existing test runner.' });
  goal.addContext(root, created.id, 'taskMaterial', { content: 'Acceptance fixture path is tests/fixture.txt.' });
  const experienceCandidate = goal.addContext(root, created.id, 'confirmedExperience', { content: 'verified runner behavior', confirmed: true });
  assert.equal(experienceCandidate.confirmed, false, 'renderer input cannot self-confirm shared experience');
  goal.confirmExperience(root, created.id, experienceCandidate.id);
  const experienceRevision=goal.read(root).revision;
  assert.equal(goal.confirmExperience(root, created.id, experienceCandidate.id).confirmed, true, 'user confirmation is idempotent');
  assert.equal(goal.read(root).revision,experienceRevision,'duplicate confirmation does not mutate the context revision');
  const implementContext = goal.contextForRole(root, created.id, first.id, 'implement');
  assert.equal(implementContext.task.id, first.id);
  assert.deepEqual(implementContext.context.confirmedExperience.map(x => x.content), ['verified runner behavior']);
  assert.equal(goal.contextForRole(root, created.id, first.id, 'explore').context.taskMaterial, undefined);
  assert.equal(goal.contextForRole(root, created.id, first.id, 'verify').context.confirmedExperience, undefined);
  assert.equal(goal.contextForRole(root, created.id, first.id, 'review').context.taskMaterial.length, 1);
  assert.equal(goal.contextForRole(root, created.id, first.id, 'canvas').context.rules.length, 1);

  goal.admit(root, created.id, first.id, 'run-completed');
  goal.settle(root, 'run-completed', { status: 'completed', usage: { total_tokens: 30 } });
  assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t => t.id === first.id).status, 'blocked', 'execution completion is not acceptance');
  assert.throws(() => goal.updateGoal(root, created.id, { status: 'completed' }), /尚未满足完成条件/);
  const evidence = goal.recordEvidence(root, created.id, { taskId: first.id, criterionId, runId: 'verify-1', check: 'npm test', status: 'passed', result: 'exit code 0' });
  assert.equal(evidence.status, 'passed');
  assert.equal(goal.read(root).goals.find(g=>g.id===created.id).tasks.find(t => t.id === first.id).status, 'completed');
  assert.equal(goal.audit(root, created.id).qualified, false, 'uncompleted required Tasks and evidence remain blocking');
  const evidenceGoal=goal.read(root).goals.find(g=>g.id===created.id);
  assert.equal(goal.evidenceStatus(evidenceGoal,evidence,evidence.sourceFingerprint,true,goal.environment()).valid,true);
  assert.equal(goal.evidenceStatus(evidenceGoal,evidence,evidence.sourceFingerprint,true,{...goal.environment(),node:'next-runtime'}).reason,'运行环境已变化');

  goal.updateGoal(root, created.id, { criteria: [{ id: criterionId, text: 'tests and lint pass' }] });
  assert.equal(goal.audit(root, created.id).evidence.find(e => e.id === evidence.id).freshness.valid, false, 'criteria revision invalidates prior evidence');

  fs.appendFileSync(path.join(root, 'source.txt'), 'changed after evidence\n');
  const stale = goal.audit(root, created.id);
  assert.equal(stale.evidence.find(e => e.id === evidence.id).freshness.valid, false);
  assert.throws(() => goal.updateGoal(root, created.id, { status: 'completed' }), /尚未满足完成条件/);
  assert.equal(goal.canRun(root, created.id).decision, 'run', 'stale evidence reopens eligible work');

  const paused = goal.updateGoal(root, created.id, { status: 'paused' });
  assert.equal(paused.status, 'paused');
  assert.equal(goal.canRun(root, created.id).decision, 'stopped');
  const stopped=goal.updateGoal(root,created.id,{status:'stopped',stopReason:'external blocker'});
  assert.equal(stopped.stopReason,'external blocker');
  assert.equal(goal.canRun(root,created.id).reason,'external blocker');
  assert.throws(()=>goal.updateGoal(root,created.id,{status:'active'}),/不能从 stopped 切换/);

  const finishGoal=goal.createGoal(root,{title:'Qualified completion',criteria:['artifact verified']});
  goal.recordEvidence(root,finishGoal.id,{criterionId:finishGoal.criteria[0].id,runId:'goal-only-verification',check:'reviewed artifact',status:'passed',result:'verified'});
  assert.equal(goal.audit(root,finishGoal.id).qualified,true);
  assert.equal(goal.updateGoal(root,finishGoal.id,{status:'completed'}).status,'completed');
  assert.throws(()=>goal.updateGoal(root,finishGoal.id,{status:'active'}),/不能从 completed 切换/);
  console.log('GOAL STORE: PASS (acceptance criteria, atomic admission, dependency/wait/decision gates, role context, evidence freshness, reviewed experience suggestions, budgets, no execution-as-acceptance)');
} finally {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-goal-store-')) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
