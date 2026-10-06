'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { withFileLock } = require('./fileLock.cjs');
const { memoryKey, memoryKind, memorySlot } = require('./memoryResolution.cjs');
const { redact } = require('./redaction.cjs');

const MAX_SESSIONS = 100;
const MAX_OVERRIDES = 16;
const DEFAULT_TASK_TURNS = 12;

function storePath(projectRoot) {
  return path.join(path.resolve(projectRoot), '.codenode', 'session-overrides.json');
}

function normalizeOverride(input) {
  if (!input || typeof input !== 'object') return null;
  const key = memoryKey(input.key);
  const rawValue = String(input.value == null ? '' : input.value).trim().slice(0, 160);
  const sanitized = redact(rawValue);
  const value = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
  if (!key || !value) return null;
  const lifetime = input.lifetime === 'task' ? 'task' : 'session';
  const updatedTurn = Number.isInteger(input.updatedTurn) && input.updatedTurn >= 0 ? input.updatedTurn : 0;
  const expiresAtTurn = lifetime === 'task'
    ? (Number.isInteger(input.expiresAtTurn) && input.expiresAtTurn >= updatedTurn
      ? input.expiresAtTurn : updatedTurn + DEFAULT_TASK_TURNS)
    : null;
  return { scope: 'all', kind: memoryKind(input.kind), key, value, lifetime, updatedTurn,
    ...(expiresAtTurn == null ? {} : { expiresAtTurn }) };
}

function validSessionId(sessionId) {
  const id = String(sessionId || '');
  return /^[\w.-]{1,120}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
}

function readStore(projectRoot) {
  const file = storePath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, file, sessions: {} };
    return { ok: false, file, code: 'SESSION_OVERRIDES_READ_FAILED', error: String(error.message || error) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || ![1, 2].includes(parsed.version) || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
      throw new Error('无效的 session-overrides.json 格式');
    }
    return { ok: true, file, sessions: parsed.sessions };
  } catch (error) {
    return { ok: false, file, code: 'SESSION_OVERRIDES_CORRUPT', error: String(error.message || error) };
  }
}

function normalizedRecord(record, file) {
  if (!record) return { ok: true, overrides: [], turnSeq: 0, slotTurns: {}, clearThroughTurn: 0,
    taskClearThroughTurn: 0, taskEpoch: 0, lastRequestId: '' };
  if (!Array.isArray(record.overrides) || record.overrides.length > MAX_OVERRIDES) {
    return { ok: false, code: 'SESSION_OVERRIDES_CORRUPT', error: '会话覆盖记录格式无效', file };
  }
  const overrides = record.overrides.map(normalizeOverride);
  if (overrides.some((entry) => !entry)) {
    return { ok: false, code: 'SESSION_OVERRIDES_CORRUPT', error: '会话覆盖记录包含无效槽位', file };
  }
  const turnSeq = Number.isInteger(record.turnSeq) && record.turnSeq >= 0 ? record.turnSeq : 0;
  const slotTurns = {};
  for (const [slot, turn] of Object.entries(record.slotTurns || {})) {
    if (Number.isInteger(turn) && turn >= 0 && turn <= turnSeq) slotTurns[slot] = turn;
  }
  return { ok: true, overrides, turnSeq, slotTurns,
    clearThroughTurn: Number.isInteger(record.clearThroughTurn) && record.clearThroughTurn >= 0 ? record.clearThroughTurn : 0,
    taskClearThroughTurn: Number.isInteger(record.taskClearThroughTurn) && record.taskClearThroughTurn >= 0 ? record.taskClearThroughTurn : 0,
    taskEpoch: Number.isInteger(record.taskEpoch) && record.taskEpoch >= 0 ? record.taskEpoch : 0,
    lastRequestId: String(record.lastRequestId || '').slice(0, 120) };
}

function writeRecord(data, sessionId, record) {
  const sessions = Object.assign(Object.create(null), data.sessions);
  sessions[sessionId] = { ...record, updatedAt: new Date().toISOString() };
  const ids = Object.keys(sessions).sort((a, b) => String(sessions[b].updatedAt || '').localeCompare(String(sessions[a].updatedAt || '')));
  for (const stale of ids.slice(MAX_SESSIONS)) delete sessions[stale];
  fs.mkdirSync(path.dirname(data.file), { recursive: true });
  atomicWriteFile(data.file, JSON.stringify({ version: 2, sessions }, null, 2) + '\n', 'utf8');
}

function readSession(projectRoot, sessionId, options = {}) {
  if (!projectRoot || !sessionId) return { ok: true, overrides: [], turnSeq: 0 };
  if (!validSessionId(sessionId)) return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '会话编号无效' };
  const data = readStore(projectRoot);
  if (!data.ok) return data;
  const record = Object.hasOwn(data.sessions, String(sessionId)) ? data.sessions[String(sessionId)] : null;
  const normalized = normalizedRecord(record, data.file);
  if (!normalized.ok) return normalized;
  const requestedEpoch = Number(options.taskEpoch);
  const overrides = Number.isInteger(requestedEpoch) && requestedEpoch > normalized.taskEpoch
    ? normalized.overrides.filter((entry) => entry.lifetime !== 'task') : normalized.overrides;
  return { ok: true, overrides, turnSeq: normalized.turnSeq, taskEpoch: normalized.taskEpoch };
}

/** 请求一到达就分配顺序号；分类耗时不同也不会颠倒用户输入顺序。 */
function beginTurn(projectRoot, sessionId, requestId = '', options = {}) {
  if (!projectRoot || !sessionId) return { ok: true, overrides: [], turnSeq: 0 };
  if (!validSessionId(sessionId)) return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '会话编号无效' };
  try {
    return withFileLock(storePath(projectRoot), () => {
      const data = readStore(projectRoot);
      if (!data.ok) return data;
      const prior = normalizedRecord(Object.hasOwn(data.sessions, sessionId) ? data.sessions[sessionId] : null, data.file);
      if (!prior.ok) return prior;
      const requestedEpoch = Number(options.taskEpoch);
      const taskEpoch = Number.isInteger(requestedEpoch) && requestedEpoch >= 0
        ? Math.max(prior.taskEpoch, requestedEpoch) : prior.taskEpoch;
      if (requestId && prior.lastRequestId === requestId && taskEpoch === prior.taskEpoch) {
        return { ok: true, overrides: prior.overrides, turnSeq: prior.turnSeq, expiredSlots: [] };
      }
      const turnSeq = prior.turnSeq + 1;
      const slotTurns = { ...prior.slotTurns };
      const expiredSlots = [];
      const newTask = taskEpoch > prior.taskEpoch;
      const overrides = prior.overrides.filter((entry) => {
        if (newTask && entry.lifetime === 'task') {
          expiredSlots.push(memorySlot(entry));
          return false;
        }
        if (entry.lifetime !== 'task' || turnSeq <= entry.expiresAtTurn) return true;
        const slot = memorySlot(entry);
        slotTurns[slot] = turnSeq;
        expiredSlots.push(slot);
        return false;
      });
      writeRecord(data, sessionId, { overrides, turnSeq, slotTurns,
        clearThroughTurn: prior.clearThroughTurn,
        taskClearThroughTurn: newTask ? turnSeq : prior.taskClearThroughTurn, taskEpoch,
        lastRequestId: String(requestId || '').slice(0, 120) });
      return { ok: true, overrides, turnSeq, taskEpoch, expiredSlots };
    });
  } catch (error) {
    return { ok: false, code: error.code || 'SESSION_OVERRIDE_WRITE_FAILED', error: String(error.message || error) };
  }
}

function applyChanges(projectRoot, sessionId, changes, options = {}) {
  if (!projectRoot || !sessionId) return { ok: true, overrides: [] };
  if (!validSessionId(sessionId)) return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '会话编号无效' };
  const actions = Array.isArray(changes) ? changes : [];
  if (actions.length > MAX_OVERRIDES || actions.some((change) => !['temporary', 'permanent', 'reset', 'reset_task'].includes(String(change && change.action || '')))) {
    return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '未知的会话覆盖动作' };
  }
  try {
    return withFileLock(storePath(projectRoot), () => {
      const data = readStore(projectRoot);
      if (!data.ok) return data;
      const id = String(sessionId);
      const prior = normalizedRecord(Object.hasOwn(data.sessions, id) ? data.sessions[id] : null, data.file);
      if (!prior.ok) return prior;
      if (!actions.length) return { ok: true, overrides: prior.overrides, turnSeq: prior.turnSeq, appliedSlots: [], skippedSlots: [] };
      const requestedTurn = Number(options.turnSeq);
      const turnSeq = Number.isInteger(requestedTurn) && requestedTurn > 0 ? requestedTurn : prior.turnSeq + 1;
      if (turnSeq > prior.turnSeq + 1) return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '覆盖轮次尚未登记' };
      let next = prior.overrides;
      const slotTurns = { ...prior.slotTurns };
      let clearThroughTurn = prior.clearThroughTurn;
      let taskClearThroughTurn = prior.taskClearThroughTurn;
      const appliedSlots = [];
      const skippedSlots = [];
      for (const change of actions) {
        const action = change.action;
        const incoming = (action === 'reset' && change.all === true) || action === 'reset_task' ? null : normalizeOverride({
          ...change.override, lifetime: change.override && change.override.lifetime || 'task',
        });
        if (!incoming && !(action === 'reset' && change.all === true) && action !== 'reset_task') {
          return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '缺少可识别的覆盖槽位和值' };
        }
        if (action === 'reset_task') {
          if (turnSeq < taskClearThroughTurn) { skippedSlots.push('task:*'); continue; }
          taskClearThroughTurn = turnSeq;
          next = next.filter((entry) => entry.lifetime !== 'task' || entry.updatedTurn > turnSeq);
          appliedSlots.push('task:*');
          continue;
        }
        if (action === 'reset' && change.all === true) {
          if (turnSeq < clearThroughTurn) { skippedSlots.push('*'); continue; }
          clearThroughTurn = turnSeq;
          next = next.filter((entry) => entry.updatedTurn > turnSeq);
          appliedSlots.push('*');
          continue;
        }
        const slot = incoming ? memorySlot(incoming) : '';
        if (!slot) return { ok: false, code: 'SESSION_OVERRIDE_INVALID', error: '覆盖槽位无效' };
        const lifetime = action === 'permanent' || (change.override && change.override.lifetime === 'session')
          ? 'session' : 'task';
        if (turnSeq < Math.max(slotTurns[slot] || 0, clearThroughTurn, lifetime === 'task' ? taskClearThroughTurn : 0)) {
          skippedSlots.push(slot);
          continue;
        }
        if (action === 'temporary' && change.override.lifetime === 'turn') {
          // 本轮覆盖只进当前 Prompt，下一轮要恢复此前仍有效的 task/session 覆盖。
          appliedSlots.push(slot);
          continue;
        }
        slotTurns[slot] = turnSeq;
        next = next.filter((entry) => memorySlot(entry) !== slot);
        if (action === 'temporary') {
          next.push(normalizeOverride({ ...incoming, lifetime, updatedTurn: turnSeq,
            ...(lifetime === 'task' ? { expiresAtTurn: turnSeq + DEFAULT_TASK_TURNS } : {}) }));
        }
        appliedSlots.push(slot);
      }
      if (next.length > MAX_OVERRIDES) {
        for (const evicted of next.slice(0, next.length - MAX_OVERRIDES)) slotTurns[memorySlot(evicted)] = turnSeq;
        next = next.slice(-MAX_OVERRIDES);
      }
      const boundedSlotTurns = Object.fromEntries(Object.entries(slotTurns)
        .sort((a, b) => b[1] - a[1]).slice(0, 128));
      writeRecord(data, id, { overrides: next, turnSeq: Math.max(prior.turnSeq, turnSeq),
        slotTurns: boundedSlotTurns, clearThroughTurn, taskClearThroughTurn, taskEpoch: prior.taskEpoch,
        lastRequestId: prior.lastRequestId });
      return { ok: true, overrides: next, turnSeq, appliedSlots, skippedSlots };
    });
  } catch (error) {
    return { ok: false, code: error.code || 'SESSION_OVERRIDE_WRITE_FAILED', error: String(error.message || error) };
  }
}

function applyChange(projectRoot, sessionId, change, options = {}) {
  return applyChanges(projectRoot, sessionId, change && change.action === 'none' ? [] : [change], options);
}

module.exports = { storePath, readSession, beginTurn, applyChange, applyChanges, normalizeOverride, DEFAULT_TASK_TURNS };
