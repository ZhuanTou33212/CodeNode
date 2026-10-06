'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    partition: 'rag-review-test-' + Date.now() } });
  try {
    await window.loadFile(path.resolve(__dirname, '../out/rag-human-review.html'));
    const result = await window.webContents.executeJavaScript(`(() => {
      const count = document.querySelectorAll('article').length;
      const labelsHidden = !document.body.textContent.includes('作者标签：可回答') && !document.body.textContent.includes('作者标签：证据不足');
      const heading = document.querySelector('h2').textContent;
      const anonymous = heading.startsWith('题目 ') && Number.isInteger(Number(heading.slice(3,6))) && !document.querySelector('small').textContent.includes('类型：');
      let warning = ''; window.alert = message => { warning = message; };
      const article = document.querySelector('article');
      article.querySelector('select').value = 'true';
      article.querySelector('button').click();
      const denied = warning.includes('真实复核者');
      document.getElementById('reviewer').value = 'TEST-ONLY-EPHEMERAL-REVIEWER';
      article.querySelector('button').click();
      const noteRequired = warning.includes('关键支持证据');
      article.querySelector('textarea').value = 'TEST-ONLY: source excerpt supports the stated constant';
      article.querySelector('button').click();
      const saved = document.getElementById('count').textContent.startsWith('1/100');
      const filter = document.getElementById('filter'); filter.value = 'pending'; filter.dispatchEvent(new Event('change'));
      const pending = document.querySelectorAll('article').length;
      return { count, denied, saved, pending, labelsHidden, noteRequired, anonymous };
    })()`);
    if (result.count !== 100 || !result.denied || !result.saved || result.pending !== 99 || !result.labelsHidden || !result.noteRequired || !result.anonymous) throw new Error(JSON.stringify(result));
    console.log('REVIEW UI: PASS (100 source-grounded questions, reviewer required, save, pending filter; ephemeral test labels are not human gold)');
  } finally { window.destroy(); }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
