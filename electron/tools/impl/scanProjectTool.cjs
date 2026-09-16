/**
 * scan_project：全量扫描项目根目录（源码+资产，忽略缓存/构建目录），返回统计与目录树。
 * applyToWorkbench=true 时把目录层级写成画布节点（文件夹→scope、文件→task，最多 200 节点）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot, isCancelled } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');

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
      const root = resolveInRoot(context.projectRoot(), rawPath || '.');
      if (!root) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('目录不存在：' + root);
      try {
        // P7 收口：整个遍历（含逐个读文件算行数）放到 **worker 线程**里跑 ——
        //   ① `worker.terminate()` 能真的杀掉一次同步 fs 调用（旧实现只能等它自己跑完）；
        //   ② Electron 主进程的事件循环不再被遍历冻住（界面保持可响应）。
        // worker 不可用时 fsRunner 会显式降级到主线程同步执行并把原因带回来（下面 audit + 留痕）。
        const outcome = await fsRunner.runFsTask(
          'scanProject',
          { root, shouldStop: () => isCancelled(context) },
          { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
        );
        // 取消/超时：如实报告「结果不完整」，不要拿半份扫描当完整结果交付
        if (outcome.cancelled || outcome.timedOut) {
          return AgentToolResult.failure('CANCELLED', '扫描已取消（用户停止），结果不完整（已扫描 ' + outcome.progress + ' 个文件）。', {
            cancelled: true,
            partial: outcome.progress,
            root,
          });
        }
        const result = outcome.result;
        if (outcome.mode === 'sync-fallback') {
          context.audit('scan_project worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
        }
        /** @type {Record<string, any>} */
        const data = {
          root,
          workerMode: outcome.mode,
          ...(outcome.mode === 'sync-fallback' ? { workerFallback: outcome.fallbackReason } : {}),
          sourceFiles: result.sourceFiles.length,
          assetFiles: result.assetFiles.length,
          fileCount: result.files.length,
          languageSummary: {},
        };
        for (const f of result.sourceFiles) {
          data.languageSummary[f.language] = (data.languageSummary[f.language] || 0) + 1;
        }
        data.tree = buildTree(result.files, root);

        let applied = false;
        if (args.applyToWorkbench === true) {
          applied =
            (await context.mutateWorkbench((model) => {
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
            })) === true;
          context.audit('scan_project applyToWorkbench root=' + root + ' applied=' + applied);
          // 如实记录是否真的写进画布：只读上下文（如 explorer 子代理）里 mutateWorkbench 返回 false，
          // 此前这里仍然写 appliedToWorkbench=true 并回报「已写入工作台」—— 模型据此认为目录树已建好，
          // 是典型的谎报（S9 实测）。现在按真实结果记录，并在下面显式失败。
          data.appliedToWorkbench = applied;
        }
        const summary =
          '扫描完成：源码=' + data.sourceFiles + ' 资产=' + data.assetFiles + ' 文件总数=' + data.fileCount;
        if (args.applyToWorkbench === true && applied !== true) {
          return AgentToolResult.error(
            summary + '。画布未写入：当前上下文不允许修改工作台（只读子代理或无画布 mutator）。' +
              '目录树已在上方结果中返回；请勿用相同参数重试，若确需把目录树落到画布，由主代理（非只读角色）执行。',
            // 走到这里说明 applied !== true：画布确实没被写入，如实报 false（不谎报）
            { code: 'WORKBENCH_WRITE_DENIED', tool: 'scan_project', userActionRequired: false, appliedToWorkbench: false, tree: data.tree }
          );
        }
        return AgentToolResult.ok(summary + (data.appliedToWorkbench ? '（已写入工作台）' : ''), data);
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
