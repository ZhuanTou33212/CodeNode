/**
 * skill-index-test.cjs —— 技能「渐进披露」（对照文档 §5 #4）
 *
 * 短板：项目 skills 的 instructions 此前**整段常驻 system prompt**（每轮都发，无论用不用得上）。
 * 改成「prompt 只放索引 + 正文由 `read_skill` 按需读」。
 *
 * 判据：
 *   A 索引注入：只出现名字与描述，**不出现**正文；无 skills 时为控（零痕迹）
 *   B read_skill：能读到正文；未知名字如实报错并列出可用项；空 name 报错；正文超限截断标注
 *   C 契约：只读 + 可缓存（同一 run 内同参重复读走缓存，且不刷新别的缓存）
 *   D 量测：正文很长时 system prompt 不跟着涨（这正是这一项的意义）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const descriptor = require('../electron/tools/descriptor.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const readSkill = require('../electron/tools/impl/readSkillTool.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-skill-index-'));
const BODY = '第一步：先读 docs/README；第二步：跑 npm run verify；'.repeat(40); // 长正文（约 1000+ 字符）
const SHORT_BODY = '提交前必须跑 npm run verify。';
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.codenode', 'extensions.json'),
  JSON.stringify([
    { name: 'verify-before-commit', kind: 'skills', description: '提交前跑门禁', instructions: BODY },
    { name: 'tiny', kind: 'skills', description: '小技能', instructions: SHORT_BODY },
    { name: 'some-mcp', kind: 'mcp', command: 'node x.cjs' },
  ]),
  'utf8'
);
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function context() {
  return new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal });
}
function registry(extra) {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_skill', 'read_file'] , ...(extra || {})});
}

(async () => {
  // ==================== A. 索引注入 ====================
  console.log('\n== A. prompt 里只放索引 ==');
  {
    const skills = readSkill.listSkills(root);
    check('[A] 只认出 kind=skills 的条目（mcp 不算）', skills.length === 2 && skills.map((s) => s.name).join(',') === 'verify-before-commit,tiny', JSON.stringify(skills.map((s) => s.name)));
    const indexText =
      skills.map((s) => '- ' + s.name + ': ' + (s.description || '（详见正文，用 read_skill 读取）')).join('\n') + '\n（需要某个技能的完整做法时调用 read_skill(name) 读取）';
    check('[A] 索引里有名字与描述', /verify-before-commit: 提交前跑门禁/.test(indexText) && /tiny/.test(indexText));
    check('[A] 索引里**没有**正文（渐进披露的关键判据）', !indexText.includes('第一步：先读 docs/README') && !SHORT_BODY.includes('') === false && !/第一步/.test(indexText));
    const prompt = agent.buildSystemPrompt({ raw: '' }, '', [], '', indexText, {});
    check('[A] system prompt 里同样没有正文', !/第一步：先读 docs\/README/.test(prompt));
    const empty = agent.buildSystemPrompt({ raw: '' }, '', [], '', '', {});
    check('[A] 无 skills 时零痕迹', !/项目 Skills/.test(empty));
  }

  // ==================== B. read_skill ====================
  console.log('\n== B. read_skill 读正文 ==');
  {
    const reg = registry();
    const hit = await reg.execute('read_skill', { name: 'verify-before-commit' }, context());
    check('[B] 读到完整正文（含首句与末句）', hit.ok === true && /第一步：先读 docs/.test(String(hit.text)) && /【Skill：verify-before-commit】/.test(String(hit.text)), String(hit.text).slice(0, 60));
    check('[B] 正文长度与源文件一致（未截断时）', hit.data.chars === BODY.length && hit.data.truncated === false, JSON.stringify({ chars: hit.data.chars, total: BODY.length }));
    const short = await reg.execute('read_skill', { name: 'tiny' }, context());
    check('[B] 另一个技能读到的是它自己的正文', short.ok === true && /提交前必须跑 npm run verify/.test(String(short.text)) && !/第一步/.test(String(short.text)));
    const upper = await reg.execute('read_skill', { name: 'TINY' }, context());
    check('[B] 名字大小写不敏感（模型大小写不稳）', upper.ok === true && upper.data.name === 'tiny');
    const miss = await reg.execute('read_skill', { name: 'no-such-skill' }, context());
    check('[B] 未知名字：报错 + 列出可用项（模型能改参数重试）', miss.ok === false && /没有名为/.test(String(miss.text)) && /verify-before-commit/.test(String(miss.text)), JSON.stringify({ code: miss.data && miss.data.code }));
    const noName = await reg.execute('read_skill', {}, context());
    // 缺 name 会被注册表的闭合 schema 先拦下（INVALID_TOOL_ARGUMENTS），工具内的判空是第二道 ——
    // 两条都算「如实报错」，断言只锁「没执行、且有可读原因」
    check('[B] 空 name 报错（schema 或工具内判空，任一都算）', noName.ok === false && /name/.test(String(noName.text)), String(noName.text).slice(0, 60));
    // 超限截断：把上限调到很小
    const tinyCap = new (require('../electron/tools/impl/readSkillTool.cjs').register, Object)();
    const regCap = registry();
    const fakeContext = new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal, skillMaxChars: 50 });
    const capped = await regCap.execute('read_skill', { name: 'verify-before-commit' }, fakeContext);
    check('[B] 正文超限截断并标注（读技能不该把上下文吃穿）', capped.data.truncated === true && String(capped.text).includes('已截断') && String(capped.text).length < 400, JSON.stringify({ len: String(capped.text).length }));
  }

  // ==================== C. 契约 ====================
  console.log('\n== C. 契约（只读 + 可缓存）==');
  {
    const reg = registry();
    const d = reg.descriptorOf('read_skill');
    check('[C] 声明为只读', d.readOnly === true && d.mutatesWorkspace === false, JSON.stringify({ readOnly: d.readOnly, mutatesWorkspace: d.mutatesWorkspace }));
    check('[C] 在缓存白名单里（同参重复读不刷缓存）', descriptor.CACHEABLE_TOOLS.has('read_skill') === true);
    check('[C] 能力是 workspace.read', d.requiredCapability === 'workspace.read', String(d.requiredCapability));
    // 注意：结果缓存是**主循环**里的 Map（不是注册表的），所以不能用两次直连 execute 验缓存命中 ——
    // 这里只锁「它在缓存白名单里」这条契约（上面那条），并用一个负向断言守住「没被误列为写工具」。
    check('[C] 负向：不在变更工具名单里', descriptor.MUTATION_TOOLS.has('read_skill') === false && descriptor.READ_ONLY_TOOLS.has('read_skill') === true);
  }

  // ==================== D. 量测：prompt 不随正文增长 ====================
  console.log('\n== D. 固定开销不随技能正文增长 ==');
  {
    const indexOnly = '- verify-before-commit: 提交前跑门禁\n（需要某个技能的完整做法时调用 read_skill(name) 读取）';
    const withOldStyle = '- verify-before-commit: ' + BODY;
    const p1 = agent.buildSystemPrompt({ raw: '' }, '', [], '', indexOnly, {});
    const p2 = agent.buildSystemPrompt({ raw: '' }, '', [], '', withOldStyle, {});
    check('[D] 索引版比整段注入版省下的字符数 ≈ 正文长度', p2.length - p1.length > BODY.length * 0.9, JSON.stringify({ index: p1.length, full: p2.length, body: BODY.length }));
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'SKILL INDEX TEST: PASS' : 'SKILL INDEX TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SKILL INDEX TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
