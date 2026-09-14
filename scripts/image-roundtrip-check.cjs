/** 校验：图像节点能随工程保存/重新加载（含 dataUrl 与 imagePath） */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let appWin = null;
app.on('browser-window-created', (_e, win) => { if (!appWin) appWin = win; });
require('../electron/main.cjs');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAJAAAAAwCAYAAAD+WvNWAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEqSURBVHhe1c8xDQAADMOw8SfdEQgBq/LTL7e7yfh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18Gvsxz9Ovh1lqNfB7/OcvTr4NdZjn4d/DrL0a+DX2c5+nXw6yxHvw5+neXo18GvsxDbA/xazRy8D5rBAAAAAElFTkSuQmCC';

app.whenReady().then(async () => {
  let failed = false;
  try {
    for (let i = 0; i < 60 && !appWin; i += 1) await sleep(250);
    const win = appWin;
    win.show();
    await sleep(800);
    const js = (c) => win.webContents.executeJavaScript(c);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-roundtrip-'));
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'pic.png'), Buffer.from(PNG_B64, 'base64'));

    await js('(async()=>{ await window.__codenodeProject.getState().loadRoot(' + JSON.stringify(dir) + '); return true; })()');
    await sleep(900);

    // 加一个图像节点（带项目路径 + 图片数据 + 说明）
    await js(
      '(()=>{ const st=window.__codenodeStore.getState(); st.addNode({ id:"img-rt", type:"image", position:{x:200,y:180},' +
        ' data:{ label:"图像节点", status:"pending", accent:"#14b8a6", width:320, height:224,' +
        ' imagePath:"assets/pic.png", dataUrl:"data:image/png;base64,' + PNG_B64 + '", note:"测试图" } }); return true; })()',
    );
    await sleep(700);

    // 保存到工程
    await js(
      '(async()=>{ const st=window.__codenodeStore.getState(); await window.codenode.saveProject(' + JSON.stringify(dir) +
        ', { graph: { nodes: st.nodes, edges: [] }, canvases: { sessions: [], messages: [] }, workspace: { viewport: { x:0, y:0, zoom:1 } } }); return true; })()',
    );
    await sleep(1400);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cnode'));
    console.log('ROUNDTRIP 保存文件: ' + JSON.stringify(files));

    // 清空画布后重新加载
    await js('(()=>{ window.__codenodeStore.getState().clear(); return true; })()');
    await sleep(400);
    const detail = await js(
      '(async()=>{ const r = await window.codenode.loadProject(' + JSON.stringify(path.join(dir, files[0])) + ');' +
        ' const g = r.data && r.data.graph; const n = g && g.nodes ? g.nodes.find(function(x){return x.type==="image";}) : null;' +
        ' return { ok: r.ok, err: r.error, nodeCount: g && g.nodes ? g.nodes.length : 0,' +
        ' node: n ? { type:n.type, imagePath:n.data&&n.data.imagePath, hasData: !!(n.data&&n.data.dataUrl), note:n.data&&n.data.note, width:n.data&&n.data.width, height:n.data&&n.data.height } : null }; })()',
    );
    console.log('ROUNDTRIP 加载结果: ' + JSON.stringify(detail));

    const n = detail && detail.node;
    const ok =
      detail &&
      detail.ok === true &&
      n &&
      n.type === 'image' &&
      n.imagePath === 'assets/pic.png' &&
      n.hasData === true &&
      n.note === '测试图';
    console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'));
    failed = !ok;
  } catch (e) {
    console.error('RT ERROR: ' + (e && e.stack ? e.stack : e));
    failed = true;
  } finally {
    app.exit(failed ? 1 : 0);
  }
});
