'use strict';
// Opt-in live acceptance: real desktop scheduler, IPC and installed OpenCode; no mocked model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const PREFIX = 'codenode-goal-auto-live-';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packageRoot = process.env.CODENODE_AUTO_LIVE_PACKAGE;
const sourceRoot = path.resolve(__dirname, '../..');
const appRoot = packageRoot ? path.join(path.resolve(packageRoot), 'resources/app.asar') : sourceRoot;

async function parent() {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, PREFIX));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const results = [];
  try {
    for (const phase of ['success-failure', 'interrupt', 'recover']) {
      const result = cp.spawnSync(process.execPath, [path.join(sourceRoot, 'node_modules/electron/cli.js'), __filename], {
        cwd: sourceRoot, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CODENODE_AUTO_LIVE_ROOT: root, CODENODE_AUTO_LIVE_PHASE: phase,
          CODENODE_USER_DATA_DIR: path.join(root, 'userdata'), CODENODE_HOME: path.join(root, 'home'), CODENODE_SOUL_FILE: path.join(root, 'soul.md') },
      });
      const line = String(result.stdout).split(/\r?\n/).find(x => x.startsWith('GOAL_AUTO_LIVE='));
      if (result.error || result.status !== 0 || !line) throw new Error(phase + ': ' + (result.error?.message || result.stderr || result.stdout || result.status));
      const summary = JSON.parse(line.slice('GOAL_AUTO_LIVE='.length));
      results.push(summary);
      console.log(JSON.stringify(summary));
    }
    assert.equal(results[0].claimRefreshes,6,'both live success and failed-start claims survive three Goal refreshes');
    assert.equal(new Set(results.map(r => r.pid)).size, 3, 'restart uses separate main processes');
    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const codeSha=relative=>crypto.createHash('sha256').update(packageRoot?require('@electron/asar').extractFile(path.join(appRoot,'..','app.asar'),path.normalize(relative)):fs.readFileSync(path.join(sourceRoot,relative))).digest('hex');
    const report = { backendPortSha256: codeSha('electron/backends/backendPort.cjs'), backendConfigSha256: codeSha('config/agent.backends.json'), scriptSha256: sha(__filename), managerSourceSha256: sha(path.join(sourceRoot,'src/components/GoalAutoAdvanceManager.tsx')), ...(packageRoot ? { asarSha256: sha(path.join(appRoot,'..','app.asar')) } : {}), passed: true, recordedAt: new Date().toISOString(), backend: 'opencode', runtime: cp.execFileSync(require('../../electron/backends/stdioRpc.cjs').resolveCommand('opencode').command, ['--version'], {encoding:'utf8',windowsHide:true}).trim(), package: packageRoot ? 'packaged' : 'source', results };
    const reportFile = process.env.CODENODE_AUTO_LIVE_REPORT;
    if (reportFile) fs.writeFileSync(path.resolve(reportFile), JSON.stringify(report, null, 2) + '\n');
    console.log('GOAL AUTO ADVANCE LIVE E2E: PASS (real model, wait timer, explicit UI authorization, settlement, failed start, pre-admission restart, interrupted model restart; no automatic retry)');
  } finally {
    // Delete only sessions created by this isolated acceptance run.
    const store = require('../../electron/runStore.cjs');
    const command = require('../../electron/backends/stdioRpc.cjs').resolveCommand('opencode');
    const sessions = new Set(store.listRuns(project, 100).flatMap(run => store.readRun(project, run.runId).filter(e => e.type === 'backend_session' && e.sessionId).map(e => e.sessionId)));
    let cleanupError;
    for (const id of sessions) {
      try { cp.execFileSync(command.command, [...command.prefix, 'session', 'delete', id], { cwd: sourceRoot, windowsHide: true, stdio: 'ignore', timeout: 20000 }); }
      catch (error) { cleanupError = error; }
    }
    if (path.dirname(root) !== temp || !path.basename(root).startsWith(PREFIX)) throw new Error('Unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (cleanupError) throw new Error('Could not delete a test-created OpenCode session');
  }
}

async function desktop() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(process.env.CODENODE_AUTO_LIVE_ROOT);
  const project = path.join(root, 'project');
  const phase = process.env.CODENODE_AUTO_LIVE_PHASE;
  const goals = require(path.join(appRoot, 'electron/goalStore.cjs'));
  const runs = require(path.join(appRoot, 'electron/runStore.cjs'));
  const settings = require(path.join(appRoot, 'electron/backends/settings.cjs'));
  const config = require(path.join(appRoot, 'config/agent.backends.json'));
  const stateFile = path.join(root, 'state.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const backend = { ...config.defaults, backend: 'opencode', executable: 'opencode', args: ['acp'], sandbox: 'read-only' };
  const originalSpawn = cp.spawn;
  const children = new Set();
  // Observe actual child processes for cleanup after simulating an abrupt main-process exit.
  cp.spawn = function (...args) { const child = originalSpawn.apply(this, args); children.add(child); return child; };
  let claimRefresh = null;
  let claimRefreshes = 0;
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => register(channel, channel === 'goal:auto-advance-claim' ? async (...args) => {
    const result = await handler.apply(null,args);
    // Keep the real IPC response pending while the same project refreshes its Goal list.
    if (result.ok && claimRefresh) {
      for (let i=0;i<3;i++) { await claimRefresh(); claimRefreshes++; await sleep(100); }
    }
    return result;
  } : handler);
  app.disableHardwareAcceleration();
  app.on('browser-window-created', (_event, win) => win.hide());
  require(path.join(appRoot, 'electron/main.cjs'));
  await app.whenReady();
  const waitFor = async (fn, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await sleep(100); }
    throw new Error('Timeout: ' + label);
  };
  /** @type {any} */
  let win;
  await waitFor(() => { win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()); return !!win; }, 'window', 20000);
  const js = code => win.webContents.executeJavaScript(code);
  await waitFor(() => js('!!window.__codenodeProject && !!window.codenode').catch(() => false), 'renderer', 20000);
  await js('window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})');
  await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)})`);
  await js('window.__codenodeUi.getState().setSideOpen(true)');
  await js(`document.querySelector('[aria-label="切换到总览"]').click()`);
  const getGoal = id => goals.read(project).goals.find(g => g.id === id);
  const getTask = id => getGoal(id).tasks[0];
  const list = () => js(`(async()=>{const result=await window.codenode.goalList(${JSON.stringify(project)});document.querySelector('.goal-toolbar button')?.click();return result;})()`);
  const create = (title, prompt, due = 1500) => {
    const g = goals.createGoal(project, { title, objective: prompt, criteria: ['independent acceptance required'] });
    const t = goals.createTask(project, g.id, { title, objective: prompt, criteriaIds: [g.criteria[0].id] });
    goals.updateTask(project, g.id, t.id, { waitCondition: {kind:'time',description:'live desktop timer',nextCheckAt:new Date(Date.now()+due).toISOString()} });
    return g.id;
  };
  const authorizeUi = async id => {
    await waitFor(()=>js(`!!document.querySelector('[data-goal-id="${id}"]')`),'overview goal');
    await js(`document.querySelector('[data-goal-id="${id}"]').click()`);
    await waitFor(() => js(`!!document.querySelector('.goal-control-panel .goal-toolbar select option[value="${id}"]')`), 'Goal option');
    await js(`(()=>{const p=document.querySelector('.goal-control-panel');p.open=true;const s=p.querySelector('.goal-toolbar select');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(() => js(`document.querySelector('.goal-toolbar select')?.value===${JSON.stringify(id)} && !!document.querySelector('[aria-label="等待条件满足后自动推进"]')`), 'Goal authorization toggle');
    assert.equal(await js('document.querySelector(\'[aria-label="等待条件满足后自动推进"]\').checked'), false);
    await js(`document.querySelector('.goal-auto-options').open=true`);
    await js('document.querySelector(\'[aria-label="等待条件满足后自动推进"]\').click()');
    await waitFor(() => getGoal(id).autoAdvanceAuthorized === true, 'persisted explicit UI authorization');
  };
  const newSession = () => js('window.__codenodeSession.getState().newCanvas()');
  const noRetry = async ids => {
    const before = ids.map(id => [getGoal(id).autoAdvanceUsedRuns, getTask(id).runIds.length]);
    const totalRuns = runs.listRuns(project, 100).length;
    for (let i=0;i<4;i++) { await list(); await sleep(800); }
    assert.deepEqual(ids.map(id => [getGoal(id).autoAdvanceUsedRuns, getTask(id).runIds.length]), before);
    assert.equal(runs.listRuns(project,100).length,totalRuns,'refresh cannot launch another Run');
  };
  const finish = summary => { fs.writeFileSync(stateFile, JSON.stringify(state)); console.log('GOAL_AUTO_LIVE='+JSON.stringify({phase,pid:process.pid,...summary})); app.exit(0); };

  if (phase === 'success-failure') {
    claimRefresh = () => js("document.querySelector('.goal-toolbar button')?.click()");
    settings.write(project, path.join(root,'userdata'), 'project', backend);
    fs.writeFileSync(path.join(project,'opencode.json'), JSON.stringify({permission:{'*':'deny'}}));
    await newSession();
    const nonce = 'AUTO_LIVE_' + Date.now().toString(36);
    state.success = create('Live success', `Reply with exactly ${nonce}. Do not use any tools.`, 500);
    await list();
    await waitFor(() => getTask(state.success).status === 'ready', 'unauthorized wait released');
    await sleep(1000);
    assert.equal(runs.listRuns(project,100).length,0,'no prompt before authorization');
    await authorizeUi(state.success);
    await waitFor(() => getTask(state.success).autoAdvance?.status === 'settled', 'real model settlement');
    const task = getTask(state.success);
    assert.equal(task.autoAdvance.runStatus,'completed');
    assert.equal(task.runIds.length,1);
    const runId = task.runIds[0];
    const events = runs.readRun(project,runId);
    const end = events.find(e => e.type === 'run_finish');
    assert.equal(end?.state,'COMPLETED');
    assert(events.some(e => e.type === 'backend_session'),'real ACP session persisted');
    assert.equal(task.status,'blocked','a reply alone does not satisfy independent Task criteria');
    assert(await js(`window.__codenodeSession.getState().messages.some(m=>m.role==='assistant'&&m.content.includes(${JSON.stringify(nonce)}))`),'fresh sentinel in real model reply');
    await waitFor(() => js('window.__codenodeChat.getState().inflight.size()===0'), 'chat idle');
    await noRetry([state.success]);
    await newSession();
    settings.write(project,path.join(root,'userdata'),'project',{...backend,executable:path.join(root,'missing-agent.exe')});
    state.failure = create('Failed startup','Reply AUTO_SHOULD_NOT_RUN without tools.',8000);
    await list(); await authorizeUi(state.failure);
    await waitFor(() => getTask(state.failure).autoAdvance?.status === 'settled', 'failed backend settlement');
    assert.equal(getTask(state.failure).autoAdvance.runStatus,'failed');
    assert.equal(getTask(state.failure).runIds.length,1);
    await noRetry([state.success,state.failure]);
    settings.write(project,path.join(root,'userdata'),'project',backend);
    claimRefresh = null;
    state.claim = create('Unadmitted restart','This claim must not start after restart.',0);
    // Stay outside renderer refresh: emulate process loss between the real claim IPC and dispatch.
    goals.updateGoal(project,state.claim,{autoAdvanceAuthorized:true});
    const claimTask=getTask(state.claim);
    await js(`window.codenode.goalList(${JSON.stringify(project)})`);
    const claim=await js(`window.codenode.goalAutoAdvanceClaim(${JSON.stringify(project)},${JSON.stringify(state.claim)},${JSON.stringify(claimTask.id)})`);
    assert.equal(claim.ok,true);
    assert.equal(getTask(state.claim).autoAdvance.status,'claimed');
    finish({successRunId:runId,claimRefreshes,realReplySentinel:true,successSettlement:'completed',taskWithoutEvidence:'blocked',failedSettlement:'failed',unauthorizedRuns:0,repeatedRefreshNoRetry:true,unadmittedClaim:true});
    return;
  }
  if (phase === 'interrupt') {
    await list();
    assert.equal(getTask(state.claim).autoAdvance.status,'failed');
    assert.equal(getTask(state.claim).autoAdvance.reason,'app_restarted_before_admission');
    await noRetry([state.success,state.failure,state.claim]);
    settings.write(project,path.join(root,'userdata'),'project',backend);
    await newSession();
    state.interrupt = create('Interrupt real model','Write a detailed explanation of reliable task scheduling, at least 3000 words. Do not use any tools.',8000);
    await list();
    const send = win.webContents.send.bind(win.webContents);
    let interrupted=false;
    win.webContents.send = (channel,...args) => {
      send(channel,...args);
      if(channel==='agent:delta' && args[0]?.kind==='content' && !interrupted){
        interrupted=true;
        const task=getTask(state.interrupt);
        assert.equal(task.autoAdvance.status,'started');
        assert.equal(task.executionStatus,'running');
        state.interruptedRunId=task.runIds[0];
        fs.writeFileSync(stateFile,JSON.stringify(state));
        // Synchronous termination leaves no opportunity to settle the main-process Run.
        for(const child of children){if(child.pid&&child.exitCode===null){try{cp.spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{}}}
        finish({preAdmissionRestartNoRetry:true,interruptedRunId:state.interruptedRunId,interruptedAfterRealModelChunk:true});
      }
    };
    await authorizeUi(state.interrupt);
    await waitFor(()=>false,'real model chunk interruption');
    return;
  }
  if(phase==='recover'){
    await list();
    const task=getTask(state.interrupt);
    assert.equal(task.executionStatus,'unknown');assert.equal(task.status,'blocked');
    assert.equal(task.autoAdvance.status,'unknown');
    assert.equal(runs.summarizeRun(runs.readRun(project,state.interruptedRunId)).status,'interrupted');
    const can=await js(`window.codenode.goalCanRun(${JSON.stringify(project)},${JSON.stringify(state.interrupt)},${JSON.stringify(task.id)})`);
    assert.notEqual(can.value.decision,'run');
    await noRetry([state.success,state.failure,state.claim,state.interrupt]);
    finish({recoveredRunStatus:'interrupted',executionStatus:'unknown',taskStatus:'blocked',automaticRetry:false,totalRuns:runs.listRuns(project,100).length});
    return;
  }
  throw new Error('Unknown live acceptance phase');
}
if(process.versions.electron) desktop().catch(error=>{console.error(require('../../electron/redaction.cjs').redact(error.stack||String(error)));require('electron').app.exit(1);});
else parent().catch(error=>{console.error(require('../../electron/redaction.cjs').redact(error.stack||String(error)));process.exitCode=1;});
