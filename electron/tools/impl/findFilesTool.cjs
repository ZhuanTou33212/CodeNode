/**
 * find_files：按 glob 模式在项目内查找文件（跳过构建/缓存目录）。返回相对路径列表。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir } = require('../toolFiles.cjs');
const { globToRegExp, isCancelled } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1000;
const MAX_MODEL_OUTPUT_CHARS = 19500;

function register(registry) {
  registry.register(
    'find_files',
    '按 glob 模式在项目内查找文件，如 **/*.java、src/**.ts。返回相对路径列表。跳过构建/缓存目录。' +
      '超过 maxResults 时截断，可用 offset 分页。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.java' },
        maxResults: { type: 'integer', description: '最多返回条数，默认 100，单次最多 1000；较多结果用 offset 分页' },
        offset: { type: 'integer', description: '跳过前 N 条结果，用于分页，默认 0' },
      },
      required: ['pattern'],
    },
    async (context, args) => {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) return AgentToolResult.error('缺少 pattern');
      const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(args.maxResults)))
        : DEFAULT_MAX_RESULTS;
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const root = path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在：' + root);
      try {
        // 主线程先校验一次模式：worker 内抛错只会变成「任务失败」，提示不如这里清楚
        globToRegExp(pattern);
      } catch (e) {
        return AgentToolResult.error('无效的 glob 模式：' + pattern);
      }
      // P7 收口：遍历放进 worker 线程 —— 同步遍历会冻住 Electron 主进程，且单次同步 fs
      // 调用（statSync 撞上挂住的网络盘）不可中断；terminate 才能真正杀掉它。
      // worker 不可用时 fsRunner 显式降级到主线程同步执行，下面是 audit 留痕。
      const outcome = await fsRunner.runFsTask(
        'findFiles',
        // 多收一条哨兵结果，确保整页刚好填满时也能提示用户继续分页。
        { root, pattern, limit: offset + max + 1, shouldStop: () => isCancelled(context) },
        { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
      );
      if (outcome.cancelled || outcome.timedOut) {
        return AgentToolResult.failure('CANCELLED', '查找已取消（用户停止），结果不完整（已找到 ' + outcome.progress + ' 个文件）。', {
          cancelled: true,
          partial: outcome.progress,
        });
      }
      if (outcome.mode === 'sync-fallback') {
        context.audit('find_files worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
      }
      const found = outcome.result.files;
      const total = found.length;
      if (total === 0) return AgentToolResult.ok('未找到匹配文件', { count: 0, offset: 0, files: [] });
      const page = found.slice(offset, offset + max);
      if (page.length === 0) {
        return AgentToolResult.ok('找到 ' + total + ' 个文件，但 offset=' + offset + ' 超出范围（共 ' + total + ' 条）', { count: total, offset, files: [] });
      }
      const visiblePage = [];
      let visibleChars = 0;
      for (const file of page) {
        let visible = String(file);
        if (visible.length > MAX_MODEL_OUTPUT_CHARS - 200) {
          visible = visible.slice(0, MAX_MODEL_OUTPUT_CHARS - 240) + '…（路径过长，未完整显示）';
        }
        if (visibleChars + visible.length + 1 > MAX_MODEL_OUTPUT_CHARS && visiblePage.length) break;
        visiblePage.push(visible);
        visibleChars += visible.length + 1;
      }
      const nextOffset = offset + visiblePage.length;
      const truncated = total > nextOffset;
      const shownRange = (offset + 1) + '-' + nextOffset;
      // A1（审计 §4 P0-2）：文件列表**只发一份** —— 下面这段文本里已经是完整列表 + 分页游标，
      // 而 data.files 是同一条列表。旧口径把它俩都发给模型（结果发两遍，LLM 压缩再为重复付一次费）。
      // data 照旧交给 UI / 审计 / 回放，只是不再自动追加给模型。
      const text =
        (truncated ? '已找到至少 ' : '找到 ') + total +
        (truncated ? ' 个文件，显示第 ' + shownRange + ' 条（用 offset=' + nextOffset + ' 继续）：' : ' 个文件：') +
        '\n' + visiblePage.join('\n');
      return AgentToolResult.ok(text, { count: total, offset, nextOffset, files: page }, { modelContent: text });
    }
  );
}

module.exports = { register };
