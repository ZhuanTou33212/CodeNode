'use strict';
const assert = require('assert');
const { RequestBudget, withBudget, estimateInputTokens, collectImageUrls } = require('../electron/requestBudget.cjs');
async function main() {
  const budget = new RequestBudget(100);
  const first = budget.reserve(80);
  assert.throws(() => budget.reserve(21), /额度不足/);
  first({ total_tokens: 20 });
  first({ total_tokens: 90 });
  assert.strictEqual(budget.used, 20);
  assert.strictEqual(budget.reserved, 0);
  const second = budget.reserve(80);
  second(null);
  assert.strictEqual(budget.used, 100);
  let invoked = false;
  await assert.rejects(withBudget({ requestBudget: budget, maxTokens: 10 }, [], [], async () => {
    invoked = true;
    return {};
  }), /额度不足/);
  assert.strictEqual(invoked, false);

  // ---- 图片估算回归 ----
  // 真实缺陷：图片的 base64 被按「字节数 = token」估算，一张 1MB 截图 ≈ 133 万字节
  // → 估算出几百万 token → 直接把 agent.max_total_tokens 顶爆，
  // 用户侧表现就是「请求前预算检查失败：额度不足」。
  const oneMbDataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil((1024 * 1024 * 4) / 3));
  assert.ok(oneMbDataUrl.length > 1_300_000, '构造的 data URL 应约 1.33MB');

  const textOnly = estimateInputTokens([{ role: 'user', content: 'x'.repeat(2000) }], []);
  assert.ok(textOnly > 2000 && textOnly < 4000, '纯文本估算应接近字节数，实际=' + textOnly);

  const imageMessages = [
    { role: 'system', content: 'x'.repeat(2000) },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: oneMbDataUrl } }] },
  ];
  const withImage = estimateInputTokens(imageMessages, []);
  assert.ok(withImage < 20000, '带一张 1MB 图的估算必须 < 2 万 token，实际=' + withImage);
  assert.strictEqual(collectImageUrls(imageMessages).length, 1);
  assert.strictEqual(collectImageUrls([{ role: 'user', content: '纯文本' }]).length, 0);

  // 单次成功：只按实际用量结算，不被「最大重试次数」放大
  const b2 = new RequestBudget(600000);
  const ref = { count: 0 };
  await withBudget({ requestBudget: b2, maxTokens: 8192, reliability: { maxAttempts: 3 } }, imageMessages, [], async () => {
    ref.count = 1;
    return { usage: { total_tokens: 4321 } };
  }, ref);
  assert.strictEqual(b2.used, 4321, '单次成功应只结算实际用量，实际=' + b2.used);

  // 真的重试过：按实际重试次数补偿输入
  const b3 = new RequestBudget(600000);
  const ref3 = { count: 0 };
  await withBudget({ requestBudget: b3, maxTokens: 8192, reliability: { maxAttempts: 3 } }, imageMessages, [], async () => {
    ref3.count = 2;
    return { usage: { total_tokens: 4000 } };
  }, ref3);
  assert.ok(b3.used > 4000, '重试过应补偿输入，实际=' + b3.used);

  // 带图请求在默认额度（60 万）下可正常预留
  const b4 = new RequestBudget(600000);
  await withBudget({ requestBudget: b4, maxTokens: 8192, reliability: { maxAttempts: 3 } }, imageMessages, [], async () => ({
    usage: { total_tokens: 5000 },
  }));

  console.log('REQUEST BUDGET: PASS' + '  text=' + textOnly + ' image=' + withImage + ' settled=' + b2.used + '/' + b3.used);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
