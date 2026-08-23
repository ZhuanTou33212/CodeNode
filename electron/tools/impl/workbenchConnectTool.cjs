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
      '若只给 targetId 则断开其全部入边；若只给 sourceId 则断开其全部出边。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'connect 或 disconnect' },
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String(args.action || '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const sourceId = String(args.sourceId || '').trim();
      const targetId = String(args.targetId || '').trim();
      const errors = [];
      const affected = [];
      try {
        await context.mutateWorkbench((model) => {
          switch (action) {
            case 'connect': {
              const source = model.byId(sourceId);
              const target = model.byId(targetId);
              if (!source) {
                errors.push('源节点不存在: ' + sourceId);
                break;
              }
              if (!target) {
                errors.push('目标节点不存在: ' + targetId);
                break;
              }
              const exists = model.edges().some(
                (e) => e.source === sourceId && e.target === targetId
              );
              if (exists) {
                errors.push('已存在 ' + sourceId + '→' + targetId + ' 连线');
                break;
              }
              model.connect(source, target);
              affected.push(sourceId + '→' + targetId);
              break;
            }
            case 'disconnect': {
              const toRemove = model.edges().filter((e) => {
                if (sourceId && targetId) return e.source === sourceId && e.target === targetId;
                if (targetId) return e.target === targetId;
                return e.source === sourceId;
              });
              model.removeEdges(toRemove);
              affected.push('断开 ' + toRemove.length + ' 条连线');
              break;
            }
            default:
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
