/**
 * fixture-shape-test.cjs —— 「用例输入是否与生产同形」的门禁（增量审查 §4.4）
 *
 * 背景：本仓库的变异测试纪律很强，但同一个「判据被 fixture 形状蒙住」的模式至少出现过三次：
 *   ① `context-budget-test.cjs` 的 tool fixture **自带 `name`**，而生产消息当时没有（掩盖 #22）；
 *   ② `compression-batch-test.cjs` 把「截断」断言成「信息不丢」（掩盖 #11）；
 *   ③ `agent-resume-test.cjs` 只断言「有 system / 有断点续跑字样」，不校验结构合法性（掩盖 #2）。
 * ②③ 已由各自的用例收口，**但缺一道门禁防止它们（或同类）再回来** —— 本文件就是那道门禁。
 *
 * 口径（都落在**真实跑出来的请求体／真实重建的消息**上，不靠约定）：
 *   A. 用真实工具循环跑一轮，从**真实请求体**里取生产生成的 tool 消息，得到其**字段集**；
 *      字段集必须逐字等于本文件声明的 `PRODUCTION_TOOL_KEYS`（生产端加/删字段 → 这条当场红，
 *      逼作者同步用例与裁剪层；这正是「同形」的意思）。
 *   B. 同一份历史走**续跑重建**（saveMessages → readCheckpoints → buildResumeMessages），
 *      重建后的 tool 消息字段集必须与 A **完全一致**（本节抓出过一个真缺陷：
 *      `buildResumeMessages` 重建时丢掉 `name`，使硬裁剪占位符退化成「此处原本是**工具**的结果」）。
 *   C. 静态扫描用例源码里手写的 `{ role: 'tool', ... }` 字面量：其键集必须是生产键集的**子集**
 *      （不许出现生产没有的字段）；`REQUIRE_FULL_SHAPE` 列出的用例（测的正是这些字段的行为）
 *      必须**逐字段齐全**。
 *   D. 自检：A 段真的抓到了 tool 消息、C 段真的扫到了字面量 —— 否则整份门禁是空转。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const runCheckpoint = require('../electron/runCheckpoint.cjs');
const runStore = require('../electron/runStore.cjs');
const { SideEffectLedger } = require('../electron/sideEffects.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** 生产 tool 消息的字段集（唯一权威表述；生产端改动必须在这里同步） */
const PRODUCTION_TOOL_KEYS = ['content', 'name', 'role', 'tool_call_id'];

/** 这些用例测的就是「裁剪占位符 / 工具名」本身 → fixture 必须逐字段齐全，不许只给子集 */
const REQUIRE_FULL_SHAPE = ['scripts/context-budget-test.cjs'];

/** 扫描范围：所有用例源码（含 lib）。本文件自身排除 —— 它在 D 段用字面量做解析器自检，
 *  那两处 `{ role: 'tool', ..., meta: {...} }` 是**被测样本**，不是 fixture。 */
const SELF = 'scripts/fixture-shape-test.cjs';
function testSources() {
  const dir = path.join(__dirname);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.cjs') && name.includes('-test')) out.push(path.join(dir, name));
  }
  for (const name of fs.readdirSync(path.join(dir, 'lib'))) {
    if (name.endsWith('.cjs')) out.push(path.join(dir, 'lib', name));
  }
  return out.filter((file) => path.relative(path.join(dir, '..'), file).replace(/\\/g, '/') !== SELF);
}

/**
 * 从源码里抽 `{ role: 'tool', ... }` 对象字面量的**顶层键名**。
 * 用平衡括号扫描（不跨字符串就算了，夹具都是简单字面量），返回 [{ line, keys }]。
 */
function toolMessageLiterals(src) {
  const found = [];
  const re = /\{\s*role:\s*'tool'/g;
  let match;
  while ((match = re.exec(src))) {
    let depth = 0;
    let index = match.index;
    for (; index < src.length; index++) {
      const ch = src[index];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(match.index, index + 1);
    // 顶层键：按逗号切分后取 `key:`（排除嵌套对象里的键 —— 用括号深度过滤）
    const keys = [];
    let inner = 0;
    let token = '';
    const flush = () => {
      const trimmed = token.trim();
      // 支持 `key: value` 与**简写属性**（`name,` / `content,` —— 本仓库的 fixture 用的正是简写）
      const keyMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
      if (keyMatch) keys.push(keyMatch[1]);
      token = '';
    };
    for (let i = 1; i < body.length - 1; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '[' || ch === '(') inner++;
      else if (ch === '}' || ch === ']' || ch === ')') inner--;
      if (ch === ',' && inner === 0) {
        flush();
        continue;
      }
      token += ch;
    }
    flush();
    const line = src.slice(0, match.index).split('\n').length;
    found.push({ line, keys });
  }
  return found;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shape-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'CONTENT-1\n');
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

async function runOneTurn() {
  const controller = new AbortController();
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: controller.signal,
  });
  const stub = installScriptedModel(
    [
      { toolCalls: [{ name: 'read_file', args: { path: 'work/a.txt' } }] },
      { content: '已完成：读到了 CONTENT-1。' },
    ],
    { loopLast: false }
  );
  try {
    const result = await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1',
        apiKey: '',
        model: 'scripted-model',
        maxTokens: 1024,
        reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
        limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
        compression: { enabled: false },
        rag: { enabled: false },
        tools: {},
      },
      messages: [
        { role: 'system', content: '测试用 system' },
        { role: 'user', content: '读一下 work/a.txt' },
      ],
      tools: {
        registry: toolkit.buildDefaultRegistryWithConfig({
          projectRoot: root,
          ragEnabled: false,
          toolsAllowed: ['read_file'],
        }),
        context,
      },
      signal: controller.signal,
      timeoutMs: 20000,
    });
    return { result, seen: stub.seen || [] };
  } finally {
    stub.restore();
  }
}

(async () => {
  // ============================ A. 生产形状（真实请求体） ============================
  console.log('== A. 主循环生成 tool 消息的字段集（从真实请求体取） ==');
  const { result, seen } = await runOneTurn();
  const secondRequest = seen[1] && seen[1].messages ? seen[1].messages : [];
  const producedToolMessages = secondRequest.filter((message) => message && message.role === 'tool');
  check('[A] 真实跑出了一轮（第二个请求里含 tool 消息）', producedToolMessages.length === 1, 'toolCount=' + producedToolMessages.length + ' seenRequests=' + seen.length);
  const producedKeys = producedToolMessages[0] ? Object.keys(producedToolMessages[0]).sort() : [];
  check(
    '[A] 生产 tool 消息字段集 == 声明的权威字段集（生产端加/删字段必须同步这里与用例）',
    JSON.stringify(producedKeys) === JSON.stringify(PRODUCTION_TOOL_KEYS),
    'actual=' + JSON.stringify(producedKeys) + ' declared=' + JSON.stringify(PRODUCTION_TOOL_KEYS)
  );
  check(
    '[A] `name` 真的是工具名（不是空串/undefined）',
    producedToolMessages[0] && producedToolMessages[0].name === 'read_file',
    JSON.stringify(producedToolMessages[0] && producedToolMessages[0].name)
  );
  check('[A] 循环正常收尾（不是为了截图截断流）', result && String(result.content || '').includes('CONTENT-1'), JSON.stringify(String((result || {}).content || '').slice(0, 60)));

  // ============================ B. 续跑重建必须同形 ============================
  console.log('\n== B. 续跑重建（planResume → buildResumeMessages）必须与 A 同形 ==');
  const resumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shape-resume-'));
  const runId = runStore.normalizeRunId('shape-probe');
  runStore.startRun(resumeRoot, runId, { prompt: '读一下 work/a.txt', model: 'scripted-model' });
  runCheckpoint.saveMessages(resumeRoot, runId, secondRequest, { reason: 'round_end' });
  // 走**生产同款路径**：planResume（带幂等账本）→ buildResumeMessages
  const plan = runCheckpoint.planResume(resumeRoot, runId, {
    ledger: new SideEffectLedger({ projectRoot: resumeRoot, scopeRunId: runId }),
  });
  check('[B] planResume 产出可续跑的计划（否则本节无从判定）', plan && plan.ok === true, JSON.stringify({ ok: plan && plan.ok, mode: plan && plan.mode, error: plan && plan.error }));
  const resumed = runCheckpoint.buildResumeMessages(plan, { systemPrompt: 'SYS' });
  const resumedToolMessages = resumed.filter((message) => message && message.role === 'tool');
  const resumedKeys = resumedToolMessages[0] ? Object.keys(resumedToolMessages[0]).sort() : [];
  check('[B] 重建后仍有 tool 消息（可判定）', resumedToolMessages.length === 1, 'count=' + resumedToolMessages.length);
  check(
    '[B] 重建后的字段集 == 主循环的字段集（此前 `name` 在这里被丢掉）',
    JSON.stringify(resumedKeys) === JSON.stringify(PRODUCTION_TOOL_KEYS),
    'resumed=' + JSON.stringify(resumedKeys)
  );
  check(
    '[B] 重建后 `name` 仍是原工具名（硬裁剪占位符才能写清是哪个工具）',
    resumedToolMessages[0] && resumedToolMessages[0].name === 'read_file',
    JSON.stringify(resumedToolMessages[0] && resumedToolMessages[0].name)
  );
  check('[B] 重建后配对仍合法（没为同形破坏结构）', runCheckpoint.isToolPairingValid(resumed) === true);
  check('[B] 重建后的正文未被改写', resumedToolMessages[0] && String(resumedToolMessages[0].content).length > 0);

  // ============================ C. 用例 fixture 与生产同形 ============================
  console.log('\n== C. 用例源码里手写的 tool 消息字面量必须与生产同形 ==');
  const productionSet = new Set(PRODUCTION_TOOL_KEYS);
  let literalTotal = 0;
  const offenders = [];
  const missingFull = [];
  for (const file of testSources()) {
    const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    for (const literal of toolMessageLiterals(src)) {
      literalTotal++;
      const extra = literal.keys.filter((key) => !productionSet.has(key));
      if (extra.length) offenders.push(rel + ':' + literal.line + ' 多出字段 ' + JSON.stringify(extra));
      if (REQUIRE_FULL_SHAPE.includes(rel)) {
        const missing = PRODUCTION_TOOL_KEYS.filter((key) => !literal.keys.includes(key));
        if (missing.length) missingFull.push(rel + ':' + literal.line + ' 缺字段 ' + JSON.stringify(missing));
      }
    }
  }
  check('[C] 没有任何 fixture 使用生产不存在的字段', offenders.length === 0, offenders.join(' | '));
  check(
    '[C] 声明「必须齐全」的用例（测裁剪/工具名本身）逐字段齐全',
    missingFull.length === 0,
    missingFull.join(' | ')
  );

  // ============================ D. 自检：门禁本身不许空转 ============================
  console.log('\n== D. 自检（防空转） ==');
  check('[D] 扫描器真的扫到了字面量（≥3 处，否则 C 段是空转）', literalTotal >= 3, 'total=' + literalTotal);
  check('[D] `REQUIRE_FULL_SHAPE` 里的文件确实存在且真的含字面量', REQUIRE_FULL_SHAPE.every((rel) => {
    const file = path.join(__dirname, '..', rel);
    return fs.existsSync(file) && toolMessageLiterals(fs.readFileSync(file, 'utf8')).length > 0;
  }));
  check('[D] 解析器对嵌套对象不误判（键只取顶层）', (() => {
    const sample = "{ role: 'tool', tool_call_id: 'x', name: 'n', content: 'c', meta: { role: 'assistant', deep: { a: 1 } } }";
    const keys = toolMessageLiterals(sample)[0].keys;
    return JSON.stringify(keys) === JSON.stringify(['role', 'tool_call_id', 'name', 'content', 'meta']);
  })(), 'sample=[' + toolMessageLiterals("{ role: 'tool', tool_call_id: 'x', name: 'n', content: 'c', meta: { role: 'assistant', deep: { a: 1 } } }")[0].keys.join(',') + ']');

  try {
    fs.rmSync(resumeRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }

  console.log('\n' + (failures === 0 ? 'FIXTURE SHAPE TEST: PASS（生产与用例同形）' : 'FIXTURE SHAPE TEST: FAIL —— ' + failures + ' 项断言未通过'));
  if (failures) process.exit(1);
})().catch((error) => {
  console.error('FIXTURE SHAPE TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
