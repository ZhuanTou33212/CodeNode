const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const cnode = require('./cnode.cjs');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'target',
  'out',
  'build',
  '.idea',
  '.vscode',
  '.codenode',
  '.cache',
  '.next',
  '.obsidian',
  'logs',
]);

async function walkProject(root) {
  const files = [];
  const queue = [''];
  const MAX = 20000;
  while (queue.length && files.length < MAX) {
    const relDir = queue.shift();
    const absDir = path.join(root, relDir);
    let items;
    try {
      items = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (IGNORE_DIRS.has(it.name)) continue;
      const rel = relDir ? `${relDir}/${it.name}` : it.name;
      const abs = path.join(absDir, it.name);
      if (it.isDirectory()) {
        queue.push(rel);
      } else if (it.isFile()) {
        if (files.length >= MAX) break;
        let size = 0;
        try {
          size = (await fsp.stat(abs)).size;
        } catch {}
        files.push({ relPath: rel, size });
      }
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'CodeNode Next',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.CODENODE_TEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const report = await win.webContents.executeJavaScript(`(async()=>{
          const out = { hasApi: !!window.codenode, keys: window.codenode ? Object.keys(window.codenode) : [] };
          try { const r = await window.codenode.listProject('E:\\\\codenode_nw\\\\codenode-desktop-next'); out.list = { ok: r.ok, n: r.files && r.files.length, err: r.error }; } catch(e){ out.list = 'THREW:'+e.message; }
          try { const r = await window.codenode.readProjectFile('E:\\\\codenode_nw\\\\codenode-desktop-next','src/App.tsx'); out.read = { ok: r.ok, len: r.content && r.content.length, err: r.error }; } catch(e){ out.read = 'THREW:'+e.message; }
          const tproj = 'E:\\\\codenode_nw\\\\logs\\\\testproj\\\\我的项目.cnode';
          try { const s = await window.codenode.saveProject(tproj, { graph: { nodes: [{ id: 'n1', type: 'task' }], edges: [] }, workspace: { viewport: { x: 0, y: 0, zoom: 1 } } }); out.save = { ok: s.ok, filePath: s.filePath, err: s.error }; } catch(e){ out.save = 'THREW:'+e.message; }
          try { const l = await window.codenode.loadProject(tproj); out.load = { ok: l.ok, nodes: l.data && l.data.graph && l.data.graph.nodes && l.data.graph.nodes.length, manifest: l.data && l.data.manifest && l.data.manifest.format, warn: l.data && l.data.warnings, err: l.error }; } catch(e){ out.load = 'THREW:'+e.message; }
          return out;
        })()`);
        require('fs').mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });
        require('fs').writeFileSync(
          path.join(__dirname, '..', 'logs', 'test-report.json'),
          JSON.stringify(report, null, 2),
          'utf-8'
        );
      } catch (e) {
        require('fs').writeFileSync(
          path.join(__dirname, '..', 'logs', 'test-report.json'),
          JSON.stringify({ hookError: String(e && e.stack || e) }),
          'utf-8'
        );
      }
      app.exit(0);
    });
  }
}

ipcMain.handle('graph:save', async (_event, payload) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '另存为 CodeNode 工程',
    defaultPath: 'workflow.cnode',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
  });
  if (canceled || !filePath) return { ok: false };
  require('fs').writeFileSync(filePath, cnode.encodeCnode(payload));
  return { ok: true, filePath };
});

ipcMain.handle('graph:open', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 CodeNode 工程',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const data = require('fs').readFileSync(filePaths[0]);
  const dec = cnode.decodeCnode(data);
  if (!dec.ok) return { ok: false, filePath: filePaths[0], error: dec.error };
  return {
    ok: true,
    filePath: filePaths[0],
    data: { graph: dec.graph, workspace: dec.workspace, manifest: dec.manifest, warnings: dec.warnings },
  };
});

ipcMain.handle('project:choose', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  return { ok: true, root: filePaths[0] };
});

ipcMain.handle('project:create', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '新建 CodeNode 项目',
    defaultPath: '未命名项目.cnode',
    filters: [{ name: 'CodeNode 工程文件', extensions: ['cnode'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const buf = cnode.encodeCnode({
    graph: { revision: 1, nodes: [], edges: [] },
    workspace: { viewport: { x: 0, y: 0, zoom: 1 } },
  });
  require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
  require('fs').writeFileSync(filePath, buf);
  return { ok: true, filePath, root: path.dirname(filePath) };
});

ipcMain.handle('project:list', async (_event, root) => {
  try {
    const files = await walkProject(root);
    return { ok: true, files };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:read', async (_event, root, relPath) => {
  try {
    const resolvedRoot = path.resolve(root);
    const full = path.resolve(root, relPath);
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, error: '路径越界' };
    }
    const MAX = 1024 * 1024;
    const buf = await fsp.readFile(full, 'utf-8');
    const truncated = buf.length > MAX;
    return { ok: true, content: truncated ? buf.slice(0, MAX) : buf, truncated };
  } catch (e) {
    return { ok: false, error: '无法读取（可能为二进制文件）' };
  }
});

ipcMain.handle('project:save', async (_event, target, payload) => {
  try {
    if (!target) return { ok: false, error: '未指定保存位置' };
    const isFile = String(target).toLowerCase().endsWith('.cnode');
    const filePath = isFile ? path.resolve(target) : path.join(path.resolve(target), 'workflow.cnode');
    require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
    require('fs').writeFileSync(filePath, cnode.encodeCnode(payload));
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:load', async (_event, target) => {
  try {
    const isFile = String(target).toLowerCase().endsWith('.cnode');
    const filePath = isFile ? path.resolve(target) : path.join(path.resolve(target), 'workflow.cnode');
    const data = require('fs').readFileSync(filePath);
    const dec = cnode.decodeCnode(data);
    if (!dec.ok) return { ok: false, error: dec.error };
    return {
      ok: true,
      filePath,
      data: { graph: dec.graph, workspace: dec.workspace, manifest: dec.manifest, warnings: dec.warnings },
    };
  } catch (e) {
    return { ok: false, error: '未找到 .cnode 工程文件' };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
