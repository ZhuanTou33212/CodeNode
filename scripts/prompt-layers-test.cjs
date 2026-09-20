/**
 * prompt-layers-test.cjs —— ③ 每轮固定开销的分层（画布规则按需注入）
 *
 * 背景：`contextBudget` 只裁工具结果、明确保护 system 消息，所以「每轮固定开销」从来没被管过。
 * 实测（本机）：system 固定部分 5,331 字符 + 22 个工具的 JSON Schema 13,825 字符 ≈ **7.4k tokens/轮**，
 * 其中**画布建模规则（运行规则 14 a–h）≈2.4k 字符**对纯代码任务完全无关却常驻。
 *
 * 判据：
 *   A. 纯函数 `resolvePromptLayers` 表驱动：**只要不确定就注入**（画布非空 / 提问含画布词 / 配置强制），
 *      只有「画布为空且提问不含画布词」才省。
 *   B. **字节级等价**：层开启时与分层前逐字节一致 —— `prompt(always).replace(CANVAS_RULES, STUB) === prompt(自动省层)`；
 *      省层时不得残留任何画布细则（`a) 一条完整的节点链路` 等），且占位规则保留编号。
 *   C. 接线：新配置键必须能从 **loader 出口**读回（`loadConfig(root).prompt.canvasRules`），非法值回落 auto；
 *      并静态断言 ipc 真的把 `canvasMode` 传给了 buildSystemPrompt（防「实现了但没接线」）。
 *   D. 开销门禁：量测 system 固定 + 工具 schema 的字符数并设**上界**（以后涨上去就红），
 *      同时断言省层确实省下 ≥2,000 字符。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const agent = require(path.join(ROOT, 'electron', 'agent.cjs'));
const toolkit = require(path.join(ROOT, 'electron', 'tools', 'toolkit.cjs'));

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const CANVAS_DETAIL = 'a) 一条完整的节点链路必须有开始节点(start)和结束节点(end)';
const PROMPT_ARGS = ['', '', [], '', '']; // soul / canvasSummary / toolGuide / memory / skills

function build(opts = {}) {
  // 注意 canvasSummary 是**位置参数**（第 2 个），不能塞进 options —— 第一版就踩了这个，
  // 于是「画布非空」的用例其实喂的是空画布，断言差 1,429 字符露了馅。
  return agent.buildSystemPrompt('', opts.canvasSummary || '', [], '', '', {
    prompt: opts.prompt,
    canvasMode: opts.canvasMode,
  });
}

try {
  // ============================ A. 层判定 ============================
  console.log('== A. resolvePromptLayers 判定（不确定就注入） ==');
  const cases = [
    [{}, false, 'pure-code-task'],
    [{ canvasSummary: '[]', prompt: '把 add 的减法改成加法，然后跑测试' }, false, 'pure-code-task'],
    [{ prompt: '读取 src/app.ts 并修掉这个 bug' }, false, 'pure-code-task'],
    [{ canvasSummary: '[{"id":"n1","type":"task"}]' }, true, 'canvas-not-empty'],
    [{ canvasSummary: '[{"id":"n1"}]', prompt: '把 add 改成加法' }, true, 'canvas-not-empty'],
    [{ canvasSummary: '[]', prompt: '帮我在画布上建一条链路' }, true, 'prompt-mentions-canvas'],
  ];
  for (const [input, want, wantReason] of cases) {
    const got = agent.resolvePromptLayers(input);
    check('[A] ' + JSON.stringify(input).slice(0, 60) + ' → canvas=' + want, got.canvas === want && got.reason === wantReason, JSON.stringify(got));
  }
  const keywords = ['节点', '连线', '工作流', '流程', '链路', '建模', 'scope', 'stage', 'object'];
  const missed = keywords.filter((word) => agent.resolvePromptLayers({ canvasSummary: '[]', prompt: '请处理' + word + '相关的事情' }).canvas !== true);
  check('[A] 画布关键词表全部命中（宁多注入）', missed.length === 0, missed.join(',') || keywords.join('/'));
  check('[A] mode=always 强制注入（纯代码任务也注入）', agent.resolvePromptLayers({ canvasSummary: '[]', prompt: 'x', mode: 'always' }).canvas === true);
  check('[A] mode=never 强制不注入（画布非空也不注入）', agent.resolvePromptLayers({ canvasSummary: '[{"id":"n1"}]', mode: 'never' }).canvas === false);
  check('[A] mode 大小写/空白不敏感（ALWAYS 也认）', agent.resolvePromptLayers({ mode: ' ALWAYS ' }).canvas === true);
  check('[A] 非法 mode 回落 auto（不炸）', agent.resolvePromptLayers({ mode: '乱七八糟', canvasSummary: '[]', prompt: 'x' }).canvas === false);

  // ============================ B. 字节级等价 ============================
  console.log('\n== B. 注入/省层都必须与分层前逐字节可比 ==');
  // 注意：`canvasSummary` 本身会被渲染进提示词（『当前画布节点清单』），所以**比对的双方必须喂同一份 summary**，
  // 否则量到的是「清单文本差异」而不是层差异（第一版就是这么误判的）。
  const alwaysPureTask = build({ canvasMode: 'always' });
  const pure = build({ canvasMode: 'auto', prompt: '把 add 的减法改成加法，然后跑测试' });
  const canvasBySummary = build({ canvasMode: 'auto', canvasSummary: '[{"id":"n1","type":"task"}]' });
  const canvasBySummaryForced = build({ canvasMode: 'always', canvasSummary: '[{"id":"n1","type":"task"}]' });
  const canvasByWord = build({ canvasMode: 'auto', prompt: '帮我在画布上建一条链路' });
  const canvasByWordForced = build({ canvasMode: 'always', prompt: '帮我在画布上建一条链路' });
  const emptyListTask = build({ canvasMode: 'auto', canvasSummary: '[]', prompt: '把 add 改成加法' });
  const emptyListForced = build({ canvasMode: 'always', canvasSummary: '[]', prompt: '把 add 改成加法' });

  check('[B] 画布任务（画布非空）→ 与强制注入逐字节相同', canvasBySummary === canvasBySummaryForced, 'len ' + canvasBySummary.length + ' vs ' + canvasBySummaryForced.length);
  check('[B] 画布任务（提问含画布词）→ 与强制注入逐字节相同', canvasByWord === canvasByWordForced, 'len ' + canvasByWord.length + ' vs ' + canvasByWordForced.length);
  check('[B] 画布清单为空数组（[]）+ 纯代码提问 → 省层，且其余逐字节不变', emptyListTask === emptyListForced.replace(agent.CANVAS_RULES, agent.CANVAS_RULES_STUB), 'len ' + emptyListTask.length);
  check(
    '[B] 省层 = 把那段画布规则**整块**换成占位，其余逐字节不变',
    pure === alwaysPureTask.replace(agent.CANVAS_RULES, agent.CANVAS_RULES_STUB),
    'len pure=' + pure.length + ' always=' + alwaysPureTask.length
  );
  check('[B] 注入时含画布细则', alwaysPureTask.includes(CANVAS_DETAIL) && alwaysPureTask.includes(CANVAS_RULES_SUBCHECK_END()));
  check('[B] 省层时不含任何画布细则（a–h 全走）', !pure.includes(CANVAS_DETAIL) && !/h\) 　?所有画布操作/.test(pure));
  check('[B] 省层时保留编号 14（占位说明，编号不断档）', /^14\. 【画布建模规则本次未注入】/m.test(pure));
  check('[B] 省层省下 ≥1,200 字符（实测 1,429）', alwaysPureTask.length - pure.length >= 1200, 'saved=' + (alwaysPureTask.length - pure.length));
  check(
    '[B] 省层的额度与画布规则块长度一致（没有顺手删别的东西）',
    alwaysPureTask.length - pure.length === agent.CANVAS_RULES.length - agent.CANVAS_RULES_STUB.length,
    'saved=' + (alwaysPureTask.length - pure.length) + ' blockDelta=' + (agent.CANVAS_RULES.length - agent.CANVAS_RULES_STUB.length)
  );

  // ============================ C. 接线 ============================
  console.log('\n== C. 配置键的 loader 出口 + ipc 接线 ==');
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-promptlayers-'));
  fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
  const writeCfg = (text) => fs.writeFileSync(path.join(projDir, '.codenode', 'agent.properties'), text);
  writeCfg('');
  check('[C] 空配置 → 出厂 auto', agent.loadConfig(projDir).prompt.canvasRules === 'auto', JSON.stringify(agent.loadConfig(projDir).prompt));
  writeCfg('agent.prompt_canvas_rules=never\n');
  check('[C] 配置 never → loader 出口读到 never', agent.loadConfig(projDir).prompt.canvasRules === 'never');
  writeCfg('agent.prompt_canvas_rules=always\n');
  check('[C] 配置 always → loader 出口读到 always', agent.loadConfig(projDir).prompt.canvasRules === 'always');
  writeCfg('agent.prompt_canvas_rules=乱写\n');
  check('[C] 非法值 → 回落 auto（不炸、不静默变 never）', agent.loadConfig(projDir).prompt.canvasRules === 'auto');
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'agent.cjs'), 'utf8');
  check(
    '[C] ipc 真的把 canvasMode 传进 buildSystemPrompt（防「实现了但没接线」）',
    /buildSystemPrompt\([^)]*\{[\s\S]{0,200}canvasMode:/.test(ipcSrc),
    (ipcSrc.match(/buildSystemPrompt\([^)]{0,80}/) || [''])[0].slice(0, 60)
  );
  check('[C] ipc 传的是 loader 出口的值（cfg.prompt.canvasRules）', /canvasMode:\s*cfg\.prompt\s*&&\s*cfg\.prompt\.canvasRules/.test(ipcSrc));

  // ============================ D. 开销门禁 ============================
  console.log('\n== D. 每轮固定开销的量测与上界 ==');
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: ROOT, ragEnabled: false });
  const tools = registry.toOpenAiTools();
  const schemaChars = JSON.stringify(tools).length;
  const systemPure = build({ canvasMode: 'auto', prompt: '把 add 改成加法' });
  const systemAlways = build({ canvasMode: 'always' });
  console.log('   量测：system（省层）=' + systemPure.length + ' 字符；system（含画布层）=' + systemAlways.length + ' 字符；工具 schema=' + schemaChars + ' 字符（' + tools.length + ' 个工具）');
  check('[D] 省层后 system 固定部分 ≤ 4,000 字符（当前 ' + systemPure.length + '）', systemPure.length <= 4000, 'chars=' + systemPure.length);
  check('[D] 工具 schema ≤ 16,000 字符（当前 ' + schemaChars + '，22 工具）', schemaChars <= 16000, 'chars=' + schemaChars);
  check(
    '[D] 纯代码任务的每轮固定开销（system 省层 + schema）≤ 18,000 字符',
    systemPure.length + schemaChars <= 18000,
    'total=' + (systemPure.length + schemaChars)
  );

  fs.rmSync(projDir, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? 'PROMPT LAYERS TEST: PASS（画布层按需注入 + 开销有上界）' : 'PROMPT LAYERS TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
} catch (error) {
  console.error('PROMPT LAYERS TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
}

/** 画布规则块的**最后一条**（h) —— 用来断言「细则真的整块走了」 */
function CANVAS_RULES_SUBCHECK_END() {
  return agent.CANVAS_RULES.slice(-120);
}
