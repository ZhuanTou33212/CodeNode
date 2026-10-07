'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const workflow = require('../electron/workflowState.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-workflow-ui-'));
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workflowTest', {
  state: (...args) => ipcRenderer.invoke('workflow-test:state', ...args),
  execute: (...args) => ipcRenderer.invoke('workflow-test:execute', ...args),
  run: (...args) => ipcRenderer.invoke('workflow-test:run', ...args),
  settings: (value) => ipcRenderer.invoke('workflow-test:settings', value),
});`);

let failPrepare = true;
let failSettle = false;
let failConsumer = true;
let allowConfirm = true;
let lastGraph;
let lastWorkflow;
const calls = [];
ipcMain.handle('workflow-test:settings', (_event, value) => {
  failPrepare = !!value.failPrepare; failSettle = !!value.failSettle;
  if (Object.prototype.hasOwnProperty.call(value, 'allowConfirm')) allowConfirm = value.allowConfirm !== false;
  return { calls: calls.slice() };
});
ipcMain.handle('workflow-test:state', (_event, selectedRoot, id, request) => {
  assert.strictEqual(selectedRoot, root);
  lastGraph = request.graph; lastWorkflow = id;
  if (request.action === 'prepare' && failPrepare) return { ok: false, error: '模拟恢复记录写入失败' };
  if (request.action === 'settle' && failSettle) return { ok: false, error: '模拟执行结果写入失败' };
  return workflow.dispatch(root, id, request);
});
ipcMain.handle('workflow-test:run', (_event, selectedRoot, command) => {
  assert.strictEqual(selectedRoot, root);
  const state = workflow.dispatch(root, lastWorkflow, { action: 'read', graph: lastGraph });
  assert.ok(state.ok && state.state.pending.length === 1 && state.state.pending[0].active, 'actual command must follow durable prepare');
  calls.push(command);
  fs.appendFileSync(path.join(root, 'effects.txt'), command + '\n');
  if (/consumer/.test(command) && failConsumer) { failConsumer = false; return { ok: false, output: 'consumer failed once' }; }
  return { ok: true, output: command + ' verified' };
});
ipcMain.handle('workflow-test:execute', async (event, selectedRoot, id, request) => {
  assert.strictEqual(selectedRoot, root);
  const stageStatus = await event.sender.executeJavaScript(`window.__codenodeStore.getState().nodes.find(n=>n.id===${JSON.stringify(request.nodeId)})?.data.status`);
  assert.strictEqual(stageStatus, 'running', 'executing stage must light up before the main-process request');
  if (failPrepare) return { ok: false, error: '模拟恢复记录写入失败' };
  const originalRename = fs.renameSync;
  if (failSettle) fs.renameSync = (from, to) => { if (String(to).endsWith('.json')) throw new Error('模拟执行结果写入失败'); return originalRename(from, to); };
  try {
    return await workflow.execute(root, id, request, {
      confirm: async () => allowConfirm,
      run: async (node, fullGraph, state) => {
        const command = String(node.data.prompt || '').replace(/^run:\s*/i, '');
        const current = workflow.dispatch(root, id, { action: 'read', graph: fullGraph });
        assert.ok(current.ok && current.state.pending.some((item) => item.active), 'actual operation must follow durable prepare');
        calls.push(command);
        fs.appendFileSync(path.join(root, 'effects.txt'), command + '\n');
        if (/consumer/.test(command) && failConsumer) { failConsumer = false; return { ok: false, output: 'consumer failed once' }; }
        return { ok: true, output: command + ' verified' };
      },
    });
  } finally { fs.renameSync = originalRename; }
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 850, show: false, webPreferences: { sandbox: true, preload } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = async (fn) => { for(let i=0;i<120;i++){ const result=fn(); if(result)return result; await new Promise(r=>setTimeout(r,30)); } throw Error('UI condition timed out'); };
      await wait(()=>window.__codenodeProject && window.__codenodeStore && window.__codenodeUi);
      window.codenode = { workflowState: (...args)=>window.workflowTest.state(...args), workflowExecute:(...args)=>window.workflowTest.execute(...args), runProjectCommand:(...args)=>window.workflowTest.run(...args),
        listProject:async()=>({ok:true,files:[]}), saveProject:async()=>({ok:true}), agentRuns:async()=>[], subagentViews:async()=>({ok:true,runs:[]}),
        agentMetrics:async()=>({ok:false}), replayEvents:async()=>({ok:false}), agentConfig:async()=>({configured:false,model:''}), agentReadPlan:async()=>({ok:false}) };
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)});
      const graph=window.__codenodeStore, ui=window.__codenodeUi;
      graph.getState().loadDocument({nodes:[
        {id:'source',type:'task',position:{x:100,y:100},data:{label:'source',prompt:'run: node source.cjs'}},
        {id:'consumer',type:'task',position:{x:400,y:100},data:{label:'consumer',prompt:'run: node consumer.cjs',requiresInput:true}}
      ],edges:[{id:'edge',source:'source',target:'consumer'}]});
      ui.getState().openDock('runs');
      const runButton=()=>Array.from(document.querySelectorAll('.dock-runs button')).find(b=>/^(开始执行|继续执行|执行中…)$/.test(b.textContent));
      const clickRun=async()=>{ const button=await wait(runButton); button.click(); await new Promise(r=>setTimeout(r,100)); await wait(()=>runButton()&&!runButton().disabled); };
      await clickRun();
      const failedPrepare=document.querySelector('.dock-run-item.blocked')?.textContent||'';
      const noCalls=(await window.workflowTest.settings({failPrepare:false})).calls.length;
      window.confirm=()=>true; await window.workflowTest.settings({allowConfirm:true});
      await clickRun();
      const first=(await window.workflowTest.settings({})).calls;
      const failedNode=document.querySelector('.dock-run-item.failed')?.textContent||'';
      window.confirm=()=>false; await window.workflowTest.settings({allowConfirm:false});
      await clickRun();
      const rejected=(await window.workflowTest.settings({})).calls.length;
      window.confirm=()=>true; await window.workflowTest.settings({allowConfirm:true});
      await clickRun();
      const resumed=(await window.workflowTest.settings({})).calls;
      graph.getState().updateNodeData('source',{prompt:'run: node changed-source.cjs'});
      await new Promise(r=>setTimeout(r,100));
      window.confirm=()=>false; await window.workflowTest.settings({allowConfirm:false});
      await clickRun();
      const graphDenied=(await window.workflowTest.settings({})).calls.length;
      window.confirm=()=>true; await window.workflowTest.settings({allowConfirm:true});
      await clickRun();
      const changed=(await window.workflowTest.settings({})).calls;
      graph.getState().updateNodeData('source',{prompt:'run: node settle-source.cjs'});
      await new Promise(r=>setTimeout(r,100));
      await window.workflowTest.settings({failSettle:true});
      await clickRun();
      const stopped=(await window.workflowTest.settings({})).calls;
      return {failedPrepare,noCalls,first,failedNode,rejected,resumed,graphDenied,changed,stopped,toast:ui.getState().toast};
    })()`);
    assert.match(result.failedPrepare, /恢复记录写入失败/);
    assert.strictEqual(result.noCalls, 0, 'write failure must block first effect');
    assert.deepStrictEqual(result.first, ['node source.cjs', 'node consumer.cjs']);
    assert.match(result.failedNode, /consumer failed once/);
    assert.strictEqual(result.rejected, 2, 'review denial must not execute');
    assert.deepStrictEqual(result.resumed, ['node source.cjs', 'node consumer.cjs', 'node consumer.cjs'], 'valid source completion is skipped on resume');
    assert.strictEqual(result.graphDenied, 3, 'contract change must require new review');
    assert.deepStrictEqual(result.changed.slice(-2), ['node changed-source.cjs', 'node consumer.cjs'], 'changed graph cannot reuse old completed nodes');
    assert.strictEqual(result.stopped.length, 5, 'settle failure stops before downstream');
    assert.match(result.toast, /保存失败|结果未能持久化/);
    console.log('WORKFLOW RECOVERY UI TEST: PASS (prepare before effects, persist failure, review denial, resume, graph invalidation, settle failure)');
    app.exit(0);
  } catch (error) { console.error('WORKFLOW RECOVERY UI TEST: FAIL', error); app.exit(1); }
  finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codenode-workflow-ui-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
