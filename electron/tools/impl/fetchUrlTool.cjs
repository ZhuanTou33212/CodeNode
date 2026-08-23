/**
 * fetch_url：抓取指定 URL 的文本内容（仅 http/https），maxChars 截断。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  registry.register(
    'fetch_url',
    '抓取指定 URL 的文本内容（仅 http/https）。maxChars 截断返回长度（默认 5000）。',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL' },
        maxChars: { type: 'integer', description: '最多返回字符数，默认 5000' },
      },
      required: ['url'],
    },
    async (_context, args) => {
      const url = String(args.url || '').trim();
      if (!url) return AgentToolResult.error('缺少 url');
      if (!/^https?:\/\//i.test(url)) return AgentToolResult.error('仅支持 http/https');
      const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? Math.max(100, Math.floor(args.maxChars)) : 5000;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let res;
        try {
          res = await fetch(url, {
            headers: { 'User-Agent': 'codenode-agent' },
            redirect: 'follow',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) return AgentToolResult.error('HTTP ' + res.status);
        const content = await res.text();
        const truncated = content.length > maxChars;
        const shown = truncated ? content.slice(0, maxChars) : content;
        return AgentToolResult.ok((truncated ? '（截断，共 ' + content.length + ' 字符）\n' : '') + shown, {
          url,
          chars: content.length,
          truncated,
        });
      } catch (e) {
        return AgentToolResult.error('抓取失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
