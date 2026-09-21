#!/usr/bin/env node
/**
 * shell-hardening-test.cjs —— execute_shell 的三条边界（增量审查 2026-09-19 #8 / #19 / #20）
 *
 * 建议 npm script 名：`test:shell-hardening`（核心套件，无需显示环境/网络/真实命令）。
 *
 * #8 高风险确认判据与白名单不共用归一化结果：
 *     白名单用归一化 basename，`isSensitiveCommand` 却用 tokens[0] 原文 —— 于是 `/usr/bin/node -e …`
 *     不触发 HIGH 确认，`gradle/gradlew/nuget` 只在白名单里不在高危名单里。在隔离后端缺失的降级路径上，
 *     HIGH 确认是任意代码执行的唯一闸门。判据：**同一程序的裸写法与路径限定写法得到相同的 sensitive 判定**。
 * #19 输出收集侧无界：`outputPage` 只限制返回的那一页，收集侧仍随命令输出线性增长（可 OOM）。
 *     判据：收集器有硬上限、丢弃量如实计数、尾部窗口保留、未超限时文本原样（反向锁）。
 * #20 POSIX 前台 spawn 不带 detached → 子进程不是进程组长，`process.kill(-pid)` ESRCH，
 *     退回只杀直接子进程（`npm test` → jest worker 这类子孙残留）。判据：前台选项在 POSIX 上 detached。
 *
 * 注意：本用例**不真正执行命令**（#8 的确认 spy 一律拒绝），因此不受「子进程管道 stdio 被环境拦截」影响。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const shellTool = require('../electron/tools/impl/executeShellTool.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shell-hardening-'));
/**
 * 本节考察的是 #8「sensitive 判据与白名单共用归一化」，所以显式声明 `network: 'inherit'`：
 * 出厂口径现在是 deny，"不写 network" 会让联网类命令（如 `nuget restore`）先被断网策略硬拒，
 * 于是本节测的就不再是「敏感判定」了（2026-09-21 出厂口径变更时实测踩到）。
 */
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);
const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['execute_shell'] });

/**
 * 确认 spy：记录 (level, what, detail) 并一律拒绝 —— `sensitive === true` 时工具在 confirm 后立刻返回，
 * 这就是「是否会弹 HIGH 确认」的可观测判据，同时保证本用例不真的执行任何命令。
 */
function makeContext() {
  const seen = [];
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async (level, what, detail) => {
      seen.push({ level, what, detail });
      return false;
    },
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  return { context, seen };
}

(async () => {
  // ===================== #8 判据与白名单共用归一化 =====================
  // 每组：[裸写法, 路径限定写法] —— 两者必须得到**相同**的 sensitive 判定（都必须触发 HIGH 确认）
  const pairs = [
    ['node -e "console.log(1)"', '/usr/bin/node -e "console.log(1)"'],
    ['node --version', '"C:/Program Files/nodejs/node.exe" --version'],
    ['python -V', '/usr/bin/python3 -V'],
    ['gradle build', '/opt/gradle/bin/gradle build'],
    ['gradlew.bat build', 'C:/proj/gradlew.bat build'],
    ['nuget restore', 'C:/tools/nuget.exe restore'],
  ];
  for (const [bare, qualified] of pairs) {
    const bareRun = makeContext();
    await registry.execute('execute_shell', { command: bare }, bareRun.context);
    const qualifiedRun = makeContext();
    await registry.execute('execute_shell', { command: qualified }, qualifiedRun.context);
    const bareSensitive = bareRun.seen.length > 0;
    const qualifiedSensitive = qualifiedRun.seen.length > 0;
    check(
      '#8 裸写法与路径限定写法判定一致（都需 HIGH 确认）：' + qualified,
      bareSensitive === true && qualifiedSensitive === true,
      JSON.stringify({ bare: bare, bareConfirm: bareSensitive, qualifiedConfirm: qualifiedSensitive, result: String((qualifiedRun.seen[0] || {}).what || '') })
    );
  }
  {
    // 反向锁：只读子命令不该被顺手升级成全量确认（防过度修复：git status 仍直接放行）
    const ro = makeContext();
    const res = await registry.execute('execute_shell', { command: 'git status' }, ro.context);
    check(
      '#8 反向锁：git status 这类只读子命令仍不触发 HIGH 确认（不是把白名单一律升级）',
      ro.seen.length === 0,
      JSON.stringify({ confirmCalls: ro.seen.length, ok: res.ok, text: String(res.text).slice(0, 80) })
    );
  }

  // ===================== #19 输出收集侧硬上限 =====================
  const MAX = shellTool.MAX_COLLECT_CHARS;
  {
    const state = shellTool.makeOutputCollector();
    shellTool.pushCollected(state, 'a'.repeat(MAX - 10));
    shellTool.pushCollected(state, 'b'.repeat(100));
    const live = shellTool.collectedText(state);
    check('#19 收集侧有界：正文长度不超过硬上限', state.output.length <= MAX && state.output.length >= MAX - 10, JSON.stringify({ len: state.output.length, max: MAX }));
    check('#19 丢弃量如实计数（不是静默丢）', state.droppedChars === 90, JSON.stringify({ dropped: state.droppedChars }));
    check('#19 保留尾部窗口（失败原因几乎总在最后几行）', state.tail === 'b'.repeat(90) && live.endsWith('b'.repeat(90)), JSON.stringify({ tailLen: state.tail.length }));
    check('#19 截断在文本里可见（不是「看起来完整」）', /收集上限/.test(live) && /已丢弃/.test(live), JSON.stringify(live.slice(-120)));
  }
  {
    const small = shellTool.makeOutputCollector();
    shellTool.pushCollected(small, 'hello\n');
    shellTool.pushCollected(small, 'world\n');
    check('#19 反向锁：未超限时文本原样、不掺杂截断标记', shellTool.collectedText(small) === 'hello\nworld\n' && small.droppedChars === 0, JSON.stringify(shellTool.collectedText(small)));
  }
  {
    // 静态门禁：前台 / 后台两条收集路径都必须走有界收集器（否则上限只在注释里）
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'impl', 'executeShellTool.cjs'), 'utf8');
    check('#19 前台收集走 pushCollected(collected, …)', /child\.stdout\.on\('data', \(d\) => \{\s*pushCollected\(collected, decodeOutput\(d\)\);/.test(src), '');
    check('#19 后台收集走 pushCollected(job, …)', /child\.stdout\.on\('data', \(d\) => \{ pushCollected\(job, decodeOutput\(d\)\); \}\);/.test(src), '');
    check('#19 前台结果如实上报截断标记', /outputTruncated: collected\.droppedChars > 0/.test(src), '');
  }

  // ===================== #20 前台 spawn 的 detached =====================
  {
    const options = shellTool.foregroundSpawnOptions(root, {}, policy, null);
    check(
      '#20 前台 spawn 选项：POSIX 上 detached=true（进程组长才能整组终止），Windows 上显式 false',
      options.detached === (process.platform !== 'win32'),
      JSON.stringify({ platform: process.platform, detached: options.detached })
    );
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'impl', 'executeShellTool.cjs'), 'utf8');
    check('#20 前台执行确实使用该选项（不是定义了一个没人用的函数）', /guardedSpawn\(spec, foregroundSpawnOptions\(/.test(src), '');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('SHELL HARDENING TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('SHELL HARDENING TEST: ERROR');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
