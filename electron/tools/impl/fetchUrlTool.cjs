/**
 * fetch_url：抓取指定 URL 的文本内容（仅 http/https），maxChars 截断。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const dns = require('node:dns').promises;

function privateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function privateIpv6(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
}

async function assertSafeUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('URL 格式无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https');
  if (parsed.username || parsed.password) throw new Error('URL 不允许携带用户名或密码');
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || privateIpv4(hostname) || privateIpv6(hostname)) {
    throw new Error('出于 SSRF 防护，禁止访问本机或私有网络地址');
  }
  if (/^[0-9a-f:.]+$/i.test(hostname)) return parsed;
  let addresses;
  try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); } catch { throw new Error('域名解析失败'); }
  if (!addresses.length || addresses.some((item) => privateIpv4(item.address) || privateIpv6(item.address))) {
    throw new Error('出于 SSRF 防护，域名解析到了本机或私有网络地址');
  }
  return parsed;
}

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
      if (url.length > 2048) return AgentToolResult.error('URL 过长');
      const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? Math.max(100, Math.floor(args.maxChars)) : 5000;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let current = url;
        let res = null;
        try {
          for (let redirect = 0; redirect <= 3; redirect++) {
            const parsed = await assertSafeUrl(current);
            res = await fetch(parsed, { headers: { 'User-Agent': 'codenode-agent' }, redirect: 'manual', signal: controller.signal });
            if (![301, 302, 303, 307, 308].includes(res.status)) break;
            const location = res.headers.get('location');
            if (!location || redirect === 3) throw new Error('重定向次数超过上限');
            current = new URL(location, parsed).toString();
          }
        } finally {
          clearTimeout(timer);
        }
        if (!res) return AgentToolResult.error('没有收到响应');
        if (!res.ok) return AgentToolResult.error('HTTP ' + res.status);
        const content = await res.text();
        const truncated = content.length > maxChars;
        const shown = truncated ? content.slice(0, maxChars) : content;
        return AgentToolResult.ok((truncated ? '（截断，共 ' + content.length + ' 字符）\n' : '') + shown, {
          url: current,
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
