'use strict';

const { redact } = require('./redaction.cjs');
const VERSION = 1;
const TERMINAL = new Set(['ok', 'error', 'cancelled', 'limit']);
const MAX_EVENTS = 100000;
function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\x00]/.test(value) ? value : null;
}
function key(traceId, spanId) { return JSON.stringify([traceId, spanId]); }
function time(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
function contextFields(value = {}) {
  const source = value.traceContext || value;
  return { traceId: identity(source.traceId), spanId: identity(source.spanId),
    parentSpanId: identity(source.parentSpanId) };
}

/**
 * Build only explicit causal edges. Legacy run/turn/actor labels are metadata,
 * never evidence of ancestry. Missing endpoints remain visibly incomplete.
 * @param {any[]} events
 * @param {{diagnostics?: any[], traceId?: string, runId?: string}} [options]
 */
function buildTraceTree(events, options = {}) {
  const source = Array.isArray(events) ? events : [];
  const selectedTraces = options.runId ? new Set(source.filter(e => e && e.runId === options.runId && identity(e.traceId)).map(e => e.traceId)) : null;
  const diagnostics = [...(options.diagnostics || [])];
  const bounded = source.slice(0, MAX_EVENTS);
  if (source.length > MAX_EVENTS) diagnostics.push({ code: 'EVENT_LIMIT', omitted: source.length - MAX_EVENTS });
  /** @type {Map<string, any>} */
  const spans = new Map();
  const unlinked = [];
  const attached = [];
  const seenCosts = new Map();
  const costs = [];
  function issue(code, index, extra = {}) { diagnostics.push({ code, eventIndex: index, ...extra }); }
  for (let index = 0; index < bounded.length; index++) {
    const raw = bounded[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.kind !== 'string') { issue('INVALID_EVENT', index); continue; }
    const event = redact(raw);
    const { traceId, spanId } = contextFields(event);
    if (options.traceId && traceId !== options.traceId) continue;
    if (selectedTraces && !(traceId ? selectedTraces.has(traceId) : event.runId === options.runId)) continue;
    if (event.kind === 'cost') {
      const recordId = identity(event.recordId);
      if (recordId) {
        const previous = seenCosts.get(recordId);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(event)) issue('COST_ID_CONFLICT', index, { recordId });
          continue;
        }
        seenCosts.set(recordId, event);
      } else issue('COST_ID_MISSING', index);
      costs.push(event);
    }
    if (!traceId || !spanId) {
      unlinked.push({ eventIndex: index, event, reason: 'explicit-context-missing' });
      if (event.kind.startsWith('span_')) issue('SPAN_CONTEXT_MISSING', index);
      continue;
    }
    const id = key(traceId, spanId);
    if (!['span_start', 'span_end'].includes(event.kind)) { attached.push({ id, event, index }); continue; }
    let slot = spans.get(id);
    if (!slot) { slot = { traceId, spanId, start: null, end: null, events: [], children: [], issues: [] }; spans.set(id, slot); }
    const field = event.kind === 'span_start' ? 'start' : 'end';
    if (slot[field]) {
      if (JSON.stringify(slot[field]) !== JSON.stringify(event)) { issue('SPAN_' + field.toUpperCase() + '_CONFLICT', index, { traceId, spanId }); slot.issues.push('duplicate-' + field); }
      continue;
    }
    slot[field] = event;
  }
  for (const item of attached) {
    const slot = spans.get(item.id);
    if (slot) slot.events.push(item.event);
    else { unlinked.push({ eventIndex: item.index, event: item.event, reason: 'span-not-found' }); issue('EVENT_SPAN_NOT_FOUND', item.index, contextFields(item.event)); }
  }
  for (const slot of spans.values()) {
    const start = slot.start;
    const end = slot.end;
    slot.parentSpanId = identity(start?.parentSpanId);
    slot.runId = identity(start?.runId || end?.runId);
    slot.spanKind = String(start?.spanKind || end?.spanKind || 'unknown');
    slot.name = String(start?.name || end?.name || slot.spanKind);
    slot.actor = start?.actor ?? end?.actor ?? null;
    slot.turnId = start?.turnId ?? end?.turnId ?? null;
    slot.toolCallId = start?.toolCallId ?? end?.toolCallId ?? null;
    slot.attemptId = start?.attemptId ?? end?.attemptId ?? null;
    slot.startedAt = start?.ts || null;
    slot.endedAt = end?.ts || null;
    slot.status = end && TERMINAL.has(end.status) ? end.status : 'incomplete';
    slot.usage = end?.usage || null;
    slot.model = end?.model || start?.attributes?.model || null;
    slot.error = end?.error || null;
    slot.attributes = { ...(start?.attributes || {}), ...(end?.attributes || {}) };
    const started = time(slot.startedAt), ended = time(slot.endedAt);
    slot.latencyMs = typeof end?.latencyMs === 'number' && Number.isFinite(end.latencyMs) && end.latencyMs >= 0
      ? end.latencyMs : started != null && ended != null && ended >= started ? ended - started : null;
    if (!start) slot.issues.push('missing-start');
    if (!end) slot.issues.push('missing-end');
    if (end && !TERMINAL.has(end.status)) slot.issues.push('invalid-end-status');
    if (start && started == null || end && ended == null) slot.issues.push('invalid-timestamp');
    if (started != null && ended != null && ended < started) slot.issues.push('end-before-start');
    if (start && end && identity(end.parentSpanId) !== slot.parentSpanId) slot.issues.push('parent-mismatch');
    if (start && end && start.runId !== end.runId) slot.issues.push('run-mismatch');
    if (slot.parentSpanId && !spans.has(key(slot.traceId, slot.parentSpanId))) slot.issues.push('orphan');
  }
  // Walk explicit parent links iteratively; cycle detection must not recurse on
  // untrusted logs or create cyclic JSON objects in the exported representation.
  const done = new Set();
  for (const [id] of spans) {
    const chain = [], positions = new Map();
    let current = id;
    while (current && spans.has(current) && !done.has(current)) {
      if (positions.has(current)) {
        for (const cycleId of chain.slice(positions.get(current))) spans.get(cycleId).issues.push('cycle');
        break;
      }
      positions.set(current, chain.length); chain.push(current);
      const slot = spans.get(current);
      current = slot.parentSpanId ? key(slot.traceId, slot.parentSpanId) : '';
    }
    for (const item of chain) done.add(item);
  }
  for (const slot of spans.values()) {
    if (slot.parentSpanId && !slot.issues.includes('cycle') && !slot.issues.includes('orphan') && !slot.issues.includes('parent-mismatch')) {
      const parent = spans.get(key(slot.traceId, slot.parentSpanId));
      if (parent && !parent.issues.includes('cycle')) parent.children.push(slot.spanId);
    }
    for (const code of slot.issues) diagnostics.push({ code: 'SPAN_' + code.replace(/-/g, '_').toUpperCase(), traceId: slot.traceId, spanId: slot.spanId });
    delete slot.start; delete slot.end;
  }
  const list = [...spans.values()].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.spanId.localeCompare(b.spanId));
  const traces = [...new Set(list.map(s => s.traceId))].sort().map(traceId => ({ traceId,
    roots: list.filter(s => s.traceId === traceId && !s.parentSpanId && !s.issues.includes('missing-start')).map(s => s.spanId),
    spanCount: list.filter(s => s.traceId === traceId).length,
  }));
  const knownCosts = costs.filter(e => typeof e.costUsd === 'number' && Number.isFinite(e.costUsd));
  return { version: VERSION, traces, spans: list, diagnostics, unlinked,
    structurallyComplete: list.length > 0 && diagnostics.length === 0 && list.every(s => s.status !== 'incomplete'),
    complete: list.length > 0 && diagnostics.length === 0 && unlinked.length === 0 && list.every(s => s.status !== 'incomplete'),
    costs: { records: costs, knownUsd: knownCosts.reduce((sum, e) => sum + e.costUsd, 0),
      unknown: costs.length - knownCosts.length, complete: knownCosts.length === costs.length },
  };
}

module.exports = { VERSION, TERMINAL, contextFields, buildTraceTree };
