/**
 * GraphModel：工作台图模型抽象（复刻原版 WorkflowModel 中工具用到的最小语义）。
 *
 * 数据结构沿用渲染进程的文档快照：
 *   doc = { root: { nodes, edges } }
 * 工具只读写当前画布（与用户所见一致）。
 */
'use strict';

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const eid = () => 'e' + Math.random().toString(36).slice(2, 10);

class GraphModel {
  constructor(doc) {
    this.doc = doc || { root: { nodes: [], edges: [] } };
    if (!this.doc.root) this.doc.root = { nodes: [], edges: [] };
  }

  /** 当前可见画布 */
  current() {
    return this.doc.root;
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

  addNode(type, data, x, y, id) {
    const used = new Set(this.nodes().map((n) => n.id));
    let nodeId = id || uid(type || 'node');
    if (used.has(nodeId)) nodeId = uid(type || 'node'); // 自定义 id 冲突时回退自动生成
    const node = {
      id: nodeId,
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
  }

  removeEdges(edges) {
    const ids = new Set(edges.map((e) => e.id));
    const g = this.current();
    g.edges = g.edges.filter((e) => !ids.has(e.id));
  }

  /** 复制节点，返回新节点 */
  duplicate(node, x, y) {
    const copy = JSON.parse(JSON.stringify(node));
    copy.id = uid(String(node.type || 'node'));
    copy.position = { x: x == null ? node.position.x + 40 : x, y: y == null ? node.position.y + 40 : y };
    copy.selected = false;
    copy.data = copy.data || {};
    if (copy.data.parentId) {
      const parent = this.byId(copy.data.parentId);
      if (parent) {
        parent.data = parent.data || {};
        parent.data.childIds = Array.isArray(parent.data.childIds) ? parent.data.childIds : [];
        parent.data.childIds.push(copy.id);
      }
    } else {
      copy.data.parentId = null;
      copy.data.memberBadge = null;
    }
    if (copy.type === 'scope') copy.data.childIds = [];
    this.current().nodes.push(copy);
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
      tasks: count('task'),
      stages: count('stage'),
      tools: count('tool'),
      files: count('file'),
      objects: count('object'),
      scopes: count('scope'),
    };
  }
}

module.exports = { GraphModel };
