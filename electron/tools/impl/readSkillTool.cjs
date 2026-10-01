/**
 * readSkillTool.cjs —— 按需读取项目 Skill 正文（渐进披露）
 *
 * 短板（对照文档 §5 #4）：项目里声明的 skills 此前是**整段注入 system prompt** ——
 * 无论这次任务用不用得上，每个 Skill 的完整 instructions 都常驻（每轮固定开销 + 干扰注意力）。
 * Claude Code 的做法是**渐进披露**：prompt 里只放名字与一句话，正文等模型需要时自己去读。
 *
 * 本工具就是那个「自己去读」的入口：
 *   - 只读 `.codenode/extensions.json` / `config/extensions.json` 里 `kind:'skills'` 的条目；
 *   - 按 name 精确匹配，读不到就如实报错并列出可用名字（模型据此改参数重试）；
 *   - 正文有上限（`agent.skill_max_chars`，默认 8000），超限截断并标注 —— 读技能不该把上下文吃穿。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { readManifest } = require('../extensions.cjs');

const DEFAULT_MAX_CHARS = 8000;

/** 当前项目声明的 skills（统一大小写与空白后的视图） */
function listSkills(projectRoot) {
  return readManifest(projectRoot)
    .filter((item) => String(item.kind || '').toLowerCase() === 'skills')
    .map((item) => ({
      name: String(item.name || '').trim(),
      description: String(item.description || '').trim(),
      instructions: String(item.instructions || '').trim(),
    }))
    .filter((item) => item.name);
}

function register(registry) {
  registry.register(
    'read_skill',
    '读取项目 Skill 的完整正文；省略 name 可列出可用技能（system prompt 里的索引可能因预算被裁剪）。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（与索引里列出的名字完全一致）' } },
      required: [],
    },
    async (context, args) => {
      const name = String((args && args.name) || '').trim();
      const skills = listSkills(context.projectRoot());
      if (!skills.length) {
        return AgentToolResult.error('本项目没有声明任何 Skill（.codenode/extensions.json 里 kind=skills 的条目）', {
          code: 'ARG_SEMANTIC',
          tool: 'read_skill',
        });
      }
      if (!name) {
        const limit = 100;
        const visible = skills.slice(0, limit).map((s) => '- ' + s.name);
        const omitted = skills.length - visible.length;
        return AgentToolResult.ok(
          '【可用 Skills】\n' + visible.join('\n') + (omitted > 0 ? '\n（另有 ' + omitted + ' 项未列出）' : ''),
        );
      }
      const hit = skills.find((s) => s.name === name) || skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        return AgentToolResult.error(
          '没有名为「' + name + '」的 Skill。可用：' + skills.map((s) => s.name).join('、'),
          { code: 'ARG_SEMANTIC', tool: 'read_skill', available: skills.map((s) => s.name) },
        );
      }
      if (!hit.instructions) {
        const text = '（该 Skill 只有描述，没有更详细的正文）\n' + hit.description;
        return AgentToolResult.ok(text, { name: hit.name, instructions: '', truncated: false }, { modelContent: text });
      }
      const maxChars = Number(context.skillMaxChars && context.skillMaxChars()) > 0 ? Number(context.skillMaxChars()) : DEFAULT_MAX_CHARS;
      const truncated = hit.instructions.length > maxChars;
      const body = truncated ? hit.instructions.slice(0, maxChars) + '\n…（技能正文已截断，共 ' + hit.instructions.length + ' 字符）' : hit.instructions;
      if (typeof context.audit === 'function') context.audit('read_skill ' + hit.name + (truncated ? ' (truncated)' : ''));
      const text = '【Skill：' + hit.name + '】\n' + body;
      return AgentToolResult.ok(text, {
        name: hit.name,
        instructions: body,
        truncated,
        chars: hit.instructions.length,
      }, { modelContent: text });
    }
  );
}

module.exports = { register, listSkills, DEFAULT_MAX_CHARS };
