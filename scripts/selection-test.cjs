const { app, BrowserWindow } = require('electron');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { sandbox: true, preload: path.join(__dirname, '..', 'electron', 'preload.cjs') },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(800);
    await win.webContents.executeJavaScript(`(async()=>{
      const st = window.__codenodeStore;
      st.getState().load([
        { id:'a', type:'task', position:{x:60,y:60}, data:{label:'A',status:'pending'} },
        { id:'b', type:'task', position:{x:320,y:60}, data:{label:'B',status:'pending'} },
        { id:'c', type:'task', position:{x:60,y:320}, data:{label:'C',status:'pending'} }
      ], []);
      return true;
    })()`);
    await sleep(500);
    await win.webContents.executeJavaScript(`(()=>{ const st=window.__codenodeStore; st.getState().runFlow(); return true; })()`);

    // 用真实屏幕坐标计算覆盖 a、b 的框
    const rects = await win.webContents.executeJavaScript(`(()=>{
      const g=(id)=>{ const r=document.querySelector('[data-id="'+id+'"]').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
      return { a:g('a'), b:g('b'), c:g('c') };
    })()`);
    const minX = Math.min(rects.a.x, rects.b.x) - 20;
    const minY = Math.min(rects.a.y, rects.b.y) - 20;
    const maxX = Math.max(rects.a.x + rects.a.w, rects.b.x + rects.b.w) + 20;
    const maxY = Math.max(rects.a.y + rects.a.h, rects.b.y + rects.b.h) + 20;
    const cx = Math.round(rects.c.x + rects.c.w / 2);
    const cy = Math.round(rects.c.y + 20);

    const sel = () =>
      win.webContents.executeJavaScript(`[...document.querySelectorAll('.react-flow__node.selected')].map(n=>n.getAttribute('data-id'))`);

    // 框选 a、b
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(minX), y: Math.round(minY), button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(minX + ((maxX - minX) * i) / 12),
        y: Math.round(minY + ((maxY - minY) * i) / 12),
        button: 'left',
        buttons: 1,
      });
      await sleep(12);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(maxX), y: Math.round(maxY), button: 'left', clickCount: 1 });
    await sleep(400);
    const s1 = await sel();

    // 按下 Ctrl → Ctrl+点击 c 加选
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: ['control'] });
    await sleep(300);
    const s2 = await sel();

    // Ctrl+点击 c 减选
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: ['control'] });
    await sleep(300);
    const s3 = await sel();
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control', modifiers: ['control'] });

    console.log('box-select:', JSON.stringify(s1.sort()));
    console.log('ctrl+click add:', JSON.stringify(s2.sort()));
    console.log('ctrl+click remove:', JSON.stringify(s3.sort()));

    const ok =
      s1.sort().join(',') === 'a,b' && s2.sort().join(',') === 'a,b,c' && s3.sort().join(',') === 'a,b';
    console.log(ok ? 'SELECTION TEST: PASS' : 'SELECTION TEST: FAIL');
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('SELECTION TEST ERROR: ' + e.message);
    app.exit(2);
  }
});
