'use strict';
const { emptyCounters, withCacheRate } = require('./costLedger.cjs');
function key(entry) { return JSON.stringify([entry.runId, entry.taskId || 'main', entry.executionId || '']); }
function summarize(records, outcomes) {
  const tasks = new Map();
  const runs = new Map();
  const ensure = entry => {
    const id = key(entry);
    if (!tasks.has(id)) tasks.set(id, { runId: entry.runId, taskId: entry.taskId || 'main', executionId: entry.executionId || null,
      role: entry.role || (entry.taskId ? 'unknown' : 'main'), models: [], kinds: {}, status: 'unknown', verified: false, ...emptyCounters() });
    return tasks.get(id);
  };
  for (const entry of records) {
    const task = ensure(entry);
    const run = runs.get(entry.runId) || { runId: entry.runId, status: 'unknown', verified: false, ...emptyCounters() };
    for (const target of [task, run]) {
      target.requests++; target.errors += entry.ok === false ? 1 : 0;
      target.retries += entry.attempt > 1 ? (entry.meta?.perAttempt ? 1 : entry.attempt - 1) : 0;
      target.promptTokens += entry.tokens?.prompt || 0; target.completionTokens += entry.tokens?.completion || 0;
      target.promptCachedTokens += entry.tokens?.cached || 0; target.promptMissTokens += entry.tokens?.miss || 0;
      target.reasoningTokens += entry.tokens?.reasoning || 0; target.totalTokens += entry.tokens?.total || 0;
      target.latencyMs += entry.latencyMs || 0; target.estimated += entry.estimated ? 1 : 0;
      if (entry.costUsd == null) target.costKnown = false; else target.costUsd += entry.costUsd;
      target.updatedAt = entry.ts;
    }
    if (!task.models.includes(entry.model)) task.models.push(entry.model);
    task.kinds[entry.kind] = (task.kinds[entry.kind] || 0) + 1;
    runs.set(entry.runId, run);
  }
  for (const outcome of outcomes) {
    const task = ensure(outcome);
    Object.assign(task, { status: outcome.status, verified: outcome.verified === true, updatedAt: outcome.ts });
    if (!outcome.taskId) {
      const run = runs.get(outcome.runId) || { runId: outcome.runId, ...emptyCounters() };
      Object.assign(run, { status: outcome.status, verified: outcome.verified === true }); runs.set(outcome.runId, run);
    }
  }
  const completed = [...runs.values()].filter(run => run.status === 'completed');
  const verified = completed.filter(run => run.verified);
  // Include failed/cancelled work in the numerator: retries are a real cost of delivery.
  const all = [...runs.values()];
  const known = all.every(run => run.costKnown);
  const totalCostUsd = known ? all.reduce((sum, run) => sum + run.costUsd, 0) : null;
  return { tasks: [...tasks.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 50).map(withCacheRate),
    runCount: runs.size, completedRuns: completed.length, verifiedRuns: verified.length, totalCostUsd,
    costPerCompletedRun: totalCostUsd != null && completed.length ? totalCostUsd / completed.length : null,
    costPerVerifiedRun: totalCostUsd != null && verified.length ? totalCostUsd / verified.length : null };
}
module.exports = { summarize };
