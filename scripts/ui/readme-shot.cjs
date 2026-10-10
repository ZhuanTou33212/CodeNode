/**
 * 一次性脚本：生成 README 截图（真实应用界面，非手绘/mock）。
 *
 * 用法：
 *   # ① 画布态（无需密钥）
 *   node scripts/run-electron.cjs scripts/ui/readme-shot.cjs
 *   # ② Agent 对话态（需要已配置 API Key；会真实调用一次模型）
 *   SHOT_PROMPT="读一下 electron/streamAccumulator.cjs，用一句话说明它解决什么问题；然后在当前画布最末一个节点后面追加一个 task 节点，命名为「跑测试」。" \
 *     node scripts/run-electron.cjs scripts/ui/readme-shot.cjs
 *
 * 可用环境变量：
 *   SHOT_PROMPT  有值 → 走「Agent 对话态」：经 UI 真实发送 → 等 Run 结束 → 截图
 *   SHOT_OUT     输出路径（默认 docs/screenshots/codenode-canvas.png / agent-chat.png）
 *   SHOT_WAIT_S  等待 Run 结束的上限秒数（默认 180）
 *
 * 做法：① 往 localStorage 种一条「最近打开」= 仓库自带示例工程 workflow.cnode；
 *       ② 重载渲染层，点该条目走**真实**打开工程链路；
 *       ③ 断言画布有真实节点、已离开启动门禁页、节点都在可见视口内；
 *          对话态额外断言：assistant 消息已完成、有工具调用记录、画布节点数增加（即真的改图了）。
 * 副作用：对话态会把 Agent 的改动写回示例工程，所以脚本在启动时快照 workflow.cnode、
 *       退出前还原 —— 出图不应在仓库里留下 diff。截图前会重试「显示全部节点」直到所有节点
 *       进入视口（新增节点的尺寸要等 React Flow 测完才参与 fit，一次点击可能漏掉它）。
 * 退出码 0 = 截图内容符合断言。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "../..");
const DEST = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(ROOT, 'workflow.cnode');

const PROMPT = String(process.env.SHOT_PROMPT || '').trim();
const WAIT_S = Number(process.env.SHOT_WAIT_S || 180);
/** 示例工程的原始字节：对话态会被 Agent 改动并落盘，出图后还原，避免截图脚本污染仓库 */
const DEMO_ORIGINAL = fs.existsSync(DEMO) ? fs.readFileSync(DEMO) : null;
const OUT = process.env.SHOT_OUT
  ? path.resolve(ROOT, process.env.SHOT_OUT)
  : path.join(DEST, PROMPT ? 'agent-chat.png' : 'codenode-canvas.png');

let win = null;
app.on('browser-window-created', (_e, w) => {
  if (!win) win = w;
});
require("../../electron/main.cjs");

app.whenReady().then(async () => {
  const failures = [];
  try {
    for (let i = 0; i < 80 && !win; i += 1) await sleep(250);
    if (!win) throw new Error('未拿到应用窗口');
    win.show();
    try {
      win.setSize(1600, 1000);
    } catch {
      /* 尺寸设置失败不影响截图 */
    }
    await sleep(1500);
    const js = (code) => win.webContents.executeJavaScript(code);
    /** 轮询某个渲染层表达式直到为真（应用可能正在「恢复上次工程」，不能假定门禁页一定在） */
    const pollJs = async (expr, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await js(expr)) return true;
        } catch {
          /* 渲染层还没就绪，继续等 */
        }
        await sleep(500);
      }
      throw new Error('等待超时：' + label);
    };

    if (!fs.existsSync(DEMO)) throw new Error('缺少示例工程：' + DEMO);

    // ① 种「最近打开」（真实链路入口），然后重载让门禁页读到它
    await pollJs('!!window.__codenodeProject', 30000, '渲染层 bootstrap');
    const seed = JSON.stringify([
      { root: ROOT, file: DEMO, name: path.basename(DEMO), openedAt: Date.now() },
    ]);
    await js(`(()=>{ localStorage.setItem('codenode.recentProjects', ${JSON.stringify(seed)}); return true; })()`);
    await win.webContents.reload();
    await pollJs('!!window.__codenodeChat', 30000, '重载后渲染层 bootstrap');

    // ② 若停在启动门禁页 → 点最近列表里的 .cnode 条目（走真实打开链路）；
    //    若应用已自动恢复上次工程 → 直接进工作台即可。
    const atGate = await js(`!!document.querySelector('.gate-card')`);
    if (atGate) {
      await pollJs(`!!document.querySelector('.gate-recent-item')`, 15000, '最近列表渲染');
      const clicked = await js(`(()=>{
        const items = [...document.querySelectorAll('.gate-recent-item')];
        const hit = items.find((i) => i.textContent.includes('.cnode'));
        if (!hit) return 'no-item';
        hit.click();
        return 'clicked';
      })()`);
      console.log('gate-recent click → ' + clicked);
    } else {
      console.log('已在工作台（应用自动恢复上次工程），跳过门禁点击');
    }
    await pollJs(`!!document.querySelector('.canvas-wrap')`, 60000, '进入工作台');
    await sleep(3000);

    const readState = () =>
      js(`(()=>{
        const nodes = [...document.querySelectorAll('.react-flow__node')];
        // 视口必须按**画布容器**算，不能用 window：一级侧栏与对话面板会盖在画布左侧/右侧，
        // 用 window 判断时「节点被面板压住」也会被算成在视口内，截图里的裁切就漏检了。
        const host = document.querySelector('.react-flow') || document.querySelector('.canvas-wrap');
        const hr = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
        const vp = document.querySelector('.react-flow__viewport');
        const inView = nodes.filter((n) => {
          const r = n.getBoundingClientRect();
          // 只排除真正塌陷/不可见的元素：原来的 width>40 && height>20 是给未适配低缩放的旧用法，
          // 现在「显示全部节点」会缩到 25%~45%，合法节点在屏幕上可能只有几十像素，会被误判成出界。
          return r.left >= hr.left - 1 && r.top >= hr.top - 1 && r.right <= hr.right + 1 && r.bottom <= hr.bottom + 1 && r.width > 2 && r.height > 2;
        }).length;
        const chat = window.__codenodeChat && window.__codenodeChat.getState();
        const sess = window.__codenodeSession && window.__codenodeSession.getState();
        const msgs = (sess && sess.messages) || [];
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
        return {
          gate: !!document.querySelector('.gate-card'),
          workspace: !!document.querySelector('.canvas-wrap'),
          nodes: nodes.length,
          inView,
          canvas: { w: Math.round(hr.width), h: Math.round(hr.height), left: Math.round(hr.left) },
          transform: vp ? vp.style.transform : null,
          edges: document.querySelectorAll('.react-flow__edge').length,
          sending: !!(chat && chat.sending),
          msgCount: msgs.length,
          roles: msgs.map((m) => m.role),
          assistantStatus: lastAssistant ? lastAssistant.status : null,
          assistantChars: lastAssistant ? String(lastAssistant.content || '').length : 0,
          tools: lastAssistant && lastAssistant.tools ? lastAssistant.tools.map((t) => t.name) : [],
          grounding: !!(lastAssistant && lastAssistant.grounding)
        };
      })()`);

    const before = await readState();
    console.log('BEFORE ' + JSON.stringify(before));
    if (before.gate) failures.push('仍在启动门禁页（未进入工作台）');
    if (!(before.nodes > 0)) failures.push('画布没有节点');

    if (PROMPT) {
      // ③ Agent 对话态：经 UI 真实发送（chatStore.send → IPC agent:chat → 真实模型 + 真实工具）
      await js(`(()=>{ const u = window.__codenodeUi && window.__codenodeUi.getState(); if (u && u.setSideTab) u.setSideTab('agent'); return true; })()`);
      await sleep(600);
      console.log('发送 prompt → ' + PROMPT);
      const started = await js(
        `(()=>{ try { void window.__codenodeChat.getState().send(${JSON.stringify(PROMPT)}); return 'sent'; } catch (e) { return 'err:' + (e && e.message); } })()`
      );
      console.log('send → ' + started);

      const deadline = Date.now() + WAIT_S * 1000;
      let last = null;
      while (Date.now() < deadline) {
        await sleep(3000);
        last = await readState();
        if (last.assistantStatus === 'done' || last.assistantStatus === 'error') break;
        if (!last.sending && last.assistantStatus && last.assistantStatus !== 'running') break;
      }
      console.log('AFTER ' + JSON.stringify(last));
      if (!last) failures.push('未取到对话后状态');
      else {
        if (last.assistantStatus !== 'done') failures.push('assistant 未完成（status=' + last.assistantStatus + '）');
        if (!last.roles.includes('user')) failures.push('没有用户消息（对话未落进会话）');
        if (!(last.tools.length > 0)) failures.push('没有工具调用记录（真实 Agent 循环没跑）');
        if (!(last.nodes > before.nodes)) {
          failures.push('画布节点数未增加（' + before.nodes + ' → ' + last.nodes + '）');
        }
        if (last.sending) failures.push('发送状态未结束');
      }
    } else {
      await js(`(()=>{ const u = window.__codenodeUi && window.__codenodeUi.getState(); if (u && u.setSideTab) u.setSideTab('agent'); return true; })()`);
      await sleep(1200);
      const now = await readState();
      if (now.inView !== now.nodes) failures.push('有节点在视口外（' + now.inView + '/' + now.nodes + '）');
      console.log('GEOM ' + JSON.stringify(now));
    }

    // 截图前把画布「显示全部节点」，保证每个节点都落在可视区内。
    // 该动作现在位于顶部「画布操作」菜单里（config/ui.defaults.json 的 menuActions），用 data-action 定位；
    // 不要再按按钮 title 找，title 早已改成「显示全部节点」。
    // 刚被 Agent 新增的节点要等 React Flow 测完尺寸才参与 fit，第一次点击可能漏掉它 —— 最多重试 3 次。
    const clickFit = () =>
      js(`(()=>{
        const menu = [...document.querySelectorAll('details')].find((d) => /画布操作/.test((d.querySelector('summary')||{}).textContent || ''));
        if (!menu) return 'no-menu';
        menu.open = true;
        const button = menu.querySelector('button[data-action="fit"]');
        if (!button) { menu.open = false; return 'no-fit-item'; }
        if (button.disabled) { menu.open = false; return 'fit-disabled'; }
        button.click();
        return 'clicked';
      })()`);
    let fitResult = 'not-tried';
    let fitState = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fitResult = await clickFit();
      await sleep(1500);
      fitState = await readState();
      console.log(
        'fit-all #' + attempt + ' → ' + fitResult + ' ' + JSON.stringify({ nodes: fitState.nodes, inView: fitState.inView })
      );
      if (fitResult !== 'clicked' || fitState.inView === fitState.nodes) break;
    }
    if (fitResult !== 'clicked') failures.push('未能执行「显示全部节点」：' + fitResult);
    else if (fitState && fitState.inView !== fitState.nodes) {
      failures.push('适应视图后仍有节点在视口外（' + fitState.inView + '/' + fitState.nodes + '）');
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const raw = await win.webContents.capturePage();
    const img = raw.getSize().width > 1600 ? raw.resize({ width: 1600 }) : raw;
    fs.writeFileSync(OUT, img.toPNG());
    const size = img.getSize();
    console.log(
      'SHOT ' + OUT + ' ' + size.width + 'x' + size.height + ' ' + fs.statSync(OUT).size + ' bytes'
    );
  } catch (e) {
    failures.push('harness error: ' + ((e && e.stack) || e));
  } finally {
    // 还原示例工程：对话态里 Agent 的改动会被应用写回 workflow.cnode，出图不应在仓库留下 diff
    try {
      if (DEMO_ORIGINAL) {
        const now = fs.existsSync(DEMO) ? fs.readFileSync(DEMO) : null;
        if (!now || !now.equals(DEMO_ORIGINAL)) {
          fs.writeFileSync(DEMO, DEMO_ORIGINAL);
          console.log('RESTORE ' + DEMO + ' (' + (now ? now.length : 0) + ' → ' + DEMO_ORIGINAL.length + ' bytes)');
        }
      }
    } catch (e) {
      console.log('RESTORE DEMO FAIL: ' + ((e && e.message) || e));
    }
    console.log(
      failures.length ? 'SHOT FAIL(' + failures.length + '): ' + failures.join(' | ') : 'SHOT PASS'
    );
    app.exit(failures.length ? 3 : 0);
  }
});
