'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const goalStore = require('../../electron/goalStore.cjs');
const runStore = require('../../electron/runStore.cjs');
app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-backend-ui-'));
const projectRoot = path.join(root, 'project');
fs.mkdirSync(projectRoot, { recursive: true });
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userdata');
let win;
app.on('browser-window-created', (_event, window) => { win = window; });
require(process.env.CODENODE_UI_TEST_PACKAGE ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources/app.asar/electron/main.cjs') : '../../electron/main.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(`(async () => { return (${code}); })()`)
  .catch(error => { throw new Error(String(error) + '\nRenderer: ' + code); });
async function waitFor(check, label) {
  console.log('UI check:', label);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error('Timeout: ' + label);
}
app.whenReady().then(async () => {
  try {
    await waitFor(() => win && js('!!window.__codenodeProject').catch(() => false), 'stores');
    win.hide();
    await js(`window.__codenodeUi.getState().updatePreferences({autoSaveEnabled:false})`);
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(projectRoot)})`);
    await waitFor(() => js('!!document.querySelector(".pp-input")'), 'composer');
    await js(`window.__codenodeSession.getState().newCanvas()`);
    await js(`window.__codenodeSession.getState().pushUser('保留会话')`);
    await js(`window.__codenodeUi.getState().setSideOpen(true)`);
    await waitFor(() => js('!!document.querySelector(".goal-control-panel")'), 'Goal panel');
    const goal = await js(`window.codenode.goalCreate(${JSON.stringify(projectRoot)}, {title:'UI Goal',criteria:['验收通过']})`);
    assert.equal(goal.ok, true);
    const task = await js(`window.codenode.goalTaskCreate(${JSON.stringify(projectRoot)}, ${JSON.stringify(goal.value.id)}, {title:'UI Task', criteriaIds:[${JSON.stringify(goal.value.criteria[0].id)}], writeScope:['src']})`);
    assert.equal(task.ok, true);
    const experience = await js(`window.codenode.goalContextAdd(${JSON.stringify(projectRoot)}, ${JSON.stringify(goal.value.id)}, 'confirmedExperience', {content:'UI confirmed workflow',source:'ui-test',confirmed:true})`);
    assert.equal(experience.value.confirmed, false, 'renderer cannot self-confirm an experience candidate');
    const waitTask=await js(`window.codenode.goalTaskCreate(${JSON.stringify(projectRoot)},${JSON.stringify(goal.value.id)},{title:'UI CI wait'})`);
    assert.equal(waitTask.ok,true);
    const waitSaved=await js(`window.codenode.goalTaskUpdate(${JSON.stringify(projectRoot)},${JSON.stringify(goal.value.id)},${JSON.stringify(waitTask.value.id)},{waitCondition:{kind:'external_status',provider:'github-actions',description:'CI for current commit',expected:'success'}})`);
    assert.equal(waitSaved.ok,true);
    const reviewTask=await js(`window.codenode.goalTaskCreate(${JSON.stringify(projectRoot)},${JSON.stringify(goal.value.id)},{title:'UI Run review task'})`);
    assert.equal(reviewTask.ok,true);
    fs.mkdirSync(path.join(projectRoot,'src'),{recursive:true});
    fs.writeFileSync(path.join(projectRoot,'src','goal-review.cjs'),'module.exports = "current";\n');
    runStore.startRun(projectRoot,'ui-unknown-review-run',{backend:'builtin',prompt:'interrupted Goal Run review UI'});
    goalStore.admit(projectRoot,goal.value.id,reviewTask.value.id,'ui-unknown-review-run');
    runStore.appendEvent(projectRoot,'ui-unknown-review-run','backend_changes',{changes:{complete:true,scope:'UI test workspace',files:[{path:'src/goal-review.cjs',kind:'modified',before:'c'.repeat(64),after:'d'.repeat(64)}]}});
    runStore.recoverInterrupted(projectRoot,new Set());goalStore.reconcileAdmissions(projectRoot,new Set());
    const verifiedRun={verified:true,status:'passed',files:['src/ui-module.cjs'],checks:[{kind:'test',status:'passed',command:'node --test src/ui-module.test.cjs',exitCode:0}]};
    fs.mkdirSync(path.join(projectRoot,'src'),{recursive:true});fs.writeFileSync(path.join(projectRoot,'src','ui-module.cjs'),'module.exports=1;\n');
    goalStore.admit(projectRoot,goal.value.id,task.value.id,'ui-generated-experience-run');
    goalStore.recordRunEvidence(projectRoot,goal.value.id,task.value.id,'ui-generated-experience-run',verifiedRun);
    goalStore.settle(projectRoot,'ui-generated-experience-run',{status:'completed',verification:verifiedRun});
    await js(`document.querySelector('.goal-control-panel summary').click()`);
    await js(`document.querySelector('.goal-toolbar button').click()`);
    await sleep(100);
    await waitFor(() => js(`document.querySelector('.goal-control-panel')?.innerText.includes('UI Task') && document.querySelector('.goal-control-panel')?.innerText.includes('UI confirmed workflow') && document.querySelector('.goal-control-panel')?.innerText.includes('自动建议')`), 'Goal, Task, and generated experience rendering');
    await js(`[...document.querySelectorAll('.goal-control-panel button')].find(b=>b.textContent==='确认写入项目经验').click()`);
    const confirmedContext = await js(`window.codenode.goalContextForRole(${JSON.stringify(projectRoot)}, ${JSON.stringify(goal.value.id)}, ${JSON.stringify(task.value.id)}, 'implement')`);
    assert.equal(confirmedContext.value.context.confirmedExperience[0].content, 'UI confirmed workflow');
    assert.equal(confirmedContext.value.context.confirmedExperience.some(item=>item.sourceRunId==='ui-generated-experience-run'),false,'generated suggestions remain hidden from implementers until explicit confirmation');
    await js(`[...document.querySelectorAll('.goal-control-panel button')].find(b=>b.textContent==='确认写入项目经验').click()`);
    const confirmedGenerated = await js(`window.codenode.goalContextForRole(${JSON.stringify(projectRoot)}, ${JSON.stringify(goal.value.id)}, ${JSON.stringify(task.value.id)}, 'implement')`);
    assert.equal(confirmedGenerated.value.context.confirmedExperience.some(item=>item.sourceRunId==='ui-generated-experience-run'),true,'UI confirmation exposes the generated candidate to implementers');
    await js(`[...document.querySelectorAll('.goal-task')].find(b=>b.textContent.includes('UI Run review task')).click()`);
    await js(`document.querySelector('.goal-toolbar button').click()`);
    await waitFor(()=>js(`!!document.querySelector('[data-testid=goal-run-review] button')`),'unknown Run review control');
    await js(`document.querySelector('[data-testid=goal-run-review] button').click()`);
    await waitFor(()=>js(`document.querySelector('.goal-run-review-detail')?.innerText.includes('src/goal-review.cjs')`),'Run file-change summary');
    await waitFor(()=>js(`!document.querySelector('[data-testid=goal-run-review] button')?.disabled`),'Run review load settled');
    const reviewSurface=()=>js(`JSON.stringify([...document.querySelectorAll('.goal-run-review input,.goal-run-review button,.goal-run-review small,.goal-run-review span')].map(n=>[n.tagName,n.getAttribute('aria-label'),n.textContent,n.checked||false,n.disabled||false]))`);
    const reviewBefore=await reviewSurface();const reviewThemeBefore=await js('window.__codenodeUi.getState().theme');
    for(const theme of ['light','dark']){await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`);await sleep(80);assert.equal(await reviewSurface(),reviewBefore);assert.equal(await js('document.documentElement.dataset.theme'),theme);}
    await js(`window.__codenodeUi.setState({theme:${JSON.stringify(reviewThemeBefore)}})`);
    await js(`[...document.querySelectorAll('.goal-task')].find(b=>b.textContent.includes('UI CI wait')).click()`);
    await js(`document.querySelector('.goal-toolbar button').click()`);
    await waitFor(()=>js(`document.querySelector('.goal-control-panel')?.innerText.includes('查询 GitHub Actions')`),'GitHub Actions wait controls');
    await win.webContents.executeJavaScript(`const textarea=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'后端测试草稿');textarea.dispatchEvent(new Event('input',{bubbles:true}))`);
    const view = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model')?.textContent,sideOpen:window.__codenodeUi.getState().sideOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
    const goalSurface = () => js(`JSON.stringify([...document.querySelectorAll('.goal-control-panel input,.goal-control-panel textarea,.goal-control-panel select,.goal-control-panel button,.goal-control-panel summary')].map(n=>[n.tagName,n.getAttribute('aria-label'),n.textContent,n.value||'',n.disabled]))`);
    await sleep(80); const before = await view(); const goalBefore = await goalSurface(); const themeBefore = await js('window.__codenodeUi.getState().theme');
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(80);
      assert.equal(await goalSurface(), goalBefore); assert.equal(await view(), before);
    }
    await js(`window.__codenodeUi.setState({theme:${JSON.stringify(themeBefore)}})`);
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await waitFor(() => js('!!document.querySelector("[aria-label=执行后端]")'), 'backend controls');
    await waitFor(() => js('!document.querySelector("[aria-label=执行后端]").disabled'), 'loaded settings');
    const select = async (label, value) => {
      await win.webContents.executeJavaScript(`(() => { const control=document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(80);
    };
    await select('后端配置范围', 'project'); await select('执行后端', 'codex');
    await select('Codex 项目文件权限', 'workspace-write');
    const controls = () => js(`JSON.stringify([...document.querySelectorAll('[data-testid=backend-settings] select,[data-testid=backend-settings] input')].map(n=>[n.getAttribute('aria-label'),n.value,n.disabled]))`);
    const expected = await controls();
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(100);
      assert.equal(await controls(), expected); assert.equal(await view(), before);
      assert.equal(await js('document.documentElement.dataset.theme'), theme);
      fs.mkdirSync(path.join(__dirname, '../../out'), { recursive: true });
      await js(`document.querySelector('[data-testid=backend-settings]').scrollIntoView({block:'start'})`);
      win.showInactive(); await sleep(200);
      const shot = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), sleep(5000).then(() => { throw new Error('Screenshot timed out: ' + theme); })]);
      fs.writeFileSync(path.join(__dirname, '../../out/backend-settings-' + theme + '.png'), shot.toPNG());
      win.hide();
    }
    await js(`[...document.querySelectorAll('[data-testid=backend-settings] button')].find(b=>b.textContent==='保存后端').click()`);
    await waitFor(() => js(`document.querySelector('[data-testid=backend-settings] [role=status]')?.textContent.includes('已保存')`), 'saved');
    const persisted = JSON.parse(fs.readFileSync(path.join(projectRoot, '.codenode/backend.json'), 'utf8'));
    assert.equal(persisted.backend, 'codex'); assert.equal(persisted.sandbox, 'workspace-write');
    await js(`window.__codenodeUi.getState().closeSettings()`);
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await waitFor(() => js('document.querySelector("[aria-label=执行后端]")?.value === "codex"'), 'reload persistence');
    assert.equal(await js('document.querySelector("[aria-label=后端配置范围]").value'), 'project');
    await js(`[...document.querySelectorAll('[data-testid=backend-settings] button')].find(b=>b.textContent==='项目跟随本机默认').click()`);
    await waitFor(() => js('document.querySelector("[aria-label=执行后端]")?.value === "builtin"'), 'inherit defaults');
    assert.equal(fs.existsSync(path.join(projectRoot, '.codenode/backend.json')), false);
    await js(`window.__codenodeUi.getState().closeSettings()`); assert.equal(await view(), before);
    console.log('BACKEND SETTINGS UI: PASS (real IPC save/reload/inherit, Goal panel and backend controls shared in both themes, session/draft/model/sidebar preserved)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', () => {
  if (path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('codenode-backend-ui-')) fs.rmSync(root, { recursive: true, force: true });
});
