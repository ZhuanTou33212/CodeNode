/**
 * hooks-test.cjs —— 钩子（对照 Claude Code 的 hooks）：`PostToolUse` + `SessionStart/Stop`
 *
 * 本轮补的短板（对照文档 §5 #3）：此前「工具执行完之后要做什么」是写死的（失败 nudge / 压缩 / 进度条），
 * 用户没有任何地方声明「改完代码自动跑一次 lint 或测试」。钩子把它变成配置。
 *
 * 判据分四层：
 *   A 配置解析（纯函数）：开关默认关、JSON 数组与 key=value 两种写法、坏规则**如实报**而不是静默丢
 *   B 匹配（纯函数）：tools 列表 / `*`、on=success|failure|always
 *   C 执行：真跑命令（退出码/输出/超时/截断）；**安全**：越界写与断网策略下的联网命令**不执行**
 *   D 端到端（真实工具循环 + 脚本化模型）：匹配到就回灌一条机器消息、只留一条、次数上限、
 *     未配置时**一次 spawn 都不发生**
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const hooks = require('../electron/hooks.cjs');
const compaction = require('../electron/compaction.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-hooks-'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work', 'a.txt'), 'v1\n');
const outsideDir = path.join(os.homedir(), 'codenode-hooks-out-' + process.pid);
fs.mkdirSync(outsideDir, { recursive: true });
const outside = path.join(outsideDir, 'hook-pwned.txt');
const slash = (p) => String(p).replace(/\\/g, '/');
const marker = (name) => path.join(root, name).replace(/\\/g, '/');

/** 一个「跑起来一定留痕」的命令：用来证明钩子到底有没有真的被执行 */
const markCmd = (name) => 'node -e "require(\'fs\').writeFileSync(\'' + marker(name) + '\',\'x\')"';
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function context(runId) {
  return new AgentToolContext({
    projectRoot: root,
    runId: runId || '',
    confirm: async () => true,
    audit: () => {},
    askUser: async () => '',
    ragConfig: { enabled: false },
    sandbox: policy,
    signal: new AbortController().signal,
  });
}

(async () => {
  // ==================== A. 配置解析 ====================
  console.log('\n== A. 配置解析（纯函数）==');
  {
    check('[A] 不配任何键 → enabled=false（零痕迹的前提）', hooks.parseHooksConfig({}).enabled === false);
    const json = hooks.parseHooksConfig({
      'hooks.enabled': 'true',
      'hooks.post_tool_use': JSON.stringify([
        { id: 'lint', tools: ['write_file', 'edit_file'], command: 'npm run lint', on: 'success', timeout_ms: 60000 },
        { id: 'after-fail', tool: 'execute_shell', command: 'echo boom', on: 'failure' },
      ]),
    });
    check('[A] JSON 数组写法解析出两条规则', json.enabled === true && json.rules.length === 2, JSON.stringify(json.rules));
    check('[A] 规则字段归一化（tools 数组 / on / timeout_ms → timeoutMs）', json.rules[0].tools.length === 2 && json.rules[0].on === 'success' && json.rules[0].timeoutMs === 60000, JSON.stringify(json.rules[0]));
    check('[A] 单 tool 写法也接受（tool 而非 tools）', json.rules[1].tools[0] === 'execute_shell' && json.rules[1].on === 'failure', JSON.stringify(json.rules[1]));
    const kv = hooks.parseHooksConfig({ 'hooks.enabled': 'true', 'hooks.post_tool_use': 'tool=write_file;command=npm run lint;on=always' });
    check('[A] key=value 写法解析出规则', kv.enabled === true && kv.rules.length === 1 && kv.rules[0].command === 'npm run lint' && kv.rules[0].on === 'always', JSON.stringify(kv.rules[0]));
    const bad = hooks.parseHooksConfig({ 'hooks.enabled': 'true', 'hooks.post_tool_use': JSON.stringify([{ tools: ['write_file'] }, { command: 'x', on: 'sometimes' }]) });
    check('[A] 坏规则不静默丢：problems 逐条说明', bad.enabled === false && bad.problems.length === 2, JSON.stringify(bad.problems));
    check('[A] JSON 坏掉也如实报（不是静默当成没有钩子）', hooks.parseHooksConfig({ 'hooks.post_tool_use': '[{bad' }).problems[0].includes('不是合法 JSON'));
    const clamped = hooks.parseHooksConfig({ 'hooks.enabled': 'true', 'hooks.post_tool_use': 'tool=*;command=x', 'hooks.timeout_ms': '99999999', 'hooks.max_runs': '-3', 'hooks.max_output_chars': '5' });
    check('[A] 开关值被钳制到安全区间', clamped.timeoutMs === 600000 && clamped.maxRuns === 0 && clamped.maxOutputChars === 200, JSON.stringify({ t: clamped.timeoutMs, r: clamped.maxRuns, o: clamped.maxOutputChars }));
    check('[A] session_start/stop 也能配（不写规则时也算启用）', hooks.parseHooksConfig({ 'hooks.enabled': 'true', 'hooks.session_start': 'npm ci' }).enabled === true);
    check('[A] 前缀是机器注入标记（压缩不会把它带进摘要）', compaction.isMachineInjectedUserMessage(hooks.HOOK_NOTE_PREFIX + '1 条）：') === true);
  }

  // ==================== B. 匹配 ====================
  console.log('\n== B. 匹配（纯函数）==');
  {
    const rules = hooks.parseHooksConfig({
      'hooks.enabled': 'true',
      'hooks.post_tool_use': JSON.stringify([
        { id: 'w', tools: ['write_file', 'edit_file'], command: 'x', on: 'success' },
        { id: 'any', tools: ['*'], command: 'y', on: 'always' },
        { id: 'fail', tools: ['execute_shell'], command: 'z', on: 'failure' },
      ]),
    }).rules;
    check('[B] 成功时匹配「列出该工具」与「*」', hooks.matchRules(rules, { tool: 'write_file', ok: true }).map((r) => r.id).join(',') === 'w,any', JSON.stringify(hooks.matchRules(rules, { tool: 'write_file', ok: true }).map((r) => r.id)));
    check('[B] 失败时 on=success 不跑、on=failure 跑', hooks.matchRules(rules, { tool: 'execute_shell', ok: false }).map((r) => r.id).join(',') === 'any,fail');
    // 上面那条里 on=success 的规则本来就没列出 execute_shell —— 想真正锁住 on 判据，
    // 必须让「列出了该工具但 on 不匹配」的规则参与（第一版就在这里假绿，变异测出来的）
    const onOnly = hooks.parseHooksConfig({
      'hooks.enabled': 'true',
      'hooks.post_tool_use': JSON.stringify([
        { id: 'only-ok', tools: ['execute_shell'], command: 'x', on: 'success' },
        { id: 'only-fail', tools: ['execute_shell'], command: 'y', on: 'failure' },
      ]),
    }).rules;
    check('[B] 工具列出了但 on 不匹配 → 不跑（success 规则在失败时不跑）', hooks.matchRules(onOnly, { tool: 'execute_shell', ok: false }).map((r) => r.id).join(',') === 'only-fail', JSON.stringify(hooks.matchRules(onOnly, { tool: 'execute_shell', ok: false }).map((r) => r.id)));
    check('[B] 反向：成功时只有 on=success 的跑', hooks.matchRules(onOnly, { tool: 'execute_shell', ok: true }).map((r) => r.id).join(',') === 'only-ok');
    check('[B] 未列出该工具 → 不匹配', hooks.matchRules(rules, { tool: 'read_file', ok: true }).map((r) => r.id).join(',') === 'any');
  }

  // ==================== C. 执行 + 安全 ====================
  console.log('\n== C. 执行与安全 ==');
  {
    const out = await hooks.runHook({ id: 'ok', command: 'node -e "console.log(\'HOOK-HELLO\')"' }, { projectRoot: root, policy, defaults: { timeoutMs: 20000, maxOutputChars: 2000 } });
    check('[C] 真跑一条命令：退出码 0 + 输出被抓到', out.ok === true && out.exitCode === 0 && /HOOK-HELLO/.test(out.output), JSON.stringify({ ok: out.ok, code: out.exitCode, out: out.output.slice(0, 40) }));
    const bad = await hooks.runHook({ id: 'bad', command: 'node -e "process.exit(3)"' }, { projectRoot: root, policy });
    check('[C] 非零退出如实报 ok=false（不假装成功）', bad.ok === false && bad.exitCode === 3, JSON.stringify({ ok: bad.ok, code: bad.exitCode }));
    const t0 = Date.now();
    const slow = await hooks.runHook({ id: 'slow', command: 'node -e "setTimeout(()=>{},10000)"', timeoutMs: 1000 }, { projectRoot: root, policy });
    check('[C] 超时被杀且如实报 timedOut（不会无限等）', slow.timedOut === true && slow.ok === false && Date.now() - t0 < 8000, JSON.stringify({ timedOut: slow.timedOut, ms: Date.now() - t0 }));
    const long = await hooks.runHook({ id: 'long', command: 'node -e "console.log(\'x\'.repeat(3000))"', maxOutputChars: 300 }, { projectRoot: root, policy });
    check('[C] 输出超限被截断并标注（注入是花上下文的动作）', long.truncated === true && long.output.length < 800 && /截断/.test(long.output), JSON.stringify({ len: long.output.length }));
  }
  {
    // 越界写：静态审计拒绝 → **真的不执行**（用「执行必留痕」的命令取证）
    const victim = path.join(outsideDir, 'ran.txt');
    const res = await hooks.runHook({ id: 'escape', command: 'cmd /c echo X > ' + slash(victim) }, { projectRoot: root, policy });
    check('[C] 越界写的钩子命令被拒（skipped，不执行）', res.skipped === true && /OUT_OF_ROOT/.test(String(res.reason)), JSON.stringify({ skipped: res.skipped, reason: res.reason }));
    check('[C] 终态判据：项目外那个文件没有被创建', fs.existsSync(victim) === false);
  }
  {
    // 断网策略下：联网钩子命令被拒（与 execute_shell 同一套判据）
    const denyPolicy = sandbox.resolvePolicy({ mode: 'off', network: 'deny' }, { projectRoot: root, userDataDir: os.tmpdir() });
    const res = await hooks.runHook({ id: 'net', command: 'npm install' }, { projectRoot: root, policy: denyPolicy });
    check('[C] sandbox.network=deny 时联网钩子被拒', res.skipped === true && /NETWORK_DENIED/.test(String(res.reason)), JSON.stringify({ skipped: res.skipped, reason: res.reason }));
  }

  // ==================== D. 端到端（真实循环）====================
  console.log('\n== D. 端到端：工具跑完 → 钩子回灌一条机器消息 ==');
  let lastSeen = [];
  async function runTurn(script, cfgOverrides, runId) {
    const { limits: limitsOverride, ...rest } = cfgOverrides || {};
    const controller = new AbortController();
    const context_ = context(runId || 'run-hooks');
    const stub = installScriptedModel(script, { loopLast: false });
    try {
      const result = await agent.runAgentChat({
        cfg: Object.assign(
          {
            apiBase: 'http://scripted.local/v1',
            apiKey: 'scripted-test',
            model: 'scripted-model',
            maxTokens: 1024,
            reasoningEffort: '',
            costRunId: runId || 'run-hooks',
            reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
            compression: { enabled: false },
            rag: { enabled: false },
            tools: {},
          },
          rest,
          { limits: Object.assign({ maxTotalTokens: 1000000, maxConcurrentRuns: 1 }, limitsOverride || {}) }
        ),
        messages: [
          { role: 'system', content: '测试用 system' },
          { role: 'user', content: '请完成测试任务' },
        ],
        tools: { registry: toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['write_file', 'read_file', 'execute_shell'] }), context: context_ },
        signal: controller.signal,
        timeoutMs: 20000,
      });
      lastSeen = stub.seen || [];
      return result;
    } finally {
      stub.restore();
    }
  }
  const hookNotes = (req) =>
    ((req && req.messages) || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(hooks.HOOK_NOTE_PREFIX));

  const HOOK_CFG = {
    'hooks.enabled': 'true',
    'hooks.post_tool_use': JSON.stringify([{ id: 'lint', tools: ['write_file'], command: markCmd('hook-ran.txt'), on: 'success' }]),
    'hooks.timeout_ms': '20000',
  };
  const SCRIPT = [
    { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'work/a.txt', content: 'v2\n' } }] },
    { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'work/a.txt' } }] },
    { toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'work/b.txt', content: 'v3\n' } }] },
    { content: '完成' },
  ];
  {
    const markerFile = path.join(root, 'hook-ran.txt');
    if (fs.existsSync(markerFile)) fs.rmSync(markerFile);
    await runTurn(SCRIPT, Object.assign({}, HOOK_CFG, { limits: { progressEvery: 0 } }), 'run-hooks-e2e');
    check('[D] 钩子真的被执行了（命令留下了痕迹）', fs.existsSync(markerFile) === true, markerFile);
    check('[D] 下一轮请求里出现钩子消息（模型能看到 lint 结果）', hookNotes(lastSeen[1]).length === 1, JSON.stringify(hookNotes(lastSeen[1]).map((m) => String(m.content).slice(0, 60))));
    const note = String((hookNotes(lastSeen[1])[0] || {}).content || '');
    check('[D] 钩子消息带命令、退出码与输出（不是一句「钩子跑过了」）', /lint/.test(note) && /退出码 0/.test(note) && /钩子结果/.test(note), note.slice(0, 120));
    check('[D] 第二次触发仍只有一条（原地替换，不堆叠）', hookNotes(lastSeen[lastSeen.length - 1]).length === 1, 'notes=' + hookNotes(lastSeen[lastSeen.length - 1]).length);
  }
  {
    // 次数上限：max_runs=1 时第二次不再跑（也不注入新的）
    const mf = path.join(root, 'hook-capped.txt');
    if (fs.existsSync(mf)) fs.rmSync(mf);
    await runTurn(SCRIPT, Object.assign({}, HOOK_CFG, { 'hooks.post_tool_use': JSON.stringify([{ id: 'lint', tools: ['write_file'], command: markCmd('hook-capped.txt'), on: 'success' }]), 'hooks.max_runs': '1', limits: { progressEvery: 0 } }), 'run-hooks-cap');
    const landed = fs.existsSync(path.join(root, 'hook-capped.txt'));
    check('[D] max_runs=1：命令被执行过（第一次）', landed === true);
    const finalNote = String((hookNotes(lastSeen[lastSeen.length - 1])[0] || {}).content || '');
    check('[D] 达到上限后如实标注「不再执行」', /上限/.test(finalNote), finalNote.slice(-60));
  }
  {
    // 负向：未配置钩子 → 一次 spawn 都不发生、请求体里没有钩子消息（与没有这个模块时一致）
    // 前置：把前面用例留下的痕迹清干净（否则「没被执行」这条断言会被上一段的产物证伪）
    const mf = path.join(root, 'hook-none.txt');
    for (const name of ['hook-none.txt', 'hook-ran.txt', 'hook-capped.txt']) {
      const f = path.join(root, name);
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    await runTurn(SCRIPT, { limits: { progressEvery: 0 } }, 'run-hooks-none');
    check('[D] 未配置钩子：没有钩子消息（零痕迹）', lastSeen.every((req) => hookNotes(req).length === 0), 'requests=' + lastSeen.length);
    check('[D] 未配置钩子：没有任何钩子命令被执行', fs.existsSync(mf) === false && fs.existsSync(path.join(root, 'hook-ran.txt')) === false);
    const result = await runTurn(SCRIPT, { limits: { progressEvery: 0 } }, 'run-hooks-none');
    check('[D] 未配置钩子：run 正常收尾（不影响既有交付）', String(result.content || '').includes('完成'));
  }
  {
    // 负向（更贴近真实误配）：规则写着、但开关没开 → 同样一次 spawn 都不发生
    // （这条同时锁住「开关默认关」这个语义：把门判据退化成「有规则就跑」会在这里红）
    const mf = path.join(root, 'hook-disabled.txt');
    if (fs.existsSync(mf)) fs.rmSync(mf);
    await runTurn(
      SCRIPT,
      { 'hooks.post_tool_use': JSON.stringify([{ id: 'lint', tools: ['write_file'], command: markCmd('hook-disabled.txt') }]), limits: { progressEvery: 0 } },
      'run-hooks-disabled'
    );
    check('[D] 规则存在但 hooks.enabled 未开：没有钩子消息（零痕迹）', lastSeen.every((req) => hookNotes(req).length === 0), 'requests=' + lastSeen.length);
    check('[D] 规则存在但开关未开：命令没有被执行', fs.existsSync(mf) === false);
  }
  {
    // context.sandbox() 注入形状：钩子用的是策略对象（与 execute_shell 同源），不是函数
    const res = await hooks.runHook({ id: 'policy', command: 'node -e "console.log(1)"' }, { projectRoot: root, policy: policy });
    check('[D] 钩子执行走的是注入的策略对象（mode/network 可读）', res.ok === true);
  }

  try {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'HOOKS TEST: PASS' : 'HOOKS TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('HOOKS TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
