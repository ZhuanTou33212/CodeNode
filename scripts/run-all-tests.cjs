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
  'test:subagent',
  'test:agent-cache',
  'test:tool-call-id',
  'test:stream-accumulator',
  'test:truncation-safety',
  'test:agent-state',
  'test:tool-descriptor',
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
];

// 需要显示环境（Electron 窗口）或本机浏览器（无头 Edge + CDP）的用例：CI 分开跑。
const DISPLAY = ['test:smoke', 'test:rag-ui', 'test:vector'];

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
