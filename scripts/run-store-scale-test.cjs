#!/usr/bin/env node
/**
 * run-store-scale-test.cjs —— #14 回归：run 日志扫描不得随历史线性变差
 *
 * 缺陷（docs/agent-incremental-review-2026-09-19.md §3 #14）：
 *   `agent:chat` 每次都同步调 `recoverInterrupted` → `listRuns(200)`（每个 run 文件**整读**
 *   + 逐行 `JSON.parse`）→ 再对每个 run `readRun` 一次（又整读）。项目使用越久，
 *   发消息前的固定卡顿越大（单文件上限 2MB × 200 个文件）。
 *
 * 修复：每个候选文件只读「首行 run_start + 尾块（run_finish / run_recovered /
 * run_retry_started）」，读取量上界 = 200 × (4KB + 首行长)，**与文件大小 / 历史总量无关**。
 *
 * 判据（能区分实现，不依赖实现细节，只看「读了多少字节」）：
 *   A. 200 个 run 文件的恢复读取字节数 < 1.5MB（而文件总量 > 8MB）；
 *   B. 把每个文件放大 4 倍，读取字节数**基本不变**（旧实现会线性放大）；
 *   C. 前一个进程写下的 run_recovered 必须被跳过（跨进程幂等）；
 *   D. 本进程重复调用不重复 recover、已完成的 run 不被误标；
 *   E. 首行超过 HEAD_SCAN_BYTES（长 prompt）也必须被识别为 run_start。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../electron/runStore.cjs');

const RUN_COUNT = 200;
const INTERRUPTED = 100; // 前 100 个中断（无 run_finish），后 100 个正常收尾
const SMALL_BODY = 40 * 1024;
const LARGE_BODY = 160 * 1024;

/** 读取计量器：只统计「对某个 runs 目录读了多少字节」。 */
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

/** 造 RUN_COUNT 个 run 文件：前 INTERRUPTED 个中断，其余 completed（外加一份大正文）。 */
function buildProject(dir, bodyBytes, options = {}) {
  const runs = path.join(dir, '.codenode', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const filler = 'x'.repeat(bodyBytes);
  const base = Date.now() - RUN_COUNT * 1000;
  let total = 0;
  for (let i = 0; i < RUN_COUNT; i++) {
    const runId = 'run-' + String(i).padStart(3, '0');
    const ts = new Date(base + i * 1000).toISOString();
    const lines = [
      JSON.stringify({ ts, runId, type: 'run_start', status: 'running', pid: 4242, prompt: 'task ' + i }),
      JSON.stringify({ ts, runId, type: 'tool_result', name: 'read_file', ok: true, text: filler }),
    ];
    if (i >= INTERRUPTED) lines.push(JSON.stringify({ ts, runId, type: 'run_finish', status: 'completed' }));
    else if (options.recovered) lines.push(JSON.stringify({ ts, runId, type: 'run_recovered', previousStatus: 'running', status: 'interrupted' }));
    const body = lines.join('\n') + '\n';
    fs.writeFileSync(path.join(runs, runId + '.jsonl'), body);
    total += Buffer.byteLength(body);
  }
  return { runs, total };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-run-scale-'));
try {
  // ---- A/B：小文件 vs 大文件，恢复读取量必须基本一致 ----
  const smallDir = path.join(temp, 'small');
  const largeDir = path.join(temp, 'large');
  const small = buildProject(smallDir, SMALL_BODY);
  const large = buildProject(largeDir, LARGE_BODY);
  assert.ok(small.total > 7 * 1024 * 1024, '#14 载荷要足够大才有判据（实际 ' + small.total + ' 字节）');

  const meterSmall = meterReads(small.runs);
  let recoveredSmall = [];
  try { recoveredSmall = store.recoverInterrupted(smallDir); } finally { meterSmall.stop(); }
  const bytesSmall = meterSmall.bytes();

  const meterLarge = meterReads(large.runs);
  let recoveredLarge = [];
  try { recoveredLarge = store.recoverInterrupted(largeDir); } finally { meterLarge.stop(); }
  const bytesLarge = meterLarge.bytes();

  assert.ok(
    bytesSmall < 1.5 * 1024 * 1024,
    '#14 recoverInterrupted 读取字节数必须有上界：读了 ' + bytesSmall + ' 字节（文件总量 ' + small.total + ' 字节）',
  );
  assert.ok(
    small.total > bytesSmall * 5,
    '#14 读取量必须远小于历史总量：读了 ' + bytesSmall + ' 字节 / 总量 ' + small.total + ' 字节',
  );
  assert.ok(
    bytesLarge < 1.5 * 1024 * 1024,
    '#14 recoverInterrupted 读取字节数不得随文件大小增长：放大 4 倍后读了 ' + bytesLarge + ' 字节（小文件 ' + bytesSmall + '）',
  );
  assert.ok(
    Math.abs(bytesLarge - bytesSmall) < bytesSmall * 0.15,
    '#14 读取量必须与 run 文件大小无关：小 ' + bytesSmall + ' 字节 / 大 ' + bytesLarge + ' 字节',
  );

  // ---- C：前一个进程写下的 run_recovered 必须被跳过（跨进程幂等） ----
  const recoveredDir = path.join(temp, 'already-recovered');
  const already = buildProject(recoveredDir, 1024, { recovered: true });
  assert.ok(already.total > 0);
  const meterDone = meterReads(already.runs);
  let doneAgain = [];
  try { doneAgain = store.recoverInterrupted(recoveredDir); } finally { meterDone.stop(); }
  assert.strictEqual(doneAgain.length, 0, '#14 已写过 run_recovered 的 run 不得重复 recover（实际 ' + doneAgain.length + ' 个）');

  // ---- D：本进程重复调用 + 完成态不被误标 ----
  assert.deepStrictEqual(store.recoverInterrupted(smallDir), [], '#14 本进程重复调用不得重复 recover');
  assert.strictEqual(recoveredSmall.length, INTERRUPTED, '#14 中断的 run 都要 recovered（实际 ' + recoveredSmall.length + '）');
  assert.strictEqual(recoveredLarge.length, INTERRUPTED, '#14 放大版同样 recovered（实际 ' + recoveredLarge.length + '）');
  assert.ok(
    store.readRun(smallDir, 'run-000').some((event) => event.type === 'run_recovered'),
    '#14 中断的 run 必须落下 run_recovered',
  );
  assert.ok(
    !store.readRun(smallDir, 'run-199').some((event) => event.type === 'run_recovered'),
    '#14 已完成的 run 不得被标成 recovered',
  );

  // ---- E：长首行（prompt 5k 字符 > HEAD_SCAN_BYTES）也要识别 run_start ----
  const longDir = path.join(temp, 'long-head');
  const longRuns = path.join(longDir, '.codenode', 'runs');
  fs.mkdirSync(longRuns, { recursive: true });
  fs.writeFileSync(
    path.join(longRuns, 'run-long.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), runId: 'run-long', type: 'run_start', status: 'running', prompt: 'p'.repeat(5000) }) + '\n',
  );
  assert.deepStrictEqual(
    store.recoverInterrupted(longDir),
    ['run-long'],
    '#14 首行超过 HEAD_SCAN_BYTES 也必须识别为 run_start',
  );

  console.log(
    'RUN STORE SCALE: PASS（小文件读 ' + bytesSmall + ' / 大文件读 ' + bytesLarge +
    ' / 总量 ' + small.total + '；中断恢复 ' + recoveredSmall.length + ' 个）',
  );
} finally {
  store.resetRunStoreCaches();
  fs.rmSync(temp, { recursive: true, force: true });
}
