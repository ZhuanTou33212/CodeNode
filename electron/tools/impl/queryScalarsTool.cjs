/**
 * query_scalars：本地标量查询。针对需要「精准数据」的场景（画布节点 prompt/goal/属性、文件节点路径等），
 * 这些数据在画布工具执行时已写入工程本地标量库（.codenode/scalars.json），不随上下文返回云端。
 * 本工具按 key（精确）或 prefix（前缀）在本地查询并返回精确值。
 *
 * key 约定：
 *   node:<id>            节点的完整属性对象（id/type/label/status/prompt/goal/members/filePath...）
 *   node:<id>:prompt     节点的 prompt 单属性
 *   node:<id>:label      节点的 label 单属性
 *   prefix=node:         列出全部节点
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

const VALUE_CHAR_CAP = 8000;

function serializeValue(value) {
  try {
    if (value == null) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const json = JSON.stringify(value);
    return json.length > VALUE_CHAR_CAP ? json.slice(0, VALUE_CHAR_CAP) + '…（已截断，用 key=node:<id>:<attr> 取单属性）' : json;
  } catch {
    return String(value);
  }
}

function register(registry) {
  registry.register(
    'query_scalars',
    '本地标量精确/语义查询：读取画布节点等已落本地标量库的精准数据（不走云端）。' +
      '按 key 精确查（如 node:<id> 取节点完整属性，node:<id>:prompt 取节点 prompt），' +
      '或用 prefix 列出（如 prefix=node: 列出全部节点），' +
      '或用 query 按自然语言语义匹配（如“登录模块的 prompt”“检索节点的名字”），无需知道精确 key。' +
      '需要节点精确 prompt/goal/名字/members/filePath 时用它。',
    {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '精确标量 key，如 node:n1 或 node:n1:prompt；逗号分隔可查多个',
        },
        prefix: {
          type: 'string',
          description: '前缀查询，如 node: 或 node:task-；与 key 同时给时 key 优先',
        },
        query: {
          type: 'string',
          description: '自然语言语义查询：名字/具体数据/prompt 等，无需知道精确 key（如“登录模块的 prompt”）',
        },
        max: { type: 'integer', description: '最多返回条数，默认 50' },
      },
      required: [],
    },
    async (context, args) => {
      const store = context.scalars();
      if (!store) return AgentToolResult.error('本地标量库未启用（scalars.enabled=false 或没有工程上下文）');

      const key = String(args.key || '').trim();
      const prefix = String(args.prefix || '').trim();
      const query = String(args.query || '').trim();
      const max = Number.isFinite(args.max) && args.max > 0 ? Math.floor(args.max) : 50;
      const out = [];
      if (key) {
        for (const one of key.split(',')) {
          const k = one.trim();
          if (!k) continue;
          const hits = store.query({ key: k, max });
          for (const hit of hits) out.push(hit);
          if (out.length >= max) break;
        }
      }
      if (prefix) {
        const hits = store.query({ prefix, max: max - out.length });
        for (const hit of hits) out.push(hit);
      }
      if (query && typeof store.search === 'function') {
        const hits = store.search({ query, max: max - out.length, minScore: 15 });
        for (const hit of hits) {
          if (out.some((item) => item.key === hit.key)) continue;
          out.push(hit);
        }
      }
      if (out.length === 0) {
        const hint = key || prefix || query || '';
        return AgentToolResult.ok(
          '本地标量库无匹配。可用 query_scalars prefix=node: 列出全部节点 key，或换用 query 语义查询；' +
            '若画布尚未被任何画布工具读取/写入，节点属性还未入库。',
          { key: key || null, prefix: prefix || null, query: query || null, count: 0, items: [] }
        );
      }

      const lines = out.map((item) => {
        const value = serializeValue(item.value);
        const kind = item.kind ? '[' + item.kind + '] ' : '';
        const score = typeof item.score === 'number' ? ' score=' + item.score : '';
        return '- ' + item.key + ': ' + kind + value + score;
      });
      const text =
        '本地标量命中 ' + out.length + ' 条' +
        (query ? '（query=' + query + '）' : '') +
        (prefix ? '（prefix=' + prefix + '）' : '') +
        (key ? '（key=' + key + '）' : '') + '。\n' + lines.join('\n');
      return AgentToolResult.ok(text, {
        key: key || null,
        prefix: prefix || null,
        query: query || null,
        count: out.length,
        items: out.map((item) => ({ key: item.key, kind: item.kind || 'scalar', value: item.value, ts: item.ts || 0, exact: !!item.exact, score: typeof item.score === 'number' ? item.score : null })),
      });
    }
  );
}

module.exports = { register };
