#!/usr/bin/env node
/**
 * run-all-tests.cjs —— 统一测试入口（CI 与本地共用，门禁集合只在此处定义一次）
 *
 * 用法：
 *   node scripts/run-all-tests.cjs                 # 核心套件：无需显示环境 / 无需网络 / 确定性
 *   node scripts/run-all-tests.cjs --group all     # 追加需要显示环境或浏览器的用例
 *   node scripts/run-all-tests.cjs --group display # 只跑需要显示环境/浏览器的用例
 *   node scripts/run-all-tests.cjs --only test:eval,test:sandbox
 *   node scripts/run-all-tests.cjs --list
 *   node scripts/run-all-tests.cjs --stop-on-fail
 *
 * 退出码：任一用例失败 → 非 0（fail-closed，CI 直接红）。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// 核心套件：全部为纯 Node 断言，不弹窗、不联网、可在三平台无显示环境运行。
const CORE = [
  'test:session',
  'test:arrange',
  'test:model',
  'test:cache',
  'test:container',
  'test:scope-frame',
  'test:undo',
  'test:scalar',
  'test:vector-store',
  'test:agent-reliability',
  'test:agent-boundary',
  'test:bridge',
  'test:request-budget',
  'test:run-store',
  'test:atomic-file',
  'test:dep-declaration',
  'test:subagent',
  'test:subagent-isolation',
  'test:subagent-role-skill',
  'test:compression-batch',
  'test:tool-failure-taxonomy',
  'test:scheduler-parallel',
  'test:approval-token',
  'test:shell-guard',
  'test:test-mode',
  'test:event-replay',
  'test:agent-limits',
  'test:context-budget',
  'test:mcp-handshake',
  'test:read-file-limits',
  'test:limit-wrapup',
  'test:memory-recall',
  'test:agent-iterations',
  'test:tool-contract',
  'test:grounding-gate',
  'test:sync-cancel',
  'test:fs-worker',
  'test:pdf-text',
  'test:agent-cache',
  'test:tool-call-id',
  'test:stream-accumulator',
  'test:stream-recovery',
  'test:compaction',
  'test:subagent-envelope',
  'test:context-overflow',
  'test:multi-agent-integrity',
  'test:agent-request-shape',
  'test:agent-progress',
  'test:truncation-safety',
  'test:agent-state',
  'test:tool-descriptor',
  'test:context-capability',
  'test:side-effect-idem',
  'test:save-project',
  'test:shell-timeout',
  'test:sandbox-stdin',
  'test:security',
  'test:ipc',
  'test:rag',
  'test:shell-output',
  'test:bg',
  'test:production-gate',
  'test:runtime-gate',
  'test:sandbox',
  'test:resume',
  'test:cost',
  'test:eval',
  // 前端增量修复（#7 并发竞态 / #21 plan 与 delta 分支 / #25 错误可见性与 a11y）：
  // 纯 node + react-dom/server 渲染，不需要窗口，所以留在核心组
  'test:frontend-incremental',
  // 流内异常必须被消费（#12）：自带 fetch stub，离线确定性
  'test:stream-anomaly',
  // 工具审批/边界加固（#8 确认判据归一化 / #10 确认信息面 / #19 shell 输出上限 / #20 前台进程树：
  // 纯 Node 断言 + 静态门禁，离线确定性）
  'test:shell-hardening',
  'test:confirm-payload',
  // 存储加固（#14 日志与恢复只读首尾 / #16 memory 损坏拒绝写 / #15 脱敏 / #13 合并落盘）：
  // 纯 Node 断言；scale 会写约 45MB 临时文件、2-4s
  'test:run-store-scale',
  'test:storage-hardening',
  // 用例输入与生产同形（增量审查 §4.4）：从真实请求体抓生产 tool 消息字段集，
  // 与续跑重建路径 + 用例 fixture 逐字段对齐（纯 node，离线确定性）
  'test:fixture-shape',
  // 真机回归挂 PR（增量审查 §4.1）：任务声明完整性 + --subset=pr 体检 + CI 接线 +
  // 无 Key fail-closed + 用独立进程 mock 服务器跑一遍真 HTTP 真机管线（离线确定性）
  'test:real-model-pr',
  // 每轮固定开销分层（增量审查 §4.3）：画布规则按需注入 + 开销上界门禁
  'test:prompt-layers',
  // Run 级文件回滚（增量审查 §4.2）：前像抓取 / 只读计划 / 执行与校验 / 越界与冲突的拒绝对待
  'test:run-rollback',
  // 运行中插话（§4.2）：队列语义 / 恰好插入一次 / 不插话零痕迹 / 接线
  'test:agent-steering',
  // 子代理任务视图跨 run 留存（§4.2）：落盘 / 跨实例可读 / 覆盖与上限 / 坏文件如实报告
  'test:subagent-view',
  // 任务清单（对照 Codex 的 update_plan）：schema/校验 / 落盘 + run 事件 / 即时回灌 / 只留一条 / 负向零痕迹
  'test:agent-plan',
  // Windows 无内核隔离这条边界的收口：出厂断网 + 「写目标判不出来」不再静默放行（含负向防误伤）
  'test:shell-boundary',
  // 钩子（对照 Claude Code 的 hooks）：PostToolUse 回灌 / SessionStart-Stop / 越界写与断网拒绝 / 未配置零痕迹
  'test:hooks',
  // 非交互入口（对照 codex exec / claude -p）：参数与凭据 fail-closed / 真 HTTP 一轮 / 写操作确认两向 / run 落盘
  'test:headless',
  // 用户级（跨项目）记忆：落盘/去重/上限/按提问打分/scope 读写
  'test:user-memory',
  // 持久化审批规则（对照 Claude Code 的 allow 规则）：命中免打扰 + 留痕 / 受保护路径写不进 / 界面接线
  'test:approval-rules',
  // 技能渐进披露（§4 固定开销）：prompt 只放索引 / read_skill 按需读正文 / 上限截断
  'test:skill-index',
  // 看图（对照 Codex 的 view_image）：格式与上限校验 / 多模态消息真的进了下一次请求 / 零痕迹
  'test:view-image',
  // MCP 会话复用 + tools/list 缓存（§5 #5）：spawn 次数 / 握手次数 / 清单只问一次 / 崩溃重拉 / 空闲回收
  'test:mcp-session',
];

// 需要显示环境（Electron 窗口）或本机浏览器（无头 Edge + CDP）的用例：CI 分开跑。
const DISPLAY = ['test:smoke', 'test:rag-ui', 'test:compaction-ui', 'test:vector', 'test:event-replay-ui'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const inline = argv.find((a) => a.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  const next = index >= 0 ? argv[index + 1] : null;
  return next && !next.startsWith('--') ? next : null;
};

const group = valueOf('--group') || 'core';
const only = (valueOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const stopOnFail = flag('--stop-on-fail');

let scripts;
if (only.length) scripts = only;
else if (group === 'all') scripts = [...CORE, ...DISPLAY];
else if (group === 'display') scripts = [...DISPLAY];
else scripts = [...CORE];

if (flag('--list')) {
  console.log('核心套件 (' + CORE.length + '):\n  ' + CORE.join('\n  '));
  console.log('\n显示/浏览器套件 (' + DISPLAY.length + '):\n  ' + DISPLAY.join('\n  '));
  process.exit(0);
}

const isWindows = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

function runScript(name) {
  const started = Date.now();
  // --only 允许从命令行指定脚本名：只接受 npm script 合法字符，避免 shell 注入。
  if (!/^[A-Za-z0-9:_-]+$/.test(name)) {
    console.log('✖ 非法脚本名（已跳过）：' + JSON.stringify(name));
    return { name, ok: false, ms: 0, status: 1, signal: null };
  }
  console.log('\n' + '─'.repeat(72) + '\n▶ ' + name + '\n' + '─'.repeat(72));
  // Windows 上直接 spawn npm.cmd 会 EINVAL，必须走 shell；POSIX 上必须用参数数组（把整条命令
  // 当字符串交给 execve 会 ENOENT → status=null，CI 上表现为"25 项全部 0.00s 失败"）。
  const result = isWindows
    ? spawnSync('npm.cmd run --silent ' + name, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', ['run', '--silent', name], { cwd, stdio: 'inherit' });
  const ms = Date.now() - started;
  const ok = result.status === 0;
  // spawn 本身失败（ENOENT/EINVAL）时 status 为 null、error 有值：必须显式带出来，
  // 否则只剩 `exit=null`，看不出是脚本失败还是根本没跑起来。
  const spawnError = result.error ? String(result.error.message || result.error) : null;
  return { name, ok, ms, status: result.status, signal: result.signal, error: spawnError };
}

console.log('CodeNode 测试套件：组=' + (only.length ? '自定义' : group) + '，共 ' + scripts.length + ' 项');

const results = [];
for (const name of scripts) {
  const r = runScript(name);
  results.push(r);
  if (!r.ok && stopOnFail) {
    console.log('\n✖ 失败即停：' + name);
    break;
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = scripts.slice(results.length);

console.log('\n' + '='.repeat(72));
console.log('测试汇总');
console.log('='.repeat(72));
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log('  ' + mark + '  ' + r.name.padEnd(26) + (r.ms / 1000).toFixed(2).padStart(7) + 's' + (r.ok ? '' : '  (exit=' + r.status + (r.error ? ', spawn 失败: ' + r.error : '') + ')'));
}
if (skipped.length) console.log('  跳过: ' + skipped.join(', '));

const total = (results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1);
console.log('-'.repeat(72));
console.log(
  failed.length
    ? '结果: FAIL —— ' + failed.length + '/' + results.length + ' 项失败（' + failed.map((r) => r.name).join(', ') + '），用时 ' + total + 's'
    : '结果: PASS —— ' + results.length + '/' + results.length + ' 项通过，用时 ' + total + 's'
);

process.exitCode = failed.length ? 1 : 0;
