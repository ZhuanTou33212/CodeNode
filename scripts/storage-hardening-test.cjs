#!/usr/bin/env node
/**
 * storage-hardening-test.cjs —— 压缩缓存的 #13（合并落盘）与 #15（落盘脱敏）回归
 *
 * #13（docs/agent-incremental-review-2026-09-19.md §3）：
 *   旧实现 `set()` 每写一条就把整个缓存（最多 200 条 / 2MB）`JSON.stringify` + fsync + rename
 *   全量重写一次 —— 一轮里压缩几十份工具结果就是几十次全量重写，全在 Electron 主进程的
 *   同步路径上。现在 `set()` 只打脏标记，攒到窗口/显式 flush/进程退出才写一次盘。
 *
 * #15：缓存的值是「工具结果的模型摘要」，落盘前必须过 `redaction.redact`（与 runStore 同口径）；
 *   条目结构、bytes/hits/misses 统计口径不变。
 *
 * 判据：用 `fs.renameSync` 计量「真实的落盘次数」（原子写的提交步），
 * 并断言「N 次 set = 0 次落盘」「显式 flush = 1 次落盘且 50 条都在」。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cacheLib = require('../electron/compressionCache.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-storage-'));
const file = path.join(temp, '.codenode', 'metrics', 'compression-cache.json');

/** 计量「对某个文件真实落盘几次」（atomicWriteFile 的提交 = renameSync）。 */
function meterWrites(target) {
  const original = fs.renameSync;
  const absolute = path.resolve(target);
  let renames = 0;
  fs.renameSync = function (from, to) {
    let hit = false;
    try { hit = typeof to === 'string' && path.resolve(to) === absolute; } catch { hit = false; }
    if (hit) renames += 1;
    return original.call(fs, from, to);
  };
  return {
    stop() { fs.renameSync = original; },
    renames: () => renames,
  };
}

try {
  // ---- A. #13：N 次 set 不得触发 N 次全量重写 ----
  const meterA = meterWrites(file);
  const cache = new cacheLib.CompressionCache({ file, flushDelayMs: 60000 });
  try {
    for (let i = 0; i < 50; i++) {
      cache.set(cacheLib.compressionKey('read_file', 1500, 'doc-' + i), '摘要-' + i, 'read_file');
    }
  } finally {
    meterA.stop();
  }
  assert.strictEqual(
    meterA.renames(),
    0,
    '#13 50 次 set 不得逐条全量重写落盘（实际 ' + meterA.renames() + ' 次）',
  );
  assert.strictEqual(cache.stats().writes, 0, '#13 未 flush 前不得写盘（writes=' + cache.stats().writes + '）');
  assert.strictEqual(cache.stats().dirty, true, '#13 set 之后必须处于「脏、等待合并落盘」状态');
  assert.strictEqual(fs.existsSync(file), false, '#13 未 flush 前磁盘上不应出现缓存文件');

  // ---- B. #13：显式 flush 把窗口内的 50 条合并成 1 次写盘 ----
  const meterB = meterWrites(file);
  let flushed = false;
  try { flushed = cache.flush(); } finally { meterB.stop(); }
  assert.strictEqual(flushed, true, '#13 flush() 必须真的落盘');
  assert.strictEqual(meterB.renames(), 1, '#13 50 条必须合并成 1 次写盘（实际 ' + meterB.renames() + ' 次）');
  assert.strictEqual(cache.stats().writes, 1, '#13 写盘计数必须如实（writes=' + cache.stats().writes + '）');
  assert.strictEqual(cache.stats().dirty, false, '#13 flush 之后不再脏');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(persisted.entries.length, 50, '#13 合并落盘不得丢条目（实际 ' + persisted.entries.length + ' 条）');

  // ---- C. #13：跨实例可见性（读之前先把同一文件的脏实例刷掉） ----
  for (let i = 50; i < 60; i++) {
    cache.set(cacheLib.compressionKey('read_file', 1500, 'doc-' + i), '摘要-' + i, 'read_file');
  }
  assert.strictEqual(cache.stats().dirty, true, '#13 新增 10 条后应再次变脏');
  const reread = new cacheLib.CompressionCache({ file, flushDelayMs: 60000 });
  assert.strictEqual(reread.stats().entries, 60, '#13 新实例必须看到尚未落盘的最新内容（实际 ' + reread.stats().entries + ' 条）');
  assert.strictEqual(cache.stats().dirty, false, '#13 读取前的 flush 应把脏实例清干净');

  // ---- D. #13：进程退出兜底落盘 ----
  const exitFile = path.join(temp, 'exit-flush', 'compression-cache.json');
  const exitCache = new cacheLib.CompressionCache({ file: exitFile, flushDelayMs: 60000 });
  exitCache.set('exit-key', '退出前要落盘', 'read_file');
  assert.strictEqual(fs.existsSync(exitFile), false, '#13 退出前不应提前写盘');
  process.emit('exit', 0); // 触发与真实退出同一个 handler
  assert.strictEqual(fs.existsSync(exitFile), true, '#13 进程退出必须把脏缓存落盘');
  assert.strictEqual(JSON.parse(fs.readFileSync(exitFile, 'utf8')).entries.length, 1, '#13 退出兜底不得丢条目');

  // ---- E. #15：落盘脱敏 + 统计仍可计算 ----
  const secretFile = path.join(temp, 'redact', 'compression-cache.json');
  const secretCache = new cacheLib.CompressionCache({ file: secretFile, flushDelayMs: 60000 });
  const secretKey = cacheLib.compressionKey('read_file', 1500, 'secret-doc');
  secretCache.set(
    secretKey,
    '环境变量：api_key=sk-abcdefghijklmnopqrstuvwx，Authorization: Bearer sk-zyxwvutsrqponmlkjihgfe',
    'read_file',
  );
  secretCache.flush();
  const text = fs.readFileSync(secretFile, 'utf8');
  assert.ok(
    !text.includes('sk-abcdefghijklmnopqrstuvwx') && !text.includes('sk-zyxwvutsrqponmlkjihgfe'),
    '#15 compression-cache.json 落盘不得含明文密钥',
  );
  const stats = secretCache.stats();
  assert.strictEqual(stats.entries, 1, '#15 脱敏不得丢条目');
  assert.ok(stats.bytes > 0 && stats.hits === 0 && stats.misses === 0, '#15 entries/bytes/hits/misses 统计保持可计算');
  assert.strictEqual(
    secretCache.get(secretKey),
    JSON.parse(text).entries[0].value,
    '#15 命中返回的必须是脱敏后落盘的那个值（内存/磁盘同源）',
  );

  console.log('STORAGE HARDENING: PASS');
} finally {
  cacheLib.resetCompressionCaches();
  fs.rmSync(temp, { recursive: true, force: true });
}
