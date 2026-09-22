const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const APP_ICON_SOURCE = path.join(__dirname, '..', 'codenode-icon.png');

function resolveAppIcon() {
  if (fs.existsSync(APP_ICON)) return APP_ICON;
  if (fs.existsSync(APP_ICON_SOURCE)) return APP_ICON_SOURCE;
  return undefined;
}

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.codenode.desktop');
  } catch {}
}

// ---- 最小可注入点：隔离 userData 目录（发布自检 / 升级回滚验证用） ----
// 支持 --codenode-user-data-dir=<dir> 或 CODENODE_USER_DATA_DIR=<dir>；
// 两者都没有时行为与改动前完全一致（继续使用默认 userData）。
(function applyUserDataOverride() {
  try {
    const flag = process.argv.find((item) => String(item).startsWith('--codenode-user-data-dir='));
    const target = flag ? String(flag).slice('--codenode-user-data-dir='.length) : process.env.CODENODE_USER_DATA_DIR;
    if (!target) return;
    const dir = path.resolve(target);
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch { /* 覆盖失败时保持默认行为 */ }
})();

// Windows 控制台切换为 UTF-8，避免终端面板打印中文乱码
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001 >nul', { stdio: 'ignore' });
  } catch {}
}

/**
 * 控制台日志面板：把主进程的 console.log/info/warn/error 同时写入
 * <exe 目录>/logs/console.log。打包后的便携版 exe 没有附着控制台，配合
 * “CodeNode 控制台.cmd”启动器（桌面快捷方式指向它）即可在独立的 cmd 面板实时查看日志。
 */
function setupConsoleLog() {
  try {
    const dir = path.join(path.dirname(process.execPath), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'console.log');
    const stamp = () => '[' + new Date().toISOString() + '] ';
    const toStr = (a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return String(a && a.stack ? a.stack : a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const write = (args) => {
      try {
        fs.appendFileSync(file, stamp() + args.map(toStr).join(' ') + '\n', 'utf-8');
      } catch {}
    };
    const hook = (original) =>
      function (...args) {
        write(args);
        if (original) original.apply(console, args);
      };
    console.log = hook(console.log);
    console.info = hook(console.info);
    console.warn = hook(console.warn);
    console.error = hook(console.error);
  } catch {}
}
setupConsoleLog();

const agent = require('./agent.cjs');
const runStore = require('./runStore.cjs');
const sandbox = require('./sandbox.cjs');
// IPC 按域拆出的模块（各自导出 register(ctx)，依赖显式传入；auditLog 也随工程域搬走了）
const { auditLog } = require('./ipc/project.cjs');

// ---------------------------------------------------------------------------
// IPC 接线区：各域实现在 electron/ipc/*.cjs，依赖显式传入（这里只有 app 相关的 userData 目录）
// ---------------------------------------------------------------------------
const ipcContext = { ipcMain, userDataDir: () => app.getPath('userData') };
require('./ipc/models.cjs').register({ ...ipcContext, agent });
require('./ipc/metrics.cjs').register({ ...ipcContext, agent, sandbox, runStore });
require('./ipc/project.cjs').register({ ...ipcContext, dialog, getFocusedWindow: () => BrowserWindow.getFocusedWindow(), sandbox });
require('./ipc/agent.cjs').register(ipcContext);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** 仅把 http(s) 外链交给系统浏览器；file:、javascript: 等其它协议直接丢弃。 */
function openExternalSafely(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return;
  try {
    shell.openExternal(target).catch(() => {});
  } catch {}
}

/** 只有应用自身页面（开发服务器或打包后的 file:// 入口）算站内导航。 */
function isInternalUrl(url) {
  const target = String(url || '');
  if (DEV_SERVER_URL && target.startsWith(DEV_SERVER_URL)) return true;
  if (!target.startsWith('file://')) return false;
  try {
    const filePath = decodeURIComponent(new URL(target).pathname);
    const normalized = process.platform === 'win32' ? filePath.replace(/^\//, '') : filePath;
    return path.resolve(normalized).startsWith(path.resolve(path.join(__dirname, '..')));
  } catch {
    return false;
  }
}

// 渲染层不使用任何浏览器权限（src/ 内无 getUserMedia / Notification / clipboard / fullscreen 调用），
// 因此默认全量拒绝；将来确有需要，必须在这里显式放行并说明用途。
/** @type {Set<string>} 渲染层不使用的权限一律不在集合里（默认全量拒绝） */
const ALLOWED_PERMISSIONS = new Set([]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // 侧栏改成可收起的 tab 面板后，窄窗口不再需要 960 硬下限：
    // 允许窗口缩到 720，交给渲染进程的响应式规则（<=860 侧栏转浮层）处理。
    minWidth: 720,
    minHeight: 560,
    title: 'CodeNode Next',
    backgroundColor: '#14161a',
    icon: resolveAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ---- 窗口加固：外链交系统浏览器、站外导航一律拦截、浏览器权限默认拒绝 ----
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) console.log('[security] 已拒绝渲染层权限请求: ' + permission);
    callback(allowed);
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
              g.layoutNodes();
              await new Promise((r)=>setTimeout(r,200));
              const s = st.getState();
              const xs = s.nodes.map(n=>Math.round(n.position.x)).sort((a,b)=>a-b);
              const ys = s.nodes.map(n=>Math.round(n.position.y));
              const rows = new Set(ys).size;
              return {
                nodeCount: s.nodes.length,
                singleRow: rows === 1,
                ascending: xs.every((v,i)=>i===0||v>xs[i-1]),
                groupNodes: s.nodes.filter(n=>n.type==='group').length
              };
            })();
            out.layout = gres;
          } catch(e){ out.layout = 'THREW:'+e.message; }
          try {
            const persist = await (async()=>{
              const st = window.__codenodeStore;
              const d = st.getState().getDocument();
              const save = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode', {
                graph: d,
              });
              const load = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj2\\\\g.cnode');
              return {
                saved: save.ok,
                loaded: load.ok,
                nodes: load.data && load.data.graph && load.data.graph.nodes && load.data.graph.nodes.length
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
              g.addNode({ id:'scope-t', type:'scope', position:{x:120,y:120}, data:{ label:'范围', status:'pending', width:320, height:220, childIds:[] } });
              g.addNode({ id:'task-t', type:'task', position:{x:180,y:180}, data:{ label:'任务', status:'pending' } });
              g.addToScope('task-t', 'scope-t');
              await new Promise((r)=>setTimeout(r,200));
              const s = st.getState();
              const scope = s.nodes.find((n)=>n.type==='scope');
              return {
                scopes: s.nodes.filter((n)=>n.type==='scope').length,
                tasks: s.nodes.filter((n)=>n.type==='task').length,
                memberCount: scope && scope.data && scope.data.childIds ? scope.data.childIds.length : 0
              };
            })();
            out.chatwindow = cw;
          } catch(e){ out.chatwindow = 'THREW:'+e.message; }
          try {
            const sc = await (async()=>{
              const st = window.__codenodeStore;
              const g = st.getState();
              g.clear();
              g.addNode({ id:'t1', type:'task', position:{x:100,y:100}, data:{label:'任务',status:'done'} });
              g.addNode({ id:'s1', type:'scope', position:{x:100,y:340}, data:{label:'范围',status:'pending',width:320,height:220,childIds:['t1']} });
              const doc = st.getState().getDocument();
              const payload = { graph: doc, workspace:{viewport:{x:0,y:0,zoom:1}}, manifest: {} };
              const s = await window.codenode.saveProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode', payload);
              const l = await window.codenode.loadProject('E:\\\\codenode_nw\\\\logs\\\\testproj3\\\\s.cnode');
              const nodes = (l.data && l.data.graph && l.data.graph.nodes) || [];
              const scopeNode = nodes.find((n)=>n.type==='scope');
              return {
                saved: s.ok, loaded: l.ok, saveErr: s.error,
                types: nodes.map((n)=>n.type).sort().join(','),
                taskCount: nodes.filter((n)=>n.type==='task').length,
                scopeMembers: scopeNode && scopeNode.data && scopeNode.data.childIds ? scopeNode.data.childIds.join(',') : ''
              };
            })();
            out.savechat = sc;
          } catch(e){ out.savechat = 'THREW:'+e.message; }
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
                graph: doc,
                workspace: { viewport: { x: 5, y: 6, zoom: 1 } },
                manifest: { name: '保存链路测试', documentId: 'save-test-doc' }
              };
              const dir = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir';
              const file = dir + '\\\\proj.cnode';
              const sDir = await window.codenode.saveProject(dir, payload);
              const sFile = await window.codenode.saveProject(file, payload);
              const lFile = await window.codenode.loadProject(file);
              return {
                sDir: { ok: sDir.ok, filePath: sDir.filePath, err: sDir.error },
                sFile: { ok: sFile.ok, filePath: sFile.filePath, err: sFile.error },
                lFile: { ok: lFile.ok, nodes: lFile.data && lFile.data.graph && lFile.data.graph.nodes && lFile.data.graph.nodes.length, edges: lFile.data && lFile.data.graph && lFile.data.graph.edges && lFile.data.graph.edges.length, warn: lFile.data && lFile.data.warnings, err: lFile.error }
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
                root: s.doc.root
              }));
              const file = 'E:\\\\codenode_nw\\\\logs\\\\tooltest\\\\savedir\\\\sessions.cnode';
              const payload = {
                graph: active ? active.doc.root : { nodes: [], edges: [] },
                canvases: { sessions, messages: ss.messages },
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
                  doc: { root: { nodes: sd.root ? sd.root.nodes : [], edges: sd.root ? sd.root.edges : [] } }
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
              const xs = nodes.map(n=>Math.round(n.position.x)).sort((a,b)=>a-b);
              const ys = nodes.map(n=>Math.round(n.position.y));
              const rows = new Set(ys).size;
              const ascending = xs.every((v,i)=>i===0||v>xs[i-1]);
              return { count: nodes.length, rowCount: rows, firstRowXAscending: ascending, singleLine: rows === 1 };
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

// ---- 发布自检入口（--codenode-selftest）：不创建窗口，输出 JSON 后立即退出 ----
// 该分支同步执行、在所有既有逻辑之前完成，`app.exit()` 立即结束进程，
// 因此不会触发下面的 app.whenReady() 窗口创建，对既有行为零改动。
if (process.argv.includes('--codenode-selftest')) {
  const selfTest = require('./selfTest.cjs');
  let code = 1;
  try {
    const result = selfTest.runSelfTest({ userDataDir: app.getPath('userData'), argv: process.argv });
    code = selfTest.emitResult(result, process.argv);
  } catch (error) {
    code = selfTest.emitResult({ ok: false, kind: 'codenode-selftest', error: String((error && error.stack) || error) }, process.argv);
  }
  app.exit(code);
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
