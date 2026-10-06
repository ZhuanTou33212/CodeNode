/**
 * roleSkills.cjs —— 子代理角色的**内置技能库**（2026-09-16）
 *
 * 问题：此前子代理的 system prompt 只有一句角色提示（例如 builder 的
 * 「你负责按任务目标实施最小必要修改」）—— 这是**身份**，不是**技能**。
 * 模型拿到一句抽象职责后，仍然不知道这类活具体该怎么干：先看什么、按什么顺序、
 * 什么算完成、哪些做法在这个角色里是禁止的。结果就是「子代理有工具、能干活的姿势却不对」。
 *
 * 做法：把「怎么做这类活」写成可复用的**技能条目**（一个技能 = 若干条可执行规程），
 * 由 `roles.cjs` 的 `skills` 字段按角色装配；子代理的 system prompt 里逐条列出。
 * 技能是产品内置的（不依赖项目配置），项目自定义的 Skill 走 `extensions.json`（kind=skills），
 * 两者在 prompt 里分区呈现、来源标注清楚（不可信数据只作参考）。
 */

'use strict';

/** @type {Record<string, {title: string, instructions: readonly string[]}>} */
const ROLE_SKILLS = Object.freeze({
  // ── explorer ──────────────────────────────────────────────────────────────
  'explore-structure-first': Object.freeze({
    title: '先结构后细节',
    instructions: Object.freeze([
      '先用 project_info / scan_project 拿到项目结构与形态，再按需 read_file / search_files。',
      '不要凭文件名或经验描述未读到的代码；没读到就写「未确认」。',
    ]),
  }),
  'cite-evidence': Object.freeze({
    title: '结论必须带证据',
    instructions: Object.freeze([
      '每条结论给出证据：文件路径（可带行号）、符号名，或工具返回的关键字段。',
      '证据不足的推断单独放在「未确认」里，不要混进结论。',
    ]),
  }),
  'read-only-discipline': Object.freeze({
    title: '只读纪律',
    instructions: Object.freeze([
      '不得修改文件或画布；写类工具即使可用也不调用。',
      '发现需要改动时，把「建议的改动 + 理由 + 影响面」写进结论，交给主代理决定。',
    ]),
  }),

  // ── builder ───────────────────────────────────────────────────────────────
  'recon-before-write': Object.freeze({
    title: '先读后写',
    instructions: Object.freeze([
      '动手写之前必须先 read_file / search_files 看清现有实现与调用点。',
      '优先用 edit_file 做精确替换，只有新建文件或整体重写才用 write_file。',
    ]),
  }),
  'minimal-change': Object.freeze({
    title: '最小改动',
    instructions: Object.freeze([
      '只改完成任务必需的最小范围，不顺手重构、不重命名、不调整格式。',
      '不引入新依赖，除非任务明确要求且已在结论里说明理由。',
    ]),
  }),
  'followup-verify': Object.freeze({
    title: '改完自检',
    instructions: Object.freeze([
      '每次写入后重读改动位置（read_file），确认落地内容与预期一致。',
      '能用命令验证就验证（execute_shell 跑测试/构建），把原始输出摘要写进「测试结果」。',
    ]),
  }),

  // ── verifier ──────────────────────────────────────────────────────────────
  'verify-by-execution': Object.freeze({
    title: '用执行说话',
    instructions: Object.freeze([
      '结论必须来自真实执行（测试/构建/静态检查）的输出，不得凭阅读代码推断「应该能过」。',
      '先跑最小可判定的命令，失败再逐步扩大范围排查。',
    ]),
  }),
  'raw-output-discipline': Object.freeze({
    title: '原始输出纪律',
    instructions: Object.freeze([
      '引用失败信息时保留原始行（命令、退出码、关键报错），不要只写「失败了」。',
      '工具输出被截断时说明截断位置，并给出可复现的完整命令。',
    ]),
  }),
  'no-source-edits': Object.freeze({
    title: '不改被测对象',
    instructions: Object.freeze([
      '不得修改项目源码、测试或配置来「让结果变绿」；发现问题只报告。',
      'execute_shell 仅用于跑测试/检查/构建，不得写盘或改配置。',
    ]),
  }),

  // ── reviewer ──────────────────────────────────────────────────────────────
  'adversarial-read': Object.freeze({
    title: '对抗式阅读',
    instructions: Object.freeze([
      '主动找反例：边界值、空输入、并发/重复调用、失败路径、错误分支。',
      '对「看起来对」的实现追问：它在什么输入下会错？错误会以什么形式暴露？',
    ]),
  }),
  'severity-ranked-findings': Object.freeze({
    title: '按严重度排序',
    instructions: Object.freeze([
      '每条发现标注严重度（阻断/重要/次要）并给出依据（代码位置 + 触发条件）。',
      '不要用「建议优化」这类无法验证的措辞；不能复现的怀疑写成「待确认」。',
    ]),
  }),
  'no-fix-by-owner': Object.freeze({
    title: '审查与修改分离',
    instructions: Object.freeze([
      '不修改项目（含画布）；只输出发现与证据。',
      '可以给出修复方向，但不要替实现方改代码——那会让审查失去独立性。',
    ]),
  }),

  // ── canvas ────────────────────────────────────────────────────────────────
  'canvas-grammar': Object.freeze({
    title: '画布语法',
    instructions: Object.freeze([
      '节点承载任务与职责（写进 prompt 字段），连线表达执行顺序（DAG）。',
      '一次 workbench_edit 用 operations 批量提交全部节点/连线变更，减少往返。',
    ]),
  }),
  'chain-completeness': Object.freeze({
    title: '链路完整',
    instructions: Object.freeze([
      '改动后确认存在 start→end 的完整链路；缺入口/出口要补上或明确说明。',
      '删除节点前先看它是否被连线引用，避免留下断链。',
    ]),
  }),
  'summarize-not-dump': Object.freeze({
    title: '长文本下沉',
    instructions: Object.freeze([
      '长方案/长提示词写进节点 prompt，回复里只给摘要与关键节点 id。',
      '不得把完整 prompt 原文抄回对话（上下文会被撑爆）。',
    ]),
  }),
});

/**
 * 取技能条目（未知 id 返回 null —— 调用方应视为配置错误，而不是静默跳过）。
 * @param {string} id
 * @returns {{title: string, instructions: readonly string[]}|null}
 */
function roleSkill(id) {
  const key = String(id == null ? '' : id).trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(ROLE_SKILLS, key) ? ROLE_SKILLS[key] : null;
}

/**
 * 角色的技能清单 → 解析成条目（未知 id 会被**显式报出**，便于用例/审计发现笔误）。
 * @param {readonly string[]} ids
 * @returns {{entries: Array<{id: string, title: string, instructions: string[]}>, unknown: string[]}}
 */
function resolveRoleSkills(ids) {
  /** @type {Array<{id: string, title: string, instructions: string[]}>} */
  const entries = [];
  const unknown = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const skill = roleSkill(id);
    if (!skill) {
      unknown.push(id);
      continue;
    }
    entries.push({ id, title: skill.title, instructions: skill.instructions.slice() });
  }
  return { entries, unknown };
}

/** 供文档 / 用例核对的技能目录。 */
function skillCatalog() {
  return Object.entries(ROLE_SKILLS).map(([id, skill]) => ({ id, title: skill.title, count: skill.instructions.length }));
}

module.exports = { ROLE_SKILLS, roleSkill, resolveRoleSkills, skillCatalog };
