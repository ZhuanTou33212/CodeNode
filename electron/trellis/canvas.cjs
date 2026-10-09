'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { atomicWriteFile } = require('../atomicFile.cjs');
const trellis = require('./index.cjs');
const { internal } = require('./writes.cjs');
const limits = require('../../config/trellis.compatibility.json');
function createGraph(root, taskPath) {
  const snapshot = trellis.resolveContext(root, taskPath); trellis.assertReady(snapshot);
  const snapshotId = randomUUID();
  atomicWriteFile(internal(root, 'canvas/' + snapshotId + '.json'), JSON.stringify({ version: 1, snapshotId, snapshot }) + '\n');
  const nodes = limits.canvasPhases.map((phase, index) => ({ id: snapshotId + '-' + phase.id, type: 'stage', position: { x: index * 280, y: 100 }, data: {
    label: phase.label, goal: snapshot.task.title, prompt: phase.prompt, status: 'pending', requiresInput: index > 0,
    outputName: phase.label + '交付', completionCondition: '真实执行并说明证据和未核验项；阶段结束不自动完成 Trellis 任务',
    trellis: { taskPath, snapshotId, phase: phase.id, role: phase.role },
  } }));
  const edges = nodes.slice(1).map((node, index) => ({ id: snapshotId + '-edge-' + index, source: nodes[index].id, target: node.id, type: 'waypoint' }));
  return { nodes, edges, snapshotId, contextFingerprint: snapshot.fingerprint };
}
function resolveBinding(root, binding) {
  if (!binding || !/^[0-9a-f-]{36}$/.test(String(binding.snapshotId))) throw new Error('画布任务快照编号无效');
  const phase = limits.canvasPhases.find(item => item.id === binding.phase && item.role === binding.role);
  if (!phase) throw new Error('画布阶段没有合法执行动作和角色绑定');
  const file = internal(root, 'canvas/' + binding.snapshotId + '.json');
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('画布任务快照过大');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (saved.version !== 1 || saved.snapshotId !== binding.snapshotId || saved.snapshot.taskPath !== binding.taskPath) throw new Error('画布任务与保存快照不匹配');
  trellis.assertReady(saved.snapshot, phase.role);
  const changes = trellis.sourceChanges(root, saved.snapshot);
  if (changes.length) throw new Error('画布资料已变化，请核对并重新生成流程：' + changes.join('、'));
  return { ...binding, snapshot: saved.snapshot };
}
function resumeBinding(root, runId) {
  if (!root || !runId) return null;
  const events = require('../runStore.cjs').readRun(root, runId);
  const stage = events.find(event => event.type === 'trellis_canvas_stage');
  if (!stage) return null;
  const taskPath = stage.taskPath || events.find(event => event.type === 'trellis_context')?.snapshot?.taskPath;
  return resolveBinding(root, { taskPath, snapshotId: stage.snapshotId, phase: stage.phase, role: stage.role });
}
module.exports = { createGraph, resolveBinding, resumeBinding };
