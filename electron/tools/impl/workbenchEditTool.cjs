/**
 * workbench_edit：统一的工作台节点编辑工具（创建/编辑/连线/结构 一体）。
 *
 * 用法一（推荐，批量）：operations=[{action,...}, {action,...}, ...] 一次调用顺序执行全部操作，
 *   把所有需要「新建节点 / 改名 / 设 prompt / 设状态 / 连线」的变更一次性提交，避免多次调用。
 * 用法二（单操作）：action + 对应参数。
 *
 * action 支持：
 *   create(nodeId 自动)       参数：name/type/count/prompt/relativePath/connect(串联链)
 *   rename                    nodeId + name
 *   set_prompt / set_category / set_goal / set_status(nodeId,value)
 *   move                      nodeId + x + y
 *   delete                    nodeId 或 nodeIds
 *   duplicate                 nodeId + offsetX/offsetY
 *   connect                   sourceId + targetId，或 connections=[{sourceId,targetId}] 批量
 *   disconnect                sourceId/targetId
 *   group                     nodeIds + name
 *   ungroup                   nodeId
 *   add_port / remove_port    nodeId + direction(input|output) [+ portId]
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

const MAX_CREATE_COUNT = 50;

const KIND_TO_TYPE = {
  regular: 'task', calculation: 'task', condition: 'task', capture: 'task',
  bundle: 'group', asset: 'file', group: 'group', file: 'file', task: 'task',
  stage: 'stage', tool: 'tool', start: 'start', end: 'end', agent: 'agent',
  user: 'user', scope: 'scope',
};

const STATUS_ALLOWED = ['pending', 'running', 'done', 'failed', 'blocked'];

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function intArg(args, key, fallback) {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.floor(args[key]) : fallback;
}

function nodeIdList(args) {
  const ids = [];
  if (args.nodeId != null && String(args.nodeId).trim() !== '') ids.push(String(args.nodeId));
  if (Array.isArray(args.nodeIds)) {
    for (const item of args.nodeIds) if (item != null && String(item).trim() !== '') ids.push(String(item));
  }
  return ids;
}

/** ---------- 单条操作执行 ---------- */

function opCreate(model, args, ctx, errors, created) {
  let n = intArg(args, 'count', 1);
  n = Math.max(1, Math.min(MAX_CREATE_COUNT, n));
  const baseName = stringArg(args, 'name', '节点');
  const prompt = stringArg(args, 'prompt', '');
  const kind = (stringArg(args, 'nodeKind', '') || stringArg(args, 'type', 'task')).toLowerCase();
  const type = KIND_TO_TYPE[kind] || 'task';
  const relativePath = stringArg(args, 'relativePath', '');
  const connect = args.connect === true;
  const baseX = intArg(args, 'x', 120);
  const baseY = intArg(args, 'y', 120);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const nodeName = n === 1 ? baseName : baseName + (i + 1);
    const data = { label: nodeName, status: 'pending', prompt };
    if (type === 'file') data.filePath = relativePath || nodeName;
    if (type === 'group') data.accent = '#06b6d4';
    if (type === 'scope') {
      data.width = 320; data.height = 200; data.fill = '#3b2f6b';
      data.opacity = 0.16; data.accent = '#8b5cf6';
    }
    const node = model.addNode(type, data, baseX, baseY + i * 110);
    nodes.push(node);
    created.push(node.id);
  }
  if (connect && nodes.length >= 2) {
    for (let i = 0; i + 1 < nodes.length; i++) model.connect(nodes[i], nodes[i + 1]);
  }
  void ctx;
}

function opRename(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  node.data = node.data || {};
  node.data.label = stringArg(args, 'name', node.data.label);
  affected.push(node.id);
}

function opSet(model, args, errors, affected, field, validate) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  const value = stringArg(args, 'value', '');
  if (validate && !validate(value)) { errors.push('非法状态: ' + value); return; }
  node.data = node.data || {};
  node.data[field] = field === 'status' ? value.toLowerCase() : value;
  affected.push(node.id);
}

function opMove(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  node.position = { x: intArg(args, 'x', node.position.x), y: intArg(args, 'y', node.position.y) };
  affected.push(node.id);
}

function opDelete(model, args, errors, affected) {
  const ids = nodeIdList(args);
  if (!ids.length) { errors.push('缺少要删除的 nodeId'); return; }
  for (const id of ids) {
    const node = model.byId(id);
    if (!node) { errors.push('节点不存在: ' + id); continue; }
    model.removeNode(node);
    affected.push(id);
  }
}

function opDuplicate(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  const copy = model.duplicate(node, node.position.x + intArg(args, 'offsetX', 40), node.position.y + intArg(args, 'offsetY', 40));
  affected.push(copy.id);
}

function opConnect(model, args, errors, affected) {
  const pairs = [];
  if (Array.isArray(args.connections)) {
    for (const p of args.connections) {
      if (p && typeof p === 'object' && p.sourceId && p.targetId) {
        pairs.push({ sourceId: String(p.sourceId), targetId: String(p.targetId) });
      }
    }
  } else if (args.sourceId && args.targetId) {
    pairs.push({ sourceId: String(args.sourceId), targetId: String(args.targetId) });
  }
  if (!pairs.length) { errors.push('缺少 sourceId/targetId 或 connections'); return; }
  for (const p of pairs) {
    const source = model.byId(p.sourceId);
    const target = model.byId(p.targetId);
    if (!source) { errors.push('源节点不存在: ' + p.sourceId); continue; }
    if (!target) { errors.push('目标节点不存在: ' + p.targetId); continue; }
    if (model.edges().some((e) => e.source === p.sourceId && e.target === p.targetId)) {
      errors.push('已存在连线 ' + p.sourceId + '→' + p.targetId);
      continue;
    }
    model.connect(source, target);
    affected.push(p.sourceId + '→' + p.targetId);
  }
}

function opDisconnect(model, args, errors, affected) {
  const sourceId = stringArg(args, 'sourceId', '');
  const targetId = stringArg(args, 'targetId', '');
  const toRemove = model.edges().filter((e) => {
    if (sourceId && targetId) return e.source === sourceId && e.target === targetId;
    if (targetId) return e.target === targetId;
    return e.source === sourceId;
  });
  model.removeEdges(toRemove);
  affected.push('断开 ' + toRemove.length + ' 条');
}

function opGroup(model, args, errors, affected) {
  const rawList = args.nodeIds;
  const selected = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const node = model.byId(String(item));
      if (node) selected.push(node);
    }
  }
  if (!selected.length) { errors.push('group 需要 nodeIds'); return; }
  const name = stringArg(args, 'name', '节点组');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of selected) {
    const w = (n.measured && n.measured.width) || 88;
    const h = (n.measured && n.measured.height) || 64;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const pad = 24;
  const originX = minX - pad;
  const originY = minY - pad;
  const gid = uid('group');
  const selSet = new Set(selected.map((n) => n.id));

  const subNodes = selected.map((n) => {
    const copy = JSON.parse(JSON.stringify(n));
    copy.position = { x: n.position.x - originX, y: n.position.y - originY };
    copy.selected = false;
    return copy;
  });

  const inputs = [];
  const outputs = [];
  const keepEdges = [];
  for (const e of model.edges()) {
    const sIn = selSet.has(e.source);
    const tIn = selSet.has(e.target);
    if (sIn && tIn) continue;
    if (!sIn && tIn) {
      const sid = 'in-' + (inputs.length + 1);
      inputs.push({ id: sid, toId: e.target });
      keepEdges.push({ ...e, id: eid(), target: gid, targetHandle: sid });
    } else if (sIn && !tIn) {
      const sid = 'out-' + (outputs.length + 1);
      outputs.push({ id: sid, fromId: e.source });
      keepEdges.push({ ...e, id: eid(), source: gid, sourceHandle: sid });
    } else {
      keepEdges.push(e);
    }
  }
  if (inputs.length === 0) inputs.push({ id: 'in-1', toId: '' });
  if (outputs.length === 0) outputs.push({ id: 'out-1', fromId: '' });

  const subEdges = model
    .edges()
    .filter((e) => selSet.has(e.source) && selSet.has(e.target))
    .map((e) => ({ ...e }));

  const giId = gid + '-gi';
  subNodes.push({ id: giId, type: 'group-input', position: { x: 0, y: 40 }, data: { label: '组输入', socketIds: inputs.map((i) => i.id), status: 'pending', accent: '#22c55e' } });
  for (const i of inputs) if (i.toId) subEdges.push({ id: eid(), source: giId, sourceHandle: i.id, target: i.toId, animated: true });
  const goId = gid + '-go';
  subNodes.push({ id: goId, type: 'group-output', position: { x: 300, y: 40 }, data: { label: '组输出', socketIds: outputs.map((o) => o.id), status: 'pending', accent: '#ef4444' } });
  for (const o of outputs) if (o.fromId) subEdges.push({ id: eid(), source: o.fromId, target: goId, targetHandle: o.id, animated: true });

  const g = model.current();
  g.nodes = g.nodes.filter((n) => !selSet.has(n.id));
  g.edges = keepEdges;
  g.nodes.push({
    id: gid,
    type: 'group',
    position: { x: originX, y: originY },
    data: { label: name, status: 'pending', accent: '#06b6d4', width: maxX - originX, height: maxY - originY, sockets: { inputs, outputs } },
  });
  model.doc.groups = model.doc.groups || {};
  model.doc.groups[gid] = { nodes: subNodes, edges: subEdges };
  affected.push(gid);
}

function opUngroup(model, args, errors, affected) {
  const group = model.byId(String(args.nodeId || ''));
  if (!group) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  if (group.type !== 'group') { errors.push('不是组节点: ' + group.id); return; }
  const sub = model.doc.groups[group.id];
  const g = model.current();
  if (!sub) {
    g.nodes = g.nodes.filter((n) => n.id !== group.id);
    delete model.doc.groups[group.id];
    affected.push(group.id);
    return;
  }
  const sockets = (group.data && group.data.sockets) || { inputs: [], outputs: [] };
  const gx = group.position.x;
  const gy = group.position.y;
  const expanded = sub.nodes
    .filter((n) => n.type !== 'group-input' && n.type !== 'group-output')
    .map((n) => ({ ...JSON.parse(JSON.stringify(n)), position: { x: n.position.x + gx, y: n.position.y + gy } }));
  const expandedEdges = sub.edges
    .filter((e) => {
      const sn = sub.nodes.find((n) => n.id === e.source);
      const tn = sub.nodes.find((n) => n.id === e.target);
      return sn && tn && sn.type !== 'group-input' && sn.type !== 'group-output';
    })
    .map((e) => ({ ...e }));
  const parentEdges = g.edges.filter((e) => e.source !== group.id && e.target !== group.id);
  for (const e of g.edges) {
    if (e.target === group.id) {
      const def = sockets.inputs.find((i) => i.id === (e.targetHandle || 'in'));
      if (def && def.toId) parentEdges.push({ ...e, id: eid(), target: def.toId, targetHandle: null });
    } else if (e.source === group.id) {
      const def = sockets.outputs.find((o) => o.id === (e.sourceHandle || 'out'));
      if (def && def.fromId) parentEdges.push({ ...e, id: eid(), source: def.fromId, sourceHandle: null });
    }
  }
  g.nodes = g.nodes.filter((n) => n.id !== group.id).concat(expanded);
  g.edges = parentEdges;
  delete model.doc.groups[group.id];
  affected.push(group.id);
  void expandedEdges;
}

function opAddPort(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  if (node.type !== 'group') { errors.push('add_port 仅支持组节点'); return; }
  const output = stringArg(args, 'direction', 'output') === 'output';
  const gd = node.data || {};
  const sockets = { inputs: [...((gd.sockets && gd.sockets.inputs) || [])], outputs: [...((gd.sockets && gd.sockets.outputs) || [])] };
  const list = output ? sockets.outputs : sockets.inputs;
  const next = (output ? 'out-' : 'in-') + (list.length + 1);
  list.push({ id: next, ...(output ? { fromId: '' } : { toId: '' }) });
  node.data = { ...gd, sockets: output ? { ...sockets, outputs: list } : { ...sockets, inputs: list } };
  const sub = model.doc.groups[node.id];
  if (sub) {
    const termType = output ? 'group-output' : 'group-input';
    sub.nodes = sub.nodes.map((n) =>
      n.type === termType ? { ...n, data: { ...n.data, socketIds: [...((n.data.socketIds || [])), next] } } : n
    );
  }
  affected.push(node.id + ':' + next);
}

function opRemovePort(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) { errors.push('节点不存在: ' + (args.nodeId || '')); return; }
  if (node.type !== 'group') { errors.push('remove_port 仅支持组节点'); return; }
  const output = stringArg(args, 'direction', 'input') === 'output';
  const portId = stringArg(args, 'portId', '');
  if (!portId) { errors.push('缺少 portId'); return; }
  const gd = node.data || {};
  const sockets = { inputs: [...((gd.sockets && gd.sockets.inputs) || [])], outputs: [...((gd.sockets && gd.sockets.outputs) || [])] };
  const list = output ? sockets.outputs : sockets.inputs;
  const idx = list.findIndex((x) => x.id === portId);
  if (idx < 0) { errors.push('端口不存在: ' + portId); return; }
  list.splice(idx, 1);
  node.data = { ...gd, sockets: output ? { ...sockets, outputs: list } : { ...sockets, inputs: list } };
  const sub = model.doc.groups[node.id];
  const g = model.current();
  if (sub) {
    const termType = output ? 'group-output' : 'group-input';
    const term = sub.nodes.find((n) => n.type === termType);
    if (term) {
      sub.edges = sub.edges.filter(
        (e) => !(output ? e.target === term.id && (e.targetHandle || 'out') === portId : e.source === term.id && (e.sourceHandle || 'in') === portId)
      );
      sub.nodes = sub.nodes.map((n) =>
        n.type === termType ? { ...n, data: { ...n.data, socketIds: (n.data.socketIds || []).filter((x) => x !== portId) } } : n
      );
    }
  }
  g.edges = g.edges.filter(
    (e) =>
      !(output && e.source === node.id && (e.sourceHandle || 'out') === portId) &&
      !(!output && e.target === node.id && (e.targetHandle || 'in') === portId)
  );
  affected.push(node.id + ':' + portId);
}

/** 按 action 分发执行 */
function applyAction(model, args, errors, affected, created) {
  const action = String(args.action || '').trim().toLowerCase();
  switch (action) {
    case 'create':
      opCreate(model, args, null, errors, created);
      break;
    case 'rename':
      opRename(model, args, errors, affected);
      break;
    case 'set_prompt':
      opSet(model, args, errors, affected, 'prompt', null);
      break;
    case 'set_category':
      opSet(model, args, errors, affected, 'category', null);
      break;
    case 'set_goal':
    case 'add_goal':
      opSet(model, args, errors, affected, 'goal', null);
      break;
    case 'set_status':
      opSet(model, args, errors, affected, 'status', (v) => STATUS_ALLOWED.includes(v.toLowerCase()));
      break;
    case 'set_collapsed':
      opSet(model, args, errors, affected, 'collapsed', null);
      break;
    case 'set_muted':
      opSet(model, args, errors, affected, 'muted', null);
      break;
    case 'set_color':
      opSet(model, args, errors, affected, 'accent', null);
      break;
    case 'move':
      opMove(model, args, errors, affected);
      break;
    case 'delete':
      opDelete(model, args, errors, affected);
      break;
    case 'duplicate':
      opDuplicate(model, args, errors, affected);
      break;
    case 'connect':
      opConnect(model, args, errors, affected);
      break;
    case 'disconnect':
      opDisconnect(model, args, errors, affected);
      break;
    case 'group':
      opGroup(model, args, errors, affected);
      break;
    case 'ungroup':
    case 'ungroup_bundle':
    case 'expand_bundle':
      opUngroup(model, args, errors, affected);
      break;
    case 'add_port':
      opAddPort(model, args, errors, affected);
      break;
    case 'remove_port':
      opRemovePort(model, args, errors, affected);
      break;
    default:
      errors.push('未知 action: ' + action);
  }
}

function buildSummary(args) {
  const created = [];
  const affected = [];
  const errors = [];
  const ops = Array.isArray(args.operations) && args.operations.length ? args.operations : null;
  return { created, affected, errors, ops };
}

function register(registry) {
  registry.register(
    'workbench_edit',
    '统一的工作台节点编辑工具：创建、编辑、连线、结构（成组/解组）全部用这一个工具完成，不需要再用 create_nodes / workbench_connect / workbench_structure。' +
      '强烈建议用批量参数 operations=[{action, ...}, {action, ...}, ...] 一次提交全部节点变更：' +
      'action 支持 create(新建，name/type/count/prompt/connect串联)、rename(nodeId,name)、set_prompt(nodeId,value)、' +
      'set_status(nodeId,value)、set_category/set_goal/move/delete(nodeId)、duplicate、connect(sourceId,targetId 或 connections 批量)、' +
      'disconnect、group(nodeIds,name)、ungroup(nodeId)、add_port/remove_port(nodeId,direction,portId)。' +
      '把需要新建/修改/连线的所有节点一次性放进 operations，避免多次调用占用上下文。',
    {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: { type: 'object' },
          description: '批量操作数组，每项 {action, ...对应参数}，按顺序一次执行',
        },
        action: { type: 'string', description: '单操作模式（未给 operations 时）' },
        nodeId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        type: { type: 'string', description: 'create 的节点类型：task/stage/tool/start/end/group/file/agent/user/scope' },
        count: { type: 'integer', description: 'create 数量，默认 1，最多 50' },
        prompt: { type: 'string' },
        value: { type: 'string', description: 'set_* 的新值' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        connections: { type: 'array', items: { type: 'object' }, description: '批量连线 [{sourceId,targetId}]' },
        connect: { type: 'boolean', description: 'create 时是否按顺序串联成链' },
        relativePath: { type: 'string' },
        direction: { type: 'string', description: 'add_port/remove_port 的 input|output' },
        portId: { type: 'string' },
      },
      required: [],
    },
    async (context, args) => {
      const { created, affected, errors } = buildSummary(args);
      const ops = Array.isArray(args.operations) && args.operations.length ? args.operations : null;
      let applied = false;
      try {
        applied = await context.mutateWorkbench((model) => {
          if (ops) {
            for (const op of ops) {
              if (!op || typeof op !== 'object') { errors.push('非法操作项'); continue; }
              applyAction(model, op, errors, affected, created);
            }
          } else {
            applyAction(model, args, errors, affected, created);
          }
        });
      } catch (e) {
        return AgentToolResult.error('workbench_edit 执行失败：' + ((e && e.message) || e));
      }
      if (!applied && !errors.length) return AgentToolResult.error('工作台不可用（无变更应用）');
      const parts = [];
      if (created.length) parts.push('新建 ' + created.length + ' 个节点: ' + created.join(', '));
      if (affected.length) parts.push('操作 ' + affected.length + ' 项: ' + affected.join(', '));
      const summary = parts.join('；') || '操作完成';
      if (errors.length) {
        return AgentToolResult.ok('部分操作失败：' + errors.join('；') + '。' + summary, { created, affected, errors, applied });
      }
      return AgentToolResult.ok(summary, { created, affected, applied });
    }
  );
}

module.exports = { register };
