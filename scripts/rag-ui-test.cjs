'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 启动门禁：未打开工程时应用停在门禁页（没有侧栏、没有消息列表），所以先准备一个真实工程根再放行。
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-rag-ui-'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await sleep(600);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const session = window.__codenodeSession;
      if (!session) return { error: 'session store unavailable' };
      const waitFor = async (fn, ms) => {
        const deadline = Date.now() + (ms || 3000);
        while (Date.now() < deadline) {
          const v = fn();
          if (v) return v;
          await new Promise((resolve)=>setTimeout(resolve, 50));
        }
        return null;
      };
      // 侧栏 tab 化之后，消息列表只在 Agent 标签下挂载（SidePanel: tab === 'agent' && <AgentPanel/>），
      // 这里先放行启动门禁（载入工程根）→ 展开侧栏 → 切到该标签，否则 .rag-grounding-* 根本不在 DOM 里。
      const project = window.__codenodeProject;
      if (!project) return { error: 'project store unavailable' };
      await project.getState().loadRoot(${JSON.stringify(projectRoot)});
      const panel = await waitFor(()=>document.querySelector('.side-panel'), 5000);
      const ui = window.__codenodeUi;
      if (ui) {
        ui.getState().setSideOpen(true);
        ui.getState().setSideTab('agent');
      }
      session.setState({
        messages: [{
          role: 'assistant',
          content: '带来源的回答',
          status: 'done',
          grounding: {
            status: 'valid', valid: true, required: true,
            allowed: ['src/a.ts#L1-L4'], used: ['src/a.ts#L1-L4'], invalid: []
          }
        }]
      });
      const valid = await waitFor(()=>document.querySelector('.rag-grounding-valid'));
      const validText = valid ? valid.textContent : '';
      session.setState({
        messages: [{
          role: 'assistant',
          content: '带错误来源的回答',
          status: 'done',
          grounding: {
            status: 'invalid', valid: false, required: true,
            allowed: ['src/a.ts#L1-L4'], used: ['src/fake.ts#L1-L2'], invalid: ['src/fake.ts#L1-L2']
          }
        }]
      });
      const invalid = await waitFor(()=>document.querySelector('.rag-grounding-invalid'));
      return {
        sideTab: ui ? ui.getState().sideTab : '(no ui store)',
        hasPanel: Boolean(document.querySelector('.side-panel')),
        validText,
        invalidText: invalid ? invalid.textContent : '',
        invalidTitle: invalid ? invalid.getAttribute('title') : ''
      };
    })()`);
    const ok =
      result.validText && result.validText.includes('来源已校验') &&
      result.invalidText && result.invalidText.includes('无效引用') &&
      result.invalidTitle && result.invalidTitle.includes('src/fake.ts#L1-L2');
    console.log('RAG UI TEST:', JSON.stringify(result));
    console.log(ok ? 'RAG UI TEST: PASS' : 'RAG UI TEST: FAIL');
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('RAG UI TEST: ERROR ' + ((error && error.stack) || error));
    app.exit(2);
  }
});
