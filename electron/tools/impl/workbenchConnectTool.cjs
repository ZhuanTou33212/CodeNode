/**
 * workbench_connect：节点连线操作。action=connect（sourceId→targetId）或
 * action=disconnect（断开 sourceId→targetId；只给 targetId 则断开其全部入边）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  registry.register(
    'workbench_connect',
    '节点连线。action=connect：sourceId → targetId 建立连线；action=disconnect：断开 sourceId→targetId 之间连线；' +
      '若只给 targetId 则断开其全部入边；若只给 sourceId 则断开其全部出边。' +
      '支持批量：connections=[{sourceId,targetId}] 一次建立多条连线。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'connect 或 disconnect' },
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        connections: {
          type: 'array',
          items: { type: 'object', properties: { sourceId: { type: 'string' }, targetId: { type: 'string' } } },
          description: '批量连线：[{sourceId, targetId}]',
        },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String(args.action || '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const sourceId = String(args.sourceId || '').trim();
      const targetId = String(args.targetId || '').trim();
      const batch = Array.isArray(args.connections) ? args.connections : null;
      const errors = [];
      const affected = [];
      try {
        await context.mutateWorkbench((model) => {
          if (action === 'connect') {
            const pairs = batch && batch.length
              ? batch
                  .filter((p) => p && typeof p === 'object' && p.sourceId && p.targetId)
                  .map((p) => ({ sourceId: String(p.sourceId), targetId: String(p.targetId) }))
              : sourceId && targetId
                ? [{ sourceId, targetId }]
                : [];
            if (pairs.length === 0) {
              errors.push('缺少 sourceId/targetId 或 connections');
              return;
            }
            for (const p of pairs) {
              const source = model.byId(p.sourceId);
              const target = model.byId(p.targetId);
              if (!source) {
                errors.push('源节点不存在: ' + p.sourceId);
                continue;
              }
              if (!target) {
                errors.push('目标节点不存在: ' + p.targetId);
                continue;
              }
              const exists = model.edges().some((e) => e.source === p.sourceId && e.target === p.targetId);
              if (exists) {
                errors.push('已存在 ' + p.sourceId + '→' + p.targetId + ' 连线');
                continue;
              }
              model.connect(source, target);
              affected.push(p.sourceId + '→' + p.targetId);
            }
          } else if (action === 'disconnect') {
            const toRemove = model.edges().filter((e) => {
              if (sourceId && targetId) return e.source === sourceId && e.target === targetId;
              if (targetId) return e.target === targetId;
              return e.source === sourceId;
            });
            model.removeEdges(toRemove);
            affected.push('断开 ' + toRemove.length + ' 条连线');
          } else {
            errors.push('未知 action: ' + action);
          }
        });
      } catch (e) {
        return AgentToolResult.error('workbench_connect 执行失败：' + ((e && e.message) || e));
      }
      if (errors.length) return AgentToolResult.error(errors.join('；'));
      return AgentToolResult.ok(affected.join(', ') || '操作完成：' + action, { action });
    }
  );
}

module.exports = { register };
