'use strict';
const { AgentToolResult } = require('../result.cjs');
const { fetchPublicText } = require('../../publicHttp.cjs');

function register(registry) {
  registry.register('fetch_url', '读取公网 HTTP/HTTPS 文本；最多下载 1MiB，整个请求限时 30 秒。',
    { type: 'object', properties: {
      url: { type: 'string', maxLength: 2048 },
      maxChars: { type: 'integer', minimum: 100, maximum: 50000 },
    }, required: ['url'] },
    async (context, args) => {
      try {
        const result = await fetchPublicText(args.url, { signal: context.signal?.() });
        const maxChars = args.maxChars || 5000;
        const truncated = result.text.length > maxChars;
        return AgentToolResult.ok(result.text.slice(0, maxChars), {
          url: result.url, chars: result.text.length, bytes: result.bytes, truncated,
        });
      } catch (error) {
        return AgentToolResult.error('抓取失败：' + error.message);
      }
    });
}
module.exports = { register };
