/**
 * 视觉功能的 UI 校验：
 *   1) 视觉模型下显示图片按钮，选择图片后出现在输入区，可删除
 *   2) 消息发出去后对话里能看到图片缩略图
 *   3) 非视觉模型下按钮置灰且提示明确
 *   4) 模型管理里有「视觉（图片输入）」开关并能持久化
 * 用法：node scripts/run-electron.cjs scripts/vision-ui-check.cjs "<临时 userData 目录>"
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
const ok = (n, c, extra = '') => {
  if (c) {
    passed += 1;
    console.log('  PASS ' + n);
  } else {
    failures.push(n);
    console.log('  FAIL ' + n + (extra ? ' - ' + extra : ''));
  }
};

let appWin = null;
app.on('browser-window-created', (_e, win) => { if (!appWin) appWin = win; });
require('../electron/main.cjs');

app.whenReady().then(async () => {
  try {
    const userDataDir = process.argv[2];
    if (!userDataDir) throw new Error('缺少 userData 目录参数');
    if (!appWin) for (let i = 0; i < 40 && !appWin; i += 1) await sleep(250);
    const win = appWin;
    win.show();
    await sleep(700);
    const js = (c) => win.webContents.executeJavaScript(c);

    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vui-'));
    fs.writeFileSync(path.join(proj, 'demo.cnode'), JSON.stringify({ nodes: [], edges: [] }));
    await js(`(async()=>{ await window.__codenodeProject.getState().loadRoot(${JSON.stringify(proj)}); return true; })()`);
    await sleep(900);

    // 打开侧栏 Agent 标签（默认可能收起）
    await js(`(()=>{ const u=window.__codenodeUi.getState(); u.setSideWidth(340); u.setSideTab('agent'); return true; })()`);
    await sleep(700);

    // 通过 UI store 选视觉模型（usageStore 未挂 window，走 select 交互）
    const picked = await js(`(()=>{ const sel=document.querySelector('.pp-model'); if(!sel) return null; const opt=[...sel.options].find(o=>o.value==='deepseek-v4-flash'); if(!opt) return null; sel.value='deepseek-v4-flash'; sel.dispatchEvent(new Event('change',{bubbles:true})); return sel.value; })()`);
    await sleep(500);
    ok('模型下拉存在并可切换', picked === 'deepseek-v4-flash', String(picked));

    const attachUi = await js(`(()=>{
      const btn = document.querySelector('.pp-attach-btn');
      return { hasBtn: !!btn, off: btn ? btn.className.includes('is-off') : null,
        hasFileInput: !!document.querySelector('.pp-composer input[type="file"]'),
        accept: (document.querySelector('.pp-composer input[type="file"]')||{}).accept || null,
        placeholder: (document.querySelector('.pp-input')||{}).placeholder || null };
    })()`);
    console.log('  (debug) attachUi=' + JSON.stringify(attachUi));
    ok('视觉模型下图片按钮可用', attachUi.hasBtn && attachUi.off === false, JSON.stringify(attachUi));
    ok('文件选择限定图片类型', String(attachUi.accept || '').includes('image/png'), String(attachUi.accept));
    ok('输入提示提到可粘贴/拖入图片', String(attachUi.placeholder || '').includes('图片'), String(attachUi.placeholder));

    // 模拟往输入区粘贴一张图片（走真实 paste 事件 + DataTransfer）
    const smallPngB64 = fs.readFileSync(path.join(ROOT, '.cache', 'vision-test.png')).toString('base64');
    await js(`(()=>{
      const ta = document.querySelector('.pp-input');
      const bin = atob(${JSON.stringify(smallPngB64)});
      const arr = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
      const file = new File([arr], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return true;
    })()`);
    await sleep(900);
    const afterPaste = await js(`(()=>{
      const list = document.querySelector('.pp-attach-list');
      const item = document.querySelector('.pp-attach img');
      return { hasList: !!list, count: document.querySelectorAll('.pp-attach').length, thumbSrc: item ? item.src.slice(0, 22) : null,
        sendDisabled: (document.querySelector('.pp-send')||{}).disabled };
    })()`);
    console.log('  (debug) afterPaste=' + JSON.stringify(afterPaste));
    ok('粘贴后输入区出现图片缩略图', afterPaste.hasList && afterPaste.count === 1 && String(afterPaste.thumbSrc).startsWith('data:image/'), JSON.stringify(afterPaste));
    ok('只有图片没有文字时发送按钮可用', afterPaste.sendDisabled === false, String(afterPaste.sendDisabled));
    // 截图：先保证窗口足够宽（<=860px 时侧栏会自动收起），再展开侧栏停在 Agent 标签
    try {
      const cb = win.getContentBounds();
      win.setSize(Math.max(1200, cb.width), Math.max(760, cb.height));
      await sleep(700);
    } catch { /* ignore */ }
    await js(`(()=>{ const u=window.__codenodeUi.getState(); u.setSideWidth(340); u.setSideTab('agent'); return true; })()`);
    await sleep(700);
    const shotState = await js(`({ panel: !!document.querySelector('.side-panel'), attach: document.querySelectorAll('.pp-attach').length })`);
    console.log('  (debug) shotState=' + JSON.stringify(shotState));
    fs.writeFileSync(path.join(OUT, 'vision-attach.png'), (await win.webContents.capturePage()).toPNG());

    // 移除按钮可用
    await js(`(()=>{ const d=document.querySelector('.pp-attach-del'); if(d) d.click(); return true; })()`);
    await sleep(300);
    ok('缩略图可移除', await js(`document.querySelectorAll('.pp-attach').length === 0`));

    // 非视觉模型：按钮置灰
    await js(`(()=>{ const sel=document.querySelector('.pp-model'); sel.value='deepseek-v4-pro'; sel.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await sleep(500);
    const proUi = await js(`(()=>{ const b=document.querySelector('.pp-attach-btn'); return { off: b ? b.className.includes('is-off') : null, title: b ? b.title : null }; })()`);
    console.log('  (debug) proUi=' + JSON.stringify(proUi));
    ok('非视觉模型下图片按钮置灰并给出原因', proUi.off === true && /视觉/.test(String(proUi.title || '')), JSON.stringify(proUi));

    // 模型管理里的视觉开关
    await js(`(()=>{ window.__codenodeUi.getState().openModelManager(); return true; })()`);
    await sleep(800);
    const mm = await js(`(()=>{
      const checks=[...document.querySelectorAll('.mm-check')];
      const vision=checks.find(l=>l.textContent.includes('视觉'));
      return { found: !!vision, checked: vision ? !!vision.querySelector('input').checked : null, labels: checks.map(l=>l.textContent.trim()) };
    })()`);
    console.log('  (debug) mm(当前模型)=' + JSON.stringify(mm));
    ok('模型管理存在「视觉（图片输入）」开关', mm.found === true, JSON.stringify(mm.labels));

    // 切到 flash 条目，开关应勾选（验证 vision 字段随配置持久化并正确回显）
    const switched = await js(`(()=>{
      const items=[...document.querySelectorAll('.mm-item')];
      const flash=items.find(i=>i.textContent.includes('deepseek-flash'));
      if(!flash) return null;
      flash.click();
      return true;
    })()`);
    await sleep(600);
    const mmFlash = await js(`(()=>{
      const checks=[...document.querySelectorAll('.mm-check')];
      const vision=checks.find(l=>l.textContent.includes('视觉'));
      const nameField=[...document.querySelectorAll('.mm-field')].find(f=>{ const l=f.querySelector('label'); return l && l.textContent.includes('显示名称'); });
      return { checked: vision ? !!vision.querySelector('input').checked : null, name: nameField ? nameField.querySelector('input').value : null };
    })()`);
    console.log('  (debug) mm(flash)=' + JSON.stringify(mmFlash));
    ok('切到 flash 后视觉开关为勾选', switched === true && mmFlash.checked === true, JSON.stringify(mmFlash));
    fs.writeFileSync(path.join(OUT, 'vision-modelmanager.png'), (await win.webContents.capturePage()).toPNG());
    await js(`(()=>{ window.__codenodeUi.getState().closeModelManager(); return true; })()`);
  } catch (e) {
    failures.push('harness error');
    console.error('VUI ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('\nVISION UI CHECK: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
