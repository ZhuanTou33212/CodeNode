'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../electron/runStore.cjs');
const { redact } = require('../electron/redaction.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-log-test-'));

/**
 * 读取计量器（#14）：patch fs 的读接口，统计「对某个目录读了多少字节 / 整文件读了几次」。
 * 只看字节数与整读次数，不看实现细节 —— 所以「不再随历史线性变差」是可判定的。
 */
function meterReads(dir) {
  const original = {
    readFileSync: fs.readFileSync,
    readSync: fs.readSync,
    openSync: fs.openSync,
    closeSync: fs.closeSync,
  };
  const absolute = path.resolve(dir);
  const tracked = new Set();
  let bytes = 0;
  let fullReads = 0;
  const under = (file) => {
    try { return typeof file === 'string' && path.resolve(file).startsWith(absolute); } catch { return false; }
  };
  fs.openSync = function (file, ...rest) {
    const fd = original.openSync.call(fs, file, ...rest);
    if (under(file)) tracked.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    tracked.delete(fd);
    return original.closeSync.call(fs, fd);
  };
  /** @types/node 的 readSync 是重载签名且返回 number；这里转发 original 的返回值（运行时等价），
   *  用 any 别名避免「重载不匹配」的静态报错 */
  fs.readSync = /** @type {any} */ (function (fd, buffer, offset, length, position) {
    const read = original.readSync.call(fs, fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytes += read;
    return read;
  });
  fs.readFileSync = function (file, ...rest) {
    const hit = under(file);
    const out = original.readFileSync.call(fs, file, ...rest);
    if (hit) {
      fullReads += 1;
      bytes += Buffer.byteLength(typeof out === 'string' ? out : String(out));
    }
    return out;
  };
  return {
    stop() { Object.assign(fs, original); },
    bytes: () => bytes,
    fullReads: () => fullReads,
  };
}

try {
  // ============ #14：appendJsonl 不得每次整读文件 ============
  {
    const scaleFile = path.join(root, 'append-no-whole-read.jsonl');
    const meter = meterReads(root);
    let appended = 0;
    try {
      store.appendJsonl(scaleFile, { type: 'run_start', runId: 'scale' });
      for (let i = 0; i < 400; i++) {
        appended += store.appendJsonl(scaleFile, { i, message: 'x'.repeat(120) }) ? 1 : 0;
      }
    } finally {
      meter.stop();
    }
    const scaleBytes = fs.statSync(scaleFile).size;
    assert.strictEqual(appended, 400, '#14 400 次追加必须全部成功');
    assert.ok(scaleBytes > 40000, '#14 载荷要足够大才有判据（实际 ' + scaleBytes + ' 字节）');
    assert.ok(
      meter.bytes() < 64 * 1024,
      '#14 appendJsonl 不得整读文件：400 次追加共读取 ' + meter.bytes() + ' 字节（文件 ' + scaleBytes + ' 字节）',
    );
    assert.strictEqual(meter.fullReads(), 0, '#14 正常追加路径不得出现整文件 readFileSync（出现 ' + meter.fullReads() + ' 次）');

    // 尾行被外部写坏 → 只在这条异常路径读回并修复（首行 run_start 保留、坏行清除）
    const brokenFile = path.join(root, 'broken-tail.jsonl');
    store.appendJsonl(brokenFile, { type: 'run_start', runId: 'broken' });
    fs.appendFileSync(brokenFile, '{"partial":');
    assert.strictEqual(store.appendJsonl(brokenFile, { type: 'note', ok: true }), true, '#14 尾行异常必须能修复写入');
    const brokenLines = fs.readFileSync(brokenFile, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(JSON.parse(brokenLines[0]).type, 'run_start', '#14 修复后首行仍是 run_start');
    assert.ok(
      brokenLines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } }),
      '#14 尾行异常修复后不得残留坏行',
    );
  }

  const file = path.join(root, 'bounded.jsonl');
  store.appendJsonl(file, { type: 'run_start', runId: 'a' }, 400);
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(store.appendJsonl(file, { message: '字'.repeat(20), i }, 400), true);
    assert.ok(fs.statSync(file).size <= 400);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).type, 'run_start');
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('injected'), { code: 'EIO' }); };
  try { assert.strictEqual(store.appendJsonl(file, { message: 'x'.repeat(350) }, 400), false); }
  finally { fs.renameSync = rename; }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  store.startRun(root, 'running', { prompt: 'api_key=synthetic-private' });
  const runFile = path.join(root, '.codenode/runs/running.jsonl');
  fs.appendFileSync(runFile, '{"partial":');
  assert.strictEqual(store.readRun(root, 'running').length, 1);
  assert.strictEqual(store.recoverInterrupted(root, new Set(['running'])).length, 0);
  assert.strictEqual(store.recoverInterrupted(root).length, 1);
  assert.strictEqual(store.recoverInterrupted(root).length, 0);
  const plan = store.resumePlan(root, 'running');
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.requiresReview, true);
  assert.match(plan.warning, /不会自动重放/);
  assert.strictEqual(store.markRetry(root, 'running', 'replacement').ok, true);
  assert.strictEqual(store.summarizeRun(store.readRun(root, 'running')).status, 'superseded');
  assert.ok(!fs.readFileSync(runFile, 'utf8').includes('synthetic-private'));
  const clean = redact({ total_tokens: 42, prompt_tokens: 20, apiKey: 'synthetic',
    args: '{"password":"synthetic-password"}' });
  assert.strictEqual(clean.total_tokens, 42);
  assert.strictEqual(clean.prompt_tokens, 20);
  assert.ok(!JSON.stringify(clean).includes('synthetic'));
  console.log('RUN STORE RELIABILITY: PASS');
} finally {
  store.resetRunStoreCaches();
  fs.rmSync(root, { recursive: true, force: true });
}
