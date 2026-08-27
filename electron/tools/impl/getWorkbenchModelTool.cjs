/**
 * get_workbench_model：读取工作台当前画布——节点（id/type/label/status/x/y）与连线（source→target）。
 * view=full（默认）全部；view=counts 只看统计。
 *
 * 数据流：节点的完整属性（prompt/goal/members/filePath/role 等）以「本地标量」写入工程
 * .codenode/scalars.json，不随上下文返回云端；需要精确属性时用 query_scalars key=node:<id> 获取。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { nodeToScalarRecords } = require('../../scalars/index.cjs');

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
  if (d.objectName != null) v.objectName = d.objectName;
  if (d.parentId != null) v.parentId = d.parentId;
  if (Array.isArray(d.childIds) && d.childIds.length) v.childIds = d.childIds;
  return v;
}

function register(registry) {
  registry.register(
    'get_workbench_model',
    '读取工作台当前画布：节点列表（id/type/label/status/x/y）与连线列表（source→target）以及统计。' +
      'view=full（默认）返回全部节点与连线；view=counts 只看统计。用于理解画布结构，定位节点 id 供其他工具使用。' +
      '节点的完整属性（prompt/goal/members/filePath 等）不会随此结果返回，而是存入本地标量库；' +
      '需要某个节点的精确属性时调用 query_scalars key=node:<id>。',
    {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'full/counts，默认 full' },
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

      // 完整节点属性 → 本地标量（不返回云端上下文）
      const scalarRecords = [];
      for (const node of nodes) scalarRecords.push(...nodeToScalarRecords(node));
      const stored = context.storeScalars(scalarRecords);

      if (view === 'counts') {
        return AgentToolResult.ok(
          '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线',
          { ...stats, view }
        );
      }

      const shown = nodes.map(nodeValue);
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
      const lines = [
        '工作台共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线（view=' + view + '）',
        '节点完整属性已写入本地标量库（' + stored + ' 条）；需要精确 prompt/goal 时用 query_scalars key=node:<id>',
      ];
      for (const n of shown) {
        const members = Array.isArray(n.childIds) && n.childIds.length ? ' · childIds=' + n.childIds.join(',') : '';
        const parent = n.parentId ? ' · parent=' + n.parentId : '';
        lines.push('- ' + n.id + ': ' + (n.label || n.type) + ' [' + (n.type || 'node') + '/' + (n.status || 'pending') + '] @(' + n.x + ',' + n.y + ')' + members + parent);
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
