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
    '读取项目 Skill 的完整正文（system prompt 里只给了索引；需要某个技能的详细做法时用它读取）。',
    {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（与索引里列出的名字完全一致）' } },
      required: ['name'],
    },
    async (context, args) => {
      const name = String((args && args.name) || '').trim();
      if (!name) return AgentToolResult.error('缺少 name');
      const skills = listSkills(context.projectRoot());
      if (!skills.length) {
        return AgentToolResult.error('本项目没有声明任何 Skill（.codenode/extensions.json 里 kind=skills 的条目）', {
          code: 'ARG_SEMANTIC',
          tool: 'read_skill',
        });
      }
      const hit = skills.find((s) => s.name === name) || skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        return AgentToolResult.error(
          '没有名为「' + name + '」的 Skill。可用：' + skills.map((s) => s.name).join('、'),
          { code: 'ARG_SEMANTIC', tool: 'read_skill', available: skills.map((s) => s.name) },
        );
      }
      if (!hit.instructions) {
        return AgentToolResult.ok('（该 Skill 只有描述，没有更详细的正文）\n' + hit.description, { name: hit.name, instructions: '', truncated: false });
      }
      const maxChars = Number(context.skillMaxChars && context.skillMaxChars()) > 0 ? Number(context.skillMaxChars()) : DEFAULT_MAX_CHARS;
      const truncated = hit.instructions.length > maxChars;
      const body = truncated ? hit.instructions.slice(0, maxChars) + '\n…（技能正文已截断，共 ' + hit.instructions.length + ' 字符）' : hit.instructions;
      if (typeof context.audit === 'function') context.audit('read_skill ' + hit.name + (truncated ? ' (truncated)' : ''));
      return AgentToolResult.ok('【Skill：' + hit.name + '】\n' + body, {
        name: hit.name,
        instructions: body,
        truncated,
        chars: hit.instructions.length,
      });
    }
  );
}

module.exports = { register, listSkills, DEFAULT_MAX_CHARS };
