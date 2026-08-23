/**
 * scan_project：全量扫描项目根目录（源码+资产，忽略缓存/构建目录），返回统计与目录树。
 * applyToWorkbench=true 时把目录层级写成画布节点（文件夹→scope、文件→task，最多 200 节点）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { scan } = require('../projectScan.cjs');

const MAX_WORKBENCH_NODES = 200;

function buildTree(files, root) {
  const tree = { name: '/', dirs: {}, files: [] };
  for (const f of files) {
    const parts = f.relPath.split('/');
    let cur = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur.dirs[parts[i]] || (cur.dirs[parts[i]] = { name: parts[i], dirs: {}, files: [] });
    }
    cur.files.push(parts[parts.length - 1]);
  }
  const lines = [];
  const render = (node, prefix) => {
    const dirNames = Object.keys(node.dirs).sort();
    const files = node.files.sort();
    for (const name of dirNames) {
      lines.push(prefix + name + '/');
      render(node.dirs[name], prefix + '  ');
    }
    for (const name of files) lines.push(prefix + name);
  };
  render(tree, '');
  return lines;
}

function register(registry) {
  registry.register(
    'scan_project',
    '全量扫描项目根目录（源码+资产，忽略缓存/构建目录）并返回统计（源码数/资产数/语言分布）与目录树。' +
      'applyToWorkbench=true 时把目录层级写入当前画布（文件夹→scope、文件→task，最多 200 节点），默认 false。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录，缺省用当前项目目录' },
        applyToWorkbench: { type: 'boolean', description: '是否把生成的目录层级写入工作台，默认 false' },
        maxDepth: { type: 'integer', description: '目录树最大深度，默认 8' },
      },
      required: [],
    },
    async (context, args) => {
      const rawPath = String(args.path || '').trim();
      const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('目录不存在：' + root);
      try {
        const result = scan(root);
        const data = {
          root,
          sourceFiles: result.sourceFiles.length,
          assetFiles: result.assetFiles.length,
          fileCount: result.files.length,
          languageSummary: {},
        };
        for (const f of result.sourceFiles) {
          data.languageSummary[f.language] = (data.languageSummary[f.language] || 0) + 1;
        }
        data.tree = buildTree(result.files, root).slice(0, 400);

        let applied = false;
        if (args.applyToWorkbench === true) {
          applied = await context.mutateWorkbench((model) => {
            const parts = [];
            for (const f of result.files.slice(0, MAX_WORKBENCH_NODES)) {
              const segs = f.relPath.split('/');
              for (let i = 0; i < segs.length; i++) {
                parts.push(segs.slice(0, i + 1).join('/'));
              }
            }
            const unique = [...new Set(parts)];
            const byPath = new Map();
            let count = 0;
            const baseX = 40;
            const baseY = 40;
            for (const p of unique.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
              if (count >= MAX_WORKBENCH_NODES) break;
              const isFile = result.files.some((f) => f.relPath === p);
              const name = p.split('/').pop();
              const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
              const node = model.addNode(
                isFile ? 'task' : 'scope',
                isFile
                  ? { label: name, status: 'pending', filePath: p, prompt: fPrompt(result, p) }
                  : { label: name, status: 'pending', width: 200, height: 60, fill: '#3b2f6b', opacity: 0.16, accent: '#8b5cf6' },
                baseX,
                baseY + count * 40
              );
              byPath.set(p, node.id);
              count++;
              if (parent && byPath.has(parent)) {
                model.addEdge(byPath.get(parent), node.id);
              }
            }
          });
          context.audit('scan_project applyToWorkbench root=' + root);
          data.appliedToWorkbench = true;
        }
        void applied;
        return AgentToolResult.ok(
          '扫描完成：源码=' + data.sourceFiles + ' 资产=' + data.assetFiles + ' 文件总数=' + data.fileCount +
            (data.appliedToWorkbench ? '（已写入工作台）' : ''),
          data
        );
      } catch (e) {
        return AgentToolResult.error('扫描失败：' + ((e && e.message) || e));
      }
    }
  );
}

function fPrompt(result, relPath) {
  const f = result.files.find((x) => x.relPath === relPath);
  return f ? '文件: ' + relPath + (f.lineCount ? '（' + f.lineCount + ' 行）' : '') : '';
}

module.exports = { register };
