/**
 * create_nodes：在工作台当前画布创建节点。count 默认 1（最多 50）；name 为名称（数量>1 自动编号）；
 * type 支持任务节点语义（task/stage/tool/start/end/file/scope/object/canvas），agent/user 已废弃（传入回退为 task）。
 * file 类型需 relativePath；canvas（=vector）创建内嵌矢量画布的画布节点；connect=true 时按创建顺序串联成链。返回节点 id 列表。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { accentForType } = require('./shared.cjs');

const MAX_COUNT = 50;

const KIND_TO_TYPE = {
  regular: 'task',
  calculation: 'task',
  condition: 'task',
  capture: 'task',
  asset: 'file',
  file: 'file',
  task: 'task',
  stage: 'stage',
  tool: 'tool',
  start: 'start',
  end: 'end',
  scope: 'scope',
  object: 'object',
  canvas: 'vector',
  vector: 'vector',
};

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function register(registry) {
  registry.register(
    'create_nodes',
    '在工作台当前画布创建节点。count 指定数量（默认1，最多50）；name 为名称（数量>1 时自动编号如 名1/名2）；' +
      'type 支持 task/stage/tool/start/end/file/scope/object/canvas（start 只有输出端口、end 只有输入端口；object 需 objectName；' +
      'canvas（别名 vector）创建一个内嵌矢量画布的画布节点，可在节点里用预设配件自由绘制并切换 设计/逻辑 模式；已废弃的 agent/user 传入回退为 task）；file 类型需 relativePath；' +
      'prompt 为节点职责说明；connect=true 时按创建顺序串联成链。创建后返回节点 id 列表。',
    {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '节点数量，默认 1，最多 50' },
        name: { type: 'string', description: '节点名称或前缀' },
        type: { type: 'string', description: 'task/stage/tool/start/end/file/scope/object/canvas（agent/user 已废弃，传入回退为 task）' },
        nodeKind: { type: 'string', description: '兼容旧版：regular/calculation/condition/capture/file/asset' },
        prompt: { type: 'string', description: '节点职责说明' },
        objectName: { type: 'string', description: 'object 类型节点的对象名称' },
        relativePath: { type: 'string', description: 'file 节点的项目内相对路径' },
        connect: { type: 'boolean', description: '是否按顺序串联，默认 false' },
      },
      required: [],
    },
    async (context, args) => {
      let n = 1;
      if (typeof args.count === 'number' && Number.isFinite(args.count)) {
        n = Math.max(1, Math.min(MAX_COUNT, Math.floor(args.count)));
      }
      const count = n;
      const baseName = stringArg(args, 'name', '节点');
      const prompt = stringArg(args, 'prompt', '说明这个节点应完成的工作');
      const kind = (stringArg(args, 'nodeKind', '') || stringArg(args, 'type', 'task')).toLowerCase();
      const type = KIND_TO_TYPE[kind] || 'task';
      const relativePath = stringArg(args, 'relativePath', '');
      const objectName = stringArg(args, 'objectName', '');
      const connect = args.connect === true;

      const ids = [];
      let applied = false;
      try {
        applied = await context.mutateWorkbench((model) => {
          const created = [];
          // 自动错位：未显式指定时从画布最大右缘继续，避免全部堆在 (120,120)
          let baseX = 120;
          for (const n of model.nodes()) {
            const w = (n.measured && n.measured.width) || (n.data && n.data.width) || 170;
            baseX = Math.max(baseX, Math.round((n.position && n.position.x) + w) + 80);
          }
          const baseY = 120;
          for (let i = 0; i < count; i++) {
            const nodeName = count === 1 ? baseName : baseName + (i + 1);
            const data = { label: nodeName, status: 'pending', prompt, accent: accentForType(type) };
            if (type === 'file') data.filePath = relativePath || nodeName;
            if (type === 'object') data.objectName = objectName || nodeName;
            if (type === 'vector') {
              // 画布节点：内嵌矢量画布，尺寸/模式与前端新节点保持一致
              data.width = 1040;
              data.height = 640;
              data.mode = 'design';
              data.dockOpen = true;
              data.accent = '#22d3ee';
            }
            if (type === 'scope') {
              data.width = 320;
              data.height = 200;
              data.fill = '#3b2f6b';
              data.opacity = 0.16;
              data.accent = '#8b5cf6';
            }
            const node = model.addNode(type, data, baseX, baseY + i * 110);
            created.push(node);
            ids.push(node.id);
          }
          if (connect && created.length >= 2) {
            for (let i = 0; i + 1 < created.length; i++) {
              model.connect(created[i], created[i + 1]);
            }
          }
        });
      } catch (e) {
        return AgentToolResult.error('创建节点失败：' + ((e && e.message) || e));
      }
      if (!applied || ids.length === 0) {
        return AgentToolResult.error('没有创建任何节点（工作台不可用）');
      }
      context.audit('create_nodes count=' + count + ' name=' + baseName + ' type=' + type + ' connect=' + connect);
      return AgentToolResult.ok('已创建 ' + ids.length + ' 个节点：' + ids.join(', '), { nodeIds: ids, count: ids.length });
    }
  );
}

module.exports = { register };
