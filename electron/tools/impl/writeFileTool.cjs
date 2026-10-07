/**
 * write_file：将内容写入项目内文件。路径校验 + 写前确认（WRITE 级，默认放行并记录）+ 可选备份 + 审计。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot, checkExpectedHash, sha256OfFile, summarizeContentForConfirm } = require('./shared.cjs');
const { atomicWriteFile } = require('../../atomicFile.cjs');
const { fileChangeReview } = require('../fileChangeReview.cjs');
const editing = require('../../safeEditing.cjs');
const { config } = require('../../editingSettings.cjs');

function register(registry) {
  registry.register(
    'write_file',
    '将内容写入项目内文件。每次执行前请求用户确认（项目内默认放行并记录）；backup=true（默认）覆盖前自动备份 .bak。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        content: { type: 'string', description: '要写入的内容' },
        backup: { type: 'boolean', description: '覆盖前是否备份，默认 true' },
        expectedSha256: {
          type: 'string',
          description:
            '乐观并发（可选）：写入前校验文件当前内容哈希必须等于它（新文件用 "absent"）。' +
            '不匹配则**不写**并返回 CONFLICT_STALE —— 用于「并行 Agent 都改同一个文件」时避免静默覆盖。',
        },
      },
      required: ['path', 'content'],
    },
    async (context, args) => {
      const relative = String(args.path || '').trim();
      const content = String(args.content || '');
      if (!relative) return AgentToolResult.error('缺少 path');
      const root = path.resolve(context.projectRoot());
      const target = resolveInRoot(root, relative);
      if (!target) return AgentToolResult.error('路径越过项目边界');
      // 乐观并发：基于「我看到的那一版」写。校验放在**确认之前** —— 注定失败的写别去打扰用户。
      if (args.expectedSha256 != null && String(args.expectedSha256).trim()) {
        const guard = checkExpectedHash(target, args.expectedSha256);
        if (!guard.ok) {
          return AgentToolResult.failure(
            'CONFLICT_STALE',
            '写入前校验失败（' + guard.reason + '）：' + relative + '。先重新读回最新内容，基于它重做再写。',
            { path: relative, expected: String(args.expectedSha256), actual: guard.actual }
          );
        }
      }
      const existed = fs.existsSync(target);
      let initial;
      let syntax;
      try {
        initial = editing.snapshot(target);
        syntax = editing.validateCandidate(relative, initial.text, content, context.editingConfig ? context.editingConfig() : config.defaults, initial.existed);
      } catch (error) { return AgentToolResult.failure('ARG_SCHEMA', error.message, { path: relative, syntax: error.syntax }); }
      const what = '写入文件 ' + relative + (existed ? '（覆盖已有文件）' : '（新建文件）');
      // #10：确认框必须给出**内容摘要**（只给字节数等于让「确认」退化成无条件放行）
      const ok = await context.confirm(
        ConfirmationLevel.WRITE,
        what,
        '将 ' + content.length + ' 字节内容写入 ' + relative + '。\n' + summarizeContentForConfirm(content)
      );
      if (!ok) return AgentToolResult.error('已取消写入');
      const implicitGuard = checkExpectedHash(target, initial.sha256);
      if (!implicitGuard.ok) return AgentToolResult.failure('CONFLICT_STALE', '确认期间文件版本已变化，请重新读取', { path: relative, actual: implicitGuard.actual });
      // #9：确认框挂着的时候目标文件可能被外部改动（TOCTOU）。确认前那次校验只是「注定失败的写
      // 别打扰用户」，**关掉 TOCTOU 窗口的是这一次**：确认已过、写入之前再校验一遍，不一致就拒写。
      if (args.expectedSha256 != null && String(args.expectedSha256).trim()) {
        const recheck = checkExpectedHash(target, args.expectedSha256);
        if (!recheck.ok) {
          return AgentToolResult.failure(
            'CONFLICT_STALE',
            '确认期间文件已被改动（' + recheck.reason + '）：' + relative + '。已放弃写入，请重新读回最新内容，基于它重做再写。',
            { path: relative, expected: String(args.expectedSha256), actual: recheck.actual }
          );
        }
      }
      // 备份/新建的判定要在确认之后重算：确认期间文件可能刚被建出来或被删掉
      const existedNow = fs.existsSync(target);
      const backup = args.backup !== false;
      try {
        let beforeText = '';
        let reviewUnavailable = null;
        if (existedNow) {
          const size = fs.statSync(target).size;
          if (size > 2 * 1024 * 1024) reviewUnavailable = '原文件超过 2 MB，未生成内联差异';
          else {
            beforeText = fs.readFileSync(target, 'utf8');
            if (beforeText.includes('\0')) reviewUnavailable = '原文件不是纯文本，未生成内联差异';
          }
        }
        if (content.length > 2 * 1024 * 1024) reviewUnavailable = '写入内容超过 2 MB，未生成内联差异';
        const review = reviewUnavailable ? null : fileChangeReview(beforeText, content, existedNow);
        if (existedNow && backup) {
          fs.copyFileSync(target, target + '.bak');
        }
        if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
        atomicWriteFile(target, content, 'utf-8', { expectedSha256: initial.sha256 });
        context.audit('write_file ' + relative + ' bytes=' + content.length);
        context.notifyFileChange(relative, existedNow ? 'modify' : 'create', content.length + ' 字节');
        return AgentToolResult.ok('已写入 ' + relative + '（' + content.length + ' 字节）', {
          path: relative,
          bytes: content.length,
          review,
          reviewUnavailable,
          // 回传写入后的哈希：下一个写者可以拿它当 expectedSha256（乐观并发的交接棒）
          sha256: sha256OfFile(target),
          syntax,
        });
      } catch (e) {
        if (e.code === 'CONFLICT_STALE') return AgentToolResult.failure('CONFLICT_STALE', e.message, { path: relative });
        return AgentToolResult.error('写入失败：' + ((e && e.message) || e));
      }
    }
  );
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, ["write_file"]);
}

module.exports = { register };
