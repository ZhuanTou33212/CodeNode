/**
 * discoverToolsTool.cjs —— 把「按任务裁掉的工具」找回来（阶段 A / P0-1）
 *
 * 问题：主 Agent 的工具面按任务裁剪（`tools/profiles.cjs`）后，模型手上只有 core(+code/canvas)
 * 那一份 schema。裁剪省下的是每轮固定税，代价是「这一轮没 expose 的能力模型看不见」。
 *
 * 本工具就是那条退路：用功能词搜一搜，把命中的工具**从下一轮开始**启用（注册表暴露面只增不减）。
 * 为什么不直接放全量 schema：这份 schema 本身就是被裁掉的那 3~4k tokens/轮 —— 用一个几十 token
 * 的入口换回「需要时才付」，这是整个 P0-1 的取舍。
 *
 * 契约要点：
 *   - `cachePolicy: none`：两次同样的搜索**必须真的执行两次**（第一次已把工具启用，第二次的回报不同）；
 *   - `readOnly: true` + `mutatesWorkspace: false`：它不改工作区，只改本次 run 的工具面；
 *   - `requiresConfirmation: false`：不打扰用户（它不产生任何外部副作用）。
 *
 * 实现上必须**闭包持有注册表**：`discover_tools` 问的是「这个注册表里还有什么」，不是工作区。
 * 子代理注册表各自 `register()` 一次 → 各自持有自己的实例（子代理本该只看到角色白名单）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const profiles = require('../profiles.cjs');

/** 一次最多启用几个（防止模型一句查询把整个面拉回来 —— 那就等于没裁） */
const MAX_ENABLE = 10;
/** 候选列表里最多写几条（回给模型的文本要有上限） */
const MAX_LIST = 12;

const DESCRIPTION =
  '按功能词搜索「本次任务没下发给你的工具」并启用它们（从下一轮开始可调用）。' +
  '当你需要画布/子代理/联网/批量编辑等现在看不到的能力时用它；query 写功能词（如「画布节点」「子代理」「联网」）。';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '功能词，如「画布」「子代理」「联网搜索」「批量编辑」' },
  },
  required: ['query'],
};

/** 简易分词：中英混合按非字母数字切，中文长词再按 2 字滑窗补 —— 与记忆检索同一思路 */
function terms(query) {
  const s = String(query || '').toLowerCase();
  const out = new Set(s.split(/[^0-9a-z\u4e00-\u9fff]+/i).filter(Boolean));
  for (const chunk of s.split(/[^0-9a-z\u4e00-\u9fff]+/i)) {
    if (/^[\u4e00-\u9fff]{4,}$/.test(chunk)) {
      for (let i = 0; i + 2 <= chunk.length; i++) out.add(chunk.slice(i, i + 2));
    }
  }
  return [...out].filter((t) => t.length >= 2);
}

/** 命中打分：名字 > 描述 > profile 名。分数为 0 不算命中。 */
function scoreTool(registry, name, terms_) {
  const d = registry.descriptorOf(name);
  const desc = String((d && d.description) || '');
  const lowered = (name + ' ' + desc).toLowerCase();
  let score = 0;
  for (const t of terms_) {
    if (name.toLowerCase().includes(t)) score += 5;
    else if (lowered.includes(t)) score += 2;
  }
  return score;
}

function register(registry) {
  registry.registerDescriptor(
    {
      name: 'discover_tools',
      version: '1',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      readOnly: true,
      idempotent: false,
      mutatesWorkspace: false,
      requiresConfirmation: false,
      requiredCapability: 'workspace.read',
      timeoutMs: 5000,
      cachePolicy: { mode: 'none' },
      concurrencyPolicy: { parallelSafe: true },
    },
    async (context, args) => {
      const query = String((args && args.query) || '').trim();
      if (!query) return AgentToolResult.error('缺少 query', { code: 'ARG_SEMANTIC', tool: 'discover_tools' });

      const exposed = new Set(registry.exposedNames());
      const all = registry.listTools().map((t) => t.name);
      const hidden = all.filter((n) => !exposed.has(n));

      if (!hidden.length) {
        const text = '当前没有未下发的工具：本次 run 的工具面就是全部工具。';
        return AgentToolResult.ok(text, { enabled: [], hidden: [], matched: 0 }, { modelContent: text });
      }

      const terms_ = terms(query);
      // ① profile 名精确命中 → 整组启用（比逐词打分更符合「我要一类能力」的说法）
      const profileHits = profiles.PROFILE_NAMES.filter((p) => query.toLowerCase().includes(p));
      const scored = hidden
        .map((name) => ({ name, score: scoreTool(registry, name, terms_) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

      const picks = [];
      for (const name of hidden) {
        if (profileHits.some((p) => profiles.PROFILE_TOOLS[p].includes(name)) && !picks.includes(name)) picks.push(name);
      }
      for (const item of scored) {
        if (picks.length >= MAX_ENABLE) break;
        if (!picks.includes(item.name)) picks.push(item.name);
      }

      if (!picks.length) {
        // 一无所获时给出**分组清单**（只列名字，不列描述）—— 让模型能换词或直接说组名，而不是瞎猜
        const groups = profiles.PROFILE_NAMES
          .map((p) => {
            const names = profiles.PROFILE_TOOLS[p].filter((n) => hidden.includes(n));
            return names.length ? p + '=' + names.join(',') : '';
          })
          .filter(Boolean)
          .join('；');
        const text =
          '没有匹配「' + query + '」的未下发工具。未下发的工具按组如下（可换功能词再搜，或直接说组名）：\n' + groups;
        return AgentToolResult.ok(text, { enabled: [], hidden, matched: 0, groups }, { modelContent: text });
      }

      const enabled = registry.exposeNames(picks);
      const newly = picks.slice(0, MAX_LIST);
      const lines = newly.map((n) => {
        const d = registry.descriptorOf(n);
        const desc = String((d && d.description) || '').replace(/\s+/g, ' ').slice(0, 60);
        return '- ' + n + '：' + desc;
      });
      const text =
        '已启用 ' + picks.length + ' 个工具（**从下一轮开始**可以调用）：\n' + lines.join('\n') +
        '\n（本次 run 的工具面只增不减；如还需要别的能力，再调用一次 discover_tools 换功能词。）';
      return AgentToolResult.ok(
        text,
        { enabled: picks, exposed: enabled, matched: picks.length, hiddenRemaining: hidden.filter((n) => !picks.includes(n)) },
        { modelContent: text },
      );
    },
  );
}

module.exports = { register, MAX_ENABLE };
