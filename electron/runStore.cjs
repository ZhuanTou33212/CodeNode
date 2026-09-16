'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { redact } = require('./redaction.cjs');

const MAX_RUN_EVENTS = 4000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

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

function appendJsonl(file, record, maxBytes = MAX_LOG_BYTES) {
  let temporary;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(redact(record)) + '\n';
    if (Buffer.byteLength(line) > maxBytes) throw new Error('Log event exceeds byte budget');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (Buffer.byteLength(existing) + Buffer.byteLength(line) > maxBytes || (existing && !existing.endsWith('\n'))) {
      const valid = existing.split(/\r?\n/).filter(text => {
        try { JSON.parse(text); return !!text; } catch { return false; }
      });
      const start = valid.find(text => JSON.parse(text).type === 'run_start');
      const kept = [];
      let bytes = Buffer.byteLength(line);
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
      temporary = file + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, kept.map(text => text + '\n').join('') + line, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } else {
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
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

function recoverInterrupted(projectRoot, activeIds = new Set()) {
  const recovered = [];
  for (const run of listRuns(projectRoot, 200)) {
    if (activeIds.has(run.runId)) continue;
    const events = readRun(projectRoot, run.runId);
    if (run.status === 'interrupted' && !events.some((event) => event.type === 'run_recovered')) {
      appendEvent(projectRoot, run.runId, 'run_recovered', { previousStatus: 'running', status: 'interrupted' });
      recovered.push(run.runId);
    }
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

module.exports = { normalizeRunId, appendJsonl, appendEvent, startRun, finishRun, readRun, summarizeRun, listRuns, recoverInterrupted, resumePlan, markRetry };
