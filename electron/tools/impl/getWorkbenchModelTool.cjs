/**
 * get_workbench_model：完整读取工作台当前画布——节点（id/type/label/position/status/goal/prompt/filePath/members）
 * 与连线（source→target）。view=full（默认）全部；view=groups 只看组节点；view=counts 只看统计。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function nodeValue(node) {
  const d = node.data || {};
  const v = {
    id: node.id,
    type: node.type,
    label: d.label || '',
    status: d.status || '',
    x: Math.round((node.position && node.position.x) || 0),
    y: Math.round((node.position && node.position.y) || 0),
  };
  if (d.goal != null) v.goal = d.goal;
  if (d.prompt != null) v.prompt = d.prompt;
  if (d.filePath != null) v.filePath = d.filePath;
  if (d.role != null) v.role = d.role;
  if (d.subtitle != null) v.subtitle = d.subtitle;
  if (Array.isArray(d.members)) v.members = d.members;
  if (Array.isArray(d.socketIds)) v.socketIds = d.socketIds;
  if (node.type === 'group' && d.sockets) v.sockets = d.sockets;
  if (d.name != null) v.name = d.name;
  return v;
}

function register(registry) {
  registry.register(
    'get_workbench_model',
    '完整读取工作台当前画布：节点列表（id/type/label/status/x/y/goal/prompt/filePath/members/sockets）与连线列表（source→target）以及统计。' +
      'view=full（默认）返回全部节点与连线；view=groups 只看组节点；view=counts 只看统计。用于理解画布结构，定位节点 id 供其他工具使用。',
    {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'full/groups/counts，默认 full' },
      },
      required: [],
    },
    async (context, args) => {
      const model = context.model();
      if (!model) return AgentToolResult.error('当前没有可用的工作台模型');
      const view = String(args.view || 'full').trim().toLowerCase();
      const nodes = model.nodes();
      const edges = model.edges();
      const stats = model.stats();

      if (view === 'counts') {
        return AgentToolResult.ok(
          '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线',
          { ...stats, view }
        );
      }

      const shown = nodes.filter((n) => (view === 'groups' ? n.type === 'group' : true)).map(nodeValue);
      const data = { ...stats, view, nodes: shown };
      if (view === 'full') {
        data.edges = edges.map((e) => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle || '',
          target: e.target,
          targetHandle: e.targetHandle || '',
        }));
      }
      // 文本里直接给出节点/连线明细，模型无需重复读取
      const lines = [
        '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线（view=' + view + '）',
      ];
      for (const n of shown) {
        const extra = n.prompt ? ' · ' + String(n.prompt).slice(0, 80) : '';
        lines.push('- ' + n.id + ': ' + (n.label || n.type) + ' [' + (n.type || 'node') + '/' + (n.status || 'pending') + ']' + extra);
      }
      if (view === 'full' && data.edges && data.edges.length) {
        lines.push('连线:');
        for (const e of data.edges) {
          lines.push('  ' + e.source + ' → ' + e.target);
        }
      }
      return AgentToolResult.ok(lines.join('\n'), data);
    }
  );
}

module.exports = { register };
