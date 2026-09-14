/**
 * 端到端验证「图片 → IPC → 多模态请求 → 模型看图」整条链路：
 * 走真实 main.cjs 的 agent:chat handler（含模型解析、附件校验、图片下发给模型）。
 *
 * 用法：node scripts/run-electron.cjs scripts/vision-e2e.cjs "<临时 userData 目录>" "<测试图片>"
 * 前置：该 userData 目录下 models.json 里放一个带明文 apiKey 的 flash 模型（vision: true）
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' - ' + extra : ''));
  }
};

let appWin = null;
app.on('browser-window-created', (_e, win) => { if (!appWin) appWin = win; });
require('../electron/main.cjs');

app.whenReady().then(async () => {
  try {
    const userDataDir = process.argv[2];
    const imageFile = process.argv[3];
    if (!userDataDir || !imageFile) throw new Error('缺少参数');
    if (!appWin) {
      for (let i = 0; i < 40 && !appWin; i += 1) await sleep(250);
    }
    const win = appWin;
    await sleep(800);
    const js = (c) => win.webContents.executeJavaScript(c);

    // 项目目录：门禁页需要工程才能渲染工作台
    const proj = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cn-vision-proj-'));
    fs.writeFileSync(path.join(proj, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(proj)}); return true; })()`);
    await sleep(800);

    // 通过 UI 暴露的 modelsList 确认打包/主进程认得 vision 字段
    const models = await js(`window.codenode.modelsList()`);
    const flash = (models.models || []).find((m) => m.id === 'deepseek-v4-flash');
    ok('主进程返回模型配置', !!flash, JSON.stringify((models.models || []).map((m) => m.id)));
    ok('模型配置带 vision 字段', flash && flash.vision === true, JSON.stringify(flash && { id: flash.id, model: flash.model, vision: flash.vision }));
    ok('API Key 已由主进程解出（apiKeySet）', flash && flash.apiKeySet === true);

    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(imageFile).toString('base64');

    // 1) 正常带图请求：模型应能答出红/绿/蓝
    await js(`(()=>{ window.__e2e = { chunks: [], done: null }; const api = window.codenode;
      api.onAgentDelta((d) => { const s = window.__e2e; if (d && d.kind === 'content' && d.text) s.chunks.push(d.text); });
      window.__e2e.run = api.agentChat({ projectRoot: ${JSON.stringify(proj)}, prompt: '这张图从左到右是什么颜色？只回颜色名，中文逗号分隔。', history: [], requestId: 'e2e-vision-1', modelId: 'deepseek-v4-flash', reasoningEffort: 'low', attachments: [{ mime: 'image/png', dataUrl: ${JSON.stringify(dataUrl)}, name: 't.png' }] })
        .then((r) => { window.__e2e.done = { ok: r.ok, error: r.error, reply: r.reply, usage: r.usage }; })
        .catch((e) => { window.__e2e.done = { ok: false, error: String(e && e.message || e) }; });
      return true; })()`);
    for (let i = 0; i < 90; i += 1) {
      const d = await js(`window.__e2e.done`);
      if (d) break;
      await sleep(1000);
    }
    const run1 = await js(`({ done: window.__e2e.done, streamed: window.__e2e.chunks.join('') })`);
    console.log('  (debug) run1=' + JSON.stringify({ ok: run1.done && run1.done.ok, error: run1.done && run1.done.error, reply: run1.done && run1.done.reply, usage: run1.done && run1.done.usage && run1.done.usage.prompt_tokens }));
    ok('带图请求成功返回', run1.done && run1.done.ok === true, JSON.stringify(run1.done));
    // 不写死颜色名：只要答出"颜色语义"即证明模型真的看到了图（未看图时会回"看不到图片"）
    const reply1 = String(run1.done?.reply || '');
    const sawImage = /色/.test(reply1) && !/无法(识别|查看|判断)|没有(收到|看到)|看不到/.test(reply1);
    ok('模型真的看到了图（答出颜色语义）', sawImage, reply1);
    ok('图片计入 prompt tokens（>200）', Number(run1.done?.usage?.prompt_tokens || 0) > 200, String(run1.done?.usage?.prompt_tokens));

    // 2) 不支持视觉的模型带图 → 必须明确拒绝，而不是让模型瞎猜
    const hasPro = await js(`window.codenode.modelsList().then(function(r){ return (r.models||[]).some(function(m){ return m.id==='deepseek-v4-pro'; }); })`);
    if (hasPro) {
      const run2 = await js(`(async () => { const api = window.codenode;
        const r = await api.agentChat({ projectRoot: ${JSON.stringify(proj)}, prompt: '看图', requestId: 'e2e-vision-2', modelId: 'deepseek-v4-pro', attachments: [{ mime: 'image/png', dataUrl: ${JSON.stringify(dataUrl)} }] });
        return { ok: r.ok, error: r.error }; })()`);
      console.log('  (debug) run2=' + JSON.stringify(run2));
      ok('未开视觉的模型被明确拒绝', run2.ok === false && /视觉/.test(String(run2.error || '')), JSON.stringify(run2));
    } else {
      console.log('  (debug) 该 userData 无 pro 模型，跳过未开视觉拒绝用例');
    }

    // 3) 非法附件被拒绝
    const run3 = await js(`(async () => { const api = window.codenode;
      const r = await api.agentChat({ projectRoot: ${JSON.stringify(proj)}, prompt: 'x', requestId: 'e2e-vision-3', modelId: 'deepseek-v4-flash', attachments: [{ mime: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }] });
      return { ok: r.ok, error: r.error }; })()`);
    ok('非图片附件被拒绝', run3.ok === false && /图片|data URL|格式/.test(String(run3.error || '')), JSON.stringify(run3));

    // 4) 纯文本请求仍然正常（回归）
    const run4 = await js(`(async () => { const api = window.codenode;
      const r = await api.agentChat({ projectRoot: ${JSON.stringify(proj)}, prompt: '只回两个字：收到', requestId: 'e2e-vision-4', modelId: 'deepseek-v4-flash' });
      return { ok: r.ok, reply: r.reply, error: r.error }; })()`);
    console.log('  (debug) run4=' + JSON.stringify(run4));
    ok('纯文本对话未受影响', run4.ok === true && String(run4.reply || '').trim().length > 0, JSON.stringify(run4));
  } catch (e) {
    failures.push('harness error');
    console.error('E2E ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('\nVISION E2E: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
