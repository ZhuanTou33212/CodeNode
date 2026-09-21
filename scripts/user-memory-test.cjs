/**
 * user-memory-test.cjs —— 用户级（跨项目）长期记忆
 *
 * 短板（对照文档 §5 #7）：此前只有项目级记忆，「我用 pnpm 不用 npm」「提交署名用 X」这类
 * 跨项目偏好每换一个项目都要重讲（Java 版有 UserMemoryStore，Electron 版没有）。
 *
 * 判据：
 *   A 文件与容错：路径在 $CODENODE_HOME 下（可隔离）、缺文件/坏文件一律当空而不是抛
 *   B 写入语义：去重（同内容不重复写）、上限 200（丢最旧）
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

const userMemory = require('../electron/userMemory.cjs');
const memory = require('../electron/memory.cjs');
const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

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
    check('[A] 文件不存在 → 空记忆（不是抛异常）', userMemory.readUserMemory().entries.length === 0);
    fs.mkdirSync(path.dirname(userMemory.userMemoryPath()), { recursive: true });
    fs.writeFileSync(userMemory.userMemoryPath(), '{坏 JSON', 'utf8');
    check('[A] 坏文件 → 当空处理（不挡住 Agent）', userMemory.readUserMemory().entries.length === 0);
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
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    check('[E] ipc 真的把用户级记忆传进了 buildSystemPrompt（接线）', /userMemoryText,/.test(src) && /buildUserMemoryText\(prompt/.test(src));
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
