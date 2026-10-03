'use strict';

// Execution journal for the canvas runner. A durable prepared record must exist
// before dispatch; an uncommitted record is an unknown side effect after restart.
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { withFileLock } = require('./fileLock.cjs');

const RUNTIME = randomUUID();
const active = new Set();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function fail(message) { throw new Error(message); }
function workflowFile(root, workflowId) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.statSync(root).isDirectory()) fail('工作流需要有效的项目根目录');
  if (typeof workflowId !== 'string' || !workflowId || workflowId.length > 200) fail('工作流会话标识无效');
  const resolved = fs.realpathSync(root);
  const file = path.join(resolved, '.codenode', 'workflows', digest(workflowId) + '.json');
  // Journal paths must never follow an untrusted project symlink/junction.
  for (const target of [path.dirname(path.dirname(file)), path.dirname(file), file, file + '.lock']) {
    try { if (fs.lstatSync(target).isSymbolicLink()) fail('工作流恢复目录不能是符号链接'); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
  return file;
}

function graphInfo(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length || graph.nodes.length > 10000 || graph.edges.length > 50000) fail('工作流图格式无效');
  // The execution journal is durable.  Bind it to an explicit graph contract
  // version so a future renderer cannot silently reinterpret old records.
  // Missing is the original v1 shape and remains compatible with saved files.
  const schemaVersion = graph.schemaVersion === undefined ? 1 : graph.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) fail('不支持的工作流图 schema 版本：' + String(graph.schemaVersion));
  const nodes = graph.nodes.map((node) => {
    if (!node || typeof node.id !== 'string' || !node.id || ['__proto__', 'constructor', 'prototype'].includes(node.id)) fail('工作流节点标识无效');
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) fail('工作流节点合同无效');
    const { status, ...data } = node.data;
    return { id: node.id, type: String(node.type || 'task'), data };
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) fail('工作流节点标识重复');
  const edges = graph.edges.map((edge) => {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) fail('工作流连线指向不存在的节点');
    return { source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || '', targetHandle: edge.targetHandle || '', data: edge.data || null };
  });
  const degrees = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) degrees.set(edge.target, degrees.get(edge.target) + 1);
  const ready = nodes.filter((node) => !degrees.get(node.id)).map((node) => node.id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const edge of edges.filter((edge) => edge.source === id)) {
      degrees.set(edge.target, degrees.get(edge.target) - 1);
      if (!degrees.get(edge.target)) ready.push(edge.target);
    }
  }
  if (order.length !== nodes.length) fail('工作流包含循环连线，无法安全恢复；请移除循环后运行');
  return { nodes, edges, order, schemaVersion, digest: digest({ schemaVersion, nodes, edges }) };
}

function read(file, workflowId) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) fail('工作流恢复记录过大，请先检查运行历史');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || value.workflowId !== workflowId || !Number.isInteger(value.revision) || value.revision < 0 || !Number.isInteger(value.cycle) || value.cycle < 1 || !Array.isArray(value.records)) fail('工作流恢复记录损坏');
    const ids = new Set();
    for (const item of value.records) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.nodeId !== 'string' || typeof item.graphDigest !== 'string' || typeof item.inputDigest !== 'string' || !Number.isInteger(item.cycle) || !['prepared', 'done', 'failed', 'reviewed'].includes(item.phase) || (item.output != null && typeof item.output !== 'string')) fail('工作流执行记录损坏');
      ids.add(item.id);
    }
    return value;
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1, workflowId, revision: 0, cycle: 1, records: [] };
    throw error;
  }
}

function live(record) {
  if (record.runtime === RUNTIME) return active.has(record.id);
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  try { process.kill(record.pid, 0); return true; }
  catch (error) { return !!(error && error.code === 'EPERM'); }
}

function snapshot(state, graph) {
  const outputs = Object.create(null);
  const completed = [];
  const attempts = Object.create(null);
  const reviews = Object.create(null);
  const inputs = Object.create(null);
  for (const id of graph.order) {
    const prior = state.records.filter((record) => record.nodeId === id);
    attempts[id] = prior.length;
    // Persisted outputs and edge order define exactly what is fed downstream.
    const incoming = graph.edges.filter((edge) => edge.target === id).map((edge) => ({ id: edge.source, output: outputs[edge.source] || '' }));
    inputs[id] = digest(incoming);
    const last = prior[prior.length - 1];
    if (last && last.cycle === state.cycle && last.graphDigest === graph.digest && last.inputDigest === inputs[id] && last.phase === 'done') {
      completed.push(id);
      outputs[id] = last.output || '';
    } else if (last) reviews[id] = last.id;
  }
  const pending = state.records.filter((record) => record.phase === 'prepared' || record.phase === 'failed')
    .map((record) => ({ id: record.id, nodeId: record.nodeId, label: record.label, active: record.phase === 'prepared' && live(record) }));
  return { revision: state.revision, schemaVersion: graph.schemaVersion, graphDigest: graph.digest, completed, outputs, attempts, reviews, inputs, pending,
    hasHistory: state.records.length > 0, complete: completed.length === graph.nodes.length, order: graph.order };
}

function persist(file, state) {
  const data = JSON.stringify(state);
  if (Buffer.byteLength(data) > MAX_BYTES) fail('工作流恢复记录已达存储上限；本次执行尚未开始');
  atomicWriteFile(file, data + '\n');
}

/** A single CAS transaction; calls never persist arbitrary renderer state. */
function transact(root, workflowId, request = {}) {
  try {
    const file = workflowFile(root, workflowId);
    const graph = graphInfo(request.graph);
    if (request.action === 'read') return { ok: true, state: snapshot(read(file, workflowId), graph) };
    return withFileLock(file, () => {
      const data = read(file, workflowId);
      const view = snapshot(data, graph);
      if (request.action !== 'settle' && request.expectedRevision !== data.revision) fail('工作流状态已变化，请重新加载后再继续');
      if (request.action === 'restart') {
        if (!view.complete || view.pending.length) fail('工作流尚未全部完成，不能清除恢复状态');
        data.cycle += 1;
      } else if (request.action === 'prepare') {
        const node = graph.nodes.find((item) => item.id === request.nodeId);
        if (!node) fail('待执行节点不存在');
        if (view.complete || view.completed.includes(node.id)) fail('该节点已经完成，请刷新工作流状态');
        if (view.pending.some((item) => item.active)) fail('工作流节点仍在执行，不能重复运行');
        const required = new Set(view.pending.map((item) => item.id));
        if (view.reviews[node.id]) required.add(view.reviews[node.id]);
        const approved = new Set(Array.isArray(request.reviewedAttemptIds) ? request.reviewedAttemptIds : []);
        if ([...required].some((id) => !approved.has(id))) return { ok: false, needsReview: true, error: '旧执行可能已产生副作用，必须先复核再重跑', state: view };
        const incoming = graph.edges.filter((edge) => edge.target === node.id);
        if (incoming.some((edge) => !view.completed.includes(edge.source)) ||
            (node.data.requiresInput && (!incoming.length || incoming.some((edge) => !view.outputs[edge.source])))) {
          fail('上游节点尚未完成或缺少必要输出');
        }
        for (const record of data.records) if (record.phase === 'prepared' || record.phase === 'failed') { record.phase = 'reviewed'; record.reviewedAt = new Date().toISOString(); }
        const record = { id: randomUUID(), cycle: data.cycle, nodeId: node.id, label: String(node.data.label || node.id), graphDigest: graph.digest,
          inputDigest: view.inputs[node.id], phase: 'prepared', pid: process.pid, runtime: RUNTIME, preparedAt: new Date().toISOString(), reviewedAttemptIds: [...required] };
        data.records.push(record);
        data.revision += 1;
        persist(file, data); // Any write/fsync/rename failure happens before dispatch.
        active.add(record.id);
        return { ok: true, attemptId: record.id, state: snapshot(data, graph) };
      } else if (request.action === 'settle') {
        const record = data.records.find((item) => item.id === request.attemptId);
        if (!record || record.phase !== 'prepared' || record.runtime !== RUNTIME || !active.has(record.id) || record.graphDigest !== graph.digest) fail('待结算的工作流执行不存在或已失效');
        try {
          if (typeof request.output !== 'string' || request.output.length > MAX_OUTPUT) fail('节点结果超过可恢复上限；原执行保留为待复核');
          record.phase = request.ok === true ? 'done' : 'failed';
          record.output = request.output;
          record.settledAt = new Date().toISOString();
          data.revision += 1;
          persist(file, data);
        } finally { active.delete(record.id); }
        return { ok: true, state: snapshot(data, graph) };
      } else fail('未知工作流状态操作');
      data.revision += 1;
      persist(file, data);
      return { ok: true, state: snapshot(data, graph) };
    });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Public renderer action: state inspection and explicit restart only. */
function dispatch(root, workflowId, request = {}) {
  if (!['read', 'restart'].includes(request.action)) {
    return { ok: false, error: '工作流准备和结算只能由主进程执行器完成' };
  }
  return transact(root, workflowId, request);
}

/**
 * Main-process-owned transaction: approval, durable prepare, real operation,
 * and settle all live in one promise. Renderer cannot forge an attempt id or
 * mark a node complete after its window disappears.
 */
async function execute(root, workflowId, request, host) {
  let prepared = null;
  try {
    if (!host || typeof host.run !== 'function' || typeof host.confirm !== 'function') fail('工作流执行器未正确配置');
    const graph = graphInfo(request.graph);
    const node = graph.nodes.find((item) => item.id === request.nodeId);
    if (!node) fail('待执行节点不存在');
    const current = transact(root, workflowId, { action: 'read', graph: request.graph });
    if (!current.ok || !current.state) return current;
    if (request.expectedRevision !== current.state.revision) fail('工作流状态已变化，请重新加载后再继续');
    if (current.state.pending.some((item) => item.active)) fail('工作流节点仍在执行，不能重复运行');
    const reviewIds = [...new Set([
      ...current.state.pending.map((item) => item.id),
      ...(current.state.reviews[node.id] ? [current.state.reviews[node.id]] : []),
    ])];
    const review = reviewIds.length > 0 || request.legacyRecovery === true;
    if (review || node.data.confirmWrite) {
      const approved = await host.confirm({ label: String(node.data.label || node.id), writeScope: String(node.data.writeScope || '未声明'),
        review, pending: current.state.pending.map((item) => item.label), legacy: request.legacyRecovery === true });
      if (approved !== true) return { ok: false, needsReview: review, error: review ? '重跑前需要复核副作用' : '用户取消写入确认', state: current.state };
    }
    prepared = transact(root, workflowId, {
      action: 'prepare', graph: request.graph, nodeId: node.id,
      expectedRevision: current.state.revision, reviewedAttemptIds: reviewIds,
    });
    if (!prepared.ok || !prepared.attemptId) return prepared;
    let outcome;
    try {
      outcome = await host.run(node, graph, current.state);
      if (!outcome || typeof outcome.output !== 'string' || typeof outcome.ok !== 'boolean') fail('工作流执行器返回无效结果');
    } catch (error) {
      outcome = { ok: false, output: String((error && error.message) || error) };
    }
    const settled = transact(root, workflowId, {
      action: 'settle', graph: request.graph, attemptId: prepared.attemptId,
      ok: outcome.ok, output: outcome.output,
    });
    if (!settled.ok) return { ok: false, error: '节点可能已执行，但结果未能持久化；后续节点已停止：' + settled.error };
    return { ok: true, executionOk: outcome.ok, output: outcome.output, state: settled.state };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    if (prepared && prepared.attemptId) active.delete(prepared.attemptId);
  }
}

module.exports = { dispatch, transact, execute, workflowFile, graphInfo };
