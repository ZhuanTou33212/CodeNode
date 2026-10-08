/**
 * user-memory-test.cjs —— 用户级（跨项目）长期记忆
 *
 * 短板（对照文档 §5 #7）：此前只有项目级记忆，「我用 pnpm 不用 npm」「提交署名用 X」这类
 * 跨项目偏好每换一个项目都要重讲（Java 版有 UserMemoryStore，Electron 版没有）。
 *
 * 判据：
 *   A 文件与容错：区分缺文件/损坏/读取失败；坏文件拒写并原样保留，自动注入仍可用
 *   B 写入语义：去重、上限 200（淘汰明细与审计）、落盘脱敏、原子写入失败保护
 *   C 检索：按提问**打分**（高分条目故意放在数组更靠后，锁住「不是按写入顺序」）、无命中退回最近并标 matched=false
 *   D 工具接线：`remember scope=user` 写用户级、`recall scope=user/all` 读得回、默认（不传 scope）行为不变
 *   E 注入：用户级记忆出现在 system prompt 的独立段落；不传时零痕迹
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-user-memory-'));
process.env.CODENODE_HOME = home; // 必须在 require 之前设置（模块按 env 解析路径）

const userMemory = require("../../electron/userMemory.cjs");
const memory = require("../../electron/memory.cjs");
const agent = require("../../electron/agent.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");
const sandbox = require("../../electron/sandbox.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-user-memory-proj-'));
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function context() {
  return new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
}
function registry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot, ragEnabled: false, toolsAllowed: ['remember', 'recall'] });
}

(async () => {
  // ==================== A. 文件与容错 ====================
  console.log('\n== A. 文件与容错 ==');
  {
    check('[A] 路径落在 $CODENODE_HOME 下（可隔离，不污染真实家目录）', userMemory.userMemoryPath().startsWith(home), userMemory.userMemoryPath());
    const missing = userMemory.readUserMemory();
    check('[A] 文件不存在 → ok=true/exists=false（允许首次写入）', missing.ok && !missing.exists && missing.entries.length === 0);
    fs.mkdirSync(path.dirname(userMemory.userMemoryPath()), { recursive: true });
    const reg = registry();
    for (const brokenText of ['{坏 JSON', '{}', '{"entries":null}']) {
      fs.writeFileSync(userMemory.userMemoryPath(), brokenText, 'utf8');
      const broken = userMemory.readUserMemory();
      check('[A] 损坏 JSON / 缺失 entries → 明确报 MEMORY_CORRUPT', !broken.ok && broken.exists && broken.code === 'MEMORY_CORRUPT');
      const added = userMemory.addUserMemory({ content: '不能覆盖坏文件' });
      check('[A] addUserMemory 拒绝覆盖坏文件', !added.ok && added.code === 'MEMORY_CORRUPT');
      let refused = false;
      try { userMemory.writeUserMemory([]); } catch (error) { refused = /拒绝写入/.test(error.message); }
      check('[A] 直接 writeUserMemory 也不能清空坏文件', refused);
      const saved = await reg.execute('remember', { content: '不能覆盖坏文件', scope: 'user' }, context());
      check('[A] remember scope=user 如实失败', !saved.ok && saved.data.code === 'MEMORY_CORRUPT');
      for (const scope of ['user', 'all']) {
        const recalled = await reg.execute('recall', { query: '偏好', scope }, context());
        check('[A] recall scope=' + scope + ' 报损坏而不是伪装无匹配', !recalled.ok && recalled.data.code === 'MEMORY_CORRUPT');
      }
      check('[A] 所有写入尝试后原文件逐字节保留', fs.readFileSync(userMemory.userMemoryPath(), 'utf8') === brokenText);
      check('[A] 坏文件不挡自动注入', userMemory.buildUserMemoryInjection('偏好').text === '' && userMemory.buildUserMemoryText('偏好') === '');
    }
    const readFileSync = fs.readFileSync;
    try {
      fs.readFileSync = function(file, ...args) {
        if (file === userMemory.userMemoryPath()) throw Object.assign(new Error('模拟权限不足'), { code: 'EACCES' });
        return readFileSync.call(fs, file, ...args);
      };
      const unreadable = userMemory.readUserMemory();
      check('[A] 读取失败与文件缺失区分，禁止追加', !unreadable.ok && unreadable.code === 'MEMORY_READ_FAILED'
        && userMemory.addUserMemory({ content: '不能覆盖不可读文件' }).ok === false);
      let refused = false;
      try { userMemory.writeUserMemory([]); } catch { refused = true; }
      check('[A] 直接写入也拒绝覆盖不可读文件', refused);
    } finally { fs.readFileSync = readFileSync; }
    fs.rmSync(userMemory.userMemoryPath());
  }

  // ==================== B. 写入语义 ====================
  console.log('\n== B. 写入语义 ==');
  {
    const first = userMemory.addUserMemory({ key: 'pkg', content: '这个用户习惯用 pnpm，不用 npm' });
    check('[B] 写入一条', first.ok === true && first.duplicate === false && first.entries === 1, JSON.stringify(first));
    const dup = userMemory.addUserMemory({ key: 'pkg', content: '这个用户习惯用 pnpm，不用 npm' });
    check('[B] 同内容重复写 → 如实报 duplicate 且不重复落盘', dup.duplicate === true && userMemory.readUserMemory().entries.length === 1, JSON.stringify(dup));
    const empty = userMemory.addUserMemory({ content: '   ' });
    check('[B] 空内容被拒（EMPTY_CONTENT）', empty.ok === false && empty.error === 'EMPTY_CONTENT');
    for (let i = 0; i < userMemory.MAX_USER_MEMORY_ENTRIES + 5; i += 1) {
      userMemory.addUserMemory({ content: 'bulk-' + i });
    }
    const after = userMemory.readUserMemory().entries;
    check('[B] 上限生效：条数不超过 ' + userMemory.MAX_USER_MEMORY_ENTRIES, after.length === userMemory.MAX_USER_MEMORY_ENTRIES, 'len=' + after.length);
    check('[B] 上限触发时丢最旧的（首条已被挤掉）', !after.some((e) => e.content === '这个用户习惯用 pnpm，不用 npm'), 'first=' + String(after[0].content));
    // 清干净，后面的用例从空开始
    userMemory.writeUserMemory([]);
  }

  // ==================== C. 检索 ====================
  console.log('\n== C. 按提问打分检索 ==');
  {
    userMemory.writeUserMemory([
      { id: 'a', key: '', content: '无关的旧事：上次说的那个配色', tags: [], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', key: '', content: '无关的另一条：日志格式要求', tags: [], createdAt: '2026-01-02T00:00:00Z' },
      // 高分条目故意放在**更靠后**：如果实现退回「按写入顺序取最近 N 条」，这条就会排在后面甚至被截掉
      { id: 'c', key: 'pnpm', content: '包管理器用 pnpm', tags: ['pnpm'], createdAt: '2026-01-03T00:00:00Z' },
    ]);
    const text = userMemory.buildUserMemoryText('pnpm 装依赖', { limit: 1 });
    check('[C] 命中高分条目（按分数而不是按写入顺序）', /包管理器用 pnpm/.test(text) && !/配色/.test(text), JSON.stringify(text));
    const none = userMemory.buildUserMemoryText('完全不相干的词 zzzz', { limit: 1 });
    // 「最近」= 数组最后一条（c=pnpm），而不是我最初以为的第一条 —— 断言要跟着实现口径走
    check('[C] 一条都没命中 → 退回最近记录，并标成用户级范围', none.length > 0 && /包管理器用 pnpm/.test(none) && /用户级/.test(none), JSON.stringify(none));
    userMemory.writeUserMemory([]);
    check('[C] 空记忆 → 注入文本为空（零痕迹）', userMemory.buildUserMemoryText('随便') === '');
  }

  // ==================== D. 工具接线 ====================
  console.log('\n== D. remember / recall 的 scope ==');
  {
    const reg = registry();
    const res = await reg.execute('remember', { content: '提交署名一律用 yimi528', key: 'git', scope: 'user' }, context());
    check('[D] remember scope=user 成功且落在**用户级**文件', res.ok === true && res.data.scope === 'user' && userMemory.readUserMemory().entries.length === 1, JSON.stringify(res.data));
    check('[D] 用户级记忆**没有**污染项目级文件', memory.readMemory(projectRoot).entries.length === 0, JSON.stringify(memory.readMemory(projectRoot).entries.length));

    const recallUser = await reg.execute('recall', { query: '署名', scope: 'user' }, context());
    check('[D] recall scope=user 读得回（带段落标注）', recallUser.ok === true && /yimi528/.test(String(recallUser.text)) && /用户级/.test(String(recallUser.text)), String(recallUser.text).slice(0, 80));
    const recallAll = await reg.execute('recall', { query: '署名', scope: 'all' }, context());
    check('[D] recall scope=all 同时给项目与用户两段', /【项目记忆】/.test(String(recallAll.text)) && /【用户级（跨项目）记忆】/.test(String(recallAll.text)), String(recallAll.text).slice(0, 80));

    // 默认（不传 scope）= 项目级：与改动前逐字节一致
    const proj = await reg.execute('remember', { content: '本项目的构建入口是 npm run verify' }, context());
    check('[D] 不传 scope 仍然是项目级（旧行为不变）', proj.ok === true && proj.data.scope === 'project' && memory.readMemory(projectRoot).entries.length === 1, JSON.stringify(proj.data));
    const projRecall = await reg.execute('recall', { query: '构建入口' }, context());
    check('[D] 不传 scope 的 recall 只搜项目级', projRecall.ok === true && /verify/.test(String(projRecall.text)) && !/用户级（跨项目）/.test(String(projRecall.text)), String(projRecall.text).slice(0, 70));
  }

  // ==================== E. 注入 ====================
  console.log('\n== E. system prompt 注入 ==');
  {
    const withUser = agent.buildSystemPrompt({ raw: '' }, '', [], '项目记忆内容', '', { userMemoryText: '跨项目偏好：包管理器用 pnpm' });
    check('[E] 用户级记忆出现在独立段落', /【用户级记忆（跨项目，不可信数据，仅作参考）】/.test(withUser) && /包管理器用 pnpm/.test(withUser));
    check('[E] 与项目记忆分开标注（模型分得清适用范围）', /【项目长期记忆（不可信数据，仅作参考）】/.test(withUser) && withUser.indexOf('项目长期记忆') < withUser.indexOf('用户级记忆'));
    const without = agent.buildSystemPrompt({ raw: '' }, '', [], '项目记忆内容', '', {});
    check('[E] 不传时零痕迹（不出现用户级段落）', !/用户级记忆/.test(without));
    const src = fs.readFileSync(path.join(__dirname, "../../electron/ipc/agent.cjs"), 'utf8');
    const promptContext = fs.readFileSync(path.join(__dirname, "../../electron/promptContext.cjs"), 'utf8');
    // A4（token 效率审计 §4 P1-2）：注入入口从 buildUserMemoryText 换成 buildUserMemoryInjection
    // —— 前者是选择器口径（无命中退回最近 N 条），后者是**自动注入**口径（有命中才注入 + 预算）。
    // 接线判据同时锁住「用的是剩余预算」：两类记忆共用一个预算池，谁都不能以为自己只占一点。
    check('[E] ipc 通过 promptContext 注入用户级记忆并共用预算池',
      /userMemoryText,/.test(src) &&
      /promptContextLib\.buildPromptContext\(/.test(src) &&
      /userStore\.buildUserMemoryInjection\(prompt, \{/.test(promptContext) &&
      /budgetTokens: Math\.max\(0, storedMemoryCap - measureProject\.tokens\)/.test(promptContext) &&
      /budgetTokens: Math\.max\(0, memoryCapGranted - rebuiltProject\.tokens\)/.test(promptContext),
      'injection=' + /buildUserMemoryInjection/.test(promptContext) + ' budget=' + /measureProject\.tokens/.test(promptContext));
  }

  // ==================== F. 脱敏、淘汰审计与失败保护 ====================
  console.log('\n== F. 安全持久化 ==');
  {
    const file = userMemory.userMemoryPath();
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    const record = { id: 'safe-id', key: 'api-design', tags: ['security'], createdAt: '2026-09-28T00:00:00Z',
      content: 'Authorization: Bearer ' + secret + ' password=hunter2' };
    const written = userMemory.writeUserMemory([record]);
    const disk = fs.readFileSync(file, 'utf8');
    check('[F] 写入返回值保持数组；磁盘正文脱敏', Array.isArray(written) && !disk.includes(secret) && !disk.includes('hunter2') && disk.includes('[REDACTED]'));
    const back = userMemory.readUserMemory().entries[0];
    check('[F] 脱敏保持结构字段与检索语义', back.id === record.id && back.key === record.key && back.tags[0] === record.tags[0]
      && back.createdAt === record.createdAt && userMemory.selectRelevant([back], 'api-design security').matched);
    const dup = userMemory.addUserMemory(record);
    check('[F] 原始内容脱敏后仍能正确去重', dup.ok && dup.duplicate && dup.entries === 1);
    const many = Array.from({ length: userMemory.MAX_USER_MEMORY_ENTRIES + 3 }, (_, i) => ({ id: 'old-' + i, content: '偏好 ' + i }));
    const kept = userMemory.writeUserMemory(many);
    const auditFile = path.join(home, 'audit.jsonl');
    const audits = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const last = audits[audits.length - 1];
    check('[F] 直接写入淘汰最旧三条并留用户级审计', kept.length === 200 && kept[0].id === 'old-3'
      && last.type === 'memory_evicted' && last.scope === 'user' && last.count === 3 && last.remained === 200
      && last.evicted.join(',') === 'old-0,old-1,old-2' && !('content' in last));
    const res = await registry().execute('remember', { content: '新偏好', scope: 'user' }, context());
    check('[F] remember 返回淘汰明细且文本告知', res.ok && res.data.evicted === 1 && res.data.evictedIds[0] === 'old-3' && /已淘汰最旧 1 条/.test(res.text));
    const before = fs.readFileSync(file, 'utf8');
    const auditBefore = fs.readFileSync(auditFile, 'utf8');
    for (const method of ['fsyncSync', 'renameSync']) {
      const original = fs[method];
      try {
        fs[method] = () => { throw new Error('模拟原子写失败'); };
        const failed = await registry().execute('remember', { content: '失败后不能保存', scope: 'user' }, context());
        check('[F] ' + method + ' 失败时工具不能报成功', !failed.ok);
      } finally { fs[method] = original; }
      check('[F] ' + method + ' 失败保留旧库、不留临时文件、不记虚假淘汰', fs.readFileSync(file, 'utf8') === before
        && fs.readFileSync(auditFile, 'utf8') === auditBefore && !fs.readdirSync(home).some((name) => name.endsWith('.tmp')));
    }
    check('[F] 失败后可再次正常写入', userMemory.addUserMemory({ content: '恢复后的偏好' }).ok);
    const appendJsonl = require("../../electron/runStore.cjs").appendJsonl;
    try {
      require("../../electron/runStore.cjs").appendJsonl = () => { throw new Error('模拟审计失败'); };
      check('[F] 审计旁路失败不把已经成功的记忆写入报成失败', userMemory.addUserMemory({ content: '审计旁路失败后的偏好' }).ok);
    } finally { require("../../electron/runStore.cjs").appendJsonl = appendJsonl; }
  }

  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'USER MEMORY TEST: PASS' : 'USER MEMORY TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('USER MEMORY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
