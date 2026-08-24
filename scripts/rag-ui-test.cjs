'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      await new Promise((resolve)=>setTimeout(resolve, 100));
      const valid = document.querySelector('.rag-grounding-valid');
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
      await new Promise((resolve)=>setTimeout(resolve, 100));
      const invalid = document.querySelector('.rag-grounding-invalid');
      return {
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
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error('RAG UI TEST: ERROR ' + ((error && error.stack) || error));
    app.exit(2);
  }
});
