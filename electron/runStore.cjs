'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { redact } = require('./redaction.cjs');

const MAX_RUN_EVENTS = 4000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
// #14：recover 只扫最近的 N 个 run（与旧 listRuns(200) 语义一致），且每个文件只读「首行 + 尾块」
const MAX_SCAN_RUNS = 200;
const TAIL_SCAN_BYTES = 4 * 1024;
const HEAD_SCAN_BYTES = 1024;
const MAX_TRACKED_FILES = 4096;

function normalizeRunId(runId) {
  const value = String(runId || '').trim();
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'run-' + Date.now().toString(36);
}

function runsDir(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs');
}

function runFile(projectRoot, runId) {
  return path.join(runsDir(projectRoot), normalizeRunId(runId) + '.jsonl');
}

/**
 * #14 修复：进程内「每文件已写字节数 + 尾字节是否换行」记账。
 *
 * 旧实现每次 append 都 `readFileSync` 整个文件再判轮转（`existing = readFileSync(file)`）——
 * 单文件写出量 O(n²) 读放大，而且全在 Electron 主进程的同步路径上（IPCC/UI 可感知卡顿）。
 * 现在只在**第一次遇到某个文件**时 `stat` 一次并探一次尾字节，之后靠记账判断；
 * 只有「超过字节预算需要轮转」或「stat 与记账对不上（文件被外部追加/截断 → 尾行异常）」
 * 才读回整文件。正常追加路径零读取。
 *
 * 记账只在写入成功后才推进；轮转失败（rename 抛错）不会污染记账 —— 与旧实现
 * 「失败则文件一字节不动」的语义一致。
 * @type {Map<string, {bytes: number, tailNewline: boolean}>}
 */
const fileCounters = new Map();

/** 本进程已判定并写过 run_recovered 的文件：不再重复读盘 */
const recoveredOnce = new Set();

function resolvedKey(file) {
  return path.resolve(String(file));
}

/** 记账条目数上限：只影响「下次多一次 stat」，放弃最旧记账不会记错（会重新 stat + 探尾） */
function rememberCounter(key, state) {
  fileCounters.set(key, state);
  while (fileCounters.size > MAX_TRACKED_FILES) {
    const oldest = fileCounters.keys().next();
    if (oldest.done) break;
    fileCounters.delete(oldest.value);
  }
}

/** 尾字节是不是换行 —— 只读 1 字节，用来判断「尾行是否被外部写坏」 */
function tailIsNewline(file, size) {
  if (size <= 0) return true;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1);
    return fs.readSync(fd, buffer, 0, 1, size - 1) === 1 && buffer[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * 取（必要时重建）某文件的记账。
 * drift=true 表示磁盘大小与记账不一致 —— 调用方必须读回真实内容（异常路径）。
 */
function counterFor(file) {
  const key = resolvedKey(file);
  const known = fileCounters.get(key);
  if (known) {
    try {
      const stat = fs.statSync(key);
      if (stat.size === known.bytes) return { key, state: known, drift: false };
      const state = { bytes: stat.size, tailNewline: tailIsNewline(key, stat.size) };
      rememberCounter(key, state);
      return { key, state, drift: true };
    } catch {
      const state = { bytes: 0, tailNewline: true };
      rememberCounter(key, state);
      return { key, state, drift: false };
    }
  }
  let state;
  try {
    const stat = fs.statSync(key);
    state = { bytes: stat.size, tailNewline: tailIsNewline(key, stat.size) };
  } catch {
    state = { bytes: 0, tailNewline: true };
  }
  rememberCounter(key, state);
  return { key, state, drift: false };
}

/** 只读一段字节（绝不整读文件）—— head/tail 扫描都走这里，测试可据此统计读取字节数 */
function readChunk(file, position, length) {
  if (!(length > 0)) return '';
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return buffer.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function parseJsonLines(text) {
  /** @type {any[]} */
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 坏行（断电 / 半写 / 尾块从行中间截取）跳过 —— 与 readRun 的策略一致
    }
  }
  return out;
}

/** 只读首行（run_start）：首行可能很长（含 prompt），按需增长读取，绝不整读文件 */
function readFirstLine(file) {
  let chunk = '';
  for (const size of [HEAD_SCAN_BYTES, 64 * 1024, MAX_LOG_BYTES]) {
    chunk = readChunk(file, 0, size);
    if (!chunk) return null;
    const end = chunk.indexOf('\n');
    if (end >= 0) return chunk.slice(0, end);
    if (chunk.length < size) break; // 已经到文件尾，首行没有换行
  }
  return chunk || null;
}

/**
 * #14：单个 run 文件的轻量扫描 —— 只读首行（run_start）+ 尾块（run_finish / run_recovered /
 * run_retry_started），既不整读、也不逐行 JSON.parse 历史。
 * 返回 null 表示「不是合法 run 文件」（与旧 summarizeRun 判为 unknown 的行为一致）。
 */
function scanRunFile(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size <= 0) return null;
  const tailStart = Math.max(0, size - TAIL_SCAN_BYTES);
  const tail = parseJsonLines(readChunk(file, tailStart, size - tailStart));
  const last = (type) => [...tail].reverse().find((event) => event.type === type) || null;
  if (last('run_retry_started')) return { interrupted: false }; // 已被续跑取代（superseded）
  if (last('run_finish')) return { interrupted: false }; // 正常收尾
  if (last('run_recovered')) return { interrupted: false }; // 已 recover 过（旧进程写的）
  let start = tailStart === 0 ? last('run_start') : null;
  if (!start) {
    const head = readFirstLine(file);
    if (!head) return null;
    try {
      const parsed = JSON.parse(head);
      start = parsed && parsed.type === 'run_start' ? parsed : null;
    } catch {
      start = null;
    }
  }
  return start ? { interrupted: true, start } : null;
}

function appendJsonl(file, record, maxBytes = MAX_LOG_BYTES) {
  let temporary = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(redact(record)) + '\n';
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > maxBytes) throw new Error('Log event exceeds byte budget');
    const { key, state, drift } = counterFor(file);
    if (drift || !state.tailNewline || state.bytes + lineBytes > maxBytes) {
      // 轮转 / 修复尾行：**只有这条异常路径**需要读回整文件（正常追加零读取，见 counterFor）
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const valid = existing.split(/\r?\n/).filter(text => {
        try { JSON.parse(text); return !!text; } catch { return false; }
      });
      const start = valid.find(text => JSON.parse(text).type === 'run_start');
      const kept = [];
      let bytes = lineBytes;
      if (start && bytes + Buffer.byteLength(start + '\n') <= maxBytes) bytes += Buffer.byteLength(start + '\n');
      else if (start) throw new Error('Log budget cannot preserve run header');
      for (let i = valid.length - 1; i >= 0 && kept.length < MAX_RUN_EVENTS - 2; i--) {
        if (valid[i] === start) continue;
        const size = Buffer.byteLength(valid[i] + '\n');
        if (bytes + size > maxBytes) break;
        kept.unshift(valid[i]);
        bytes += size;
      }
      if (start) kept.unshift(start);
      const content = kept.map(text => text + '\n').join('') + line;
      temporary = file + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      temporary = null;
      rememberCounter(key, { bytes: Buffer.byteLength(content), tailNewline: true });
    } else {
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      rememberCounter(key, { bytes: state.bytes + lineBytes, tailNewline: true });
    }
    return true;
  } catch (error) {
    console.error('[log-write-failed]', error.code || 'LOG_WRITE_FAILED');
    return false;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function appendEvent(projectRoot, runId, type, data) {
  if (!projectRoot) return null;
  const normalized = normalizeRunId(runId);
  const record = { ts: new Date().toISOString(), runId: normalized, type: String(type || 'event'), ...(data || {}) };
  try {
    const written = appendJsonl(runFile(projectRoot, normalized), record) ? record : null;
    // S8：run 级状态也投递到统一事件流（延迟 require 打破 runStore ↔ eventBus 的循环依赖）
    if (written) {
      require('./eventBus.cjs').bridge(projectRoot, 'run_state', {
        runId: normalized,
        turnId: record.turnId == null ? null : record.turnId,
        toolCallId: record.toolCallId == null ? null : record.toolCallId,
        type: record.type,
        state: record.state || null,
        status: record.status || null,
        reason: record.reason || null,
      });
    }
    return written;
  } catch {
    return null;
  }
}

function startRun(projectRoot, runId, data) {
  return appendEvent(projectRoot, runId, 'run_start', {
    status: 'running',
    pid: process.pid,
    ...(data || {}),
  });
}

function finishRun(projectRoot, runId, status, data) {
  return appendEvent(projectRoot, runId, 'run_finish', { status: String(status || 'unknown'), ...(data || {}) });
}

function readRun(projectRoot, runId) {
  try {
    const lines = fs.readFileSync(runFile(projectRoot, runId), 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function summarizeRun(events) {
  const list = Array.isArray(events) ? events : [];
  const start = list.find((event) => event.type === 'run_start');
  const finish = [...list].reverse().find((event) => event.type === 'run_finish');
  const retry = [...list].reverse().find((event) => event.type === 'run_retry_started');
  // 状态机终态（agentState.STATES.*）：附加字段，status 的取值与语义保持原样
  const lastState = [...list].reverse().find((event) => event.type === 'run_state');
  return {
    runId: (finish || start || {}).runId || null,
    status: retry ? 'superseded' : finish ? finish.status : start ? 'interrupted' : 'unknown',
    state: (finish && finish.state) || (lastState && lastState.state) || (start ? 'RUNNING' : null),
    startedAt: start ? start.ts : null,
    finishedAt: finish ? finish.ts : null,
    eventCount: list.length,
    lastEvent: list[list.length - 1] || null,
  };
}

function markRetry(projectRoot, runId, replacementRunId) {
  const summary = summarizeRun(readRun(projectRoot, runId));
  if (!summary.runId || summary.status !== 'interrupted') return { ok: false, error: 'Run 当前不可重试：' + (summary.status || 'unknown') };
  appendEvent(projectRoot, runId, 'run_retry_started', { replacementRunId: normalizeRunId(replacementRunId) });
  return { ok: true, runId: summary.runId, replacementRunId: normalizeRunId(replacementRunId) };
}

function listRuns(projectRoot, limit = 30) {
  try {
    const files = fs.readdirSync(runsDir(projectRoot)).filter((name) => name.endsWith('.jsonl'));
    return files
      .map((name) => summarizeRun(readRun(projectRoot, name.slice(0, -6))))
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
  } catch {
    return [];
  }
}

/**
 * #14 修复：恢复「中断的 Run」时不再对每个文件整读 + 逐行 JSON.parse。
 *
 * 旧实现是 `listRuns(200)`（每个文件整读并解析全部历史）→ 再对每个 run 调一次
 * `readRun`（又整读一遍）。而它在 `agent:chat` 的同步路径上每次调用都执行，
 * 于是「发消息前的固定卡顿」随项目历史单调变差（单文件上限 2MB × 200）。
 *
 * 现在：每个候选文件只读**首行 run_start + 尾块**（run_finish / run_recovered /
 * run_retry_started），本进程已 recover 过的路径直接跳过（不再读盘）。
 * 读取量上界 = MAX_SCAN_RUNS × (TAIL_SCAN_BYTES + 首行长)，与历史总量无关。
 */
function recoverInterrupted(projectRoot, activeIds = new Set()) {
  const dir = runsDir(projectRoot);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  /** @type {string[]} */
  let files = names.map((name) => path.join(dir, name));
  if (files.length > MAX_SCAN_RUNS) {
    // 只扫最近的 MAX_SCAN_RUNS 个（旧 listRuns(200) 的语义）；超过上限才 stat 排序，
    // 排序只读元数据、不读文件内容。
    const stamped = files.map((file) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      return { file, mtimeMs };
    });
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    files = stamped.slice(0, MAX_SCAN_RUNS).map((item) => item.file);
  }
  const recovered = [];
  for (const file of files) {
    const runId = normalizeRunId(path.basename(file, '.jsonl'));
    if (activeIds.has(runId)) continue;
    if (recoveredOnce.has(file)) continue; // 本进程已处理：连 tail 都不用读
    const scan = scanRunFile(file);
    if (!scan || !scan.interrupted) continue;
    appendEvent(projectRoot, runId, 'run_recovered', { previousStatus: 'running', status: 'interrupted' });
    recoveredOnce.add(file);
    recovered.push(runId);
  }
  return recovered;
}

function resumePlan(projectRoot, runId) {
  const events = readRun(projectRoot, runId);
  const summary = summarizeRun(events);
  if (!summary.runId) return { ok: false, error: 'Run 不存在' };
  if (summary.status !== 'interrupted') return { ok: false, error: 'Run 当前不可恢复：' + summary.status };
  const start = events.find((event) => event.type === 'run_start') || {};
  const tools = events.filter((event) => event.type === 'tool_result')
    .flatMap((event) => Array.isArray(event.tools) ? event.tools : []);
  return {
    ok: true,
    requiresReview: true,
    runId: summary.runId,
    prompt: String(start.prompt || ''),
    model: start.model || null,
    nodeId: start.nodeId || null,
    startedAt: summary.startedAt,
    lastEvent: summary.lastEvent,
    completedToolNames: tools.map((tool) => tool.name).filter(Boolean),
    warning: '这是全新重试计划，不会自动重放未知副作用；执行前请重新确认当前项目状态。',
  };
}

/** 测试用：丢弃进程内字节记账与「已 recover」标记（生产不需要调用）。 */
function resetRunStoreCaches() {
  fileCounters.clear();
  recoveredOnce.clear();
}

module.exports = { normalizeRunId, appendJsonl, appendEvent, startRun, finishRun, readRun, summarizeRun, listRuns, recoverInterrupted, resumePlan, markRetry, resetRunStoreCaches };
