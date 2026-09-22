#!/usr/bin/env node
/**
 * compaction-tail-test.cjs —— P1-4（compaction 保留「最近无损操作尾部」）的回归判据
 *
 * 审计指出的不足：压缩后的新历史是 `[system, 保留的人的话, 一个摘要]`，**没有保留最近若干完整的
 * assistant/tool 操作组** —— 摘要一写，「刚才那次精确的 edit_file 到底改了什么」就没了。
 *
 * 现在的口径：
 *   ① 结构 = `[system] → [人说过的话] → [新摘要信封] → [最近无损操作组（逐字）]`；
 *   ② **原子性**：一个操作组 = `assistant(tool_calls)` + `tool_call_id` 对得上的 `tool` 结果，
 *      绝不从中间切开；孤儿 tool 消息一条都不留（交坏消息比少给一条更糟）；
 *   ③ 按 token 预算整组取，单组超预算时仍保留该组（原子性优先于预算）并如实标注；
 *   ④ 触发线统一进公式 `min(window×ratio, inputLimit−buffer, window−max(outputReserve, buffer))`，
 *      三个新输入不配时行为与旧版逐字一致（负向判据）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const compaction = require('../electron/compaction.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
  if (!ok) failures++;
}

const sys = { role: 'system', content: 'system 提示' };
const human = { role: 'user', content: '请改一下 a.txt' };
const op1 = {
  a: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
  t1: { role: 'tool', name: 'read_file', tool_call_id: 'c1', content: 'ORIGINAL-1' },
};
const op2 = {
  a: { role: 'assistant', content: '我改一下', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.txt"}' } }] },
  t1: { role: 'tool', name: 'edit_file', tool_call_id: 'c2', content: 'EDITED-OK' },
  t2: { role: 'tool', name: 'read_file', tool_call_id: 'c2b', content: 'ORPHAN-TOOL-RESULT' },
};
const tailUser = { role: 'user', content: '顺便解释一下' };

/** 每个 tool 消息都能找到配对的 assistant tool_call（供应商不接受孤儿 tool 消息） */
function pairsIntact(messages) {
  const ids = new Set();
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.id) ids.add(c.id);
    if (m && m.role === 'tool' && !ids.has(m.tool_call_id)) return false;
  }
  return true;
}

// ============================ A. 原子性与内容 ============================
console.log('== A. 无损尾部：原子操作组 ==');
{
  const messages = [sys, human, op1.a, op1.t1, op2.a, op2.t1, op2.t2, tailUser];
  const tail = compaction.buildLosslessTail(messages, { tokenBudget: 100000 });
  const roles = tail.messages.map((m) => (m.role === 'assistant' ? 'A(' + (m.tool_calls ? m.tool_calls.map((c) => c.id).join('/') : '-') + ')' : m.role === 'tool' ? 'T(' + m.tool_call_id + ')' : 'U'));
  check('[A] 尾部按时间顺序取回、且**不出现孤儿 tool 结果**（c2b 没有配对调用 → 丢掉）',
    pairsIntact(tail.messages) && !tail.messages.some((m) => m.content === 'ORPHAN-TOOL-RESULT'), JSON.stringify(roles));
  check('[A] 操作组原样逐字保留（assistant 调用 + 配对结果都在）',
    tail.messages.some((m) => m.content === 'ORIGINAL-1') &&
    tail.messages.some((m) => m.content === 'EDITED-OK') &&
    tail.messages.filter((m) => m.role === 'assistant' && m.tool_calls).length === 2, JSON.stringify(roles));
  check('[A] 人说的话与最后的 pending 消息也在尾部里（顺序不乱）',
    tail.messages[0] === human && tail.messages[tail.messages.length - 1] === tailUser, JSON.stringify(roles));
  check('[A] token 估算是正数、组数 = 4（human / op1 / op2 / tailUser）', tail.tokens > 0 && tail.groups === 4, JSON.stringify({ tokens: tail.tokens, groups: tail.groups }));
}

// ============================ B. 预算与原子性冲突 ============================
console.log('\n== B. 预算用完时整组停（绝不切开一次工具调用） ==');
{
  const big = { role: 'tool', name: 'read_file', tool_call_id: 'cb', content: 'X'.repeat(40000) };
  const heavy = { role: 'assistant', content: '', tool_calls: [{ id: 'cb', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
  const messages = [sys, human, heavy, big, { role: 'user', content: '最后一句' }];
  /**
   * 小预算下的两种口径（默认 = 最新操作逐字优先；严格 = 尊重预算）：
   * 默认会把「装不下但最新」的那个大组也留下来（并标记 oversized），严格口径则整组丢弃。
   * 两种都必须**不剩半个操作组**，被丢掉的组数也要如实报出。
   */
  const tight = compaction.buildLosslessTail(messages, { tokenBudget: 500 });
  check('[B] 小预算（默认）：最新的大组也留（标记 oversized），且不剩半个操作组',
    pairsIntact(tight.messages) && tight.messages.includes(heavy) && tight.messages.includes(big) && tight.oversized === true,
    JSON.stringify({ roles: tight.messages.map((m) => m.role), oversized: tight.oversized }));
  check('[B] 被丢掉的组数如实报出（默认丢 1 组：更早的人话）', tight.droppedGroups === 1, String(tight.droppedGroups));
  const tightStrict = compaction.buildLosslessTail(messages, { tokenBudget: 500, allowOversized: false });
  check('[B] 小预算（严格）：超预算的大组整组丢弃，丢组数如实报出',
    pairsIntact(tightStrict.messages) && !tightStrict.messages.includes(heavy) && tightStrict.droppedGroups >= 2,
    JSON.stringify({ roles: tightStrict.messages.map((m) => m.role), dropped: tightStrict.droppedGroups }));
  /**
   * 单个操作组超预算的**两种取法都要能被显式选中**（默认尊重预算）：
   *   - 默认：不要这一组（压缩的意义是把上下文压下来；放进来会让下一轮立刻又踩触发线），
   *     标记 oversized 让调用方知道「这里有东西被预算挡掉了」；
   *   - allowOversized=true：整组保留（最新操作逐字优先）。两种情况下都**不切开**这一组。
   */
  const oversizedDefault = compaction.buildLosslessTail(messages, { tokenBudget: 100 });
  check('[B] 单组超预算（默认）→ 整组保留、标记 oversized、不留半个操作组（最新操作逐字优先）',
    oversizedDefault.oversized === true && oversizedDefault.messages.includes(heavy) && oversizedDefault.messages.includes(big) &&
    pairsIntact(oversizedDefault.messages),
    JSON.stringify({ oversized: oversizedDefault.oversized, roles: oversizedDefault.messages.map((m) => m.role) }));
  const oversizedStrict = compaction.buildLosslessTail(messages, { tokenBudget: 100, allowOversized: false });
  check('[B] 单组超预算（严格口径 allowOversized=false）→ 不要这一组，尾部到此为止',
    oversizedStrict.oversized === true && !oversizedStrict.messages.includes(heavy) && pairsIntact(oversizedStrict.messages),
    JSON.stringify({ oversized: oversizedStrict.oversized, roles: oversizedStrict.messages.map((m) => m.role) }));
  check('[B] 负向：预算为 0 → 不保留尾部（旧行为）',
    compaction.buildLosslessTail(messages, { tokenBudget: 0 }).messages.length === 0);
}

// ============================ C. 压缩后的历史结构 ============================
console.log('\n== C. buildCompactedHistory 的新结构 ==');
{
  const messages = [sys, human, op1.a, op1.t1, op2.a, op2.t1, op2.t2, tailUser];
  const rebuilt = compaction.buildCompactedHistory({ systemMessage: sys, messages, summary: '摘要正文', keepTailTokens: 100000 });
  const kinds = rebuilt.messages.map((m) => m.role);
  const summaryAt = rebuilt.messages.findIndex((m) => /<compaction>/.test(String(m.content || '')));
  const tailAt = rebuilt.messages.indexOf(human);
  check('[C] 顺序：system →（尾部之前的人话）→ 摘要信封 → 无损操作组（最新的在最后）',
    kinds[0] === 'system' && summaryAt > 0 && tailAt > summaryAt &&
    rebuilt.messages[kinds.length - 1] === tailUser &&
    !rebuilt.messages.slice(0, summaryAt).some((m) => m.role === 'assistant' || m.role === 'tool'),
    JSON.stringify({ kinds, summaryAt, tailAt }));
  check('[C] 最新的人话不会重复出现两遍（尾部里有了，就不再从 keptUserTurns 里再来一条）',
    rebuilt.messages.filter((m) => m === human).length === 1 && rebuilt.messages.filter((m) => m === tailUser).length === 1,
    JSON.stringify(rebuilt.messages.map((m) => String(m.content).slice(0, 12))));
  check('[C] 尾部内容逐字在（EDITED-OK / ORIGINAL-1 都能找到）',
    rebuilt.messages.some((m) => m.content === 'ORIGINAL-1') && rebuilt.messages.some((m) => m.content === 'EDITED-OK'));
  check('[C] 整个新历史仍然没有孤儿 tool 消息', pairsIntact(rebuilt.messages));
  check('[C] 尾部统计进了返回值（trace 能报出来）',
    rebuilt.tailGroups === 4 && rebuilt.tailTokens > 0 && rebuilt.tailDroppedGroups === 0,
    JSON.stringify({ groups: rebuilt.tailGroups, tokens: rebuilt.tailTokens, dropped: rebuilt.tailDroppedGroups }));
  const legacy = compaction.buildCompactedHistory({ systemMessage: sys, messages, summary: '摘要正文' });
  check('[C] 负向：keepTailTokens 为 0 → 消息结构与旧版一致（system + 人话 + 摘要，**没有** assistant/tool 消息）',
    legacy.messages.length === 4 && legacy.messages[0] === sys && !legacy.messages.some((m) => m.role === 'assistant' || m.role === 'tool') &&
    legacy.keptUserTurns === 2 && legacy.tailGroups === 0 && legacy.tailTokens === 0,
    JSON.stringify({ len: legacy.messages.length, roles: legacy.messages.map((m) => m.role), groups: legacy.tailGroups }));
}

// ============================ D. 触发公式 ============================
console.log('\n== D. 触发线：统一公式 ==');
{
  const base = { tokens: 100000, contextWindow: 128000, ratio: 0.9, compressible: 3 };
  const old = compaction.shouldCompact(base);
  check('[D] 负向：不配新输入 → limit 仍是 window × ratio（行为逐字一致）', old.limit === 115200 && old.needed === false, JSON.stringify(old));
  const withReserve = compaction.shouldCompact({ ...base, outputReserve: 32000 });
  check('[D] 输出预留 32k → 触发线降到 window − 32k = 96000（更早压）',
    withReserve.limit === 96000 && withReserve.needed === true, JSON.stringify(withReserve));
  const withBuffer = compaction.shouldCompact({ ...base, buffer: 8000 });
  check('[D] 只配 buffer 8k → 触发线 min(115200, 120000) = 115200（默认不改变行为）',
    withBuffer.limit === 115200, JSON.stringify(withBuffer));
  const withInput = compaction.shouldCompact({ ...base, inputLimit: 100000, buffer: 8000 });
  check('[D] 输入上限 100k − buffer 8k = 92000 → 更早压',
    withInput.limit === 92000 && withInput.needed === true, JSON.stringify(withInput));
  check('[D] 公式取三者最小：min(ratio 线, 输入上限−buffer, 窗口−max(输出预留,buffer))',
    compaction.shouldCompact({ ...base, inputLimit: 110000, outputReserve: 40000, buffer: 8000 }).limit === 88000);
  check('[D] 没有任何可压内容时仍然不动手（nothing-to-compact 优先）',
    compaction.shouldCompact({ ...base, compressible: 0, outputReserve: 32000 }).reason === 'nothing-to-compact');
}

// ============================ E. 配置接线 ============================
console.log('\n== E. 配置与接线 ==');
{
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tail-cfg-'));
  fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
  const writeCfg = (text) => fs.writeFileSync(path.join(projDir, '.codenode', 'agent.properties'), text);
  writeCfg('');
  const d = agent.loadConfig(projDir).compaction;
  check('[E] 出厂：尾部 12k（审计建议区间 8k~15k）、buffer 8k、输入上限 0（不额外约束）',
    d.tailTokens === 12000 && d.bufferTokens === 8000 && d.inputLimit === 0,
    JSON.stringify({ tail: d.tailTokens, buffer: d.bufferTokens, input: d.inputLimit }));
  check('[E] 审计建议的 8k~15k 区间成立', d.tailTokens >= 8000 && d.tailTokens <= 15000);
  writeCfg('agent.compact.tail_tokens=0\nagent.compact.buffer_tokens=0\n');
  const off = agent.loadConfig(projDir).compaction;
  check('[E] 可关可调：tail_tokens=0（不保留尾部）+ buffer 0（回到纯 ratio 判定）',
    off.tailTokens === 0 && off.bufferTokens === 0);
  check('[E] 出厂 = 最新操作逐字优先（tail_allow_oversized 默认 true）', d.tailAllowOversized === true);
  writeCfg('agent.compact.tail_allow_oversized=false\n');
  check('[E] 可以显式改成「严格尊重预算」', agent.loadConfig(projDir).compaction.tailAllowOversized === false);
  writeCfg('agent.compact.tail_tokens=999999\n');
  check('[E] 超区间被夹到上界（15k，不让尾部把预算吃光）', agent.loadConfig(projDir).compaction.tailTokens === 15000);

  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent.cjs'), 'utf8');
  check('[E] 接线：尾部预算进了重建历史、触发判定带三个新输入、且「压不下来」时用严格预算重算一次',
    /buildHistory\(compactionCfg\.tailTokens\)/.test(src) &&
    /keepTailTokens: tailBudget/.test(src) &&
    /rebuilt = buildHistory\(nextTail, true\)/.test(src) &&
    /inputLimit: compactionCfg\.inputLimit/.test(src) &&
    /outputReserve: Number\(cfg\.maxTokens\) \|\| 0/.test(src) &&
    /buffer: compactionCfg\.bufferTokens/.test(src));
}

// ============================ F. 端到端：真压缩 + 「必须真的压下来」 ============================
(async () => {
  console.log('\n== F. 端到端：尾部进真历史 / 压不下来时自动收窄 ==');
  const sandbox = require('../electron/sandbox.cjs');
  const toolkit = require('../electron/tools/toolkit.cjs');
  const costLedger = require('../electron/costLedger.cjs');
  const { AgentToolContext } = require('../electron/tools/context.cjs');
  const { installScriptedModel } = require('./lib/scripted-model.cjs');

  const zh = (n) => '中'.repeat(n);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-tail-e2e-'));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'ok\n');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);

  /**
   * 造一段「刚过线」的历史：**多个**完整操作组（每组 ≈10k token），每组都能装进 12k 的尾部预算。
   * 第一版夹具只造了一个 105k token 的巨组 —— 那种组无论怎么保留都放不进尾部，
   * 测出来的其实是「收窄兜底」，不是「尾部生效」。
   */
  function history(groups) {
    const out = [{ role: 'system', content: '你是测试用 system' }, { role: 'user', content: '第一轮：看看 a.txt' }];
    for (let i = 1; i <= groups; i++) {
      out.push({
        role: 'assistant',
        content: zh(200),
        tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"work/a.txt"}' } }],
      });
      out.push({ role: 'tool', name: 'read_file', tool_call_id: 'call_' + i, content: zh(9200) });
    }
    out.push({ role: 'user', content: '第二轮：继续' });
    return out;
  }

  async function runCompaction({ contextWindow, tailTokens, groups, runId }) {
    const controller = new AbortController();
    const context = new AgentToolContext({
      projectRoot: root, confirm: async () => true, audit: () => {}, askUser: async () => '',
      ragConfig: { enabled: false }, sandbox: policy, signal: controller.signal,
    });
    const ledger = new costLedger.CostLedger({ projectRoot: root, runId });
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
    const stub = installScriptedModel(
      [
        { content: '<compaction>摘要：已读过 a.txt，下一步检查 b.txt', finishReason: 'stop' },
        { content: '按摘要继续完成。', finishReason: 'stop' },
      ],
      { loopLast: false },
    );
    let sent = null;
    try {
      await agent.runAgentChat({
        cfg: {
          apiBase: 'http://scripted.local/v1', apiKey: 'test-key-not-real', model: 'scripted-model',
          maxTokens: 2048, reasoningEffort: '',
          reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2, streamMaxAttempts: 0 },
          limits: { ...agent.loadConfig(root).limits, maxTotalTokens: 10000000, maxConcurrentRuns: 1 },
          compression: { enabled: false },
          context: { enabled: false },
          compaction: { ...agent.parseCompactionConfig({}), tailTokens, ratio: 0.9, bufferTokens: 8000 },
          contextWindow,
          rag: { enabled: false }, tools: {},
          costLedger: ledger, costRunId: runId,
        },
        messages: history(groups),
        tools: { registry, context },
        signal: controller.signal,
        timeoutMs: 30000,
      });
      sent = stub.seen[1] ? stub.seen[1].messages : null;
    } finally {
      stub.restore();
    }
    const traceFile = path.join(root, '.codenode', 'tools_trace.jsonl');
    const traces = fs.existsSync(traceFile)
      ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((t) => t.runId === runId)
      : [];
    return { sent, compaction: traces.filter((t) => t.kind === 'compaction_done').pop(), calls: stub.calls };
  }

  // F1：窗口够大 → 尾部原样进历史（操作组逐字在）
  const f1 = await runCompaction({ contextWindow: 40000, tailTokens: 12000, groups: 5, runId: 'run-tail-fit' });
  check('[F] 够大窗口：压缩后主请求真的发出去了（没有被预检判超窗）', !!f1.sent && f1.calls === 2, 'calls=' + f1.calls);
  check('[F] 够大窗口：尾部进了历史（assistant 调用 + 配对结果逐字在，且没被收窄）',
    !!f1.compaction && f1.compaction.tailTokens > 0 && f1.compaction.tailShrunk === false &&
    f1.sent.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) &&
    f1.sent.some((m) => m.role === 'tool' && String(m.content).startsWith('中')),
    f1.compaction ? JSON.stringify({ tail: f1.compaction.tailTokens, shrunk: f1.compaction.tailShrunk, limit: f1.compaction.limit, after: f1.compaction.tokensAfter }) : 'no-compaction');
  check('[F] 够大窗口：压缩确实把上下文压下来了（压后 < 触发线）',
    f1.compaction && f1.compaction.tokensAfter < f1.compaction.limit,
    f1.compaction ? JSON.stringify({ after: f1.compaction.tokensAfter, limit: f1.compaction.limit }) : 'missing');

  // F2：窗口紧 → 尾部必须自动收窄，否则压缩后仍在线下不了（下一轮立刻又压 / 直接被预检拦）
  const f2 = await runCompaction({ contextWindow: 13000, tailTokens: 12000, groups: 5, runId: 'run-tail-shrink' });
  check('[F] 紧窗口：尾部被自动收窄（tailShrunk=true）而不是硬塞进去',
    !!f2.compaction && f2.compaction.tailShrunk === true, f2.compaction ? JSON.stringify({ tail: f2.compaction.tailTokens, shrunk: f2.compaction.tailShrunk }) : 'no-compaction');
  check('[F] 紧窗口：收窄之后**确实到了线下**（这是压缩的意义）',
    f2.compaction && f2.compaction.tokensAfter < f2.compaction.limit,
    f2.compaction ? JSON.stringify({ after: f2.compaction.tokensAfter, limit: f2.compaction.limit }) : 'missing');
  check('[F] 紧窗口：主请求仍然发得出去（没有被预检拦下）', !!f2.sent && f2.calls === 2, 'calls=' + f2.calls);

  console.log('\n' + (failures === 0 ? 'COMPACTION TAIL TEST: PASS（无损操作尾部逐字保留 + 原子配对 + 统一触发公式 + 压不下来会自动收窄）' : 'COMPACTION TAIL TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('COMPACTION TAIL TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
