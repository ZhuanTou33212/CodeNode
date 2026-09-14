/** 右侧统一侧栏的 UI 校验：由 side-panel-check.cjs 在真实主进程内调用 */
module.exports = async function run({ win, js, sleep, ok, shot }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // 临时项目目录：一个 .cnode 工程文件 + 一个源码文件，让文件树有内容可选
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-side-'));
  fs.writeFileSync(path.join(root, 'demo.cnode'), JSON.stringify({ name: 'demo', nodes: [], edges: [] }, null, 2));
  fs.writeFileSync(path.join(root, 'readme.md'), '# CodeNode\n\n侧栏预览测试文件\n第二行\n第三行\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'console.log("hello side panel");\n');

  const geom = () =>
    js(
      `(()=>{
        const el = document.querySelector('.side-panel');
        const c = document.querySelector('.canvas-wrap');
        const cr = c ? c.getBoundingClientRect() : null;
        const sr = el ? el.getBoundingClientRect() : null;
        const active = document.querySelector('.sp-tab.is-active');
        return {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          side: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height), right: Math.round(sr.right) } : null,
          canvas: cr ? { x: Math.round(cr.x), w: Math.round(cr.width), right: Math.round(cr.right) } : null,
          bad: el ? el.scrollWidth > el.clientWidth + 1 : false,
          badParts: el
            ? (function () {
                const pr = el.getBoundingClientRect();
                return [...el.querySelectorAll('*')]
                  .map(function (n) {
                    const r = n.getBoundingClientRect();
                    const cls = n.className && typeof n.className === 'string' ? n.className : n.tagName;
                    return { cls: cls, right: Math.round(r.right), w: Math.round(r.width), pos: getComputedStyle(n).position };
                  })
                  .filter(function (x) {
                    // 拖动把手 .pm-resize 故意越界 3px，不算缺陷
                    return x.right > pr.right + 4 && x.cls.indexOf('pm-resize') < 0;
                  })
                  .slice(0, 6);
              })()
            : [],
          popBad: (function () {
            var pop = document.querySelector('.ap-usage-pop');
            return pop ? pop.scrollWidth > pop.clientWidth + 1 : false;
          })(),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1 || document.documentElement.scrollHeight > window.innerHeight + 1,
          activeTab: active ? active.textContent.trim() : null,
          tabs: [...document.querySelectorAll('.sp-tab')].map((b) => b.textContent.trim()),
          badge: (document.querySelector('.side-badge') || {}).textContent || null,
          treeRows: document.querySelectorAll('.pm-tree .pm-row').length,
          preview: document.querySelector('.fp-content') ? document.querySelector('.fp-content').textContent.length : 0,
          hasAgentBody: !!document.querySelector('.ap-body'),
          hasComposer: !!document.querySelector('.pp-composer .pp-input'),
          hasLegacyOverlay: !!document.querySelector('.cs-sidebar') || !!document.querySelector('.prompt-bar'),
          position: el ? getComputedStyle(el).position : null
        };
      })()`,
    );

  // 显示窗口：隐藏窗口下 Chromium 会节流绘制，capturePage 会拿到过期帧
  win.show();
  await sleep(400);

  // 注入项目根目录，绕过启动门禁页
  await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(root)}); return true; })()`);
  await sleep(700);
  ok('工作台已渲染（非门禁页）', await js(`!!document.querySelector('.canvas-wrap')`));

  // ---- 1) 默认收起：画布占满 ----
  const closed = await geom();
  ok('默认收起时不渲染侧栏，只有入口角标', closed.side === null && !!closed.badge, JSON.stringify(closed.badge));
  ok('收起时画布占满工作区宽度', closed.canvas.right >= closed.viewport.w - 2, `canvas.right=${closed.canvas.right} vw=${closed.viewport.w}`);
  ok('收起时无横向溢出', !closed.overflow);
  await shot(win, 'side-01-collapsed');

  // ---- 2) 打开侧栏：默认落在 Agent 标签（原画布悬浮会话面板）----
  await js(`(()=>{ window.__codenodeUi.getState().toggleSide(); return true; })()`);
  await sleep(400);
  const open = await geom();
  ok('侧栏打开且为静态列（非浮层）', !!open.side && open.position === 'relative', 'position=' + open.position);
  ok('侧栏与画布并排：画布变窄而非被遮挡', open.canvas.w < closed.canvas.w - 200 && open.side.right <= open.canvas.x + 1, JSON.stringify(open));
  ok('侧栏贴在左侧', open.side.x <= 1, 'side.x=' + open.side.x);
  ok('侧栏宽度默认 300', Math.abs(open.side.w - 300) <= 1, 'w=' + open.side.w);
  ok('侧栏内无横向内容溢出', open.badParts.length === 0, 'width=' + open.side.w + ' offenders=' + JSON.stringify(open.badParts));
  ok('页面无溢出滚动条', !open.overflow);
  ok('四个标签齐全(Agent/节点/项目/预览)', open.tabs.join('/') === 'Agent/节点/项目/预览', open.tabs.join('/'));
  ok('默认标签是 Agent', open.activeTab === 'Agent', 'active=' + open.activeTab);
  ok('Agent 标签内含消息区与输入区', open.hasAgentBody && open.hasComposer, `body=${open.hasAgentBody} composer=${open.hasComposer}`);
  await shot(win, 'side-02-agent');

  // 画布上不再有悬浮会话面板 / 底部 Prompt
  ok(
    '画布中已无悬浮 ChatSidebar / PromptBar',
    (await js(`!document.querySelector('.cs-sidebar') && !document.querySelector('.cs-panel') && !document.querySelector('.prompt-bar')`)),
  );

  // 节点标签仍可用
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('node'); return true; })()`);
  await sleep(350);
  ok('节点标签可用（未选中节点提示）', (await js(`!!document.querySelector('.sp-pane .inspector-empty')`)));
  await shot(win, 'side-02b-node');

  // ---- 3) 项目标签：文件树 + 点文件 → 预览 ----
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('project'); return true; })()`);
  await sleep(400);
  const proj = await geom();
  ok('项目标签显示文件树行', proj.treeRows >= 3, 'rows=' + proj.treeRows);
  ok('项目标签高亮', proj.activeTab === '项目', 'active=' + proj.activeTab);
  await shot(win, 'side-03-project');

  const clicked = await js(
    `(()=>{ const row=[...document.querySelectorAll('.pm-tree .pm-row.pm-file')].find(r=>r.title==='readme.md'); if(!row) return false; row.click(); return true; })()`,
  );
  await sleep(600);
  const prev = await geom();
  ok('点击文件树里的文件生效', clicked);
  ok('点击文件后自动切到预览标签', prev.activeTab === '预览', 'active=' + prev.activeTab);
  ok('预览标签渲染出文件内容', prev.preview > 10, 'chars=' + prev.preview);
  ok('预览标签有内容标记', await js(`!!document.querySelector('.sp-tab.is-active .sp-tab-dot')`));
  await shot(win, 'side-04-preview');

  // ---- 4) 宽度夹取 ----
  await js(`(()=>{ window.__codenodeUi.getState().setSideWidth(999); return true; })()`);
  await sleep(250);
  const wide = await geom();
  ok('宽度上限被夹到 520', Math.abs(wide.side.w - 520) <= 1, 'w=' + wide.side.w);
  await js(`(()=>{ window.__codenodeUi.getState().setSideWidth(10); return true; })()`);
  await sleep(250);
  const narrow = await geom();
  ok('宽度下限被夹到 260', Math.abs(narrow.side.w - 260) <= 1, 'w=' + narrow.side.w);
  ok('最窄时隐藏标签文字（容器查询）', await js(`(function(){ var el=document.querySelector('.sp-tab .sp-tab-label'); return !!el && getComputedStyle(el).display === 'none'; })()`));
  ok('最窄时标签条仍无横向溢出', await js(`(function(){ var t=document.querySelector('.sp-tabs'); return !!t && t.scrollWidth <= t.clientWidth + 1; })()`));
  await shot(win, 'side-05-narrow-sidebar');
  await js(`(()=>{ window.__codenodeUi.getState().setSideWidth(320); return true; })()`);

  // ---- 4b) Agent 标签在侧栏内完整可用（输入区贴底、消息区可滚）----
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
  await sleep(400);
  const agent = await js(`(function(){
    const panel = document.querySelector('.side-panel').getBoundingClientRect();
    const body = document.querySelector('.ap-body');
    const comp = document.querySelector('.pp-composer');
    const cr = comp.getBoundingClientRect();
    return {
      title: (document.querySelector('.sp-head-name')||{}).textContent || null,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      composerInside: cr.bottom <= panel.bottom + 1 && cr.left >= panel.left - 1 && cr.right <= panel.right + 1,
      composerW: Math.round(cr.width),
      inputVisible: !!document.querySelector('.pp-composer .pp-input'),
      sendVisible: !!document.querySelector('.pp-send'),
      tabsBad: (function(){ const t=document.querySelector('.sp-tabs'); return t.scrollWidth > t.clientWidth + 1; })()
    };
  })()`);
  ok('Agent 标签标题正确', agent.title === 'Agent', 'title=' + agent.title);
  ok('消息区可滚动', agent.bodyOverflow === 'auto' || agent.bodyOverflow === 'scroll', 'overflow=' + agent.bodyOverflow);
  ok('输入区落在侧栏内且宽度合理', agent.composerInside && agent.composerW > 200, JSON.stringify(agent));
  ok('输入框与发送按钮齐全', agent.inputVisible && agent.sendVisible);
  ok('四个标签在 320px 宽下不溢出', !agent.tabsBad);
  await shot(win, 'side-05b-agent-tab');

  // ---- 5) 用户典型窗口尺寸（1065x599，竖向空间紧张）下的人工复核截图 ----
  // 注意：窗口必须可见，否则 Windows 不会派发 renderer 的 resize。
  // setSize 用 CSS/逻辑像素（BrowserWindow 的 minWidth=720 已放宽，见 electron/main.cjs）。
  const { screen } = require('electron');
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const setCssWidth = (cssW, cssH) => {
    win.setSize(Math.round(cssW), Math.round(cssH));
    // 连续快速改尺寸时 Windows 可能合并/忽略单次调用：再确认一次
    if (win.getSize()[0] !== Math.round(cssW)) win.setSize(Math.round(cssW), Math.round(cssH));
  };

  setCssWidth(1065, 599);
  await sleep(800);
  await js(`(()=>{ const u=window.__codenodeUi.getState(); u.closeDock(); u.setSideTab('project'); return true; })()`);
  await sleep(500);
  const userGeom = await geom();
  console.log(`  (debug) scale=${scale} 用户尺寸视口=${userGeom.viewport.w}x${userGeom.viewport.h} side.h=${userGeom.side.h}`);
  ok('用户尺寸下侧栏与画布并排且无溢出', userGeom.side.right <= userGeom.canvas.x + 1 && userGeom.badParts.length === 0, JSON.stringify(userGeom.badParts));
  await shot(win, 'side-08-user-size-project');
  await js(`(()=>{ const row=[...document.querySelectorAll('.pm-tree .pm-row.pm-file')].find(r=>r.title==='readme.md'); if(row) row.click(); return !!row; })()`);
  await sleep(500);
  await shot(win, 'side-09-user-size-preview');

  // 用户尺寸下 Agent 标签：对话区 + 常驻底部输入框
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
  await sleep(500);
  const userAgent = await js(`(function(){
    const p = document.querySelector('.side-panel').getBoundingClientRect();
    const b = document.querySelector('.ap-body').getBoundingClientRect();
    const c = document.querySelector('.pp-composer');
    const cr = c.getBoundingClientRect();
    const input = document.querySelector('.pp-composer .pp-input').getBoundingClientRect();
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { sel: sel, h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    return {
      composerAtBottom: Math.abs(cr.bottom - (p.bottom - 10)) <= 14,
      inside: cr.bottom <= p.bottom + 1 && cr.left >= p.left - 1 && cr.right <= p.right + 1,
      composerH: Math.round(cr.height),
      bodyH: Math.round(b.height),
      panelH: Math.round(p.height),
      inputH: Math.round(input.height),
      composerOverlapsInput: !(cr.top >= input.bottom - 1) && !(input.top >= cr.bottom - 1),
      boxes: [box('.side-panel'), box('.sp-head'), box('.sp-tabs'), box('.sp-body'), box('.sp-pane-agent'), box('.ap-head'), box('.ap-body'), box('.ap-head-meta'), box('.pp-composer')]
    };
  })()`);
  console.log('  (debug) agent boxes=' + JSON.stringify(userAgent.boxes));  ok('输入框常驻侧栏底部', userAgent.composerAtBottom && userAgent.inside, JSON.stringify(userAgent));
  ok('对话区占据剩余高度（未被输入框挤压）', userAgent.bodyH > 200 && userAgent.composerH < userAgent.panelH / 3, JSON.stringify(userAgent));
  ok('输入区未裁切且可用', userAgent.composerOverlapsInput && userAgent.inputH > 20, JSON.stringify(userAgent));
  await shot(win, 'side-10-user-size-agent');

  // ---- 6) 窄窗口：自动收起 + 浮层 ----
  // 先回到宽窗口，保证接下来是「宽 → 窄」的真实过渡（自动收起只在过渡时触发）
  setCssWidth(1360, 800);
  await sleep(600);
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
  await sleep(400);
  const preWide = await geom();
  setCssWidth(820, 720);
  await sleep(900);
  const wideToNarrow = await js(`({ w: window.innerWidth, open: window.__codenodeUi.getState().sideOpen })`);
  console.log(
    `  (debug) 窄窗 视口前=${preWide.viewport.w} 视口后=${wideToNarrow.w} sideOpen=${wideToNarrow.open} winSize=${JSON.stringify(win.getSize())}`,
  );
  ok(
    '窄窗过渡前侧栏是打开的（前置条件）',
    preWide.viewport.w > 1000 && preWide.side !== null,
    `vw=${preWide.viewport.w} side=${preWide.side ? 'open' : 'null'}`,
  );
  const narrowVp = await geom();
  console.log(`  (debug) 窄窗视口=${narrowVp.viewport.w}x${narrowVp.viewport.h} winSize=${JSON.stringify(win.getSize())}`);
  ok('窄窗口视口确实落在断点内(≤860)', narrowVp.viewport.w > 0 && narrowVp.viewport.w <= 860, 'vw=' + narrowVp.viewport.w);
  const shrunk = await geom();
  ok('窄窗口自动收起侧栏', shrunk.side === null);
  ok('窄窗口下画布仍是满宽', shrunk.canvas.right >= shrunk.viewport.w - 2, `canvas.right=${shrunk.canvas.right} vw=${shrunk.viewport.w}`);
  await js(`(()=>{ window.__codenodeUi.getState().setSideTab('agent'); return true; })()`);
  await sleep(450);
  const overlay = await geom();
  ok('窄窗口打开时是浮层（absolute）', overlay.position === 'absolute', 'position=' + overlay.position);
  ok('浮层不改变画布宽度', Math.abs(overlay.canvas.w - shrunk.canvas.w) <= 1, `${overlay.canvas.w} vs ${shrunk.canvas.w}`);
  ok('浮层留在窗口内', overlay.side.right <= overlay.viewport.w + 1 && overlay.side.x >= 0, JSON.stringify(overlay.side));
  await shot(win, 'side-06-narrow-window');
  await js(`(()=>{ document.querySelector('.sp-close').click(); return true; })()`);
  await sleep(350);
  ok('窄窗口下关闭按钮可用', (await geom()).side === null);

  // ---- 7) dock 打开时让位 ----
  setCssWidth(1280, 800);
  await sleep(700);
  await js(`(()=>{ const u=window.__codenodeUi.getState(); u.openDock('editor'); window.__codenodeUi.getState().setSideTab('project'); return true; })()`);
  await sleep(700);
  const docked = await geom();
  const dockH = await js(`(()=>{ const d=document.querySelector('.workbench-dock'); return d ? Math.round(d.getBoundingClientRect().height) : 0; })()`);
  ok('dock 打开时侧栏让出底部空间', dockH > 100 && docked.side.h <= docked.viewport.h - dockH + 2, `side.h=${docked.side.h} dockH=${dockH} vh=${docked.viewport.h}`);
  ok('dock 打开时侧栏仍无内部横向溢出', docked.badParts.length === 0, JSON.stringify(docked.badParts));
  await shot(win, 'side-07-with-dock');
};
