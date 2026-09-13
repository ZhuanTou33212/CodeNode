'use strict';

const fs = require('fs');
const path = require('path');

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
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_RUN_EVENTS + 1);
      const compact = file + '.compact';
      fs.writeFileSync(compact, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
      fs.rmSync(file, { force: true });
      fs.renameSync(compact, file);
    }
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function appendEvent(projectRoot, runId, type, data) {
  if (!projectRoot) return null;
  const normalized = normalizeRunId(runId);
  const record = { ts: new Date().toISOString(), runId: normalized, type: String(type || 'event'), ...(data || {}) };
  try {
    return appendJsonl(runFile(projectRoot, normalized), record) ? record : null;
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
    return lines.slice(-MAX_RUN_EVENTS).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function summarizeRun(events) {
  const list = Array.isArray(events) ? events : [];
  const start = list.find((event) => event.type === 'run_start');
  const finish = [...list].reverse().find((event) => event.type === 'run_finish');
  return {
    runId: (finish || start || {}).runId || null,
    status: finish ? finish.status : start ? 'interrupted' : 'unknown',
    startedAt: start ? start.ts : null,
    finishedAt: finish ? finish.ts : null,
    eventCount: list.length,
    lastEvent: list[list.length - 1] || null,
  };
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

function recoverInterrupted(projectRoot) {
  const recovered = [];
  for (const run of listRuns(projectRoot, 200)) {
    const events = readRun(projectRoot, run.runId);
    if (run.status === 'interrupted' && !events.some((event) => event.type === 'run_recovered')) {
      appendEvent(projectRoot, run.runId, 'run_recovered', { previousStatus: 'running', status: 'interrupted' });
      recovered.push(run.runId);
    }
  }
  return recovered;
}

module.exports = { normalizeRunId, appendJsonl, appendEvent, startRun, finishRun, readRun, summarizeRun, listRuns, recoverInterrupted };
