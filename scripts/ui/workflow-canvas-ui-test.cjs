'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-workflow-canvas-'));
const source = path.join(__dirname, '../..');
process.env.CODENODE_USER_DATA_DIR = path.join(project, 'userData');
process.env.CODENODE_HOME = path.join(project, 'home');
process.env.CODENODE_SOUL_FILE = path.join(project, 'soul.md');
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.hide(); });
require(path.join(source, 'electron/main.cjs'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, preload: path.join(source, 'electron/preload.cjs') } });
  try {
    await win.loadFile(path.join(source, 'dist/index.html'));
    const setup = await win.webContents.executeJavaScript(`(async()=>{
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(let i=0;!window.__codenodeProject&&i<120;i++)await sleep(50);
      await window.__codenodeProject.getState().loadRoot(${JSON.stringify(project)});
      window.__codenodeSession.getState().newCanvas();
      window.__codenodeUi.setState({sideOpen:false,sideTab:'agent'});
      window.__codenodeStore.getState().load([
        {id:'source',type:'start',position:{x:100,y:120},data:{label:'开始',status:'pending',accent:'#22c55e'}},
        {id:'work',type:'task',position:{x:430,y:120},data:{label:'处理任务',status:'running',prompt:'检查并修复问题',accent:'#3b82f6'}},
        {id:'finish',type:'end',position:{x:760,y:120},data:{label:'结束',status:'pending',accent:'#ef4444'}}
      ],[{id:'edge-a',source:'source',target:'work',type:'waypoint'},{id:'edge-b',source:'work',target:'finish',type:'waypoint'}]);
      await sleep(350);
      const canvas=document.querySelector('.workflow-canvas-layer');
      const node=document.querySelector('.react-flow__node[data-id="work"]');
      return {hasCanvas:canvas instanceof HTMLCanvasElement,nodeOpacity:getComputedStyle(node).opacity};
    })()`);
    assert.deepEqual(setup, { hasCanvas: true, nodeOpacity: '0' });
    win.setPosition(-1900, -1900); win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await win.webContents.executeJavaScript(`(()=>{
      const canvas=document.querySelector('.workflow-canvas-layer'),node=document.querySelector('.react-flow__node[data-id="work"]');
      const rect=node.getBoundingClientRect(),screen=canvas.getBoundingClientRect(),ratio=canvas.width/screen.width;
      const pixel=canvas.getContext('2d').getImageData(Math.floor((rect.left+rect.width/2-screen.left)*ratio),Math.floor((rect.top+rect.height/2-screen.top)*ratio),1,1).data;
      return {width:canvas.width,height:canvas.height,pixel:[...pixel],center:{x:rect.left+rect.width/2,y:rect.top+rect.height/2},position:window.__codenodeStore.getState().nodes.find(item=>item.id==='work').position};
    })()`);
    assert.ok(before.width > 500 && before.height > 300, JSON.stringify(before));
    assert.ok(before.pixel[3] > 100, 'Canvas must paint the task card');
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(before.center.x),y:Math.round(before.center.y),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(before.center.x),y:Math.round(before.center.y),button:'left',clickCount:1});
    await new Promise(resolve => setTimeout(resolve, 90));
    const selected = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().selectedId`);
    assert.equal(selected, 'work', 'Canvas-painted node must remain clickable');
    const dragFrom = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.react-flow__node[data-id="work"]').getBoundingClientRect();return{x:Math.round(r.left+45),y:Math.round(r.top+14)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:dragFrom.x,y:dragFrom.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:dragFrom.x,y:dragFrom.y,button:'left',clickCount:1});
    for (let step=1;step<=5;step++) {
      win.webContents.sendInputEvent({type:'mouseMove',x:dragFrom.x+step*15,y:dragFrom.y+step*6,button:'left'});
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    win.webContents.sendInputEvent({type:'mouseUp',x:dragFrom.x+75,y:dragFrom.y+30,button:'left',clickCount:1});
    await new Promise(resolve=>setTimeout(resolve,80));
    const moved = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().nodes.find(item=>item.id==='work').position`);
    assert.ok(moved.x > before.position.x+30 && moved.y > before.position.y+10, JSON.stringify({before:before.position,moved}));
    const handles = await win.webContents.executeJavaScript(`(()=>{try{
      const point=(selector)=>{const el=document.querySelector(selector);if(!el)throw Error('Missing handle: '+selector+' / '+[...document.querySelectorAll('.react-flow__handle')].map(item=>item.className).join(' | '));const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
      return {source:point('.react-flow__node[data-id="source"] .react-flow__handle.source'),target:point('.react-flow__node[data-id="finish"] .react-flow__handle.target')};
    }catch(error){return{error:String(error)}}})()`);
    assert.ok(!handles.error, JSON.stringify(handles));
    win.webContents.sendInputEvent({type:'mouseMove',x:handles.source.x,y:handles.source.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:handles.source.x,y:handles.source.y,button:'left',clickCount:1});
    for (let step=1;step<=7;step++) {
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(handles.source.x+(handles.target.x-handles.source.x)*step/7),y:Math.round(handles.source.y+(handles.target.y-handles.source.y)*step/7),button:'left'});
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    win.webContents.sendInputEvent({type:'mouseUp',x:handles.target.x,y:handles.target.y,button:'left',clickCount:1});
    await new Promise(resolve=>setTimeout(resolve,90));
    const connected = await win.webContents.executeJavaScript(`window.__codenodeStore.getState().edges.some(edge=>edge.source==='source'&&edge.target==='finish')`);
    assert.equal(connected,true,'Canvas-painted handles must retain connection interaction');
    const theme = await win.webContents.executeJavaScript(`(async()=>{
      const ui=window.__codenodeUi;
      const previous=ui.getState().theme;
      ui.getState().toggleTheme();
      await new Promise(resolve=>setTimeout(resolve,180));
      const canvas=document.querySelector('.workflow-canvas-layer'),node=document.querySelector('.react-flow__node[data-id="work"]');
      const rect=node.getBoundingClientRect(),screen=canvas.getBoundingClientRect(),ratio=canvas.width/screen.width;
      const pixel=canvas.getContext('2d').getImageData(Math.floor((rect.left+rect.width/2-screen.left)*ratio),Math.floor((rect.top+rect.height/2-screen.top)*ratio),1,1).data;
      return {changed:ui.getState().theme!==previous,pixel:[...pixel],selected:window.__codenodeStore.getState().selectedId};
    })()`);
    assert.equal(theme.changed, true);
    assert.equal(theme.selected, 'work');
    assert.notDeepEqual(theme.pixel, before.pixel, 'theme switch must repaint the Canvas card');
    const editor = await win.webContents.executeJavaScript(`(async()=>{
      const graph=window.__codenodeStore.getState();
      graph.addNode({id:'drawing',type:'vector',position:{x:100,y:320},data:{label:'画布节点',status:'pending',width:560,height:380,mode:'design',accent:'#22d3ee'}});
      await new Promise(resolve=>setTimeout(resolve,180));
      const node=document.querySelector('.react-flow__node[data-id="drawing"]');
      const active={opacity:getComputedStyle(node).opacity,editor:!!node.querySelector('.vs-svg')};
      window.__codenodeStore.getState().setSelectedIds([]);
      await new Promise(resolve=>setTimeout(resolve,90));
      return {active,inactiveOpacity:getComputedStyle(node).opacity};
    })()`);
    assert.deepEqual(editor, {active:{opacity:'1',editor:true},inactiveOpacity:'0'}, 'embedded drawing editor must stay interactive while selected');
    console.log('WORKFLOW CANVAS UI: PASS (Canvas pixels, node click/drag/connect, theme repaint, embedded editor)');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => {
  if (path.dirname(project) !== os.tmpdir() || !path.basename(project).startsWith('codenode-workflow-canvas-')) return;
  try { fs.rmSync(project, { recursive: true, force: true }); } catch {}
});
