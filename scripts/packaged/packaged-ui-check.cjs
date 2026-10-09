/**
 * 打包产物前端校验：直接用 Electron 的 asar 感知 fs 从 app.asar 内加载 dist/index.html，
 * 确认「桌面快捷方式启动的那个 exe」看到的界面就是新版（左侧 tab 面板 + Agent 常驻输入框）。
 *
 * 用法：node scripts/run-electron.cjs scripts/packaged/packaged-ui-check.cjs
 * 前置：npm run dist:win（生成 release/win-unpacked/resources/app.asar）
 */
'use strict';
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "../..");
const ASAR = process.env.CODENODE_PACKAGED_ASAR
  ? path.resolve(process.env.CODENODE_PACKAGED_ASAR)
  : path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
const SHOT = process.env.CODENODE_PACKAGED_UI_SHOT
  ? path.resolve(process.env.CODENODE_PACKAGED_UI_SHOT)
  : path.join(ROOT, 'out', 'packaged-ui.png');
function removeIsolatedTemp(target, prefix) {
  if (!target) return;
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('拒绝清理意外路径：' + resolved);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};

let appWin = null;
app.on('browser-window-created', (_e, win) => {
  if (!appWin) appWin = win;
});
// 先加载应用主进程，注册 IPC handler（project:list / models:list 等），
// 保证渲染进程拿到的 API 与正式启动一致
require("../../electron/main.cjs");

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-packaged-'));
  let win = null;
  let projRoot = null;
  try {
    if (!fs.existsSync(ASAR)) throw new Error('未找到打包产物：' + ASAR + '（先跑 npm run dist:win）');

    const indexInAsar = path.join(ASAR, 'dist', 'index.html');
    const rawHtml = fs.readFileSync(indexInAsar, 'utf8'); // 走 Electron 的 asar 感知 fs
    console.log('asar 内入口可读: ' + rawHtml.length + ' 字节');
    const packagedConfig = JSON.parse(fs.readFileSync(path.join(ASAR, 'config', 'agent.backends.json'), 'utf8'));
    ok('asar 包含六种已注册后端', JSON.stringify(packagedConfig.backends) === JSON.stringify(['builtin', 'codex', 'deepseek-harness', 'hermes', 'opencode', 'openclaw']));
    const waitConfig=JSON.parse(fs.readFileSync(path.join(ASAR,'config','goal.wait.json'),'utf8'));
    const evalWait=require(path.join(ASAR,'electron','goalWaitProviders','agentEval.cjs'));
    ok('asar 包含按 SHA/数据集绑定的 Agent Eval 报告状态源',waitConfig.providers.includes('agent-eval')&&typeof evalWait.check==='function');
    const packagedBackends = require(path.join(ASAR, 'electron', 'backends', 'index.cjs'));
    ok('asar 可加载 ACP 与 DeepSeek Harness adapters', packagedBackends.createBackend('hermes', { backend: 'hermes', sandbox: 'read-only' }).constructor.name === 'AcpBackend' && packagedBackends.createBackend('deepseek-harness', { backend: 'deepseek-harness', sandbox: 'read-only' }).constructor.name === 'DeepSeekHarnessBackend');
    const packagedGoalStore = require(path.join(ASAR, 'electron', 'goalStore.cjs'));
    ok('asar 可加载 Goal admission、重启恢复、证据与等待调度', typeof packagedGoalStore.admit === 'function' && typeof packagedGoalStore.reconcileAdmissions === 'function' && typeof packagedGoalStore.recordEvidence === 'function' && typeof packagedGoalStore.releaseDueTimeWaits === 'function' && typeof packagedGoalStore.confirmExperience === 'function');
    ok('asar 包含默认关闭、单次认领与失败终止的自动推进状态机', typeof packagedGoalStore.claimAutoAdvance === 'function' && typeof packagedGoalStore.releaseAutoAdvanceClaim === 'function' && typeof packagedGoalStore.reconcileAutoAdvanceClaims === 'function');
    ok('asar 包含未知 Run 的差异复核与重排门', typeof packagedGoalStore.runReview === 'function' && typeof packagedGoalStore.confirmRunReview === 'function');

    // asar 内 .js/.css 用相对路径引用，file:// 读不到；把同一份 asar 内资源实体化到临时目录，
    // 保证加载的就是「打包产物里的那一份」而不是源码 dist。
    const assetsDir = path.join(ASAR, 'dist', 'assets');
    const assetNames = fs.readdirSync(assetsDir);
    const rendererBundles=assetNames.filter(name=>name.endsWith('.js')).map(name=>fs.readFileSync(path.join(assetsDir,name),'utf8'));
    ok('asar 渲染包包含 Run 复核与 Agent Eval 等待控件',rendererBundles.some(bundle=>bundle.includes('确认复核并重新排队')&&bundle.includes('我已查看 Run 差异并核对外部副作用')&&bundle.includes('Agent Eval commit SHA')&&bundle.includes('查询 Agent Eval 报告')));
    ok('asar 渲染包包含显式自动推进授权与应用级调度器',rendererBundles.some(bundle=>bundle.includes('等待条件满足后自动推进')&&bundle.includes('自动启动 Task')));
    ok('asar 包含未保存配置检测与 ACP 权限设置',rendererBundles.some(bundle=>bundle.includes('检测当前配置')&&bundle.includes('ACP 权限请求策略')));
    ok('asar 包含 ACP 文件/终端、多媒体、MCP 客户端与设置入口', typeof require(path.join(ASAR,'electron/backends/acpClient.cjs')).AcpClient === 'function' && typeof require(path.join(ASAR,'electron/backends/acpContent.cjs')).promptContent === 'function' && typeof require(path.join(ASAR,'electron/backends/acpMcp.cjs')).createToolBridge === 'function' && rendererBundles.some(bundle=>bundle.includes('ACP 会话配置')&&bundle.includes('执行 ACP 认证')));
    const distTmp = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(distTmp, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distTmp, 'index.html'), rawHtml);
    for (const name of assetNames) {
      fs.copyFileSync(path.join(assetsDir, name), path.join(distTmp, 'assets', name));
    }
    console.log('打包前端资源: ' + assetNames.join(', '));

    // 注册最小 file 协议旁路（Electron 默认已能读 asar，这里仅兜底根路径）
    protocol.handle('asset', (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      return new Response(fs.readFileSync(path.join(distTmp, rel)), {
        headers: { 'content-type': rel.endsWith('.css') ? 'text/css' : 'text/javascript' },
      });
    });
    void pathToFileURL;

    win = new BrowserWindow({
      width: 1180,
      height: 760,
      show: false,
      webPreferences: { sandbox: true, preload: path.join(ROOT, 'electron', 'preload.cjs') },
    });
    await win.loadFile(path.join(distTmp, 'index.html'));
    await sleep(700);

    const js = (code) => win.webContents.executeJavaScript(code).catch((error) => {
      throw new Error(String(error) + '\nRenderer script: ' + code);
    });

    // 打包后的 App 同样走门禁页；注入临时工程进入工作台
    projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-packaged-proj-'));
    fs.writeFileSync(path.join(projRoot, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(projRoot)}); return true; })()`);
    await sleep(800);

    ok('工作台已渲染', await js(`!!document.querySelector('.canvas-wrap')`));
    ok('画布上已无悬浮会话面板/输入条', await js(`!document.querySelector('.cs-sidebar') && !document.querySelector('.prompt-bar')`));

    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); window.__codenodeUi.setState({conversationOpen:true}); return true; })()`);
    await sleep(500);
    const geom = await js(`(function(){
      const el = document.querySelector('.conversation-workspace');
      const r = el.getBoundingClientRect();
      const c = document.querySelector('.canvas-wrap').getBoundingClientRect();
      const compt = document.querySelector('.pp-composer');
      const cr = compt.getBoundingClientRect();
      return {
        conversationVisible: !el.hidden,
        conversation: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) },
        canvas: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height), bottom: Math.round(c.bottom) },
        composerInside: cr.bottom <= r.bottom + 1,
        composerH: Math.round(cr.height),
        bodyH: Math.round(document.querySelector('.ap-body').getBoundingClientRect().height),
        hasInput: !!document.querySelector('.pp-composer .pp-input'),
        hasSend: !!document.querySelector('.pp-send'),
        duplicateWorkspaceTabs: !!document.querySelector('.workspace-tabs')
      };
    })()`);
    console.log('GEOM: ' + JSON.stringify(geom));
    ok('对话栏已显示', geom.conversationVisible, JSON.stringify(geom));
    ok('画布与对话栏左右相邻且不重叠', geom.conversation.x >= geom.canvas.x + geom.canvas.w - 1 && Math.abs(geom.conversation.y - geom.canvas.y) <= 1 && geom.conversation.w > 0, JSON.stringify(geom));
    ok('Agent 输入框位于对话栏底部', geom.hasInput && geom.hasSend && geom.composerInside, JSON.stringify(geom));
    ok('工作区没有重复顶部页签', !geom.duplicateWorkspaceTabs);
    ok('对话区占据主要高度', geom.bodyH > geom.composerH, `body=${geom.bodyH} composer=${geom.composerH}`);
    const autoAdvanceApi=await js(`({claim:typeof window.codenode.goalAutoAdvanceClaim==='function',release:typeof window.codenode.goalAutoAdvanceRelease==='function'})`);
    ok('打包 preload 暴露自动推进 claim/release IPC',autoAdvanceApi.claim&&autoAdvanceApi.release,JSON.stringify(autoAdvanceApi));

    await js(`(()=>{ window.__codenodeUi.getState().setSideTab('project'); return true; })()`);
    await sleep(400);
    ok('项目标签含文件树与过滤框', await js(`!!document.querySelector('.pm-tree') && !!document.querySelector('.pm-search')`));

    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, img.toPNG());
    console.log('  shot → ' + SHOT);
  } catch (e) {
    failures.push('harness error');
    console.error('PACKAGED UI CHECK ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    try {
      if (win) win.destroy();
      removeIsolatedTemp(tmp, 'codenode-packaged-');
      removeIsolatedTemp(projRoot, 'codenode-packaged-proj-');
    } catch { /* 清理失败无所谓 */ }
    console.log('\nPACKAGED UI CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
