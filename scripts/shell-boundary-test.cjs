/**
 * shell-boundary-test.cjs —— 「Windows 无内核隔离」这条边界的两处收口（2026-09-21）
 *
 * 背景（`docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 #1）：
 * Windows 后端（windows-job）**不隔离文件系统、也不隔离网络**，唯一的边界是工具层：
 * 静态审计（shellGuard）+ 路径校验（writeRoots）+ 一次用户确认。而实测有两条默认放行的口子：
 *   ① `sandbox.network` 出厂 `inherit` → 出厂口径下**联网命令默认放行**（只有命令级无策略可言）；
 *   ② 写目标含变量/通配（`writeFileSync(p)`、`> $OUT`）→ 静态审计判不出是否越界，
 *      **best-effort（出厂模式）下静默放行**，只有 strict 才拒 —— 等于「把路径放进变量」即可绕过边界。
 *
 * 本轮口径：
 *   - `sandbox.network` 出厂改 **deny**（对齐 Codex 的 workspace-write 默认不给网络）；
 *     显式 `inherit` 时联网命令**走 HIGH 审批**（不是静默放行）。
 *   - 「写目标无法静态判定」在**任何模式**下都不再静默放行：strict 硬拒（原有），
 *     其余模式**必须用户确认**，且确认文案写明"判不出来"这件事。
 *
 * 判据全部落在终端状态：工具返回 + 磁盘上到底有没有那个文件 + 确认回调到底被调了几次。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const shellGuard = require('../electron/tools/shellGuard.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shell-boundary-'));
/**
 * 「项目外」目录必须在 tmpdir **之外**：策略的 writeRoots 天然包含 os.tmpdir()
 * （临时文件是正常产物），放在 tmp 里的路径不算越界 —— 第一版测试就栽在这上面。
 */
const outsideDir = path.join(os.homedir(), 'codenode-boundary-out-' + process.pid);
fs.mkdirSync(outsideDir, { recursive: true });
const outside = path.join(outsideDir, 'pwned.txt');
const slash = (p) => String(p).replace(/\\/g, '/');

/** 造一个策略；不传 network 时用 sandbox.resolvePolicy 的**出厂口径**（这是本用例要锁的东西） */
function makePolicy(overrides) {
  return sandbox.resolvePolicy(
    Object.assign({ mode: 'best-effort' }, overrides || {}),
    { projectRoot: root, userDataDir: root },
  );
}

/** 每次执行都带一个记录 (level, what, detail) 的 confirm 探针 */
function makeConfirm(answer) {
  const calls = [];
  const fn = async (level, what, detail) => {
    calls.push({ level, what, detail });
    return typeof answer === 'function' ? answer(level, what, detail) : answer;
  };
  fn.calls = calls;
  return fn;
}

function registry(policy) {
  sandbox.setDefaultPolicy(policy);
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['execute_shell'] });
}

function contextWith(policy, confirm) {
  return new AgentToolContext({
    projectRoot: root,
    confirm,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
}

async function runShell(policy, command, confirm) {
  const reg = registry(policy);
  const ctx = contextWith(policy, confirm);
  const res = await reg.execute('execute_shell', { command }, ctx);
  return res;
}

(async () => {
  // ==================== A. 出厂口径：默认断网 ====================
  console.log('\n== A. 出厂口径 ==');
  check('[A] parseSandboxConfig({}) 出厂 network=deny', agent.parseSandboxConfig({}).network === 'deny', JSON.stringify(agent.parseSandboxConfig({})));
  check(
    '[A] loadConfig(null) 出厂 network=deny（入库 properties 没有 sandbox.network 键，出厂值只来自代码默认）',
    agent.loadConfig(null).sandbox.network === 'deny',
    JSON.stringify(agent.loadConfig(null).sandbox)
  );
  check('[A] sandbox.resolvePolicy({}) 出厂 network=deny（两处默认口径必须一致）', sandbox.resolvePolicy({}, { projectRoot: root }).network === 'deny');
  check(
    '[A] 显式 inherit 仍然生效（可配置，不是写死）',
    agent.parseSandboxConfig({ 'sandbox.network': 'inherit' }).network === 'inherit' &&
      sandbox.resolvePolicy({ network: 'inherit' }, { projectRoot: root }).network === 'inherit'
  );

  // ==================== B. 出厂 deny：联网命令硬拒，且不试连 ====================
  console.log('\n== B. 出厂 deny：联网命令硬拒 ==');
  for (const command of ['git push origin main', 'npm install', 'node -e "fetch(\'https://example.com\')"']) {
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), command, confirm);
    check(
      '[B] 出厂 deny 拒绝联网命令：' + command.slice(0, 22),
      res.ok === false && res.data && res.data.code === 'PERMISSION_DENIED',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code })
    );
    check('[B] 硬拒不走确认（不把「该不该联网」推给用户逐条点）', confirm.calls.length === 0, 'confirmCalls=' + confirm.calls.length);
    check('[B] 拒绝文案给出放行的配置键', /sandbox\.network=inherit/.test(String(res.text || '')), String(res.text || '').slice(0, 80));
  }
  {
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), 'node --version', confirm);
    check('[B] 出厂 deny 不误伤离线命令', res.ok === true, JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
  }

  // ==================== C. 显式 inherit：联网命令走 HIGH 审批 ====================
  console.log('\n== C. 显式 inherit：审批而不是静默放行 ==');
  {
    const confirm = makeConfirm(false);
    const res = await runShell(makePolicy({ network: 'inherit' }), 'git push origin main', confirm);
    check('[C] inherit 下联网命令要求确认（HIGH）', confirm.calls.length === 1 && confirm.calls[0].level === 'HIGH', JSON.stringify(confirm.calls.map((c) => c.level)));
    check('[C] 确认文案点名是联网命令', /联网|push/.test(String(confirm.calls[0] && confirm.calls[0].detail || '')), String(confirm.calls[0] && confirm.calls[0].detail || '').slice(0, 100));
    check('[C] 用户拒绝 → 未执行（ok=false）', res.ok === false, JSON.stringify({ ok: res.ok, text: String(res.text || '').slice(0, 60) }));
  }

  // ==================== D. 未解析写目标：默认模式必须确认 ====================
  console.log('\n== D. 写目标含变量/通配（默认 best-effort）==');
  /**
   * 选 `git status`（在白名单里、**不在** SENSITIVE_PROGRAMS 里）当载体：
   * 这样「有没有弹确认」只可能来自本轮新增的「未解析写目标」这条判据，而不是既有的高危命令判据。
   * 第一版用 mvn 当载体，mvn 本身就在高危名单里 → 无论怎么改都会弹确认（假绿）。
   */
  const unresolvedCmd = 'git status > $OUT';
  const literalCmd = 'git status > build.log';
  {
    const analysis = shellGuard.analyzeShellCommand(unresolvedCmd, { projectRoot: root, writeRoots: [root, os.tmpdir()] });
    check(
      '[D] 前置：静态审计确实把它记为「未解析」而不是「越界」',
      analysis.unresolvedWrites.length > 0 && analysis.outsideWrites.length === 0,
      JSON.stringify(analysis)
    );
    const literal = shellGuard.analyzeShellCommand(literalCmd, { projectRoot: root, writeRoots: [root, os.tmpdir()] });
    check(
      '[D] 对照命令（明文写目标）既不算越界也不算未解析 → 判据只针对「判不出来」那类',
      literal.unresolvedWrites.length === 0 && literal.outsideWrites.length === 0,
      JSON.stringify(literal)
    );
  }
  {
    // 拒绝：不许执行
    const confirm = makeConfirm(false);
    const res = await runShell(makePolicy(), unresolvedCmd, confirm);
    check(
      '[D] 未解析写目标在默认模式下**必须确认**（修复前是静默放行）',
      confirm.calls.length === 1 && confirm.calls[0].level === 'HIGH',
      'confirmCalls=' + confirm.calls.length
    );
    check(
      '[D] 确认文案写明「无法静态判定」这件事（用户才知道自己在批准什么）',
      /变量或通配/.test(String(confirm.calls[0] && confirm.calls[0].detail || '')),
      String(confirm.calls[0] && confirm.calls[0].detail || '').slice(0, 120)
    );
    check('[D] 拒绝 → APPROVAL_DENIED 且未执行', res.ok === false && res.data && res.data.code === 'APPROVAL_DENIED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
  }
  {
    // 批准：放行（走到执行阶段）
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), unresolvedCmd, confirm);
    check('[D] 批准后不再被结构性拒绝（真的走到执行阶段）', confirm.calls.length === 1 && !/拒绝执行/.test(String(res.text || '')), JSON.stringify({ ok: res.ok, text: String(res.text || '').slice(0, 80) }));
  }

  // strict 模式：硬拒（原有行为，负向保护）
  {
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy({ mode: 'strict' }), unresolvedCmd, confirm);
    check(
      '[D] strict 模式仍然硬拒（不因本轮改动而放松）',
      res.ok === false && res.data && res.data.code === 'PATH_OUT_OF_ROOT',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code })
    );
    check('[D] strict 下不弹确认（直接拒，不问）', confirm.calls.length === 0, 'confirmCalls=' + confirm.calls.length);
  }

  // 真实风险演示：变量写目标批准后确实能写到项目外 —— 所以「默认放行」是漏洞，「按用户决定」才是当前边界
  {
    const riskCmd = 'node -e "const fs=require(\'fs\');const p=\'' + slash(outside) + '\';fs.writeFileSync(p,\'x\')"';
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), riskCmd, confirm);
    check('[D] 演示前置：该命令确实被静态审计记为未解析写目标', /变量或通配/.test(String(confirm.calls[0] && confirm.calls[0].detail || '')), String(confirm.calls[0] && confirm.calls[0].detail || '').slice(0, 120));
    check(
      '[D] 用户批准后越界写会真的发生（这条路径的防护是「人」，不是内核 —— 文案必须说清）',
      res.ok === true && fs.existsSync(outside) === true,
      JSON.stringify({ ok: res.ok, exists: fs.existsSync(outside) })
    );
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  }

  // ==================== E. 负向：不该误伤的一律不弹确认 ====================
  console.log('\n== E. 负向（不能过度修复）==');
  {
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), literalCmd, confirm);
    check('[E] 明文写目标落在项目内 → 不额外要求确认', confirm.calls.length === 0, 'confirmCalls=' + confirm.calls.length);
    check('[E] 且没有被结构性拒绝', !/拒绝执行/.test(String(res.text || '')), JSON.stringify({ ok: res.ok, text: String(res.text || '').slice(0, 60) }));
  }
  {
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), 'git status', confirm);
    check('[E] 只读命令（git status）不受影响', confirm.calls.length === 0 && !/拒绝执行/.test(String(res.text || '')), 'confirmCalls=' + confirm.calls.length);
  }
  {
    // 显式越界写仍然硬拒（既有行为回归保护）
    const confirm = makeConfirm(true);
    const res = await runShell(makePolicy(), 'cmd /c echo X > ' + slash(path.join(outsideDir, 'still-outside.txt')), confirm);
    check(
      '[E] 显式越界写仍然硬拒（PATH_OUT_OF_ROOT）',
      res.ok === false && res.data && res.data.code === 'PATH_OUT_OF_ROOT',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code })
    );
    check('[E] 未落盘（终态判据）', fs.existsSync(path.join(outsideDir, 'still-outside.txt')) === false);
  }

  // ==================== F. 归一化一致性：换个写法不许绕过断网策略 ====================
  console.log('\n== F. 联网判定必须与白名单/高危判据共用归一化 ==');
  {
    /**
     * 实测缺口（2026-09-21，由出厂 deny 暴露）：`nuget restore` 被判为联网命令，
     * 而同一件事的路径限定写法 `C:/tools/nuget.exe restore` 一点都不命中 ——
     * 因为 detectNetwork 只用 tokens[0] 原文匹配，不剥目录/扩展名。
     * 出厂 deny 下前者的表现是「被拒」，后者是「弹一次确认就走」，同一件事两种判定。
     */
    // 注意：带空格的绝对路径必须加引号（不加引号在 cmd/POSIX 里本来就跑不起来，不属于「换写法绕过」）
    for (const cmd of ['nuget restore', 'C:/tools/nuget.exe restore', 'npm install', '"C:/Program Files/nodejs/npm.cmd" install']) {
      const analysis = shellGuard.analyzeShellCommand(cmd, { projectRoot: root, writeRoots: [root, os.tmpdir()] });
      check('[F] 静态审计认出联网意图：' + cmd, analysis.network.length > 0, JSON.stringify(analysis.network));
    }
    for (const cmd of ['nuget restore', 'C:/tools/nuget.exe restore']) {
      const confirm = makeConfirm(true);
      const res = await runShell(makePolicy(), cmd, confirm);
      check(
        '[F] 断网策略下两种写法都必须被拒（不许换写法绕过）：' + cmd,
        res.ok === false && res.data && res.data.code === 'PERMISSION_DENIED' && confirm.calls.length === 0,
        JSON.stringify({ ok: res.ok, code: res.data && res.data.code, confirmCalls: confirm.calls.length })
      );
    }
  }

  try {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'SHELL BOUNDARY TEST: PASS' : 'SHELL BOUNDARY TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SHELL BOUNDARY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
