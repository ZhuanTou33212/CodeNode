/**
 * GraphModel：工作台图模型抽象（复刻原版 WorkflowModel 中工具用到的最小语义）。
 *
 * 数据结构沿用渲染进程的文档快照：
 *   doc = { root: { nodes, edges }, groups: { [gid]: { nodes, edges } }, viewStack: [] }
 * 其中 viewStack 顶部即「当前画布」。工具只读写当前画布（与用户所见一致）。
 */
'use strict';

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

class GraphModel {
  constructor(doc) {
    this.doc = doc || { root: { nodes: [], edges: [] }, groups: {}, viewStack: [] };
    if (!this.doc.root) this.doc.root = { nodes: [], edges: [] };
    if (!this.doc.groups) this.doc.groups = {};
    if (!this.doc.viewStack) this.doc.viewStack = [];
  }

  /** 当前可见画布 */
  current() {
    const stack = this.doc.viewStack;
    if (stack.length === 0) return this.doc.root;
    return this.doc.groups[stack[stack.length - 1]] || this.doc.root;
  }

  nodes() {
    return this.current().nodes;
  }

  edges() {
    return this.current().edges;
  }

  byId(id) {
    return this.current().nodes.find((n) => n.id === id) || null;
  }

  addNode(type, data, x, y) {
    const node = {
      id: uid(type || 'node'),
      type: type || 'task',
      position: { x: x == null ? 120 : x, y: y == null ? 120 : y },
      data: data || { label: type || '节点', status: 'pending' },
    };
    this.current().nodes.push(node);
    return node;
  }

  addEdge(source, target, sourceHandle, targetHandle) {
    const edge = {
      id: eid(),
      source,
      target,
      sourceHandle: sourceHandle || null,
      targetHandle: targetHandle || null,
      type: 'smoothstep',
      animated: true,
    };
    this.current().edges.push(edge);
    return edge;
  }

  connect(sourceNode, targetNode) {
    return this.addEdge(sourceNode.id, targetNode.id);
  }

  removeNode(node) {
    const g = this.current();
    g.nodes = g.nodes.filter((n) => n.id !== node.id);
    g.edges = g.edges.filter((e) => e.source !== node.id && e.target !== node.id);
    this.doc.groups = this.doc.groups || {};
    for (const key of Object.keys(this.doc.groups)) {
      const sub = this.doc.groups[key];
      sub.nodes = sub.nodes.filter((n) => n.id !== node.id);
      sub.edges = sub.edges.filter((e) => e.source !== node.id && e.target !== node.id);
    }
  }

  removeEdges(edges) {
    const ids = new Set(edges.map((e) => e.id));
    const g = this.current();
    g.edges = g.edges.filter((e) => !ids.has(e.id));
  }

  /** 复制节点（含其子组内容），返回新节点 */
  duplicate(node, x, y) {
    const copy = JSON.parse(JSON.stringify(node));
    copy.id = uid(String(node.type || 'node'));
    copy.position = { x: x == null ? node.position.x + 40 : x, y: y == null ? node.position.y + 40 : y };
    copy.selected = false;
    this.current().nodes.push(copy);
    if (node.type === 'group') {
      const sub = this.doc.groups[node.id];
      if (sub) {
        const idMap = { [node.id]: copy.id };
        const newNodes = sub.nodes.map((n) => {
          const nn = JSON.parse(JSON.stringify(n));
          const oldId = n.id;
          nn.id = uid(n.type || 'node');
          idMap[oldId] = nn.id;
          return nn;
        });
        const newEdges = sub.edges
          .map((e) => ({ ...e, id: eid(), source: idMap[e.source] || e.source, target: idMap[e.target] || e.target }))
          .filter((e) => e.source && e.target);
        this.doc.groups[copy.id] = { nodes: newNodes, edges: newEdges };
      }
    }
    return copy;
  }

  /** 统计 */
  stats() {
    const nodes = this.nodes();
    const edges = this.edges();
    const count = (t) => nodes.filter((n) => n.type === t).length;
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      groups: count('group'),
      tasks: count('task'),
      stages: count('stage'),
      tools: count('tool'),
      files: count('file'),
      agents: count('agent'),
      users: count('user'),
      scopes: count('scope'),
    };
  }
}

module.exports = { GraphModel };
