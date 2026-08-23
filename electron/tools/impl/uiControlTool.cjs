/**
 * ui_control：操控 CodeNode 软件本体界面。action 支持：
 * view_all（查看全部节点）、focus（聚焦 nodeId）、zoom（zoom 倍率）、pan（x,y 平移）、
 * resize（width,height 窗口尺寸）、toggle_panel（panel=inspector）、new_content（x,y 创建 name 节点）。
 * 所有 action 必须由渲染进程接线后生效，否则返回未接线。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  registry.register(
    'ui_control',
    '操控 CodeNode 软件本体界面。action 支持：view_all（查看全部节点）、focus（聚焦 nodeId 节点）、' +
      'zoom（按 zoom 倍率缩放画布 0.25~2.5）、pan（按 x,y 平移画布）、resize（调整窗口 width,height）、' +
      'toggle_panel（切换面板显隐，panel=inspector）、new_content（在画布 x,y 创建 name 节点）。' +
      '所有 action 必须在调用方提供 UiAction 时生效，否则返回未接线。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'view_all/focus/zoom/pan/resize/toggle_panel/new_content' },
        nodeId: { type: 'string', description: 'focus 目标节点' },
        x: { type: 'integer', description: 'pan/new_content 的 x' },
        y: { type: 'integer', description: 'pan/new_content 的 y' },
        zoom: { type: 'number', description: '缩放倍率 0.25~2.5' },
        width: { type: 'integer', description: 'resize 宽度' },
        height: { type: 'integer', description: 'resize 高度' },
        name: { type: 'string', description: 'new_content 节点名称' },
        panel: { type: 'string', description: 'toggle_panel 目标面板：inspector' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String(args.action || '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const applied = await context.ui(action, args);
      const data = { action, applied };
      if (!applied) return AgentToolResult.error('ui_control 未接线（当前上下文不支持 ' + action + '）', data);
      context.audit('ui_control action=' + action);
      return AgentToolResult.ok('已执行界面操控：' + action, data);
    }
  );
}

module.exports = { register };
