/**
 * write_analysis_md：把项目分析结果写成 Markdown 分析节点（file 节点 + 磁盘文件）。
 * content 缺省时自动从当前画布生成项目架构 markdown。返回节点 id。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot } = require('./shared.cjs');

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function generateArchitecture(model) {
  if (!model) return '';
  const lines = [];
  lines.push('# 项目架构');
  lines.push('');
  const stats = model.stats();
  lines.push('> 画布共 ' + stats.nodeCount + ' 个节点、' + stats.edgeCount + ' 条连线。');
  lines.push('');
  for (const n of model.nodes()) {
    const d = n.data || {};
    lines.push('- **[' + (n.type || 'node') + '] ' + (d.label || n.id) + '**（' + (d.status || 'pending') + '）');
    if (d.goal) lines.push('  - 目标：' + d.goal);
    if (d.prompt) lines.push('  - 说明：' + d.prompt);
    if (d.filePath) lines.push('  - 文件：' + d.filePath);
  }
  return lines.join('\n');
}

function register(registry) {
  registry.register(
    'write_analysis_md',
    '把项目分析结果写成 Markdown 分析节点（file 节点 + 磁盘 analysis/ 目录文件）。content 缺省时自动从画布生成项目架构；' +
      'name 为节点名称（默认「项目分析」）；relativePath 为文件路径（默认 analysis/<时间戳>.md）。返回节点 id。',
    {
      type: 'object',
      properties: {
        content: { type: 'string', description: '分析内容（markdown），缺省自动生成项目架构' },
        name: { type: 'string', description: '节点名称，默认「项目分析」' },
        relativePath: { type: 'string', description: '文件相对路径，默认 analysis/<时间戳>.md' },
        regenerate: { type: 'boolean', description: '缺省 content 时是否重新从画布生成架构，默认 true' },
      },
      required: [],
    },
    async (context, args) => {
      const name = stringArg(args, 'name', '项目分析');
      let content = stringArg(args, 'content', '');
      if (!content) {
        const regenerate = args.regenerate !== false;
        if (regenerate) {
          const model = context.model();
          if (!model) return AgentToolResult.error('当前没有可用的工作台模型');
          content = generateArchitecture(model);
        }
      }
      if (!content.trim()) return AgentToolResult.error('没有可写入的分析内容（content 为空且无法自动生成架构）');
      const relativePath = stringArg(args, 'relativePath', 'analysis/' + Date.now() + '.md');

      const what = '写入分析文档 ' + relativePath + '（' + content.length + ' 字符）并创建文件节点';
      const ok = await context.confirm(ConfirmationLevel.WRITE, what, '将分析内容写入 ' + relativePath + '，并在画布创建引用该文件的节点。');
      if (!ok) return AgentToolResult.error('已取消写入');

      const root = path.resolve(context.projectRoot());
      const target = resolveInRoot(root, relativePath);
      if (!target) return AgentToolResult.error('路径越过项目边界');
      try {
        if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf-8');
      } catch (e) {
        return AgentToolResult.error('写入失败：' + ((e && e.message) || e));
      }

      let nodeId = '';
      await context.mutateWorkbench((model) => {
        const node = model.addNode('file', {
          label: name,
          status: 'pending',
          filePath: relativePath,
          prompt: '分析文档：' + relativePath,
          accent: '#f97316',
        }, 120, 120);
        nodeId = node.id;
      });
      if (!nodeId) return AgentToolResult.error('没有创建分析节点（工作台不可用）');
      context.audit('write_analysis_md name=' + name + ' path=' + relativePath + ' chars=' + content.length);
      return AgentToolResult.ok('已写入分析节点 ' + name + '（' + content.length + ' 字符）→ ' + nodeId, {
        nodeId,
        name,
        relativePath,
        chars: content.length,
        preview: content.length > 400 ? content.slice(0, 400) + '…' : content,
      });
    }
  );
}

module.exports = { register };
