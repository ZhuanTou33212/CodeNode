/**
 * search_files：跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行号:内容。跳过构建/缓存/二进制。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { shouldSkipDir, isBinaryFileName } = require('../toolFiles.cjs');
const { globToRegExp, isSensitivePath, resolveInRoot, isCancelled } = require('./shared.cjs');
const fsRunner = require('../fsRunner.cjs');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1000;
const MAX_MODEL_OUTPUT_CHARS = 19500;
const MAX_MODEL_RESULT_CHARS = 1500;

function register(registry) {
  registry.register(
    'search_files',
    '跨项目文件按正则搜索内容（UTF-8 文本），返回 文件:行号:内容。path 限定子目录，filePattern 限定文件 glob，' +
      'caseSensitive 默认 false。超过 maxResults 时截断，可用 offset 分页。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '项目内子目录，缺省整个项目' },
        filePattern: { type: 'string', description: '限定文件的 glob，如 *.java' },
        maxResults: { type: 'integer', description: '最多返回条数，默认 100，单次最多 1000；较多结果用 offset 分页' },
        offset: { type: 'integer', description: '跳过前 N 条结果，用于分页，默认 0' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      },
      required: ['pattern'],
    },
    async (context, args) => {
      const patternText = String(args.pattern || '').trim();
      if (!patternText) return AgentToolResult.error('缺少 pattern');
      const max = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
        ? Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(args.maxResults)))
        : DEFAULT_MAX_RESULTS;
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const caseSensitive = args.caseSensitive === true;
      const root = path.resolve(context.projectRoot());
      const subDir = String(args.path || '').trim();
      const start = resolveInRoot(root, subDir || '.');
      if (!start) return AgentToolResult.error('路径越过项目边界');
      if (start !== root && !start.startsWith(root + path.sep)) return AgentToolResult.error('路径越过项目边界');
      if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return AgentToolResult.error('目录不存在：' + (subDir || '.'));
      let regex;
      try {
        regex = new RegExp(patternText, caseSensitive ? '' : 'i');
      } catch (e) {
        return AgentToolResult.error('无效正则：' + ((e && e.message) || e));
      }
      const filePattern = String(args.filePattern || '').trim();
      let fileRegex = null;
      if (filePattern) {
        try {
          fileRegex = globToRegExp(filePattern);
        } catch {
          return AgentToolResult.error('无效 filePattern：' + filePattern);
        }
      }
      // P7 收口：内容搜索（遍历 + 逐文件读取 + 匹配）整体放进 worker 线程，
      // 理由同 find_files：同步遍历会冻住主进程，且单次 readFileSync 不可中断。
      const outcome = await fsRunner.runFsTask(
        'searchFiles',
        {
          root,
          start,
          pattern: patternText,
          caseSensitive,
          filePattern,
          // 多收一条哨兵结果，才能可靠判断刚好满一页时后面是否还有内容。
          maxCollect: offset + max + 1,
          maxFileBytes: MAX_FILE_BYTES,
          shouldStop: () => isCancelled(context),
        },
        { enabled: fsRunner.fsWorkerEnabled(context), signal: context.signal && context.signal() },
      );
      if (outcome.cancelled || outcome.timedOut) {
        return AgentToolResult.failure('CANCELLED', '搜索已取消（用户停止），结果不完整（已找到 ' + outcome.progress + ' 处匹配）。', {
          cancelled: true,
          partial: outcome.progress,
        });
      }
      if (outcome.mode === 'sync-fallback') {
        context.audit('search_files worker 不可用，已退回主线程同步执行：' + outcome.fallbackReason);
      }
      const matches = outcome.result.matches;
      const total = matches.length;
      if (total === 0) return AgentToolResult.ok('未找到匹配内容', { count: 0, offset: 0 });
      const page = matches.slice(offset, offset + max);
      if (page.length === 0) {
        return AgentToolResult.ok('找到 ' + total + ' 处匹配，但 offset=' + offset + ' 超出范围（共 ' + total + ' 条）', { count: total, offset });
      }
      const visiblePage = [];
      let visibleChars = 0;
      for (const match of page) {
        let visible = String(match);
        if (visible.length > MAX_MODEL_RESULT_CHARS) {
          visible = visible.slice(0, MAX_MODEL_RESULT_CHARS) + '…（匹配行已截断）';
        }
        if (visibleChars + visible.length + 1 > MAX_MODEL_OUTPUT_CHARS && visiblePage.length) break;
        if (visible.length > MAX_MODEL_OUTPUT_CHARS) visible = visible.slice(0, MAX_MODEL_OUTPUT_CHARS) + '…';
        visiblePage.push(visible);
        visibleChars += visible.length + 1;
      }
      const nextOffset = offset + visiblePage.length;
      const truncated = total > nextOffset;
      const shownRange = (offset + 1) + '-' + nextOffset;
      // A1（审计 §4 P0-2）：匹配列表只发一份，并给模型可见输出设硬上限。
      const text =
        (truncated ? '已找到至少 ' : '找到 ') + total + ' 处匹配' +
        (truncated ? '，显示第 ' + shownRange + ' 条（用 offset=' + nextOffset + ' 继续）：' : '：') +
        '\n' + visiblePage.join('\n');
      return AgentToolResult.ok(text, { count: total, offset, nextOffset, matches: page,
        sourceVersions: outcome.result.sourceVersions || {} }, { modelContent: text });
    }
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ["search_files"]);
}

module.exports = { register };
