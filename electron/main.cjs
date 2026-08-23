const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const cnode = require('./cnode.cjs');
const agent = require('./agent.cjs');
const toolkit = require('./tools/toolkit.cjs');
const { GraphModel } = require('./tools/GraphModel.cjs');
const { AgentToolContext } = require('./tools/context.cjs');
const { makeBridge } = require('./tools/bridge.cjs');

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
          try {
            const sv = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'t1', type:'task', position:{x:50,y:50}, data:{label:'任务A',status:'pending',prompt:''} });
              g.addNode({ id:'t2', type:'task', position:{x:300,y:50}, data:{label:'任务B',status:'done',prompt:''} });
              g.onConnect({ source:'t1', target:'t2' });
              // 模拟 projectActions.buildPayload()
              const doc = st.getState().getDocument();
              const payload = {
                graph: doc.root,
                canvases: { groups: doc.groups, viewStack: doc.viewStack },
                workspace: { viewport: { x: 5, y: 6, zoom: 1 } },
                manifest: { name: '保存链路测试', documentId: 'save-test-doc' }
              };
              const dir = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir';
              const file = dir + '\\\\proj.cnode';
              const sDir = await window.codenode.saveProject(dir, payload);
              const sFile = await window.codenode.saveProject(file, payload);
              const lFile = await window.codenode.loadProject(file);
              // 组内画布保存/读取
              g.makeGroup(['t1','t2']);
              const doc2 = st.getState().getDocument();
              const payload2 = {
                graph: doc2.root,
                canvases: { groups: doc2.groups, viewStack: doc2.viewStack },
                workspace: { viewport: { x: 0, y: 0, zoom: 1 } },
                manifest: {}
              };
              const sGrp = await window.codenode.saveProject(file, payload2);
              const lGrp = await window.codenode.loadProject(file);
              return {
                sDir: { ok: sDir.ok, filePath: sDir.filePath, err: sDir.error },
                sFile: { ok: sFile.ok, filePath: sFile.filePath, err: sFile.error },
                lFile: { ok: lFile.ok, nodes: lFile.data && lFile.data.graph && lFile.data.graph.nodes && lFile.data.graph.nodes.length, edges: lFile.data && lFile.data.graph && lFile.data.graph.edges && lFile.data.graph.edges.length, warn: lFile.data && lFile.data.warnings, err: lFile.error },
                sGrp: { ok: sGrp.ok, err: sGrp.error },
                lGrp: { ok: lGrp.ok, viewStack: lGrp.data && lGrp.data.canvases && lGrp.data.canvases.viewStack, groupIds: lGrp.data && lGrp.data.canvases && Object.keys(lGrp.data.canvases.groups||{}) }
              };
            })();
            out.savetest = sv;
          } catch(e){ out.savetest = 'THREW:'+e.message; }
          try {
            const sess = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂内容');
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请在画布创建 2 个任务节点并连线。');
              const s1 = window.__codenodeSession.getState();
              const first = s1.sessions[s1.order[0]];
              const active = s1.current();
              return {
                chatOk: !!r.reply || r.tools.length > 0,
                sessionCount: s1.order.length,
                activeLabel: active ? active.label : null,
                activeNodes: active ? active.doc.root.nodes.length : -1,
                completed: s1.order.filter((id)=>s1.sessions[id].status==='completed').length,
                firstNodeCount: first ? first.doc.root.nodes.length : -1,
                graphNodes: window.__codenodeStore.getState().nodes.length
              };
            })();
            out.sessionsim = sess;
          } catch(e){ out.sessionsim = 'THREW:'+e.message; }
          try {
            const sp = await (async()=>{
              const ss = window.__codenodeSession.getState();
              ss.syncActiveGraph();
              const active = ss.current();
              const sessions = ss.order.map((id)=>ss.sessions[id]).filter(Boolean).map((s)=>({
                id: s.id, label: s.label, prompt: s.prompt, status: s.status,
                createdAt: s.createdAt, nodeCount: s.nodeCount, summary: s.summary || '',
                root: s.doc.root, groups: s.doc.groups, viewStack: s.doc.viewStack
              }));
              const file = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir\\\\sessions.cnode';
              const payload = {
                graph: active ? active.doc.root : { nodes: [], edges: [] },
                canvases: { groups: active ? active.doc.groups : {}, viewStack: active ? active.doc.viewStack : [], sessions, messages: ss.messages },
                workspace: { viewport: { x:0, y:0, zoom:1 } },
                manifest: { name: '会话持久化测试' }
              };
              const s = await window.codenode.saveProject(file, payload);
              const l = await window.codenode.loadProject(file);
              const sess2 = l.data && l.data.canvases && l.data.canvases.sessions;
              return {
                saved: s.ok,
                loaded: l.ok,
                stored: Array.isArray(sess2) ? sess2.length : 0,
                lastNodes: sess2 && sess2[sess2.length-1] ? sess2[sess2.length-1].root.nodes.length : -1,
                lastLabel: sess2 && sess2[sess2.length-1] ? sess2[sess2.length-1].label : null,
                messages: l.data && l.data.canvases && Array.isArray(l.data.canvases.messages) ? l.data.canvases.messages.length : 0
              };
            })();
            out.sesspersist = sp;
          } catch(e){ out.sesspersist = 'THREW:'+e.message; }
          try {
            const rc = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂内容');
              // 模拟用户手动新建节点
              graph.addNode({ id:'m1', type:'task', position:{x:40,y:40}, data:{label:'节点甲',status:'pending',prompt:''} });
              graph.addNode({ id:'m2', type:'task', position:{x:240,y:40}, data:{label:'节点乙',status:'pending',prompt:''} });
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请阅读画布中的节点并制作：把两个节点连接起来，并说明每个节点应该做什么。');
              const s1 = window.__codenodeSession.getState();
              const active = s1.current();
              const lastAgent = [...s1.messages].reverse().find((m)=>m.role==='assistant');
              const toolNames = (lastAgent && lastAgent.tools ? lastAgent.tools.map(t=>t.name) : []);
              const wbm = lastAgent && lastAgent.tools ? lastAgent.tools.find(t=>t.name==='get_workbench_model') : null;
              return {
                chatOk: !!r.reply || r.tools.length>0,
                sessionCount: s1.order.length,
                activeLabel: active ? active.label : null,
                activeNodes: active ? active.doc.root.nodes.length : -1,
                toolNames: toolNames.join(','),
                wbmSawNodes: !!(wbm && JSON.stringify(wbm.data || '').indexOf('节点甲') >= 0),
                replyHasNodes: !!(r.reply && r.reply.indexOf('节点甲') >= 0)
              };
            })();
            out.readcanvas = rc;
          } catch(e){ out.readcanvas = 'THREW:'+e.message; }
          try {
            const lt = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              // 加载用户保存的 t9.cnode（节点在画布1，画布2/3 为空）
              const l = await window.codenode.loadProject('E:\\\\Dev_1\\\\t9.cnode');
              const sessData = l.data && l.data.canvases && l.data.canvases.sessions;
              if (Array.isArray(sessData)) {
                const list = sessData.map((sd, i)=>({
                  id: sd.id || ('c'+i), label: sd.label || ('画布'+(i+1)), prompt: sd.prompt || '',
                  status: (sd.status==='active'||sd.status==='completed') ? sd.status : 'active',
                  createdAt: sd.createdAt||0, nodeCount: sd.nodeCount||0, summary: sd.summary||'',
                  doc: { root: { nodes: sd.root ? sd.root.nodes : [], edges: sd.root ? sd.root.edges : [] },
                         groups: sd.groups || {}, viewStack: sd.viewStack || [] }
                }));
                ss.restoreSessions(list, (l.data.canvases.messages)||[], undefined);
              }
              const s1 = window.__codenodeSession.getState();
              const active = s1.current();
              const before = { label: active?active.label:null, nodes: active?active.doc.root.nodes.length:-1 };
              // 让 Agent 阅读画布并制作
              const chat = window.__codenodeChat.getState();
              const r = await chat.send('请阅读当前画布上的全部节点并制作。');
              const s2 = window.__codenodeSession.getState();
              const a2 = s2.current();
              const lastAgent = [...s2.messages].reverse().find((m)=>m.role==='assistant');
              const wbm = lastAgent && lastAgent.tools ? lastAgent.tools.find(t=>t.name==='get_workbench_model') : null;
              return {
                loaded: l.ok,
                beforeLabel: before.label,
                beforeNodes: before.nodes,
                afterLabel: a2 ? a2.label : null,
                afterNodes: a2 ? a2.doc.root.nodes.length : -1,
                sessionCount: s2.order.length,
                wbmDataLen: wbm ? JSON.stringify(wbm.data||'').length : 0,
                replyOk: !!r.reply
              };
            })();
            out.loadt9 = lt;
          } catch(e){ out.loadt9 = 'THREW:'+e.message; }
          try {
            const mt = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('你好，我能为你做什么', '灵魂');
              const chat = window.__codenodeChat.getState();
              await chat.send('请创建 2 个任务节点并连线。');
              const s1 = window.__codenodeSession.getState();
              const c2 = s1.current();
              await chat.send('请阅读当前画布并继续制作：在每个节点后补充一个说明节点。');
              const s2 = window.__codenodeSession.getState();
              const c3 = s2.current();
              await new Promise((r)=>setTimeout(r, 1100));
              // 检查横向自动整理
              const nodes = window.__codenodeStore.getState().nodes;
              const xs = nodes.map(n=>Math.round(n.position.x));
              const ys = nodes.map(n=>Math.round(n.position.y));
              const sorted = [...xs].sort((a,b)=>a-b);
              const horizontal = xs.length>1 && sorted[sorted.length-1] > sorted[0];
              const rows = new Set(ys).size;
              return {
                turn1Canvas: c2 ? c2.label : null,
                turn1Nodes: c2 ? c2.doc.root.nodes.length : -1,
                turn2Canvas: c3 ? c3.label : null,
                turn2Nodes: c3 ? c3.doc.root.nodes.length : -1,
                sessionCount: s2.order.length,
                nodeCount: nodes.length,
                horizontal: horizontal,
                rowCount: rows
              };
            })();
            out.multiturn = mt;
          } catch(e){ out.multiturn = 'THREW:'+e.message; }
          try {
            const lw = await (async()=>{
              const ss = window.__codenodeSession.getState();
              const graph = window.__codenodeStore.getState();
              graph.clear();
              ss.reset();
              ss.initProject('', '');
              for(let i=1;i<=15;i++){
                graph.addNode({ id:'w'+i, type:'task', position:{x:40,y:40}, data:{label:'节点'+i,status:'pending'} });
              }
              graph.layoutNodes();
              await new Promise((r)=>setTimeout(r,150));
              const nodes = window.__codenodeStore.getState().nodes;
              const xs = nodes.map(n=>Math.round(n.position.x));
              const ys = nodes.map(n=>Math.round(n.position.y));
              const rows = new Set(ys).size;
              const firstRowXs = nodes.filter(n=>Math.round(n.position.y)===ys[0]).map(n=>Math.round(n.position.x)).sort((a,b)=>a-b);
              const ascending = firstRowXs.every((v,i)=>i===0||v>firstRowXs[i-1]);
              return { count: nodes.length, rowCount: rows, firstRowXAscending: ascending };
            })();
            out.layoutwrap = lw;
          } catch(e){ out.layoutwrap = 'THREW:'+e.message; }
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

function auditLog(projectRoot, entry) {
  try {
    if (!projectRoot) return;
    const dir = path.join(projectRoot, '.codenode');
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').appendFileSync(
      path.join(dir, 'audit.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), entry }) + '\n',
      'utf-8'
    );
  } catch {}
}

/** 保存文档到工程文件（save_project 工具用）。 */
function saveDoc(projectRoot, projectFile, model) {
  const doc = model ? model.doc : null;
  const graph = (doc && doc.root) || { nodes: [], edges: [] };
  const canvases = doc ? { groups: doc.groups || {}, viewStack: doc.viewStack || [] } : undefined;
  const filePath = projectFile
    ? path.resolve(projectFile)
    : path.join(path.resolve(projectRoot || '.'), 'workflow.cnode');
  require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
  require('fs').writeFileSync(
    filePath,
    cnode.encodeCnode({
      graph,
      canvases,
      workspace: {},
      manifest: {},
    })
  );
  return filePath;
}

ipcMain.handle('agent:config', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  return { configured: !!cfg.apiKey, model: cfg.model, soul, toolsEnabled: cfg.tools.toolsEnabled };
});

ipcMain.handle('agent:greeting', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const soul = agent.parseSoul(agent.loadSoul(cfg, projectRoot));
  return { greeting: soul.greeting, name: soul.name, configured: !!cfg.apiKey };
});

ipcMain.handle('agent:tools', async (_event, projectRoot) => {
  const cfg = agent.loadConfig(projectRoot);
  const registry = toolkit.buildDefaultRegistryWithConfig(cfg.tools);
  return {
    enabled: cfg.tools.toolsEnabled,
    tools: registry.listTools().map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    })),
  };
});

ipcMain.handle('agent:chat', async (event, payload) => {
  const { projectRoot, prompt, history, canvasSummary, nodeId, requestId, document, projectFile } = payload || {};
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

    // 先装配工具注册表：用于系统提示中的工具引导，也用于工具循环
    let registry = null;
    if (cfg.tools.toolsEnabled) {
      registry = toolkit.buildDefaultRegistryWithConfig(cfg.tools);
    }
    const toolGuide = agent.buildToolGuide(registry ? registry.listTools() : []);
    const messages = [{ role: 'system', content: agent.buildSystemPrompt(soul, canvasSummary, toolGuide) }];
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

    // ---- 装配工具 ----
    let tools = null;
    let model = null;
    let bridge = null;
    let dirty = false;
    if (registry && registry.listTools().length > 0) {
        bridge = makeBridge(sender);
        model = new GraphModel(document || undefined);
        const undoStack = [];
        const redoStack = [];
        const context = new AgentToolContext({
          projectRoot,
          model,
          confirm: (level, what, detail) => bridge.confirm(level, what, detail),
          askUser: (question, options) => bridge.askUser(question, options),
          ui: (action, args) => bridge.ui(action, args),
          audit: (entry) => auditLog(projectRoot, entry),
          mutateWorkbench: async (fn) => {
            undoStack.push(JSON.parse(JSON.stringify(model.doc)));
            if (redoStack.length) redoStack.length = 0;
            fn(model);
            dirty = true;
            return true;
          },
          undo: async () => {
            if (undoStack.length) {
              redoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(undoStack.pop()));
              dirty = true;
            }
          },
          redo: async () => {
            if (redoStack.length) {
              undoStack.push(JSON.parse(JSON.stringify(model.doc)));
              model.doc = JSON.parse(JSON.stringify(redoStack.pop()));
              dirty = true;
            }
          },
          saveProject: async () => {
            const saved = saveDoc(projectRoot, projectFile, model);
            sendDelta({ kind: 'saved', filePath: saved });
            return saved;
          },
          conversationHistory: () =>
            messages.filter((m) => m.role !== 'system').slice(-20).map((m) => ({ role: m.role, content: m.content })),
          notifyFileChange: (rel, kind, detail) => {
            sendDelta({ kind: 'file_change', fileChange: { path: rel, kind, detail } });
          },
        });
        tools = { registry, context };
    }

    sendDelta({ kind: 'start' });
    const result = await agent.runAgentChat({
      cfg,
      messages,
      onDelta: sendDelta,
      tools,
    });
    agent.logConversation(projectRoot, {
      ts: new Date().toISOString(),
      role: 'assistant',
      content: result.content,
      reasoning: result.reasoning || null,
      toolCalls: result.toolCalls || null,
      usage: result.usage || null,
    });
    sendDelta({ kind: 'done' });
    const out = {
      ok: !result.error,
      reply: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
    };
    if (result.error) out.error = result.error;
    if (dirty && model) out.document = model.doc;
    if (bridge) bridge.cleanup();
    return out;
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
