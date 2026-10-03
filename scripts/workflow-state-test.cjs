'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const workflow = require('../electron/workflowState.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-workflow-state-'));
const graph = { nodes: [
  { id: 'source', type: 'task', data: { label: 'source', prompt: 'run: node produce.cjs', completionCondition: 'verified' } },
  { id: 'consumer', type: 'task', data: { label: 'consumer', prompt: 'consume output', requiresInput: true } },
], edges: [{ source: 'source', target: 'consumer' }] };
const clone = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; console.log('PASS ' + message); }
function call(id, action, args = {}, selectedGraph = graph) { return workflow.dispatch(root, id, { action, graph: selectedGraph, ...args }); }
function prepare(id, nodeId, selectedGraph = graph, reviewedAttemptIds = []) {
  const view = call(id, 'read', {}, selectedGraph);
  assert.ok(view.ok, view.error);
  return workflow.transact(root, id, { action: 'prepare', graph: selectedGraph, nodeId, expectedRevision: view.state.revision, reviewedAttemptIds });
}
function settle(id, prepared, output, selectedGraph = graph, ok = true) {
  assert.ok(prepared.ok, prepared.error);
  return workflow.transact(root, id, { action: 'settle', graph: selectedGraph, attemptId: prepared.attemptId, ok, output });
}

try {
  // A separate process actually exits after the first side effect and before
  // settle. No pre-existing localStorage or successful node is needed.
  const child = spawnSync(process.execPath, ['-e', `
    const fs=require('fs'), path=require('path');
    const w=require(process.argv[1]), root=process.argv[2], graph=JSON.parse(process.argv[3]);
    const p=w.transact(root,'crash',{action:'prepare',graph,nodeId:'source',expectedRevision:0});
    if(!p.ok) throw Error(p.error);
    fs.writeFileSync(path.join(root,'effect.txt'),'once');
    process.stdout.write(JSON.stringify(p));
    process.exit(0);
  `, require.resolve('../electron/workflowState.cjs'), root, JSON.stringify(graph)], { encoding: 'utf8' });
  check(child.status === 0, 'first execution persisted before a real process exit');
  const first = JSON.parse(child.stdout);
  const recovered = call('crash', 'read');
  check(recovered.ok && recovered.state.pending.length === 1 && !recovered.state.pending[0].active, 'restart finds unresolved first attempt');
  check(fs.readFileSync(path.join(root, 'effect.txt'), 'utf8') === 'once', 'effect occurred once before crash');
  const refused = prepare('crash', 'source');
  check(!refused.ok && refused.needsReview, 'unknown side effect cannot be replayed without review');
  const restarted = prepare('crash', 'source', graph, [first.attemptId]);
  check(restarted.ok, 'review binds the exact interrupted attempt');
  const duplicate = prepare('crash', 'source', graph, [restarted.attemptId]);
  check(!duplicate.ok && /仍在执行/.test(duplicate.error), 'active attempt cannot be stolen by another caller');
  check(settle('crash', restarted, 'source-result').ok, 'recovered attempt settles atomically');
  check(settle('crash', prepare('crash', 'consumer'), 'consumer-result').ok, 'downstream completion binds input');
  check(call('crash', 'read').state.complete, 'identical graph and inputs are resumably complete');

  for (const mutate of [
    (g) => { g.nodes[0].data.prompt = 'run: node changed.cjs'; },
    (g) => { g.nodes[1].data.completionCondition = 'new contract'; },
    (g) => { g.edges = []; },
    (g) => { g.nodes[0].data.writeScope = 'different target'; },
  ]) {
    const changed = clone(graph); mutate(changed);
    const view = call('crash', 'read', {}, changed);
    check(view.ok && view.state.completed.length === 0, 'graph or execution contract change invalidates saved completion');
  }
  const statusOnly = clone(graph); statusOnly.nodes[0].data.status = 'running';
  check(call('crash', 'read', {}, statusOnly).state.complete, 'UI status is not part of execution identity');
  const explicitV1 = { ...clone(graph), schemaVersion: 1 };
  check(call('versioned', 'read', {}, explicitV1).ok && call('versioned', 'read', {}, explicitV1).state.schemaVersion === 1, 'explicit workflow schema v1 is accepted and exposed');
  for (const version of [0, 2, '1', null]) {
    const candidate = clone(graph);
    if (version === null) candidate.schemaVersion = null;
    else candidate.schemaVersion = version;
    check(!call('unsupported-' + String(version), 'read', {}, candidate).ok, 'unsupported workflow schema is rejected: ' + String(version));
  }

  const file = workflow.workflowFile(root, 'crash');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.records.find((item) => item.id === restarted.attemptId).output = 'different-upstream-result';
  fs.writeFileSync(file, JSON.stringify(data));
  const changedInput = call('crash', 'read').state;
  check(changedInput.completed.includes('source') && !changedInput.completed.includes('consumer'), 'upstream output change invalidates dependent completion');

  const stale = call('cas', 'read').state;
  const p = prepare('cas', 'source');
  check(!call('cas', 'prepare', { nodeId: 'consumer', expectedRevision: stale.revision }).ok, 'CAS rejects stale writes across windows');
  settle('cas', p, 'ok');
  const removed = clone(graph); removed.nodes = [removed.nodes[1]]; removed.edges = [];
  const removedChild = spawnSync(process.execPath, ['-e', `
    const w=require(process.argv[1]); const r=w.transact(process.argv[2],'removed',{action:'prepare',graph:JSON.parse(process.argv[3]),nodeId:'source',expectedRevision:0});
    if(!r.ok) throw Error(r.error);
  `, require.resolve('../electron/workflowState.cjs'), root, JSON.stringify(graph)], { encoding: 'utf8' });
  check(removedChild.status === 0 && prepare('removed', 'consumer', removed).needsReview, 'removing an interrupted node does not erase its unknown effect');

  // Inject a real failed atomic rename: no prepared success can escape it.
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('.json')) throw new Error('simulated disk failure'); return rename(from, to); };
  try { check(!prepare('disk-failed', 'source').ok, 'prepare fails closed on durable write failure'); }
  finally { fs.renameSync = rename; }
  check(call('disk-failed', 'read').state.attempts.source === 0, 'failed prepare never claims a committed intent');
  const ready = prepare('commit-failed', 'source');
  fs.renameSync = () => { throw new Error('simulated settle failure'); };
  try { check(!settle('commit-failed', ready, 'already-executed').ok, 'settle failure is observable'); }
  finally { fs.renameSync = rename; }
  check(call('commit-failed', 'read').state.pending.length === 1 && prepare('commit-failed', 'source').needsReview, 'failed settle preserves intent and requires review');

  const invalid = clone(graph); invalid.edges.push({ source: 'consumer', target: 'source' });
  check(!call('cycle', 'read', {}, invalid).ok, 'cycles fail closed instead of appended execution order');
  fs.mkdirSync(path.dirname(workflow.workflowFile(root, 'corrupt')), { recursive: true });
  fs.writeFileSync(workflow.workflowFile(root, 'corrupt'), '{broken');
  check(!call('corrupt', 'read').ok && !prepareCorrupt(), 'corrupt journal never becomes an empty run');
  function prepareCorrupt() { return call('corrupt', 'prepare', { nodeId: 'source', expectedRevision: 0 }).ok; }
  const protect = require('../electron/approvalRules.cjs');
  check(protect.isProtectedWriteTarget(root, workflow.workflowFile(root, 'crash')), 'model file tools cannot forge workflow state');
  check(!workflow.dispatch(root, 'public', { action: 'prepare', graph, nodeId: 'source', expectedRevision: 0 }).ok, 'public state IPC cannot forge prepare');

  const linkedRoot = path.join(root, 'linked'); const outside = path.join(root, 'outside');
  fs.mkdirSync(linkedRoot); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(linkedRoot, '.codenode'), process.platform === 'win32' ? 'junction' : 'dir');
  check(!workflow.dispatch(linkedRoot, 'escape', { action: 'prepare', graph, nodeId: 'source', expectedRevision: 0 }).ok, 'journal cannot follow project junctions');
  console.log('WORKFLOW STATE TEST: PASS ' + checks);
} finally {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('codenode-workflow-state-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(absolute, { recursive: true, force: true });
}
