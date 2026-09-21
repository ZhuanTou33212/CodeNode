/**
 * webSearchTool.cjs —— 联网搜索（对照 Codex / Claude Code 的 `web_search` / `WebSearch`）
 *
 * 短板（对照文档 §5 #7）：此前只有 `fetch_url`（**已知 URL 才**能抓），没有「先搜再读」的能力 ——
 * 查文档、找报错、比对版本这些最常见的动作都做不了。
 *
 * 设计取舍（为什么是「可配置后端 + 出厂关闭」而不是写死某一家）：
 *   - 搜索后端要么要 API Key（Tavily / Brave / Bing），要么要自建实例（SearxNG）、要么有风控；
 *     把某一家写进产品等于替用户选服务商与计费方式，不合适；
 *   - 所以工具本身只做「把查询发给你配的后端 + 把结果结构化回灌」，后端由
 *     `config/agent.properties` 的 `web_search.*` 指定；**不配 = 工具根本不注册**（零痕迹、零上下文成本）。
 *
 * 支持的后端形状：
 *   - `searxng`：`GET {endpoint}?q=<query>&format=json` → `{results:[{title,url,content}]}`（自建实例，无需 Key）
 *   - `custom` ：`GET {endpoint}`（`{query}` 会被替换成 URL 编码后的查询）→ 接受 `{results:[…]}` 或裸数组，
 *               元素取 `title`/`url`/`content|snippet|description`；`api_key` 存在时以 `Authorization: Bearer` 发送
 *
 * 安全：出网仍受 `sandbox.network` 约束（deny = 不发请求），且走 `publicHttp.fetchPublicText`
 * （只允许公网地址、限字节上限）；**不编造结果**：后端返回空就是「没有结果」。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { request } = require('../../publicHttp.cjs');

const DEFAULTS = { backend: 'searxng', maxResults: 5, timeoutMs: 15000, maxBytes: 512 * 1024 };

/** 解析 web_search 配置（扁平 properties 键）；enabled 默认 false —— 不配就不注册这个工具 */
function parseWebSearchConfig(cfg) {
  const source = cfg || {};
  const enabled = String(source['web_search.enabled'] || '').toLowerCase() === 'true';
  const backendRaw = String(source['web_search.backend'] || DEFAULTS.backend).toLowerCase();
  const backend = ['searxng', 'custom'].includes(backendRaw) ? backendRaw : DEFAULTS.backend;
  const endpoint = String(source['web_search.endpoint'] || '').trim();
  const apiKey = String(source['web_search.api_key'] || '').trim();
  const maxResults = Math.min(20, Math.max(1, Number(source['web_search.max_results']) || DEFAULTS.maxResults));
  const timeoutMs = Math.min(60000, Math.max(1000, Number(source['web_search.timeout_ms']) || DEFAULTS.timeoutMs));
  const problems = [];
  if (enabled && !endpoint) problems.push('web_search.enabled=true 但没有配 web_search.endpoint（例如 http://127.0.0.1:8888/search 或 https://api.tavily.com/search）');
  if (enabled && /^https?:\/\//i.test(endpoint) === false && endpoint) problems.push('web_search.endpoint 必须以 http:// 或 https:// 开头');
  return { enabled, backend, endpoint, apiKey, maxResults, timeoutMs, problems };
}

/** 把后端返回的 JSON 归一化成 [{title,url,snippet}]（各家字段名不同，这里只认最常见几种） */
function normalizeResults(payload, limit) {
  const list = Array.isArray(payload) ? payload : payload && Array.isArray(payload.results) ? payload.results : payload && Array.isArray(payload.items) ? payload.items : null;
  if (!list) return null;
  return list
    .slice(0, limit)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const url = String(item.url || item.link || item.href || '').trim();
      const title = String(item.title || item.name || url || '').trim();
      const snippet = String(item.content || item.snippet || item.description || item.text || '').trim();
      if (!url && !title) return null;
      return { title, url, snippet };
    })
    .filter(Boolean);
}

function buildQueryUrl(config, query) {
  const encoded = encodeURIComponent(query);
  if (config.endpoint.includes('{query}')) return config.endpoint.split('{query}').join(encoded);
  const separator = config.endpoint.includes('?') ? '&' : '?';
  if (config.backend === 'searxng') return config.endpoint + separator + 'q=' + encoded + '&format=json';
  return config.endpoint + separator + 'q=' + encoded;
}

function register(registry) {
  registry.register(
    'web_search',
    '联网搜索（用项目配置的搜索后端）：返回标题/链接/摘要。用于查文档、找报错原因、核对版本等「先搜再读」的场景。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条（默认取配置值）' },
      },
      required: ['query'],
    },
    async (context, args) => {
      const query = String((args && args.query) || '').trim();
      if (!query) return AgentToolResult.error('缺少 query');
      const config = typeof context.webSearchConfig === 'function' ? context.webSearchConfig() : null;
      if (!config || !config.enabled || !config.endpoint) {
        return AgentToolResult.error('web_search 未启用或未配置后端（config/agent.properties 的 web_search.enabled / web_search.endpoint）', {
          code: 'ARG_SCHEMA',
          tool: 'web_search',
        });
      }
      const policy = typeof context.sandbox === 'function' ? context.sandbox() : null;
      if (policy && policy.network === 'deny') {
        // 出厂默认断网：如实说清「为什么搜不了」和「怎么放开」，不要静默失败
        return AgentToolResult.error('联网搜索需要出网，但当前 sandbox.network=deny（出厂默认）：请把 sandbox.network 设为 allow 或 inherit', {
          code: 'NETWORK_DENIED',
          tool: 'web_search',
        });
      }
      const limit = Math.min(20, Math.max(1, Number((args && args.maxResults) || config.maxResults)));
      const url = buildQueryUrl(config, query);
      try {
        const headers = config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {};
        /**
         * 走 `publicHttp.request` 而不是 `fetchPublicText`：搜索端点由**用户自己配置**，
         * 自建 SearxNG 十有八九在 `http://127.0.0.1:8888`（`fetchPublicText` 只允许公网地址 → 必被 SSRF 判据拦下）。
         * 仍然保留地址解析与连接固定、字节上限；「能不能联网」由 sandbox.network 另行约束。
         */
        const result = await request(url, {
          headers,
          signal: context.signal && context.signal(),
          timeoutMs: config.timeoutMs,
          maxBytes: DEFAULTS.maxBytes,
          allowPrivateHosts: true,
        });
        let payload = null;
        try {
          payload = JSON.parse(result.text);
        } catch {
          return AgentToolResult.error('搜索后端应答不是 JSON（backend=' + config.backend + '）：' + String(result.text || '').slice(0, 120), {
            code: 'FATAL_FAILURE',
            tool: 'web_search',
            backend: config.backend,
          });
        }
        const results = normalizeResults(payload, limit);
        if (results === null) {
          return AgentToolResult.error('搜索后端应答里没有 results 数组（backend=' + config.backend + '）：' + JSON.stringify(payload).slice(0, 160), {
            code: 'FATAL_FAILURE',
            tool: 'web_search',
            backend: config.backend,
          });
        }
        if (!results.length) {
          // 空就是空 —— 绝不编造「看起来合理」的结果
          return AgentToolResult.ok('搜索「' + query + '」没有返回结果（后端：' + config.backend + '）。可以换关键词，或用 fetch_url 直接读已知文档地址。', {
            query,
            backend: config.backend,
            count: 0,
            results: [],
          });
        }
        const lines = results.map((r, i) => i + 1 + '. ' + r.title + (r.url ? '\n   ' + r.url : '') + (r.snippet ? '\n   ' + r.snippet.replace(/\s+/g, ' ').slice(0, 300) : ''));
        return AgentToolResult.ok('搜索「' + query + '」（后端：' + config.backend + '，' + results.length + ' 条）\n' + lines.join('\n'), {
          query,
          backend: config.backend,
          count: results.length,
          results,
        });
      } catch (error) {
        return AgentToolResult.error('搜索失败：' + String((error && error.message) || error), { code: 'FATAL_FAILURE', tool: 'web_search', backend: config.backend });
      }
    }
  );
}

module.exports = { register, parseWebSearchConfig, normalizeResults, buildQueryUrl, DEFAULTS };
