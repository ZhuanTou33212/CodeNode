/**
 * workbench_edit：工作台节点编辑（泛化参数化）。action 支持：
 * rename / move / set_prompt / set_category(→label) / set_status / set_collapsed / set_muted /
 * delete / duplicate / undo / redo / add_goal / set_color。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function stringValue(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  return String(v);
}

function intArg(args, key, fallback) {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.floor(args[key]) : fallback;
}

function nodeIds(args) {
  const ids = [];
  const single = args.nodeId;
  if (single != null && String(single).trim() !== '') ids.push(String(single));
  if (Array.isArray(args.nodeIds)) {
    for (const item of args.nodeIds) {
      if (item != null && String(item).trim() !== '') ids.push(String(item));
    }
  }
  return ids;
}

function register(registry) {
  registry.register(
    'workbench_edit',
    '编辑工作台节点。action：rename(nodeId,name)、move(nodeId,x,y)、set_prompt(nodeId,value)、' +
      'set_category(nodeId,value)、set_status(nodeId,value: pending/running/done/failed/blocked)、' +
      'set_collapsed(nodeId,value true/false)、set_muted(nodeId,value)、add_goal(nodeId,value)、' +
      'delete(nodeId 或 nodeIds)、duplicate(nodeId[,offsetX,offsetY])、undo、redo。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: '要执行的操作' },
        nodeId: { type: 'string', description: '目标节点 id' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '批量目标节点 id' },
        name: { type: 'string' },
        value: { type: 'string', description: 'set_* 操作的新值' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        offsetX: { type: 'integer', description: 'duplicate 偏移，默认 40' },
        offsetY: { type: 'integer', description: 'duplicate 偏移，默认 40' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = stringValue(args, 'action', '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const errors = [];
      const affected = [];
      let applied = false;
      try {
        applied = await context.mutateWorkbench((model) => {
          const requireNode = () => {
            const node = model.byId(String(args.nodeId || ''));
            if (!node) errors.push('节点不存在: ' + (args.nodeId || ''));
            return node;
          };
          switch (action) {
            case 'undo':
              context.undo && context.undo();
              break;
            case 'redo':
              context.redo && context.redo();
              break;
            case 'rename': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.label = stringValue(args, 'name', node.data.label);
              affected.push(node.id);
              break;
            }
            case 'move': {
              const node = requireNode();
              if (!node) break;
              node.position = {
                x: intArg(args, 'x', node.position.x),
                y: intArg(args, 'y', node.position.y),
              };
              affected.push(node.id);
              break;
            }
            case 'set_prompt': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.prompt = stringValue(args, 'value', '');
              affected.push(node.id);
              break;
            }
            case 'set_category': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.category = stringValue(args, 'value', '');
              affected.push(node.id);
              break;
            }
            case 'add_goal': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.goal = stringValue(args, 'value', '');
              affected.push(node.id);
              break;
            }
            case 'set_status': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              const status = stringValue(args, 'value', 'pending').toLowerCase();
              const allowed = ['pending', 'running', 'done', 'failed', 'blocked'];
              if (!allowed.includes(status)) {
                errors.push('未知状态: ' + status);
                break;
              }
              node.data.status = status;
              affected.push(node.id);
              break;
            }
            case 'set_collapsed': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.collapsed = stringValue(args, 'value', 'false') === 'true';
              affected.push(node.id);
              break;
            }
            case 'set_muted': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.muted = stringValue(args, 'value', 'false') === 'true';
              affected.push(node.id);
              break;
            }
            case 'set_color': {
              const node = requireNode();
              if (!node) break;
              node.data = node.data || {};
              node.data.accent = stringValue(args, 'value', '');
              affected.push(node.id);
              break;
            }
            case 'delete': {
              const ids = nodeIds(args);
              if (ids.length === 0) {
                errors.push('缺少要删除的 nodeId');
                break;
              }
              for (const id of ids) {
                const node = model.byId(id);
                if (!node) {
                  errors.push('节点不存在: ' + id);
                  continue;
                }
                model.removeNode(node);
                affected.push(id);
              }
              break;
            }
            case 'duplicate': {
              const node = requireNode();
              if (!node) break;
              const ox = intArg(args, 'offsetX', 40);
              const oy = intArg(args, 'offsetY', 40);
              const copy = model.duplicate(node, node.position.x + ox, node.position.y + oy);
              affected.push(copy.id);
              break;
            }
            default:
              errors.push('未知 action: ' + action);
          }
        });
      } catch (e) {
        return AgentToolResult.error('workbench_edit 执行失败：' + ((e && e.message) || e));
      }
      void applied;
      if (errors.length) return AgentToolResult.error(errors.join('；'));
      if (affected.length === 0) return AgentToolResult.ok('操作完成：' + action);
      return AgentToolResult.ok('已执行 ' + action + '，节点: ' + affected.join(', '), { action, nodeIds: affected });
    }
  );
}

module.exports = { register };
