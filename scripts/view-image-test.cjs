/**
 * view-image-test.cjs —— `view_image`（对照 Codex 的 view_image）
 *
 * 短板：此前只有**用户**能发图，模型自己看不了项目里的图片（截图/图表/UI 稿只能靠文件名猜）。
 *
 * 判据：
 *   A 工具：读项目内图片 → data URL；非图片格式 / 超限 / 不存在 / 越界 各自如实报错
 *   B 契约：只读、可缓存、能力 workspace.read、不进变更工具名单
 *   C 端到端：脚本化模型调用 view_image → **下一次请求**里出现多模态 user 消息（image_url 部分）
 *   D 负向：没调用 view_image 时请求体里没有任何 image_url（零痕迹）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const descriptor = require('../electron/tools/descriptor.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-view-image-'));
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
// 1x1 透明 PNG（最小合法图片）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAB/wD/AH8A/9kAAAAASUVORK5CYII=';
fs.writeFileSync(path.join(root, 'shots', 'pixel.png'), Buffer.from(PNG_B64, 'base64'));
fs.writeFileSync(path.join(root, 'notes.txt'), '这不是图片');
fs.writeFileSync(path.join(root, 'shots', 'huge.png'), Buffer.alloc(5 * 1024 * 1024, 1));
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function context() {
  return new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal });
}
function registry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['view_image', 'read_file'] });
}

(async () => {
  // ==================== A. 工具行为 ====================
  console.log('\n== A. 工具行为 ==');
  {
    const reg = registry();
    const ok = await reg.execute('view_image', { path: 'shots/pixel.png', note: '看看这个像素' }, context());
    check('[A] 读到图片并回传 data URL', ok.ok === true && /^data:image\/png;base64,/.test(String(ok.data.image.dataUrl)), JSON.stringify({ ok: ok.ok, mime: ok.data && ok.data.image && ok.data.image.mime }));
    check('[A] 结果里带清楚的说明（模型知道图已附上）', /已读取图片 shots\/pixel\.png/.test(String(ok.text)) && /附在/.test(String(ok.text)), String(ok.text).slice(0, 60));
    check('[A] note 原样带进 data（可追溯为什么看这张图）', ok.data.image.note === '看看这个像素');
    check('[A] 非图片扩展名 → 如实报错', (await reg.execute('view_image', { path: 'notes.txt' }, context())).ok === false, 'notes.txt');
    const huge = await reg.execute('view_image', { path: 'shots/huge.png' }, context());
    check('[A] 超过 4MB → 拒绝（与用户附件同一上限）', huge.ok === false && /过大/.test(String(huge.text)), String(huge.text).slice(0, 50));
    const missing = await reg.execute('view_image', { path: 'shots/none.png' }, context());
    check('[A] 文件不存在 → 如实报错', missing.ok === false && /不存在/.test(String(missing.text)));
    const outside = await reg.execute('view_image', { path: '../outside.png' }, context());
    check('[A] 路径越界 → 拒绝（PATH_OUT_OF_ROOT）', outside.ok === false && outside.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ code: outside.data && outside.data.code }));
    const noPath = await reg.execute('view_image', {}, context());
    check('[A] 缺 path → 报错', noPath.ok === false);
  }

  // ==================== B. 契约 ====================
  console.log('\n== B. 契约 ==');
  {
    const reg = registry();
    const d = reg.descriptorOf('view_image');
    check('[B] 只读 + 不改工作区', d.readOnly === true && d.mutatesWorkspace === false, JSON.stringify({ readOnly: d.readOnly, mutatesWorkspace: d.mutatesWorkspace }));
    check('[B] 在只读缓存白名单里 / 不在变更名单里', descriptor.CACHEABLE_TOOLS.has('view_image') === true && descriptor.MUTATION_TOOLS.has('view_image') === false);
    check('[B] 能力 workspace.read', d.requiredCapability === 'workspace.read', String(d.requiredCapability));
  }

  // ==================== C. 端到端：图真的进了下一次请求 ====================
  console.log('\n== C. 端到端 ==');
  let lastSeen = [];
  async function runTurn(script, runId) {
    const controller = new AbortController();
    const stub = installScriptedModel(script, { loopLast: false });
    try {
      const result = await agent.runAgentChat({
        cfg: {
          apiBase: 'http://scripted.local/v1',
          apiKey: 'scripted-test',
          model: 'scripted-model',
          maxTokens: 1024,
          reasoningEffort: '',
          costRunId: runId || 'run-view-image',
          reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
          compression: { enabled: false },
          rag: { enabled: false },
          tools: {},
          limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1, progressEvery: 0 },
        },
        messages: [
          { role: 'system', content: '测试用 system' },
          { role: 'user', content: '看看截图' },
        ],
        tools: { registry: registry(), context: context() },
        signal: controller.signal,
        timeoutMs: 20000,
      });
      lastSeen = stub.seen || [];
      return result;
    } finally {
      stub.restore();
    }
  }

  const imageParts = (req) =>
    ((req && req.messages) || []).filter((m) => Array.isArray(m && m.content) && m.content.some((part) => part && part.type === 'image_url'));

  {
    await runTurn([
      { toolCalls: [{ id: 'v1', name: 'view_image', args: { path: 'shots/pixel.png' } }] },
      { content: '我看到是一个 1x1 的透明像素。' },
    ]);
    check('[C] 第一次请求还没有图（模型要先去读）', imageParts(lastSeen[0]).length === 0);
    check('[C] 第二次请求里出现多模态 user 消息', imageParts(lastSeen[1]).length === 1, 'requests=' + lastSeen.length);
    const msg = imageParts(lastSeen[1])[0];
    const urlPart = msg.content.find((p) => p.type === 'image_url');
    check('[C] image_url 指向上一步读的图（data URL + 同一 MIME）', String(urlPart.image_url.url).startsWith('data:image/png;base64,') === true, String(urlPart.image_url.url).slice(0, 40));
    check('[C] 同一条消息里带文本说明（模型知道这是哪张图）', msg.content.some((p) => p.type === 'text' && /shots\/pixel\.png/.test(String(p.text))), JSON.stringify(msg.content.filter((p) => p.type === 'text').map((p) => String(p.text).slice(0, 40))));
    check('[C] 工具结果本身也在（图不替代结果文本）', (lastSeen[1].messages || []).some((m) => m.role === 'tool' && /已读取图片/.test(String(m.content))));
  }
  {
    // 负向：不调 view_image 就没有任何图片部分
    await runTurn([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'notes.txt' } }] },
      { content: '读到了文本。' },
    ], 'run-view-image-none');
    check('[D] 没调用 view_image → 请求体里没有 image_url（零痕迹）', lastSeen.every((req) => imageParts(req).length === 0), 'requests=' + lastSeen.length);
  }
  {
    // 附不上去时要如实告诉模型（构造一个读得到但超过附件上限的场景太贵，这里只锁「代码路径存在」）
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.cjs'), 'utf8');
    check('[D] 附图上失败有如实回执（不假装看过）', /image_attach_failed/.test(src) && /不要假设你看到了画面/.test(src));
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'VIEW IMAGE TEST: PASS' : 'VIEW IMAGE TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('VIEW IMAGE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
