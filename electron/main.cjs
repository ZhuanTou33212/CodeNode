const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const cnode = require('./cnode.cjs');
const agent = require('./agent.cjs');

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
          try {
            const gres = await (async()=>{
              const st = window.__codenodeStore;
              if (!st) return { error: 'no store' };
              const g = st.getState();
              g.load([
                { id:'n1', type:'start', position:{x:0,y:0}, data:{label:'开始',status:'done'} },
                { id:'n2', type:'task', position:{x:200,y:0}, data:{label:'任务',status:'pending'} },
                { id:'n3', type:'end', position:{x:400,y:0}, data:{label:'结束',status:'pending'} }
              ], [ { id:'e1', source:'n1', target:'n2' }, { id:'e2', source:'n2', target:'n3' } ]);
              g.makeGroup(['n2']);
              await new Promise((r)=>setTimeout(r,400));
              const s = st.getState();
              const grp = s.root.nodes.find(n=>n.type==='group');
              const sub = s.groups[grp ? grp.id : ''];
              return {
                viewStack: s.viewStack.length,
                groupSockets: grp ? grp.data.sockets : null,
                inView: s.nodes.map(n=>n.type).sort().join(','),
                subTypes: sub ? sub.nodes.map(n=>n.type).sort().join(',') : null,
                handleCount: document.querySelectorAll('.react-flow__handle').length
              };
            })();
            out.group = gres;
          } catch(e){ out.group = 'THREW:'+e.message; }
          try {
            const persist = await (async()=>{
              const st = window.__codenodeStore;
              const d = st.getState().getDocument();
              const save = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode', {
                graph: d.root,
                canvases: { groups: d.groups, viewStack: d.viewStack }
              });
              const load = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode');
              return {
                saved: save.ok,
                loaded: load.ok,
                viewStack: load.data && load.data.canvases && load.data.canvases.viewStack,
                groupIds: load.data && load.data.canvases && Object.keys(load.data.canvases.groups || {})
              };
            })();
            out.persist = persist;
          } catch(e){ out.persist = 'THREW:'+e.message; }
          try {
            const ag = await (async()=>{
              const g = await window.codenode.agentGreeting(null);
              const c = await window.codenode.agentConfig(null);
              const chat = await window.codenode.agentChat({ projectRoot: null, prompt: 'hi', history: [], canvasSummary: '[]' });
              return { greeting: g, config: c, chat };
            })();
            out.agent = ag;
          } catch(e){ out.agent = 'THREW:'+e.message; }
          try {
            const cw = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'agent-t', type:'agent', position:{x:120,y:120}, data:{ label:'Agent', name:'', content:'', status:'pending', accent:'#22c55e', greeted:false, width:360 } });
              await new Promise((r)=>setTimeout(r,700));
              const s = st.getState();
              const agents = s.nodes.filter((n)=>n.type==='agent').length;
              const users = s.nodes.filter((n)=>n.type==='user').length;
              const ag = s.nodes.find((n)=>n.type==='agent');
              const u = s.nodes.find((n)=>n.type==='user');
              return {
                agents, users,
                greeting: ag ? (ag.data && ag.data.content) : null,
                name: ag ? (ag.data && ag.data.name) : null,
                userBelow: u && ag ? (u.position.y > ag.position.y) : false
              };
            })();
            out.chatwindow = cw;
          } catch(e){ out.chatwindow = 'THREW:'+e.message; }
          try {
            const sc = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'a1', type:'agent', position:{x:100,y:100}, data:{label:'Agent',name:'CodeNode',content:'你好',status:'done',greeted:true,width:360,reasoning:'思考过程',tools:[{name:'read_file',args:{path:'x'}}]} });
              g.addNode({ id:'u1', type:'user', position:{x:100,y:340}, data:{label:'用户',content:'',status:'pending',width:360,height:220} });
              const doc = st.getState().getDocument();
              const payload = { graph: doc.root, canvases: { groups: doc.groups, viewStack: doc.viewStack }, workspace:{viewport:{x:0,y:0,zoom:1}}, manifest: {} };
              const s = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode', payload);
              const l = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode');
              const nodes = (l.data && l.data.graph && l.data.graph.nodes) || [];
              const ag = nodes.find((n)=>n.type==='agent');
              return {
                saved: s.ok, loaded: l.ok, saveErr: s.error,
                types: nodes.map((n)=>n.type).sort().join(','),
                agentContent: ag ? (ag.data && ag.data.content) : null,
                agentTools: ag && ag.data && ag.data.tools ? ag.data.tools.length : 0
              };
            })();
            out.savechat = sc;
          } catch(e){ out.savechat = 'THREW:'+e.message; }
          try {
            const mg = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.load([
                { id:'a', type:'task', position:{x:50,y:50}, data:{label:'A',status:'pending'} },
                { id:'b', type:'task', position:{x:250,y:50}, data:{label:'B',status:'pending'} },
                { id:'c', type:'task', position:{x:450,y:50}, data:{label:'C',status:'pending'} }
              ], []);
              g.setSelectedIds(['a','b']);
              g.makeGroup();
              await new Promise((r)=>setTimeout(r,300));
              const s = st.getState();
              const grp = s.root.nodes.find((n)=>n.type==='group');
              const sub = s.groups[grp ? grp.id : ''];
              const tasks = sub ? sub.nodes.filter((n)=>n.type==='task').length : 0;
              const zc = await (async()=>{
                const st2 = window.__codenodeStore;
                st2.getState().exitGroup();
                st2.getState().clear();
                st2.getState().addNode({ id:'u9', type:'user', position:{x:0,y:0}, data:{label:'用户',content:'',width:380,height:220} });
                st2.getState().addNode({ id:'t9', type:'task', position:{x:100,y:100}, data:{label:'T',status:'pending'} });
                const s2 = st2.getState();
                return { userZ: s2.nodes.find((n)=>n.id==='u9').zIndex, taskZ: s2.nodes.find((n)=>n.id==='t9').zIndex };
              })();
              return { viewStack: s.viewStack.length, groupExists: !!grp, subTasks: tasks, z: zc };
            })();
            out.multigroup = mg;
          } catch(e){ out.multigroup = 'THREW:'+e.message; }
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
          JSON.stringify({ hookError: String((e && e.stack) || e) }),
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
    data: {
      graph: dec.graph,
      workspace: dec.workspace,
      manifest: dec.manifest,
      canvases: dec.canvases || null,
      warnings: dec.warnings,
    },
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
      data: {
        graph: dec.graph,
        workspace: dec.workspace,
        manifest: dec.manifest,
        canvases: dec.canvases || null,
        warnings: dec.warnings,
      },
    };
  } catch (e) {
    return { ok: false, error: '未找到 .cnode 工程文件' };
  }
});

ipcMain.handle('agent:config', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  return { configured: !!cfg.apiKey, model: cfg.model, soul };
});

ipcMain.handle('agent:greeting', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  return { greeting: soul.greeting, name: soul.name, configured: !!cfg.apiKey };
});

ipcMain.handle('agent:chat', async (event, payload) => {
  const { projectRoot, prompt, history, canvasSummary, nodeId, requestId } = payload || {};
  const sender = event.sender;
  const sendDelta = (d) => {
    if (!sender.isDestroyed()) sender.send('agent:delta', { requestId, ...d });
  };
  try {
    const cfg = agent.loadConfig(projectRoot);
    if (!cfg.apiKey) {
      return { ok: false, error: '未配置 API Key（config/agent.properties）' };
    }
    const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
    const messages = [{ role: 'system', content: agent.buildSystemPrompt(soul, canvasSummary) }];
    for (const m of history || []) {
      if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: prompt });
    agent.logConversation(projectRoot, {
      ts: new Date().toISOString(),
      role: 'user',
      content: prompt,
      nodeId: nodeId || null,
    });
    sendDelta({ kind: 'start' });
    const { content, reasoning, toolCalls, usage } = await agent.chatCompletionStream(cfg, messages, (ev) => {
      if (ev.kind === 'reasoning') sendDelta({ kind: 'reasoning', text: ev.text });
      else if (ev.kind === 'content') sendDelta({ kind: 'content', text: ev.text });
      else if (ev.kind === 'tool') sendDelta({ kind: 'tool', toolCalls: ev.toolCalls });
    });
    agent.logConversation(projectRoot, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content,
      reasoning: reasoning || null,
      toolCalls: toolCalls || null,
      usage: usage || null,
    });
    sendDelta({ kind: 'done' });
    return { ok: true, reply: content, reasoning, toolCalls, usage };
  } catch (e) {
    sendDelta({ kind: 'error', error: String((e && e.message) || e) });
    return { ok: false, error: String((e && e.message) || e) };
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
