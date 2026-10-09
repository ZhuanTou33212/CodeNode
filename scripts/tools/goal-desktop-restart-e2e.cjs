'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PREFIX = 'codenode-goal-desktop-restart-';
const GOAL_TITLE = 'Desktop restart recovery';
const TASK_TITLE = 'Interrupted real desktop task';
const RUN_ID = 'desktop-restart-interrupted-run';

function spawnElectronPhase(root, phase) {
  const cli = path.join(__dirname, '../../node_modules/electron/cli.js');
  const env = {
    ...process.env,
    CODENODE_DESKTOP_RESTART_ROOT: root,
    CODENODE_DESKTOP_RESTART_PHASE: phase,
    CODENODE_USER_DATA_DIR: path.join(root, 'userdata'),
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    electron_config_cache: process.env.electron_config_cache || path.join(process.cwd(), '.cache', 'electron'),
  };
  return spawnSync(process.execPath, [cli, __filename], {
    cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
}

function cleanTemp(root) {
  const resolved = path.resolve(root);
  const temp = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith(PREFIX)) throw new Error('Refusing to clean unexpected Goal restart path: ' + resolved);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function runParent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  try {
    const first = spawnElectronPhase(project, 'prepare');
    if (first.error || first.status !== 0) throw new Error('First Electron process failed: ' + (first.error?.message || first.stderr || first.stdout || first.status));
    const firstResult = JSON.parse(String(first.stdout).split(/\r?\n/).find(line => line.startsWith('GOAL_RESTART_PHASE='))?.slice('GOAL_RESTART_PHASE='.length) || 'null');
    assert.equal(firstResult?.phase, 'prepare');
    assert(Number.isInteger(firstResult?.pid), 'first phase reports its Electron process ID');

    const second = spawnElectronPhase(project, 'recover');
    if (second.error || second.status !== 0) throw new Error('Second Electron process failed: ' + (second.error?.message || second.stderr || second.stdout || second.status));
    const secondResult = JSON.parse(String(second.stdout).split(/\r?\n/).find(line => line.startsWith('GOAL_RESTART_PHASE='))?.slice('GOAL_RESTART_PHASE='.length) || 'null');
    assert.equal(secondResult?.phase, 'recover');
    assert.notEqual(secondResult?.pid, firstResult.pid, 'recovery must run in a different Electron process');
    assert.equal(secondResult?.recoveredAdmissions, 1);
    assert.equal(secondResult?.runStatus, 'interrupted');
    assert.equal(secondResult?.settlementStatus, 'unknown');
    assert.equal(secondResult?.taskStatus, 'blocked');
    assert.equal(secondResult?.taskExecutionStatus, 'unknown');
    assert.equal(secondResult?.costUnknown, true);
    assert.equal(secondResult?.secondRefreshRecoveries, 0, 'refreshing again does not repeat restart recovery');
    assert.equal(secondResult?.reviewedRunId,RUN_ID);
    assert.deepEqual(secondResult?.reviewedFiles,['src/changed.cjs']);
    assert.equal(secondResult?.requeuedTaskStatus,'todo');
    assert.equal(secondResult?.requeuedTaskExecutionStatus,'reviewed');
    assert.equal(secondResult?.canRunAfterUserReview,'run');
    console.log(JSON.stringify({
      phase1Pid: firstResult.pid,
      phase2Pid: secondResult.pid,
      runStatus: secondResult.runStatus,
      settlementStatus: secondResult.settlementStatus,
      taskStatus: secondResult.taskStatus,
      idempotentSecondRefresh: true,
    }));
    console.log('GOAL DESKTOP RESTART E2E: PASS (desktop restart, persisted unknown Run, reviewed file-diff acknowledgement, direct requeue blocked, UI requeue admitted)');
  } finally {
    cleanTemp(root);
  }
}

async function runElectronPhase() {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.on('browser-window-created', (_event, window) => window.hide());
  require('../../electron/main.cjs');
  const project = path.resolve(process.env.CODENODE_DESKTOP_RESTART_ROOT || '');
  const phase = process.env.CODENODE_DESKTOP_RESTART_PHASE;

  await app.whenReady();
  const goalStore = require('../../electron/goalStore.cjs');
  const runStore = require('../../electron/runStore.cjs');
  if (phase === 'prepare') {
    fs.writeFileSync(path.join(project, 'baseline.txt'), 'persisted before closing the desktop process\n');
    const goal = goalStore.createGoal(project, { title: GOAL_TITLE, criteria: ['verify after restart'] });
    const task = goalStore.createTask(project, goal.id, { title: TASK_TITLE, criteriaIds: [goal.criteria[0].id] });
    assert(runStore.startRun(project, RUN_ID, { backend: 'builtin', prompt: 'leave this Run unresolved across desktop restart' }));
    goalStore.admit(project, goal.id, task.id, RUN_ID);
    fs.mkdirSync(path.join(project,'src'),{recursive:true});
    fs.writeFileSync(path.join(project,'src','changed.cjs'),'module.exports = "after restart";\n');
    runStore.appendEvent(project,RUN_ID,'backend_changes',{changes:{complete:true,scope:'E2E project snapshot',files:[{path:'src/changed.cjs',kind:'modified',before:'b'.repeat(64),after:'a'.repeat(64)}]}});
    process.stdout.write('GOAL_RESTART_PHASE=' + JSON.stringify({ phase, pid: process.pid, goalId: goal.id, taskId: task.id }) + '\n');
    app.exit(0);
    return;
  }
  if (phase !== 'recover') throw new Error('Unknown restart test phase');

  const deadline = Date.now() + 20000;
  let window = null;
  while (Date.now() < deadline && !window) {
    window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed()) || null;
    if (!window) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!window) throw new Error('Main window did not start in the recovery process');
  while (Date.now() < deadline) {
    try { if (await window.webContents.executeJavaScript('!!window.codenode?.goalList')) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!(await window.webContents.executeJavaScript('!!window.codenode?.goalList'))) throw new Error('Renderer bridge did not load');

  const firstRefresh = await window.webContents.executeJavaScript(`window.codenode.goalList(${JSON.stringify(project)})`);
  assert.equal(firstRefresh.ok, true);
  const goal = firstRefresh.value.goals.find(item => item.title === GOAL_TITLE);
  assert(goal, 'persisted Goal is visible after reopening');
  const task = goal.tasks.find(item => item.title === TASK_TITLE);
  assert(task, 'persisted Task is visible after reopening');
  const run = runStore.summarizeRun(runStore.readRun(project, RUN_ID));
  const settlement = firstRefresh.value.settlements.find(item => item.runId === RUN_ID);
  const revision = goalStore.read(project).revision;
  const secondRefresh = await window.webContents.executeJavaScript(`window.codenode.goalList(${JSON.stringify(project)})`);
  const secondGoal = secondRefresh.value.goals.find(item => item.title === GOAL_TITLE);
  assert.equal(goalStore.read(project).revision, revision, 'second list call is idempotent before user review writes its audit record');
  await window.webContents.executeJavaScript(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
  await window.webContents.executeJavaScript(`window.__codenodeUi.getState().setSideTab('agent')`);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="切换到总览"]').click()`);
  const panelDeadline=Date.now()+10000;
  while(Date.now()<panelDeadline){
    if(await window.webContents.executeJavaScript("!!document.querySelector('.goal-control-panel .goal-toolbar select')"))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const panelReady=await window.webContents.executeJavaScript("!!document.querySelector('.goal-control-panel .goal-toolbar select')");
  assert.equal(panelReady,true,'Goal control panel is mounted in the Agent side panel');
  await window.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('.goal-control-panel');panel.open=true;const select=panel.querySelector('.goal-toolbar select');select.value=${JSON.stringify(goal.id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const taskDeadline=Date.now()+10000;
  while(Date.now()<taskDeadline){
    if(await window.webContents.executeJavaScript(`!![...document.querySelectorAll('.goal-control-panel .goal-task')].find(button=>button.textContent.includes(${JSON.stringify(TASK_TITLE)}))`))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.goal-control-panel .goal-task')].find(button=>button.textContent.includes(${JSON.stringify(TASK_TITLE)})).click())()`);
  const directRequeue=await window.webContents.executeJavaScript(`window.codenode.goalTaskUpdate(${JSON.stringify(project)},${JSON.stringify(goal.id)},${JSON.stringify(task.id)},{status:'todo'})`);
  assert.equal(directRequeue.ok,false,'unknown Run cannot bypass review through direct Goal IPC');
  assert.match(directRequeue.error,/查看对应 Run 差异/);
  const initialRequeueState=await window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('.goal-control-panel button')].find(item=>item.textContent==='确认复核并重新排队');return button?{exists:true,disabled:button.disabled}:{exists:false};})()`);
  assert.equal(initialRequeueState.exists,true);assert.equal(initialRequeueState.disabled,true,'requeue stays disabled until Run details are reviewed');
  await window.webContents.executeJavaScript(`document.querySelector('[data-testid=goal-run-review] button').click()`);
  const reviewDeadline=Date.now()+10000;
  while(Date.now()<reviewDeadline){
    if(await window.webContents.executeJavaScript("document.querySelector('.goal-run-review-detail')?.innerText.includes('src/changed.cjs')"))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const reviewText=await window.webContents.executeJavaScript("document.querySelector('.goal-run-review-detail')?.innerText||''");
  assert.match(reviewText,/src\/changed\.cjs/);assert.match(reviewText,/bbbbbbbbbbbb/);assert.match(reviewText,/aaaaaaaaaaaa/);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="我已查看 Run 差异并核对外部副作用"]').click()`);
  const enabledAfterReview=await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.goal-control-panel button')].find(button=>button.textContent==='确认复核并重新排队')?.disabled===false)()`);
  assert.equal(enabledAfterReview,true,'explicit acknowledgment enables requeue');
  await window.webContents.executeJavaScript(`(()=>[...document.querySelectorAll('.goal-control-panel button')].find(button=>button.textContent==='确认复核并重新排队').click())()`);
  const requeueDeadline=Date.now()+10000;
  let requeued=null;
  while(Date.now()<requeueDeadline){
    requeued=await window.webContents.executeJavaScript(`window.codenode.goalList(${JSON.stringify(project)}).then(result=>result.value.goals.find(item=>item.id===${JSON.stringify(goal.id)}).tasks.find(item=>item.id===${JSON.stringify(task.id)}))`);
    if(requeued?.status==='todo')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(requeued?.status,'todo');assert.equal(requeued?.executionStatus,'reviewed');
  const canRun=await window.webContents.executeJavaScript(`window.codenode.goalCanRun(${JSON.stringify(project)},${JSON.stringify(goal.id)},${JSON.stringify(task.id)})`);
  assert.equal(canRun.value.decision,'run');
  const payload = {
    phase,
    pid: process.pid,
    recoveredAdmissions: firstRefresh.value.recoveredAdmissions.count,
    runStatus: run.status,
    settlementStatus: settlement?.status,
    taskStatus: task.status,
    taskExecutionStatus: task.executionStatus,
    costUnknown: goal.budget.costUnknown,
    secondRefreshRecoveries: secondRefresh.value.recoveredAdmissions.count,
    reviewedRunId: RUN_ID,
    reviewedFiles: ['src/changed.cjs'],
    requeuedTaskStatus: requeued.status,
    requeuedTaskExecutionStatus: requeued.executionStatus,
    canRunAfterUserReview: canRun.value.decision,
  };
  assert.equal(secondGoal.tasks.find(item => item.id === task.id).status, 'blocked');
  process.stdout.write('GOAL_RESTART_PHASE=' + JSON.stringify(payload) + '\n');
  app.exit(0);
}

if (process.versions.electron) runElectronPhase().catch(error => { console.error(error?.stack || error); require('electron').app.exit(1); });
else {
  try { runParent(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
