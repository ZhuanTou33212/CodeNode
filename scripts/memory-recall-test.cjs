/**
 * memory-recall-test.cjs —— 项目记忆的「检索」而非「时间切片」（任务单第 5 项）的回归用例
 *
 * 缺陷：system prompt 注入的是 `memory.entries.slice(-30)` —— **纯按写入时间取最近 30 条**，
 * key/tags 完全不参与打分。项目约定写在第 31 条之前就永远进不了提示（写了但读不到），
 * 而最近的 30 条可能全是无关的临时记录。
 *
 * 修复：electron/memory.cjs 增加 tokenize / scoreEntry / selectRelevant / buildMemoryText
 * （英文按词、中文按 2-gram；key×6、tags×4、content×2；**一条都没命中时才退回最近 N 条**，
 * 并在文本里如实说明「未按当前问题检索」），ipc/agent.cjs 的注入与 recall 工具共用它。
 *
 * 产品契约（如实标注，不夸大）：这仍然是**项目级**记忆，不是跨项目用户记忆，也没有语义向量检索。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memory = require('../electron/memory.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-memory-'));

function entry(id, key, content, tags) {
  return { id, key, content, tags: tags || [], createdAt: '2026-09-01T00:00:00.000Z' };
}

(async () => {
  // ======================= A. 分词与打分 =======================
  {
    const terms = memory.tokenize('缓存命中率 cache_hit 怎么算');
    check('A1 中文按 2-gram、英文/下划线按词切',
      terms.includes('缓存') && terms.includes('命中') && terms.includes('cache_hit') && terms.length >= 5, JSON.stringify(terms));
    const keyHit = memory.scoreEntry(entry('1', 'cache', '与缓存有关的一段话'), memory.tokenize('cache'));
    const tagHit = memory.scoreEntry(entry('2', '', '无关内容', ['cache']), memory.tokenize('cache'));
    const contentHit = memory.scoreEntry(entry('3', '', '这里提到 cache 这个词'), memory.tokenize('cache'));
    check('A2 打分权重：key > tags > content', keyHit > tagHit && tagHit > contentHit && contentHit > 0,
      JSON.stringify({ key: keyHit, tag: tagHit, content: contentHit }));
  }

  // ======================= B. 选谁进提示 =======================
  {
    const entries = [entry('old', 'cache-policy', '命中前缀缓存时按 cached 价计费'), entry('new1', '', '今天改了个按钮颜色'), entry('new2', '', '顺手加了个日志')];
    const picked = memory.selectRelevant(entries, '前缀缓存命中怎么计价？', { limit: 1 });
    check('B1 相关但更旧的记忆排在新记录之前（这才是「检索」）',
      picked.matched === true && picked.entries.length === 1 && picked.entries[0].id === 'old',
      JSON.stringify({ matched: picked.matched, picked: picked.entries.map((item) => item.id) }));

    // 排序敏感性：两条都命中、但**高分的那条在数组更后面** → 必须按分数排到前面
    // （只按写入顺序排的实现会在这里露馅）
    const ranked = [entry('weak-old', '', '这里提到 cache 一次'), entry('strong-new', 'cache-policy', '缓存命中价按 cachedIn 计价')];
    const rankedPicked = memory.selectRelevant(ranked, 'cache 命中价怎么算', { limit: 2 });
    check('B1b 按分数排序（高分条目即使写入更晚也排最前）',
      rankedPicked.entries.length === 2 && rankedPicked.entries[0].id === 'strong-new',
      JSON.stringify(rankedPicked.scores));

    const none = memory.selectRelevant(entries, '完全不相关的提问 abs', { limit: 2 });
    check('B2 一条都不命中时退回最近的 N 条，并如实标记 matched=false（不编造相关性）',
      none.matched === false && none.entries.length === 2 && none.entries[1].id === 'new2', JSON.stringify({ matched: none.matched, ids: none.entries.map((item) => item.id) }));
  }

  // ======================= C. 注入文本 =======================
  {
    // 35 条：最旧的一条才是相关的 —— 旧实现 slice(-30) 会把它挤掉
    const entries = [entry('oldest-relevant', 'sandbox', '沙箱在 Windows 上用 Job Object 限额')];
    for (let i = 0; i < 34; i++) entries.push(entry('bulk-' + i, '', '无关记录 ' + i));
    const text = memory.buildMemoryText(entries, '沙箱限额怎么设', { limit: 30 });
    check('C1 第 1 条（最旧但相关）能被注入 —— 旧实现 slice(-30) 会丢掉它',
      text.includes('沙箱在 Windows 上用 Job Object 限额') && text.includes('[sandbox]'), text.slice(0, 60));
    check('C1b 命中时不加「未按问题检索」的说明（有相关性就别自谦）', !text.includes('未按当前问题检索'), text.slice(0, 20));

    const fallback = memory.buildMemoryText(entries, 'zzzz', { limit: 5 });
    check('C2 没命中时注入最近 5 条并显式说明是「最近保存的记忆」',
      fallback.includes('未按当前问题检索') && fallback.split('\n').length === 6, 'lines=' + fallback.split('\n').length);

    check('C3 空记忆不产生空标题', memory.buildMemoryText([], 'x') === '', JSON.stringify(memory.buildMemoryText([], 'x')));
  }

  // ======================= D. 真实工具链路（remember → recall） =======================
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['remember', 'recall'] });
    const context = new AgentToolContext({
      projectRoot: root,
      confirm: async () => true,
      audit: () => {},
      sandbox: null,
      signal: new AbortController().signal,
    });
    await registry.execute('remember', { content: '本项目的 UI 只用单一 accent 色', key: 'ui-design' }, context);
    for (let i = 0; i < 5; i++) await registry.execute('remember', { content: '无关记录 ' + i }, context);
    const res = await registry.execute('recall', { query: 'UI accent 配色约定' }, context);
    check('D1 recall 命中带 key 的那条（同参同源：与注入共用打分口径）',
      res.ok && String(res.text).includes('单一 accent 色') && res.data.matched === true, String(res.text).slice(0, 60));
    const miss = await registry.execute('recall', { query: 'zzzz-none' }, context);
    check('D2 无命中时不冒充检索结果：matched=false + 文本显式说明「没有关键词匹配，以下是最近保存的记忆」',
      miss.ok && miss.data.matched === false && String(miss.text).includes('没有关键词匹配') && String(miss.text).includes('未按查询检索'),
      JSON.stringify({ matched: miss.data.matched, text: String(miss.text).slice(0, 30) }));
    check('D3 落盘仍在项目 .codenode/memory.json（契约不变）',
      fs.existsSync(path.join(root, '.codenode', 'memory.json')), path.join(root, '.codenode', 'memory.json'));
  }

  // ======================= E. #16 记忆库损坏：绝不静默清空 =======================
  {
    const memFile = path.join(root, '.codenode', 'memory.json');
    memory.writeMemory(root, [entry('keep', 'k', '正常内容')]);
    const good = fs.readFileSync(memFile, 'utf8');

    const missing = memory.readMemory(path.join(root, 'no-such-project'));
    check('E1 「文件不存在」与「解析失败」必须区分：不存在 = ok/exists=false（全新项目仍可写）',
      missing.ok === true && missing.exists === false && missing.entries.length === 0,
      JSON.stringify({ ok: missing.ok, exists: missing.exists }));

    fs.writeFileSync(memFile, '{"version":1,"entries":[ {"id":"x"', 'utf8'); // 被截断的坏文件
    const corruptText = fs.readFileSync(memFile, 'utf8');
    const broken = memory.readMemory(root);
    check('E2 解析失败如实报 ok=false + MEMORY_CORRUPT（不再吞成空记忆库）',
      broken.ok === false && broken.exists === true && broken.code === 'MEMORY_CORRUPT' && broken.entries.length === 0,
      JSON.stringify({ ok: broken.ok, code: broken.code }));

    let refused = null;
    try { memory.writeMemory(root, [entry('new', 'k2', '新内容')]); } catch (error) { refused = error; }
    check('E3 损坏文件上 writeMemory 必须拒绝写入（抛错，而不是把整库覆盖成 1 条）',
      !!refused && /拒绝写入/.test(String(refused.message)), refused && refused.message);
    check('E4 坏文件必须原样保留（一字节都没被覆盖）', fs.readFileSync(memFile, 'utf8') === corruptText);

    const brokenRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['remember', 'recall'] });
    const brokenContext = new AgentToolContext({
      projectRoot: root,
      confirm: async () => true,
      audit: () => {},
      sandbox: null,
      signal: new AbortController().signal,
    });
    const rememberBroken = await brokenRegistry.execute('remember', { content: '不该写进去' }, brokenContext);
    check('E5 真实 remember 链路在坏文件上返回失败（不是虚假的成功）',
      rememberBroken.ok === false && !String(rememberBroken.text).includes('已保存'), JSON.stringify({ ok: rememberBroken.ok, text: String(rememberBroken.text).slice(0, 80) }));
    check('E6 走完 remember 之后坏文件仍然没被覆盖', fs.readFileSync(memFile, 'utf8') === corruptText);

    fs.writeFileSync(memFile, good, 'utf8');
    check('E7 修好文件后读取恢复 ok=true，写入恢复正常',
      memory.readMemory(root).ok === true && memory.writeMemory(root, [entry('after', 'k3', '修复后')]).ok === true);
  }

  // ======================= F. #15 记忆落盘脱敏 =======================
  {
    const memFile = path.join(root, '.codenode', 'memory.json');
    memory.writeMemory(root, [{
      id: 'mem-secret',
      key: 'api-design',
      tags: ['security'],
      content: '调用示例：Authorization: Bearer sk-abcdefghijklmnopqrstuvwx 与 api_key=sk-zyxwvutsrqponmlkjihgfe',
      createdAt: '2026-09-19T00:00:00.000Z',
    }]);
    const text = fs.readFileSync(memFile, 'utf8');
    check('F1 memory.json 落盘不得含明文密钥（#15）',
      !text.includes('sk-abcdefghijklmnopqrstuvwx') && !text.includes('sk-zyxwvutsrqponmlkjihgfe'), text.slice(0, 140));
    const back = memory.readMemory(root).entries[0] || {};
    check('F2 结构/标签字段不被脱敏（id/key/tags/createdAt 原样，检索口径不变）',
      back.id === 'mem-secret' && back.key === 'api-design' && Array.isArray(back.tags) && back.tags[0] === 'security'
        && back.createdAt === '2026-09-19T00:00:00.000Z',
      JSON.stringify({ id: back.id, key: back.key, tags: back.tags }));
    const scored = memory.selectRelevant(memory.readMemory(root).entries, 'api-design security', { limit: 1 });
    check('F3 脱敏后仍能按 key/tags 命中（打分不受影响）',
      scored.matched === true && scored.entries[0].id === 'mem-secret', JSON.stringify(scored.scores));
  }

  // ======================= G. #16 超上限：显式淘汰 + 审计 =======================
  {
    const evictRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-memory-evict-'));
    try {
      const many = [];
      for (let i = 0; i < memory.MAX_MEMORY_ENTRIES + 3; i++) many.push(entry('m-' + i, 'k' + i, '约定 ' + i));
      const result = memory.writeMemory(evictRoot, many);
      const data = memory.readMemory(evictRoot);
      check('G1 超上限显式淘汰最旧（保留最新 200 条）并返回淘汰明细',
        result.evicted === 3 && result.evictedIds.join(',') === 'm-0,m-1,m-2'
          && data.entries.length === memory.MAX_MEMORY_ENTRIES && data.entries[0].id === 'm-3',
        JSON.stringify({ evicted: result.evicted, ids: result.evictedIds, kept: data.entries.length, first: data.entries[0] && data.entries[0].id }));
      const auditFile = path.join(evictRoot, '.codenode', 'audit.jsonl');
      const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
      check('G2 淘汰必须留审计（audit.jsonl 出现 memory_evicted 与被淘汰 id）',
        audit.includes('memory_evicted') && audit.includes('m-0'), audit.slice(0, 160));
    } finally {
      fs.rmSync(evictRoot, { recursive: true, force: true });
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('MEMORY RECALL TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('MEMORY RECALL TEST: ERROR', error);
  process.exit(1);
});
