'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-scheduling-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '..');
process.env.CODENODE_USER_DATA_DIR = path.join(root, 'userData');
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
let mainWindow;
app.on('browser-window-created', (_event, win) => { mainWindow = win; win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cleanup() {
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codenode-scheduling-ui-')) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
app.whenReady().then(async () => {
  try {
    const until = Date.now() + 8000;
    while (!mainWindow && Date.now() < until) await sleep(30);
    assert.ok(mainWindow, 'Main window ready');
    const win = mainWindow;
    win.setSize(1280, 960); win.webContents.setBackgroundThrottling(false);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async (expression, label) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (await js(expression)) return; await sleep(40); }
      throw new Error('UI wait timeout: ' + label);
    };
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(path.join(root, 'userData'), [
      { id: 'scheduling-fixture', model: 'fixture-model', label: '调度测试模型', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-test-key' },
    ], 'scheduling-fixture');
    const toolkit = require(path.join(moduleRoot, 'electron/tools/toolkit.cjs'));
    const { AgentToolContext } = require(path.join(moduleRoot, 'electron/tools/context.cjs'));
    const { GraphModel } = require(path.join(moduleRoot, 'electron/tools/GraphModel.cjs'));
    const { SubagentManager } = require(path.join(moduleRoot, 'electron/subagents.cjs'));
    const context = new AgentToolContext({ projectRoot: root, model: new GraphModel({ root: { nodes: [], edges: [] } }), confirm: async () => true, audit: () => {} });
    let attemptCalls = 0;
    const manager = new SubagentManager({ toolkit, registry: toolkit.buildDefaultRegistry(), runId: 'attempt-ui', cfg: { tools: {}, rag: { enabled: false }, costSettings: { delegationGate: false, roleModels: {} } },
      agent: { runAgentChat: async () => ++attemptCalls === 1 ? { content: '', error: '首次尝试失败', toolCalls: [] } : { content: '第二次尝试完成', toolCalls: [] } } });
    await manager.delegate(context, { taskId: 'ui-attempt', role: 'explorer', objective: '探查模块并归纳结论' });
    const retryPlan = manager.inspectRetry(context, { taskId: 'ui-attempt' });
    const redone = await manager.retry(context, { taskId: 'ui-attempt', expectedExecutionId: retryPlan.executionId, planDigest: retryPlan.planDigest, reason: '再次探查并核验' });
    assert.equal(redone.ok, true, redone.text);
    await wait('!!window.__codenodeProject', 'project store');
    assert.equal((await js('window.codenode.agentConfig(null)')).scheduling.concurrency, 4);
    await js(`window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)})`);
    await wait('!!document.querySelector(".pp-input")', 'composer');
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await wait(`document.querySelector('[aria-label="子任务与模型请求并发上限"]')?.disabled===false`, 'global settings');
    assert.equal(await js(`document.querySelector('[aria-label="子任务与模型请求并发上限"]').value`), '4');
    assert.match(await js(`document.querySelector('.scheduling-settings').textContent`), /18\/24/);
    await js(`window.__codenodeUi.getState().closeSettings()`);
    await js(`window.__codenodeSession.setState({messages:[{role:'assistant',content:'保留调度前会话',status:'done'}]});window.__codenodeUi.setState({navigationOpen:true,sideOpen:true,sideTab:'agent'}); const input=document.querySelector('.pp-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'scheduling-draft');input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await sleep(80);
    const state = () => js(`JSON.stringify({id:window.__codenodeSession.getState().activeId,messages:window.__codenodeSession.getState().messages,draft:document.querySelector('.pp-input').value,model:document.querySelector('.pp-model').textContent,navigation:window.__codenodeUi.getState().navigationOpen,sideOpen:window.__codenodeUi.getState().sideOpen,sideTab:window.__codenodeUi.getState().sideTab})`);
    const before = await state();
    await js(`window.__codenodeUi.getState().openSettings('general')`);
    await wait(`document.querySelector('[aria-label="子任务与模型请求并发上限"]')?.disabled===false`, 'loaded settings');
    const labels = ['子任务与模型请求并发上限', '每次运行子任务上限', '单批子任务上限', '子任务配额预警百分比', '单任务尝试上限（含首次）', '每次运行尝试上限（含首次）'];
    for (let index = 0; index < labels.length; index++) {
      await js(`(()=>{const input=document.querySelector('[aria-label="'+${JSON.stringify(labels[index])}+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String([6, 28, 8, 80, 2, 50][index]))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(30);
    }
    await js(`document.querySelector('.scheduling-settings button').click()`);
    await wait(`document.querySelector('.scheduling-settings [role="status"]')?.textContent.includes('已保存')`, 'saved global settings');
    const expected = { concurrency: 6, maxTasksPerRun: 28, maxBatchTasks: 8, warningPercent: 80, maxAttemptsPerTask: 2, maxAttemptsPerRun: 50 };
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'home/agent-scheduling.json'), 'utf8')).settings, expected);
    const queue = require(path.join(moduleRoot, 'electron/requestQueue.cjs')).modelQueue;
    assert.equal(queue.stats().limit, 6);
    const agent = require(path.join(moduleRoot, 'electron/agent.cjs'));
    const otherProject = path.join(root, 'other-project'); fs.mkdirSync(otherProject);
    assert.equal(agent.loadConfig(otherProject).subagent.maxConcurrentTasks, 6);
    assert.deepEqual((await js(`window.codenode.agentConfig(${JSON.stringify(otherProject)})`)).scheduling, expected);
    await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('general')`);
    await wait(`document.querySelector('[aria-label="每次运行子任务上限"]')?.value==='28'`, 'reopen persistence');
    const themes = [];
    for (const theme of ['light', 'dark']) {
      await js(`if(window.__codenodeUi.getState().theme!==${JSON.stringify(theme)})document.querySelector('.settings-theme-toggle').click()`);
      await sleep(80);
      assert.equal(await state(), before, 'Theme switch preserves session, draft, model and sidebar');
      themes.push(await js(`JSON.stringify([...document.querySelectorAll('.scheduling-settings input')].map(input=>({label:input.getAttribute('aria-label'),type:input.type,value:input.value,disabled:input.disabled})))`));
      assert.match(await js(`document.querySelector('.scheduling-settings').textContent`), /23\/28/);
      await js(`document.querySelector('.scheduling-settings').scrollIntoView({block:'center'})`);
      await sleep(160); // Let the compositor present the scrolled settings panel.
      const screenshot = await win.webContents.capturePage();
      fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../out/scheduling-' + theme + '.png'), screenshot.toPNG());
    }
    assert.equal(themes[0], themes[1], 'Themes use identical controls and persisted settings');
    await js(`window.__codenodeSession.setState({streaming:true})`);
    assert.equal(await js(`document.querySelector('.scheduling-settings button').disabled`), true);
    await js(`window.__codenodeSession.setState({streaming:false})`);
    const release = await queue.acquire(new AbortController().signal);
    try {
      const rejected = await js(`window.codenode.schedulingSave(${JSON.stringify(expected)})`);
      assert.equal(rejected.ok, false); assert.match(rejected.error, /正在运行/);
    } finally { release(); }
    assert.equal(queue.stats().limit, 6);
    await js(`window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openDock('runs')`);
    await wait(`!!document.querySelector('[data-testid="dock-subagents"] .dock-attempt-history')`, 'persisted Attempt history');
    const historyState = await state();
    const histories = [];
    for (const theme of ['light', 'dark']) {
      await js(`window.__codenodeUi.setState({theme:${JSON.stringify(theme)}})`); await sleep(80);
      assert.equal(await state(), historyState);
      const content = await js(`(()=>{const history=document.querySelector('.dock-attempt-history');if(!history.open)history.querySelector('summary').click();return history.textContent;})()`);
      assert.match(content, /第 1 次.*failed.*首次尝试失败/);
      assert.match(content, /第 2 次.*done.*第二次尝试完成/);
      histories.push(content);
      await js(`document.querySelector('.dock-attempt-history').scrollIntoView({block:'center'})`); await sleep(160);
      const layout = await js(`(()=>{const history=document.querySelector('.dock-attempt-history');const lines=history.querySelectorAll('p');return {width:history.getBoundingClientRect().width,firstY:lines[0].getBoundingClientRect().y,secondY:lines[1].getBoundingClientRect().y};})()`);
      assert.ok(layout.width > 200 && layout.secondY > layout.firstY, 'Expanded history is laid out as readable rows');
      const capture = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, '../out/attempt-history-' + theme + '.png'), capture.toPNG());
      await js(`document.querySelector('.dock-attempt-history summary').click()`);
    }
    assert.equal(histories[0], histories[1]);
    console.log('SCHEDULING UI: PASS (real settings/Attempt persistence, cross-project, both themes/history interactions/state retention, linked queue and active request guard)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('will-quit', cleanup);
