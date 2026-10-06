#!/usr/bin/env node
/**
 * compression-batch-test.cjs —— S10「压缩请求批量合并」用例（2026-09-16）
 *
 * 锁住四件事：
 *   A. 分段解析：缺段 / 乱序 / 模型忘记标记都要能被识别（不能把整段文本当成某一份的摘要）
 *   B. 切分：按条数与字符上限分批（避免一次请求塞进无上限的原文）
 *   C. 合并：同一轮多份结果 → **一次**请求，按序号归位
 *   D. 内容级缓存：同样的内容再压 → 0 次请求
 *   E. 缺段兜底：批量漏掉的那一份退回单条压缩（不丢信息）
 *   F. 整体失败 → 降级成截断（不中断主循环）
 *   G. 单份结果走单条路径（不套批量格式）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compressionCache = require('../electron/compressionCache.cjs');

const ok = (label) => console.log('  ✓ ' + label);

(async () => {
  // ---- A. 分段解析 ----
  const parsed = agent.parseCompressionBatchOutput(
    '前言\n<!-- summary i=1 -->\n第一份摘要\n<!-- summary i=2 -->\n第二份摘要\n尾部',
    [1, 2, 3],
  );
  assert.strictEqual(parsed.summaries.get(1), '第一份摘要');
  // 最后一段之后的收尾文本归到该段（宁可多留、不做会丢信息的截断），但「标记之前」的内容必须丢弃
  assert.ok(String(parsed.summaries.get(2)).startsWith('第二份摘要'), '尾段保留收尾文本，不得丢内容');
  assert.ok(!String(parsed.summaries.get(1)).includes('前言'), '标记之前的内容不能当成摘要');
  assert.deepStrictEqual(parsed.missing, [3]);
  const shuffled = agent.parseCompressionBatchOutput('<!-- summary i=2 -->\nB\n<!-- summary i=1 -->\nA', [1, 2]);
  assert.strictEqual(shuffled.summaries.get(1), 'A');
  assert.strictEqual(shuffled.summaries.get(2), 'B');
  assert.strictEqual(shuffled.missing.length, 0);
  const nomark = agent.parseCompressionBatchOutput('模型忘了标记，直接给一段话', [1]);
  assert.deepStrictEqual(nomark.missing, [1], '没有标记就不能当成摘要');
  ok('A 分段解析（缺段/乱序/无标记）');

  // ---- B. 切分 ----
  const items = [{ content: 'x'.repeat(10) }, { content: 'y'.repeat(10) }, { content: 'z'.repeat(10) }, { content: 'w'.repeat(10) }];
  assert.strictEqual(agent.chunkCompressionItems(items, 2, 1e6).length, 2, '按条数切');
  assert.strictEqual(agent.chunkCompressionItems(items, 10, 25).length, 2, '按字符上限切');
  assert.strictEqual(agent.chunkCompressionItems([], 4, 100).length, 0);
  ok('B 按条数 + 字符上限切分');

  // ---- C. 合并成一次请求 ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-comp-batch-'));
  compressionCache.resetCompressionCaches();
  let calls = 0;
  const fakeChat = async (_body, messages) => {
    calls += 1;
    assert.ok(String(messages[0].content).includes('压缩代理'), 'system 必须是那个压缩提示常量');
    assert.ok(String(messages[1].content).includes('index="1"'), '批量请求要带第一份的序号');
    assert.ok(String(messages[1].content).includes('index="2"'), '批量请求要带第二份的序号');
    return { content: '<!-- summary i=1 -->\n摘要一\n<!-- summary i=2 -->\n摘要二', usage: { total_tokens: 42 } };
  };
  const cfg = { model: 'test-model', maxTokens: 512, compression: { budgetChars: 200, cache: true }, costRunId: 'run-x' };
  const twoItems = [
    { toolName: 'scan_project', content: 'A'.repeat(5000) },
    { toolName: 'read_file', content: 'B'.repeat(5000) },
  ];
  const out1 = await agent.compressToolBatch(cfg, twoItems, null, { projectRoot: tmp, chat: fakeChat });
  assert.strictEqual(calls, 1, '两份结果必须合并成一次请求');
  assert.strictEqual(out1[0].text, '摘要一');
  assert.strictEqual(out1[1].text, '摘要二');
  assert.ok(out1.every((r) => r.batched === true && r.cacheHit === false));
  ok('C 多份结果合并成一次请求并按序号归位');

  // ---- D. 内容级缓存命中 ----
  const out2 = await agent.compressToolBatch(cfg, twoItems, null, { projectRoot: tmp, chat: fakeChat });
  assert.strictEqual(calls, 1, '同内容必须命中缓存，不再调用模型');
  assert.ok(out2.every((r) => r.cacheHit === true));
  ok('D 内容级缓存：同内容不再付 prefill');

  // ---- E. 缺段兜底 ----
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-comp-miss-'));
  compressionCache.resetCompressionCaches();
  let calls2 = 0;
  const fakeChat2 = async () => {
    calls2 += 1;
    if (calls2 === 1) return { content: '<!-- summary i=1 -->\n只有第一段', usage: { total_tokens: 10 } };
    return { content: '单条摘要', usage: { total_tokens: 10 } };
  };
  const noCacheCfg = { ...cfg, compression: { budgetChars: 100, cache: false } };
  const out3 = await agent.compressToolBatch(noCacheCfg, twoItems, null, { projectRoot: tmp2, chat: fakeChat2 });
  assert.strictEqual(calls2, 2, '缺段必须触发单条兜底请求');
  assert.strictEqual(out3[0].text, '只有第一段');
  assert.strictEqual(out3[1].text, '单条摘要');
  ok('E 缺段兜底：漏掉的那一份退回单条压缩');

  // ---- F. 整体失败降级 ----
  const boom = async () => {
    throw new Error('network down');
  };
  const out4 = await agent.compressToolBatch(noCacheCfg, twoItems, null, { projectRoot: tmp2, chat: boom });
  assert.ok(out4.every((r) => r.text.includes('子代理压缩失败') && r.degraded === true));
  // 回归 #11：降级必须是**保留原文**，而不是把正文截成 budget（这里 200）字符却仍标「已压缩」。
  // 真实预算下最坏情形是 12 万字符 → 1500 字符（丢 98.7%），而模型只看到一句「压缩失败，已截断」，
  // 于是它在一份**看起来正常**的结果上做出错误判断（代码读了一半、JSON 被砍断）。
  assert.ok(out4.every((r) => r.text.includes('【未压缩】')), '降级必须显式标注「未压缩」');
  assert.ok(
    out4.every((r, i) => r.text.includes(twoItems[i].content)),
    '降级必须保留完整原文（不得截断）'
  );
  ok('F 压缩失败降级为「保留原文 + 显式标注未压缩」（不丢信息、不中断主循环）');

  // ---- F2. 压缩调用**成功但返回空摘要** → 同样必须保留原文 ----
  // 这是另一条降级分支（`if (!out)`），与 F 的 catch 分支是两处独立代码，必须各自有判据。
  compressionCache.resetCompressionCaches();
  const emptyChat = async () => ({ content: '', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } });
  const out4b = await agent.compressToolBatch(noCacheCfg, twoItems, null, { projectRoot: tmp2, chat: emptyChat });
  assert.ok(out4b.every((r) => r.text.includes('【未压缩】')), '空摘要也必须显式标注「未压缩」');
  assert.ok(out4b.every((r, i) => r.text.includes(twoItems[i].content)), '空摘要时原文必须完整保留');
  ok('F2 压缩返回空摘要 → 保留原文 + 标注未压缩');

  // ---- G. 单份走单条路径 ----
  compressionCache.resetCompressionCaches();
  let calls3 = 0;
  const fakeChat3 = async () => {
    calls3 += 1;
    return { content: '单份摘要', usage: { total_tokens: 5 } };
  };
  const out5 = await agent.compressToolBatch(noCacheCfg, [twoItems[0]], null, { projectRoot: tmp2, chat: fakeChat3 });
  assert.strictEqual(calls3, 1);
  assert.strictEqual(out5[0].text, '单份摘要');
  assert.strictEqual(out5[0].batched, false);
  ok('G 单份结果走单条路径');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  compressionCache.resetCompressionCaches();
  console.log('compression batch ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
