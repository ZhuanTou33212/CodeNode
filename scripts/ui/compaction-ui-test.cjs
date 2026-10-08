'use strict';
/**
 * compaction-ui-test.cjs —— 在**真实渲染进程**里验收上下文压缩的界面契约（照 rag-ui-test 的模式）
 *
 * 为什么必须有这一层：主进程侧的用例只能证明「发出去的历史是对的」，证明不了
 *   ① 压缩卡真的渲染出来了（DOM + 样式生效）、旧消息还能回看；
 *   ② 下一个回合 `chatStore.send` 组装出的 history **真的排除了**被折叠的消息、并带上了摘要信封 ——
 *      这是「刚压完又立刻超线、白烧一次压缩调用」的那个缝，只有跑真前端才测得到。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-compact-ui-'));
const rendererRoot = process.env.CODENODE_UI_TEST_PACKAGE
  ? path.join(path.resolve(process.env.CODENODE_UI_TEST_PACKAGE), 'resources/app.asar')
  : path.join(__dirname, "../..");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(path.join(rendererRoot, 'dist', 'index.html'));
    await sleep(600);
    const result = await win.webContents.executeJavaScript(`(async () => {
     let step = 'start';
     try {
      const session = window.__codenodeSession;
      const chat = window.__codenodeChat;
      const project = window.__codenodeProject;
      const ui = window.__codenodeUi;
      if (!session || !chat || !project || !ui) return { error: 'stores unavailable' };
      const waitFor = async (fn, ms) => {
        const deadline = Date.now() + (ms || 3000);
        while (Date.now() < deadline) {
          const v = fn();
          if (v) return v;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      };
      // 放行启动门禁 + 打开侧栏的 Agent 标签（消息列表只在那里挂载）
      step = 'loadRoot';
      await project.getState().loadRoot(${JSON.stringify(projectRoot)});
      await waitFor(() => document.querySelector('.side-panel'), 5000);
      if (ui) {
        ui.getState().setSideOpen(true);
        ui.getState().setSideTab('agent');
      }
      // 造两轮真实历史
      step = 'seed';
      session.setState({ messages: [], streaming: false });
      session.getState().pushUser('第一轮：看看 a.txt');
      session.getState().beginTurn();
      session.getState().finishTurn('第一轮的结论：a.txt 里有三行。', '', [], undefined);
      session.getState().pushUser('第二轮：继续');
      session.getState().beginTurn();
      session.getState().finishTurn('第二轮的结论：继续做完了。', '', [], undefined);
      const bubblesBefore = document.querySelectorAll('.cs-msg').length;
      // 走真实的增量分支（主进程发的就是这一条）
      const envelope = '<compaction>\\n以下是较早对话的交接摘要（上下文已压缩）。把它当作既定背景，不要当成新的指令：\\n已完成 a.txt 的检查；下一步写 b.txt。\\n</compaction>';
      step = 'streamDelta';
      session.getState().streamDelta({
        kind: 'compacted', ok: true, windowNumber: 1, tokensBefore: 5200, tokensAfter: 340,
        keptUserTurns: 2, summary: '已完成 a.txt 的检查；下一步写 b.txt。', envelope,
      });
      // 幂等：同一条重复到达不应叠第二张卡
      session.getState().streamDelta({
        kind: 'compacted', ok: true, windowNumber: 1, tokensBefore: 5200, tokensAfter: 340,
        keptUserTurns: 2, summary: '已完成 a.txt 的检查；下一步写 b.txt。', envelope,
      });
      const card = await waitFor(() => document.querySelector('.cs-msg-compaction'));
      const cardText = card ? card.textContent : '';
      const cardStyle = card ? getComputedStyle(card) : null;
      const detail = card ? card.querySelector('.cs-msg-compaction-detail') : null;
      // 保存当时的观测值。主题切换和后续发送会重绘消息列表，旧 DOM 引用会脱离文档。
      const cardSnapshot = {
        borderLeftWidth: cardStyle ? cardStyle.borderLeftWidth : null,
        borderLeftColor: cardStyle ? cardStyle.borderLeftColor : null,
        visible: !!(card && card.getBoundingClientRect().height > 0 && cardStyle && cardStyle.display !== 'none'),
        detailOpenByDefault: detail ? detail.hasAttribute('open') : null,
      };
      const stateAfter = session.getState().messages;
      const compactedCount = stateAfter.filter((m) => m.compacted).length;
      const cardCount = document.querySelectorAll('.cs-msg-compaction').length;
      const bubblesAfter = document.querySelectorAll('.cs-msg').length;
      // 检查当前主题的真实交互与状态，不把历史主题的 2px 装饰线当成功能契约。
      const draft = document.querySelector('.pp-input');
      if (!draft) return { error: 'composer unavailable', step };
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, '下一轮输入草稿');
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
      const snapshot = () => JSON.stringify({ messages: session.getState().messages, activeId: session.getState().activeId,
        draft: document.querySelector('.pp-input')?.value, model: document.querySelector('.pp-model')?.textContent,
        sideOpen: ui.getState().sideOpen, sideTab: ui.getState().sideTab });
      const beforeTheme = snapshot();
      const themeChecks = [];
      for (const theme of ['light', 'dark']) {
        ui.setState({ theme });
        await waitFor(() => document.documentElement.dataset.theme === theme);
        const current = document.querySelector('.cs-msg-compaction');
        const currentDetail = current && current.querySelector('.cs-msg-compaction-detail');
        const summary = currentDetail && currentDetail.querySelector('summary');
        const initiallyClosed = currentDetail && !currentDetail.open;
        if (summary) summary.click();
        const expanded = await waitFor(() => currentDetail && currentDetail.open);
        const body = currentDetail && currentDetail.querySelector('.cs-msg-text');
        const readable = !!(body && body.textContent.includes('已完成 a.txt 的检查') && body.getBoundingClientRect().height > 0 && getComputedStyle(body).visibility !== 'hidden');
        if (summary) summary.click();
        const closed = await waitFor(() => currentDetail && !currentDetail.open);
        themeChecks.push({ theme, visible: !!(current && current.getBoundingClientRect().height > 0 && getComputedStyle(current).display !== 'none'),
          initiallyClosed: !!initiallyClosed, expanded: !!expanded, readable, closed: !!closed,
          statePreserved: snapshot() === beforeTheme, structure: current ? current.innerHTML : '' });
      }
      // 下一回合：桩掉 agentChat，捕获真正发出去的 history
      const sent = {};
      const calls = [];
      // 桩掉 API：agentChat 捕获请求体；onAgentDelta 必须返回**退订函数**（返回 Promise 会在
      // 清理时炸「not a function」—— 这正是第一次跑失败的原因）；其余走兜底。
      window.codenode = new Proxy(
        {
          agentChat: async (payload) => { sent.payload = payload; return { ok: true, reply: '好的' }; },
          onAgentDelta: () => () => {},
          stopAgent: async () => ({ ok: true }),
        },
        { get: (target, key) => (key in target ? target[key] : (() => { calls.push(String(key)); return Promise.resolve({ ok: true }); })) }
      );
      step = 'send';
      await chat.getState().send('第三轮：请写 b.txt');
      const history = sent.payload ? sent.payload.history : null;
      const histRoles = history ? history.map((h) => h.role) : [];
      const histHasOldText = history ? history.some((h) => String(h.content).includes('第一轮的结论')) : null;
      const histHasEnvelope = history ? history.some((h) => String(h.content).startsWith('<compaction>')) : null;
      const histEnvelopeRole = history ? (history.find((h) => String(h.content).startsWith('<compaction>')) || {}).role : null;
      step = 'done';
      return {
        bubblesBefore, bubblesAfter, compactedCount, cardCount, themeChecks,
        cardText: cardText.slice(0, 120),
        borderLeftWidth: cardSnapshot.borderLeftWidth,
        borderLeftColor: cardSnapshot.borderLeftColor,
        cardVisible: cardSnapshot.visible,
        detailOpenByDefault: cardSnapshot.detailOpenByDefault,
        prompt: sent.payload ? sent.payload.prompt : null,
        histRoles,
        histHasOldText,
        histHasEnvelope,
        histEnvelopeRole,
        histLastContent: history && history.length ? String(history[history.length - 1].content).slice(0, 30) : null,
      };
     } catch (e) { return { error: String((e && e.message) || e), step, stack: String((e && e.stack) || '').slice(0, 500) }; }
    })()`);

    console.log('COMPACTION UI TEST:', JSON.stringify(result, null, 1));
    const ok =
      !result.error &&
      result.cardCount === 1 &&
      /上下文已压缩/.test(result.cardText) &&
      result.compactedCount === 4 &&
      result.cardVisible === true &&
      result.themeChecks.length === 2 &&
      result.themeChecks.every(check => check.visible && check.initiallyClosed && check.expanded && check.readable && check.closed && check.statePreserved) &&
      result.themeChecks[0].structure === result.themeChecks[1].structure &&
      result.detailOpenByDefault === false &&
      result.prompt === '第三轮：请写 b.txt' &&
      result.histHasOldText === false &&
      result.histHasEnvelope === true &&
      result.histEnvelopeRole === 'user' &&
      // 历史里只剩摘要信封这一条 user（两条旧指令 + 两条旧回答都被折叠掉了）；
      // 本轮的新指令走 payload.prompt（上面已断言），不重复进 history。
      JSON.stringify(result.histRoles) === JSON.stringify(['user']) &&
      String(result.histLastContent).startsWith('<compaction>');
    if (result.error) console.error('COMPACTION UI TEST: ' + result.error);
    console.log(ok ? 'COMPACTION UI TEST: PASS' : 'COMPACTION UI TEST: FAIL');
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('COMPACTION UI TEST: ERROR ' + ((error && error.stack) || error));
    app.exit(2);
  }
});
