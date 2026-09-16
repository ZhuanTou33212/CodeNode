/**
 * 一次性脚本：生成 README 截图（真实应用界面，非手绘/mock）。
 *
 * 用法：
 *   # ① 画布态（无需密钥）
 *   node scripts/run-electron.cjs scripts/readme-shot.cjs
 *   # ② Agent 对话态（需要已配置 API Key；会真实调用一次模型）
 *   SHOT_PROMPT="读一下 electron/streamAccumulator.cjs，用一句话说明它解决什么问题；然后在当前画布最末一个节点后面追加一个 task 节点，命名为「跑测试」。" \
 *     node scripts/run-electron.cjs scripts/readme-shot.cjs
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
 * 退出码 0 = 截图内容符合断言。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(ROOT, 'workflow.cnode');

const PROMPT = String(process.env.SHOT_PROMPT || '').trim();
const WAIT_S = Number(process.env.SHOT_WAIT_S || 180);
const OUT = process.env.SHOT_OUT
  ? path.resolve(ROOT, process.env.SHOT_OUT)
  : path.join(DEST, PROMPT ? 'agent-chat.png' : 'codenode-canvas.png');

let win = null;
app.on('browser-window-created', (_e, w) => {
  if (!win) win = w;
});
require('../electron/main.cjs');

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
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const inView = nodes.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && r.width > 40 && r.height > 20;
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

    // 截图前把画布「聚焦全部」，保证节点完整落在可视区内（与任务栏上的 Z 按钮同一动作）
    const fitted = await js(`(()=>{
      const b = [...document.querySelectorAll('button')].find((x) => /聚焦全部/.test(x.title || ''));
      if (!b) return 'no-fit-button';
      b.click();
      return 'clicked';
    })()`);
    console.log('fit-all → ' + fitted);
    await sleep(1200);

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
    console.log(
      failures.length ? 'SHOT FAIL(' + failures.length + '): ' + failures.join(' | ') : 'SHOT PASS'
    );
    app.exit(failures.length ? 3 : 0);
  }
});
