/**
 * viewImageTool.cjs —— 让模型「看图」（对照 Codex 的 `view_image`）
 *
 * 短板（对照文档 §5 #7）：此前只有**用户**能发图（`electron/attachments.cjs` 的多模态输入），
 * 模型自己没法看项目里的图片 —— 截图、图表、UI 稿、验证用的渲染结果它都只能靠文件名猜。
 *
 * 语义：读一张项目内的图片，转成 data URL 交回主循环；主循环把它**作为一条 user 消息**附在
 * 工具结果之后（OpenAI 兼容接口只允许在 user 消息里带 image_url，tool 消息里带图会被部分供应商拒绝）。
 *
 * 约束（与用户附件同一套口径，避免两套上限）：
 *   - MIME 只认 png/jpeg/webp/gif；单张 ≤ 4MB（attachments.MAX_IMAGE_BYTES）；
 *   - 路径必须落在项目根内（`resolveInRoot`，越界直接拒）；
 *   - 只读、可缓存（同一 run 内同参重复读没必要重读磁盘）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { resolveInRoot } = require('./shared.cjs');
const attachments = require('../../attachments.cjs');

/** 扩展名 → MIME（只认视觉接口支持的四类） */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function register(registry) {
  registry.register(
    'view_image',
    '读取项目内的一张图片（png/jpeg/webp/gif，≤4MB）并把它附到对话里，让你真的「看到」它（截图/图表/UI 稿/渲染结果）。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的图片路径' },
        note: { type: 'string', description: '可选：为什么看这张图（会一起传给你）' },
      },
      required: ['path'],
    },
    async (context, args) => {
      const rel = String((args && args.path) || '').trim();
      if (!rel) return AgentToolResult.error('缺少 path');
      const root = context.projectRoot();
      const full = resolveInRoot(root, rel);
      if (!full) return AgentToolResult.error('路径越界或不可用：' + rel, { code: 'PATH_OUT_OF_ROOT', tool: 'view_image' });
      const mime = MIME_BY_EXT[path.extname(full).toLowerCase()];
      if (!mime) {
        return AgentToolResult.error('不是支持的图片格式（png/jpeg/webp/gif）：' + rel, { code: 'ARG_SCHEMA', tool: 'view_image' });
      }
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        return AgentToolResult.error('文件不存在：' + rel, { code: 'ARG_SEMANTIC', tool: 'view_image' });
      }
      if (!stat.isFile()) return AgentToolResult.error('不是文件：' + rel, { code: 'ARG_SEMANTIC', tool: 'view_image' });
      if (stat.size > attachments.MAX_IMAGE_BYTES) {
        return AgentToolResult.error(
          '图片过大（' + (stat.size / 1048576).toFixed(1) + 'MB，上限 ' + (attachments.MAX_IMAGE_BYTES / 1048576) + 'MB）：' + rel,
          { code: 'ARG_SCHEMA', tool: 'view_image' }
        );
      }
      let base64 = '';
      try {
        base64 = fs.readFileSync(full).toString('base64');
      } catch (error) {
        return AgentToolResult.error('读取失败：' + String((error && error.message) || error), { code: 'FATAL_FAILURE', tool: 'view_image' });
      }
      const note = String((args && args.note) || '').trim();
      if (typeof context.audit === 'function') context.audit('view_image ' + rel + ' (' + stat.size + 'B)');
      return AgentToolResult.ok(
        '已读取图片 ' + rel + '（' + (stat.size / 1024).toFixed(1) + 'KB，' + mime + '）—— 它已附在本条结果之后，请直接依据画面内容回答。' + (note ? '\n（说明：' + note + '）' : ''),
        {
          image: {
            path: rel,
            mime,
            bytes: stat.size,
            dataUrl: 'data:' + mime + ';base64,' + base64,
            note: note || null,
          },
        }
      );
    }
  );
}

module.exports = { register, MIME_BY_EXT };
