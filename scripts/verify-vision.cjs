/**
 * 验证真实安装配置：模型列表可读、API Key 可解密、视觉链路端到端可用。
 * 用法：node scripts/run-electron.cjs scripts/verify-vision.cjs "<userData 目录>"
 *
 * 说明：不加载 main.cjs（避免触发单实例/AI 工具执行），只加载 modelStore + agent，
 *     用与 agent:chat 完全相同的配置解析方式发起一次带图请求。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const modelStore = require('../electron/modelStore.cjs');
const agent = require('../electron/agent.cjs');
const attachmentSpec = require('../electron/attachments.cjs');

let passed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log('  PASS ' + name);
  } else {
    failures.push(name);
    console.log('  FAIL ' + name + (extra ? ' - ' + extra : ''));
  }
};

app.whenReady().then(async () => {
  try {
    const dir = process.argv[2];
    if (!dir) throw new Error('缺少 userData 目录参数');
    app.setPath('userData', dir);
    console.log('userData: ' + dir);

    const baseCfg = agent.loadConfig(null);
    let store;
    try {
      store = modelStore.getModels(dir, baseCfg);
    } catch (e) {
      ok('读取 models.json（含 API Key 解密）', false, e.message);
      throw e;
    }
    ok('读取 models.json 且 API Key 可解密', store.models.every((m) => !!m.apiKey), JSON.stringify(store.models.map((m) => ({ id: m.id, keySet: !!m.apiKey }))));

    const flash = store.models.find((m) => m.id === 'deepseek-v4-flash');
    ok('flash 条目存在', !!flash);
    ok('flash 的 model 是可用的 deepseek-flash', flash?.model === 'deepseek-flash', String(flash?.model));
    ok('flash 已开启视觉', flash?.vision === true, String(flash?.vision));

    const pro = store.models.find((m) => m.id === 'deepseek-v4-pro');
    ok('pro 未开启视觉（实测不支持图片）', pro?.vision !== true);

    // 用 agent 的配置解析方式构造模型配置
    const cfg = {
      ...baseCfg,
      apiBase: flash.apiBase || baseCfg.apiBase,
      apiKey: flash.apiKey,
      model: flash.model,
      maxTokens: 512,
      reasoningEffort: 'low',
    };

    const png = fs.readFileSync(path.join(__dirname, '..', '.cache', 'vision-test.png'));
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const normalized = attachmentSpec.normalizeAttachments([{ mime: 'image/png', dataUrl, name: 'vision-test.png' }]);
    ok('附件校验通过', normalized.ok === true, normalized.ok ? '' : normalized.error);

    const userMsg = attachmentSpec.buildUserMessage('这张图从左到右是什么颜色？只回颜色名，中文逗号分隔。', normalized.attachments);
    ok('多模态消息结构正确', Array.isArray(userMsg.content) && userMsg.content[0].type === 'text' && userMsg.content[1].type === 'image_url');

    const messages = [
      { role: 'system', content: '你是助手，回答要简短。' },
      userMsg,
    ];
    let reply = '';
    let reasoning = '';
    await agent.chatCompletionStream(cfg, messages, (ev) => {
      if (ev && ev.kind === 'content' && ev.text) reply += ev.text;
      if (ev && ev.kind === 'reasoning' && ev.text) reasoning += ev.text;
    }, { tools: [], timeoutMs: 120000 });
    console.log('  (debug) reply="' + reply.replace(/\s+/g, ' ').trim() + '"');
    console.log('  (debug) reasoning="' + reasoning.replace(/\s+/g, ' ').trim().slice(0, 160) + '"');
    ok('模型真的看图并答出 红/绿/蓝', /红/.test(reply) && /绿/.test(reply) && /蓝/.test(reply), reply.trim());

    // 不带图时不应误报
    let reply2 = '';
    await agent.chatCompletionStream({ ...cfg, maxTokens: 200 }, [
      { role: 'system', content: '你是助手。' },
      { role: 'user', content: '只回两个字：收到' },
    ], (ev) => {
      if (ev && ev.kind === 'content' && ev.text) reply2 += ev.text;
    }, { tools: [], timeoutMs: 60000 });
    ok('纯文本对话仍正常', reply2.trim().length > 0, reply2.trim());
  } catch (e) {
    failures.push('harness error');
    console.error('VERIFY ERROR: ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('\nVISION VERIFY: ' + (failures.length ? 'FAIL(' + failures.length + ') ' + failures.join(' | ') : 'PASS') + ` [${passed} passed]`);
    app.exit(failures.length ? 1 : 0);
  }
});
