/**
 * workbench_structure：节点结构操作。action：
 *   group(nodeIds[,name])           把节点打包为组节点（含组输入/组输出端子，外部连线自动接驳）
 *   ungroup(nodeId)                 解开组节点，成员回到当前画布
 *   add_port(nodeId,direction)      给组节点增删输入/输出端子
 *   remove_port(nodeId,direction,portId)
 *   expand_bundle / ungroup_bundle  资源组语义在新版已并入普通组，等效 ungroup
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function doGroup(model, args, errors, affected) {
  const rawList = args.nodeIds;
  const selected = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const node = model.byId(String(item));
      if (node) selected.push(node);
    }
  }
  if (selected.length === 0) {
    errors.push('group 需要 nodeIds');
    return;
  }
  const name = stringArg(args, 'name', '节点组');
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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
    if (sIn && tIn) {
      continue;
    } else if (!sIn && tIn) {
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
  subNodes.push({
    id: giId,
    type: 'group-input',
    position: { x: 0, y: 40 },
    data: { label: '组输入', socketIds: inputs.map((i) => i.id), status: 'pending', accent: '#22c55e' },
  });
  for (const i of inputs) {
    if (i.toId) subEdges.push({ id: eid(), source: giId, sourceHandle: i.id, target: i.toId, animated: true });
  }
  const goId = gid + '-go';
  subNodes.push({
    id: goId,
    type: 'group-output',
    position: { x: 300, y: 40 },
    data: { label: '组输出', socketIds: outputs.map((o) => o.id), status: 'pending', accent: '#ef4444' },
  });
  for (const o of outputs) {
    if (o.fromId) subEdges.push({ id: eid(), source: o.fromId, target: goId, targetHandle: o.id, animated: true });
  }

  const g = model.current();
  g.nodes = g.nodes.filter((n) => !selSet.has(n.id));
  g.edges = keepEdges;
  g.nodes.push({
    id: gid,
    type: 'group',
    position: { x: originX, y: originY },
    data: {
      label: name,
      status: 'pending',
      accent: '#06b6d4',
      width: maxX - originX,
      height: maxY - originY,
      sockets: { inputs, outputs },
    },
  });
  model.doc.groups = model.doc.groups || {};
  model.doc.groups[gid] = { nodes: subNodes, edges: subEdges };
  affected.push(gid);
}

function doUngroup(model, args, errors, affected) {
  const group = model.byId(String(args.nodeId || ''));
  if (!group) {
    errors.push('节点不存在: ' + (args.nodeId || ''));
    return;
  }
  if (group.type !== 'group') {
    errors.push('不是组节点: ' + group.id);
    return;
  }
  const sub = model.doc.groups[group.id];
  const g = model.current();
  if (!sub) {
    // 空组：直接删除
    g.nodes = g.nodes.filter((n) => n.id !== group.id);
    delete model.doc.groups[group.id];
    affected.push(group.id);
    return;
  }
  const gd = group.data || {};
  const sockets = gd.sockets || { inputs: [], outputs: [] };
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
}

function doAddPort(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) {
    errors.push('节点不存在: ' + (args.nodeId || ''));
    return;
  }
  if (node.type !== 'group') {
    errors.push('add_port 仅支持组节点: ' + node.id);
    return;
  }
  const output = String(args.direction || 'output') === 'output';
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
      n.type === termType
        ? { ...n, data: { ...n.data, socketIds: [...((n.data.socketIds || [])), next] } }
        : n
    );
  }
  affected.push(node.id + ':' + next);
}

function doRemovePort(model, args, errors, affected) {
  const node = model.byId(String(args.nodeId || ''));
  if (!node) {
    errors.push('节点不存在: ' + (args.nodeId || ''));
    return;
  }
  if (node.type !== 'group') {
    errors.push('remove_port 仅支持组节点: ' + node.id);
    return;
  }
  const output = String(args.direction || 'input') === 'output';
  const portId = String(args.portId || '');
  if (!portId) {
    errors.push('缺少 portId');
    return;
  }
  const gd = node.data || {};
  const sockets = { inputs: [...((gd.sockets && gd.sockets.inputs) || [])], outputs: [...((gd.sockets && gd.sockets.outputs) || [])] };
  const list = output ? sockets.outputs : sockets.inputs;
  const idx = list.findIndex((x) => x.id === portId);
  if (idx < 0) {
    errors.push('端口不存在: ' + portId);
    return;
  }
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
        n.type === termType
          ? { ...n, data: { ...n.data, socketIds: ((n.data.socketIds || [])).filter((x) => x !== portId) } }
          : n
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

function register(registry) {
  registry.register(
    'workbench_structure',
    '节点结构操作。action：group（把 nodeIds 打包为组节点，可给 name）、ungroup（解开组 nodeId）、' +
      'add_port / remove_port（给组节点增删端子，direction=input|output，remove 需 portId）、' +
      'expand_bundle / ungroup_bundle（资源组在新版并入普通组，等效 ungroup）。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'group/ungroup/expand_bundle/ungroup_bundle/add_port/remove_port' },
        nodeId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' } },
        name: { type: 'string', description: 'group 名称' },
        direction: { type: 'string', description: 'input 或 output' },
        portId: { type: 'string', description: 'remove_port 要删除的端口 id' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String(args.action || '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const errors = [];
      const affected = [];
      try {
        await context.mutateWorkbench((model) => {
          switch (action) {
            case 'group':
              doGroup(model, args, errors, affected);
              break;
            case 'ungroup':
            case 'ungroup_bundle':
            case 'expand_bundle':
              doUngroup(model, args, errors, affected);
              break;
            case 'add_port':
              doAddPort(model, args, errors, affected);
              break;
            case 'remove_port':
              doRemovePort(model, args, errors, affected);
              break;
            default:
              errors.push('未知 action: ' + action);
          }
        });
      } catch (e) {
        return AgentToolResult.error('workbench_structure 执行失败：' + ((e && e.message) || e));
      }
      if (errors.length) return AgentToolResult.error(errors.join('；'));
      if (affected.length === 0) return AgentToolResult.ok('操作完成：' + action);
      return AgentToolResult.ok('已执行 ' + action + '：' + affected.join(', '), { action, nodeIds: affected });
    }
  );
}

module.exports = { register };
