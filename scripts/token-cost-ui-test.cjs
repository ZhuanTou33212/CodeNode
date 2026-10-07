'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-token-ui-'));
const moduleRoot = process.env.CODENODE_PACKAGED_ASAR || path.join(__dirname, '..');
const userData = path.join(root, 'userData');
process.env.CODENODE_USER_DATA_DIR = userData;
process.env.CODENODE_HOME = path.join(root, 'home');
process.env.CODENODE_SOUL_FILE = path.join(root, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(moduleRoot, 'electron/main.cjs'));
function cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(moduleRoot, 'electron/preload.cjs') } });
  try {
    require(path.join(moduleRoot, 'electron/modelStore.cjs')).writeModels(userData, [
      { id: 'main-ui', model: 'capable', label: '主模型', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-main' },
      { id: 'cheap-ui', model: 'cheap', label: '探查模型', apiBase: 'http://127.0.0.1:12345', apiKey: 'synthetic-child' },
    ], 'main-ui');
    const ledger = new (require(path.join(moduleRoot, 'electron/costLedger.cjs')).CostLedger)({ projectRoot: root, runId: 'ui-run', prices: { cheap: { in: 1, out: 2 } } });
    ledger.record({ taskId: 'explorer-task', executionId: 'execution-1', role: 'explorer', kind: 'subagent', model: 'cheap', usage: { prompt_tokens: 100, completion_tokens: 20 } });
    ledger.recordOutcome({ taskId: 'explorer-task', executionId: 'execution-1', role: 'explorer', status: 'completed' });
    ledger.recordOutcome({ status: 'completed', verified: false });
    await win.loadFile(path.join(moduleRoot, 'dist/index.html'));
    const setup = await win.webContents.executeJavaScript(`(async()=>{
      window.costWait=async(fn)=>{const until=Date.now()+8000;while(Date.now()<until){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,30));}throw Error('UI wait timed out');};
      await costWait(()=>window.__codenodeProject);
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      if(!window.__codenodeSession.getState().current())window.__codenodeSession.getState().newCanvas();
      const input=await costWait(()=>document.querySelector('.pp-composer textarea'));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'cost-draft');input.dispatchEvent(new Event('input',{bubbles:true}));
      window.__codenodeUi.getState().openSettings('costs');
      const select=await costWait(()=>document.querySelector('.cost-settings select'));
      await costWait(()=>!select.disabled);
      select.value='cheap-ui';select.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,40));
      document.querySelector('.cost-settings input').click();
      await new Promise(r=>setTimeout(r,40));document.querySelector('.cost-settings button').click();
      await costWait(()=>document.querySelector('.cost-settings [role="status"]')?.textContent.includes('已保存'));
      const config=await window.codenode.agentConfig(${JSON.stringify(root)});
      const metrics=await window.codenode.agentMetrics(${JSON.stringify(root)});
      const activeId=(await window.codenode.modelsList()).activeId;
      window.__codenodeUi.getState().closeSettings();window.__codenodeUi.getState().openSettings('costs');
      await costWait(()=>document.querySelector('.cost-settings select')?.value==='cheap-ui');
      return {settings:config.costSettings,metrics:metrics.taskCosts,activeId,sessionId:window.__codenodeSession.getState().activeId,
        draft:input.value,navigation:window.__codenodeUi.getState().navigationOpen,side:window.__codenodeUi.getState().sideTab};
    })()`);
    assert.equal(setup.settings.roleModels.explorer, 'cheap-ui'); assert.equal(setup.settings.delegationGate, false);
    assert.equal(setup.activeId, 'main-ui'); assert.equal(setup.metrics.completedRuns, 1); assert.equal(setup.metrics.verifiedRuns, 0);
    assert.equal(setup.metrics.tasks.find(task => task.role === 'explorer').totalTokens, 120);
    const themes = [];
    for (const theme of ['light', 'dark']) {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const ui=window.__codenodeUi;ui.getState().openSettings('general');await new Promise(r=>setTimeout(r,60));
        if(ui.getState().theme!==${JSON.stringify(theme)})document.querySelector('.settings-theme-toggle').click();
        ui.getState().openSettings('costs');await costWait(()=>document.querySelector('.cost-settings select')?.value==='cheap-ui');
        return {controls:[...document.querySelectorAll('.cost-settings input,.cost-settings select')].map(el=>({label:el.getAttribute('aria-label'),value:el.value,checked:el.checked,type:el.type})),
          text:document.querySelector('.task-cost-list').textContent,theme:ui.getState().theme,sessionId:window.__codenodeSession.getState().activeId,
          activeId:(await window.codenode.modelsList()).activeId,draft:document.querySelector('.pp-composer textarea').value,navigation:ui.getState().navigationOpen,side:ui.getState().sideTab};
      })()`);
      assert.equal(result.theme, theme); assert.equal(result.sessionId, setup.sessionId); assert.equal(result.activeId, setup.activeId);
      assert.equal(result.draft, setup.draft); assert.equal(result.navigation, setup.navigation); assert.equal(result.side, setup.side);
      assert.equal(result.controls.length, 6); assert.match(result.text, /120 token/); assert.match(result.text, /已完成/);
      themes.push(result);
      win.showInactive(); await new Promise(resolve => setTimeout(resolve, 120));
      const picture = await win.webContents.capturePage(); win.hide();
      fs.writeFileSync(path.join(__dirname, '../out/token-cost-settings-' + theme + '.png'), picture.toPNG());
    }
    assert.deepEqual(themes[0].controls, themes[1].controls); assert.equal(themes[0].text, themes[1].text);
    assert.match(fs.readFileSync(path.join(root, '.codenode/agent.properties'), 'utf8'), /agent.subagent.model.explorer=cheap-ui/);
    // Drive the production chat IPC: its role resolver must use the persisted
    // selection, then put main and child requests into the same run ledger.
    const scripted = require('./lib/scripted-model.cjs').installScriptedModel([
      { toolCalls: [{ name: 'delegate_task', args: { role: 'explorer', objective: 'Locate implementation and compare callers', taskSize: 'multi_step' } }] },
      { content: '独立探查完成。' }, { content: '已汇总探查结果。' },
    ], { loopLast: false });
    try {
      const run = await win.webContents.executeJavaScript(`window.codenode.agentChat({projectRoot:${JSON.stringify(root)},requestId:'ui-live-run',prompt:'委派独立探查后汇总',modelId:'main-ui',document:{root:{nodes:[],edges:[]}}})`);
      assert.equal(run.ok, true, run.error);
      const models = scripted.seen.filter(call => call.kind !== 'intent').map(call => call.model);
      assert.deepEqual(models, ['capable', 'cheap', 'capable'], 'Actual IPC selects child model and keeps parent model');
      assert.equal(run.taskCosts.tasks.find(task => task.runId === 'ui-live-run' && task.role === 'explorer').requests, 1);
      const main = run.taskCosts.tasks.find(task => task.runId === 'ui-live-run' && task.role === 'main');
      assert.equal(main.kinds.main, 2);
      assert.equal(main.requests, Object.values(main.kinds).reduce((sum, count) => sum + Number(count), 0), 'Helpers are attributed rather than omitted');
    } finally { scripted.restore(); }
    console.log('TOKEN COST UI: PASS (real IPC persistence, reopen, shared themes, task costs, draft/session/main-model/sidebar preserved)');
  } finally { win.destroy(); }
  cleanup(); app.exit(0);
}).catch(error => { console.error(error); cleanup(); app.exit(1); });
app.on('quit', cleanup);
