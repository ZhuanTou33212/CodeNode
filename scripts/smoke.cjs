const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await new Promise((r) => setTimeout(r, 1500));
    const result = await win.webContents.executeJavaScript(`({
      title: document.title,
      rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      hasCanvas: !!document.querySelector('.react-flow'),
      hasProjectManager: !!document.querySelector('.project-manager'),
      hasCollapsedBtn: !!document.querySelector('.pm-collapse-btn'),
      hasInspectorBadge: !!document.querySelector('.inspector-badge'),
      hasControls: !!document.querySelector('.react-flow__controls'),
      hasMiniMap: !!document.querySelector('.react-flow__minimap'),
      addMenuHidden: !document.querySelector('.add-menu')
    })`);
    console.log('SMOKE: ' + JSON.stringify(result));
    const fail =
      !result.hasCanvas ||
      !result.hasProjectManager ||
      !result.hasInspectorBadge ||
      result.hasControls ||
      result.hasMiniMap ||
      !result.addMenuHidden ||
      result.rootChildren <= 0;
    console.log('RESULT: ' + (fail ? 'FAIL' : 'PASS'));
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('SMOKE ERROR: ' + e.message);
    app.exit(2);
  }
});
