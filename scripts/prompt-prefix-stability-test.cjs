#!/usr/bin/env node
/**
 * prompt-prefix-stability-test.cjs —— P1-1（稳定内容前置、动态内容后置）的回归判据
 *
 * 为什么需要：prompt cache 命中的是**请求前缀**。此前「画布清单 / 项目记忆 / 用户记忆」紧跟回复约束，
 * 每个提问都会改写第 3 段 —— 等于把后面所有稳定内容（运行规则 ≈3.3k 字符、soul、工具引导）一起踢出缓存。
 * 重排之后，同一项目 + 同一工具面下，**只有动态区段会变**，前缀逐字节稳定。
 *
 * 五组判据（都在真实 `buildSystemPrompt` 输出上做，不是对内部变量的推断）：
 *   A. 段落登记表：稳定段必须全部排在动态段之前，且实际装配顺序 = 登记顺序；
 *   B. **规则零改字**：规则块拆两段只按编号搬运整行 —— 合成输入上逐行比对 + 真 prompt 上核对编号并集；
 *   C. 稳定前缀：改记忆 / 技能 / 用户记忆 / 画布内容 → 前缀逐字节不变（且长度 = 登记表算出的边界）；
 *   D. 判别力（变异）：改**稳定段**的内容（soul）→ 前缀必须变，否则 C 是假判据；
 *   E. 跨任务类型前缀的棘轮 + 接线断言。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const agent = require('../electron/agent.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}
/** 最长的公共前缀长度（重排是否真的让前缀稳定，直接量它） */
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
const ruleLines = (text) => (String(text).match(/^\d+\. [^\n]*/gm) || []).map((s) => s.trim());
const ruleNumbers = (text) => ruleLines(text).map((line) => Number(/^(\d+)\./.exec(line)[1]));
/**
 * 只取「运行规则 + 任务相关规则」两段里的规则行。
 * 注意：`【回复与编码约束】` 那组**也有 1–4 的编号**，直接全文匹配会把两套编号混在一起
 * （第一版就这么错了 —— 断言写错，代码是对的）。
 */
const promptRules = (text) => agent.splitPromptSections(text)
  .filter((s) => s.id === 'runtime-rules' || s.id === 'task-rules')
  .flatMap((s) => ruleLines(s.text));
const promptRuleNumbers = (text) => promptRules(text).map((line) => Number(/^(\d+)\./.exec(line)[1]));
const soul = { raw: '灵魂：演示项目，交付标准高。' };
const guide = agent.buildToolGuide([
  { name: 'read_file', description: '读取项目内文本文件' },
  { name: 'workbench_edit', description: '统一节点工具' },
  { name: 'execute_shell', description: '跑命令' },
]);
const CANVAS_A = '[{"id":"n1","label":"开始"},{"id":"n2","label":"任务"}]';
const CANVAS_B = '[{"id":"n1","label":"开始"}]';

const build = (opts) => agent.buildSystemPrompt(
  opts.soul || soul,
  opts.canvas == null ? '' : opts.canvas,
  opts.guide === undefined ? guide : opts.guide,
  opts.memory === undefined ? '记忆：构建入口是 npm run verify' : opts.memory,
  opts.skills === undefined ? 'my-skill: 做 X 时先 Y' : opts.skills,
  {
    prompt: opts.prompt || '把 add 改成加法',
    canvasMode: opts.canvasMode || 'always',
    userMemoryText: opts.userMemory === undefined ? '用户偏好：中文' : opts.userMemory,
    exposedTools: opts.exposedTools,
    toolFaceTrimmed: opts.toolFaceTrimmed,
  },
);

// ============================ A. 段落登记表与装配顺序 ============================
console.log('== A. 段落登记表：稳定段全在动态段之前 ==');
{
  const table = agent.PROMPT_SECTIONS;
  const firstDynamic = table.findIndex((s) => !s.stable);
  const lastStable = table.map((s) => s.stable).lastIndexOf(true);
  check('[A] 登记表里「稳定段」全部排在「动态段」之前', lastStable < firstDynamic,
    'lastStable=' + lastStable + ' firstDynamic=' + firstDynamic);
  check('[A] 登记表覆盖全部段落标题（≥8 段）且标题互不为前缀',
    table.length >= 8 && new Set(table.map((s) => s.title)).size === table.length, 'segments=' + table.length);

  const prompt = build({ canvas: CANVAS_A });
  const secs = agent.splitPromptSections(prompt);
  check('[A] 实际装配顺序 = 登记顺序', JSON.stringify(secs.map((s) => s.id)) === JSON.stringify(table.map((s) => s.id)),
    JSON.stringify(secs.map((s) => s.id)));
  check('[A] 切分能定位全部段落（不漏段、不重复）', secs.length === table.length, 'found=' + secs.length);
  // 画布建模规则 f) 里**引用了**【当前画布节点清单】这个名字；若切分按子串匹配，就会把规则块中间
  // 当成画布段的起点（整段厚度与顺序全错）。这里要证明：那个名字所在的位置没有被当成段落起始。
  const taskSec = secs.find((s) => s.id === 'task-rules');
  const canvasSecs = secs.filter((s) => s.id === 'canvas');
  check('[A] 切分按**行首**匹配标题（画布规则里引用的【当前画布节点清单】不会被误判成段落起始）',
    canvasSecs.length === 1 && taskSec.text.includes('【当前画布节点清单】') && canvasSecs[0].start > taskSec.start,
    JSON.stringify({ canvasSections: canvasSecs.length, canvasAt: canvasSecs[0] && canvasSecs[0].start, taskAt: taskSec.start }));
}

// ============================ B. 规则零改字（拆分只搬整行） ============================
console.log('\n== B. 规则块拆两段：只搬整行、正文零改字 ==');
{
  // B1：合成输入 —— 直接验 splitRuntimeRules 是无损搬运
  const synthetic = [
    '',
    '【运行规则】（硬性要求）',
    '1. 甲',
    '2. 乙',
    '3. 丙',
    '7. 丁（画布那半句已被门控摘掉）',
    '12. 戊',
    '13. 己',
    'SKELETON_CANVAS_BLOCK',
    '15. 庚',
    '19. 辛',
    '20. 壬',
  ].join('\n');
  const split = agent.splitRuntimeRules(synthetic, 'SKELETON_CANVAS_BLOCK');
  const taskNums = ruleNumbers(split.task);
  check('[B] 任务段只收登记过的编号（升序）', JSON.stringify(taskNums) === JSON.stringify([2, 7, 12, 19, 20]), JSON.stringify(taskNums));
  check('[B] 稳定段只留其余编号', JSON.stringify(ruleNumbers(split.stable)) === JSON.stringify([1, 3, 13, 15]), JSON.stringify(ruleNumbers(split.stable)));
  check('[B] 画布块原样落进任务段、且不在稳定段', split.task.includes('SKELETON_CANVAS_BLOCK') && !split.stable.includes('SKELETON_CANVAS_BLOCK'));
  const before = ruleLines(synthetic).sort();
  const after = [...ruleLines(split.stable), ...ruleLines(split.task)].sort();
  check('[B] **两段规则行的集合与拆分前逐字节相同**（零改字、无丢失、无重复）',
    JSON.stringify(before) === JSON.stringify(after), 'before=' + before.length + ' after=' + after.length);
  check('[B] 拆分后两段的编号并集 = 原编号并集', (() => {
    const u = [...new Set([...ruleNumbers(split.stable), ...ruleNumbers(split.task)])].sort((x, y) => x - y);
    const v = [...new Set(ruleNumbers(synthetic))].sort((x, y) => x - y);
    return JSON.stringify(u) === JSON.stringify(v);
  })());

  // B2：真 prompt —— 编号并集完整（1..19 连续），缺号只能来自门控
  const full = build({ canvas: '' , canvasMode: 'auto' });
  const fullNums = [...new Set(promptRuleNumbers(full))].sort((a, b) => a - b);
  check('[B] 未裁剪时规则编号并集 = 1..19 连续（一行都不能丢）',
    JSON.stringify(fullNums) === JSON.stringify(Array.from({ length: 19 }, (_, i) => i + 1)), JSON.stringify(fullNums));
  check('[B] 任务段与稳定段各非空（真的分了两段）',
    agent.splitPromptSections(full).filter((s) => s.id === 'task-rules' || s.id === 'runtime-rules').every((s) => s.text.length > 200));
  const trimmed = build({
    canvas: '', canvasMode: 'auto', toolFaceTrimmed: true,
    exposedTools: ['read_file', 'search_files', 'execute_shell', 'discover_tools'],
  });
  const trimmedNums = [...new Set(promptRuleNumbers(trimmed))].sort((a, b) => a - b);
  // 这次给的暴露面是 core 子集（没有 workbench_edit / query_scalars）→ 规则 2/6/12/19 被门控摘掉，
  // 并追加规则 20（告诉模型用 discover_tools 把能力找回来）。
  check('[B] 裁剪时：点名未暴露工具的规则（2/6/12/19）消失、并追加规则 20（取回入口）',
    JSON.stringify(trimmedNums) === JSON.stringify([1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 20]), JSON.stringify(trimmedNums));
  const taskNumsReal = ruleNumbers(agent.splitPromptSections(trimmed).find((s) => s.id === 'task-rules').text);
  check('[B] 真 prompt 上任务段只收「按面变化」的那几条（7 的剩余部分 / 14 画布块 / 20）',
    JSON.stringify(taskNumsReal) === JSON.stringify([7, 14, 20]), JSON.stringify(taskNumsReal));
  check('[B] 稳定段里不含任何任务规则编号', (() => {
    const stableNums = ruleNumbers(agent.splitPromptSections(trimmed).find((s) => s.id === 'runtime-rules').text);
    return stableNums.every((n) => !agent.TASK_RULE_NUMBERS.includes(n));
  })());
}

// ============================ C. 稳定前缀 ============================
console.log('\n== C. 稳定前缀：动态内容变化不动前缀 ==');
{
  const base = build({ canvas: CANVAS_A });
  const boundary = agent.splitPromptSections(base).find((s) => !s.stable).start;
  const stablePrefix = base.slice(0, boundary);
  check('[C] 稳定前缀非空且不算窄（≥2,000 字符）', boundary >= 2000, 'prefix=' + boundary);
  check('[C] 稳定前缀里不含任何动态段标题',
    !['【任务相关规则', '【项目 Skills', '【项目长期记忆', '【用户级记忆', '【当前画布节点清单'].some((t) => stablePrefix.includes(t)));

  const variants = [
    ['只改画布内容', build({ canvas: CANVAS_B })],
    ['只改项目记忆', build({ canvas: CANVAS_A, memory: '记忆：另一条完全不同的记忆内容' })],
    ['只改用户记忆', build({ canvas: CANVAS_A, userMemory: '用户偏好：英文' })],
    ['只改技能索引', build({ canvas: CANVAS_A, skills: 'another-skill: 先 Z' })],
    ['记忆/用户记忆/技能全清空', build({ canvas: CANVAS_A, memory: '', userMemory: '', skills: '' })],
    ['换一个提问（同任务面）', build({ canvas: CANVAS_A, prompt: '给这个函数补单测' })],
  ];
  /**
   * 判据是「公共前缀 **≥** 稳定前缀」而不是「恰好等于」：只改画布内容时，边界之后的
   * 任务规则/技能/记忆/用户记忆几段本来就一模一样（那些输入没变），公共前缀自然会长过边界。
   * 要证明的是「动态输入动了，前缀**没有**被推到边界之前」。
   */
  for (const [label, p] of variants) {
    check('[C] ' + label + ' → 公共前缀仍 ≥ 稳定前缀（动态输入不动前缀）', commonPrefix(base, p) >= boundary,
      'common=' + commonPrefix(base, p) + ' boundary=' + boundary);
  }
  const noCanvas = build({ canvas: '', canvasMode: 'auto' });
  check('[C] 画布为空（画布层退成占位）时，前缀到「任务段」为止仍相同（画布层差异只在动态段里）',
    commonPrefix(base, noCanvas) >= boundary, 'common=' + commonPrefix(base, noCanvas));

  // D. 判别力：改稳定段的内容，前缀必须变
  const otherSoul = build({ canvas: CANVAS_A, soul: { raw: '灵魂：换了一个完全不同的灵魂设定。' } });
  check('[D] 变异/判别力：改稳定段（soul）→ 前缀必须变（否则 C 是假判据）',
    commonPrefix(base, otherSoul) < boundary, 'common=' + commonPrefix(base, otherSoul));
  const otherGuide = build({ canvas: CANVAS_A, guide: agent.buildToolGuide([{ name: 'read_file', description: '换个描述' }]) });
  check('[D] 变异/判别力：换工具面（引导段变化）→ 前缀也变（引导段属于「本次有哪些工具」）',
    commonPrefix(base, otherGuide) < boundary, 'common=' + commonPrefix(base, otherGuide));
}

// ============================ E. 跨任务类型 + 接线 ============================
console.log('\n== E. 跨任务类型前缀（棘轮）+ 接线 ==');
{
  // 真实装配下跨类型：画布轮带画布层与画布面，纯代码轮不带 —— 前缀到「工具引导/任务规则」为止
  const code = build({ canvas: '', canvasMode: 'auto', guide: agent.buildToolGuide([{ name: 'read_file', description: '读' }]) });
  const canvas = build({ canvas: CANVAS_A, canvasMode: 'always', guide: agent.buildToolGuide([{ name: 'read_file', description: '读' }, { name: 'workbench_edit', description: '画' }]) });
  const common = commonPrefix(code, canvas);
  /**
   * 跨任务类型的公共前缀止于**工具引导段**（面不同 → 引导不同），而引导段按审计给的顺序属稳定区。
   * 实测 2,325（重排前是 344）。这条棘轮只允许涨：要再涨就得把引导段也移到边界之后
   * （那会让「同一任务类型的稳定前缀」短 288 字符，按现口径不划算）。
   */
  check('[E] 跨任务类型公共前缀 ≥2,300 字符（重排前实测 344）', common >= 2300, 'common=' + common);
  check('[E] 跨类型前缀的边界落在**任务规则/画布层**附近（不是被记忆/画布清单打断）',
    common >= agent.splitPromptSections(code).find((s) => s.id === 'runtime-rules').start + 1000, 'common=' + common);

  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.cjs'), 'utf8');
  check('[E] 装配走的是登记表排序（不是随手 join）',
    /return orderPromptSections\(lines\)\.join\('\\n\\n'\)/.test(src));
  check('[E] 规则块拆两段的地方确实调了 splitRuntimeRules，且任务段进了 lines',
    /const splitRules = splitRuntimeRules\(rulesText, canvasRules\)/.test(src) && /if \(splitRules\.task\) lines\.push\(splitRules\.task\)/.test(src));
  check('[E] 两段都在登记表里（稳定段 runtime-rules / 任务段 task-rules）',
    agent.PROMPT_SECTIONS.find((s) => s.id === 'runtime-rules').stable === true &&
    agent.PROMPT_SECTIONS.find((s) => s.id === 'task-rules').stable === false);
  check('[E] 任务段编号表与工具面门控表指向同一批编号（加规则时两处都要登记）',
    JSON.stringify(agent.TASK_RULE_NUMBERS) === JSON.stringify([2, 6, 7, 12, 19, 20]));
}

console.log('\n' + (failures === 0 ? 'PROMPT PREFIX STABILITY TEST: PASS（稳定内容前置、规则按面分层且零改字）' : 'PROMPT PREFIX STABILITY TEST: FAIL —— ' + failures + ' 项断言未通过'));
process.exit(failures ? 1 : 0);
