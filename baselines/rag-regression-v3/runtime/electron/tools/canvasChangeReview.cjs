'use strict';

function graphSnapshot(model) {
  if (!model || typeof model.nodes !== 'function' || typeof model.edges !== 'function') return { nodes: [], edges: [] };
  return JSON.parse(JSON.stringify({ nodes: model.nodes(), edges: model.edges() }));
}

function value(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return '未设置';
  return json.length > 220 ? json.slice(0, 220) + '…' : json;
}

function canvasChangeReview(before, after) {
  const changes = [];
  const oldNodes = new Map((before.nodes || []).map((node) => [node.id, node]));
  const newNodes = new Map((after.nodes || []).map((node) => [node.id, node]));
  for (const [id, node] of newNodes) {
    const prior = oldNodes.get(id);
    if (!prior) { changes.push({ kind: 'added', nodeId: id, label: String(node.data && node.data.label || id), type: node.type }); continue; }
    const keys = new Set([...Object.keys(prior.data || {}), ...Object.keys(node.data || {})]);
    if (JSON.stringify(prior.position) !== JSON.stringify(node.position)) keys.add('position');
    if (prior.type !== node.type) keys.add('type');
    for (const key of keys) {
      const from = key === 'position' || key === 'type' ? prior[key] : prior.data && prior.data[key];
      const to = key === 'position' || key === 'type' ? node[key] : node.data && node.data[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ kind: 'changed', nodeId: id, field: key, before: value(from), after: value(to) });
    }
  }
  for (const [id, node] of oldNodes) if (!newNodes.has(id)) changes.push({ kind: 'removed', nodeId: id, label: String(node.data && node.data.label || id), type: node.type });
  const edgeKey = (edge) => String(edge.source) + '→' + String(edge.target);
  const oldEdges = new Set((before.edges || []).map(edgeKey));
  const newEdges = new Set((after.edges || []).map(edgeKey));
  for (const key of newEdges) if (!oldEdges.has(key)) changes.push({ kind: 'edge_added', edge: key });
  for (const key of oldEdges) if (!newEdges.has(key)) changes.push({ kind: 'edge_removed', edge: key });
  return { changes: changes.slice(0, 60), total: changes.length, truncated: changes.length > 60 };
}

module.exports = { graphSnapshot, canvasChangeReview };
