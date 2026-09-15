/**
 * sandbox-stdin-eof-test.cjs —— 沙箱子进程的 stdin 必须是「立即 EOF」
 *
 * 回归 bug（P0，实测）：winjob.cs 用 RedirectStandardInput=false 启动目标命令，子进程因此
 * **继承了 broker 的 stdin**（node 侧用于存活探测的长生命管道：永不写入、也不关闭）。
 * 任何会读 stdin 的程序就永久阻塞、零输出，只能等超时强杀 ——
 * 实测 MSYS git.exe：`git --version` / `cmd /c git --version` 在 windows-job 后端下挂满 60s
 * （`node --version`、`where git` 正常，251ms），即「沙箱开着时 git 全部不可用」。
 *
 * 修法：broker 改为 RedirectStandardInput=true 并在启动后立即 Close()（该后端本就不支持交互式
 * stdin，guardedInteractiveSpawn 走别的路径）。本用例用一个「读到 EOF 才退出」的子进程验证：
 * 有 bug 时它会挂住，修好后应立刻拿到 EOF 并打印标记。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../electron/sandbox.cjs');
const { safeEnvironment } = require('../electron/envPolicy.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-stdin-eof-'));
const policy = sandbox.resolvePolicy({ mode: 'best-effort' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);
const backend = (sandbox.capabilities() || {}).backend;

const childScript = "process.stdin.resume();process.stdin.on('end',function(){console.log('STDIN-EOF');});";

function run() {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let child;
    try {
      child = sandbox.guardedSpawn(
        { file: process.execPath, args: ['-e', childScript] },
        { cwd: root, env: safeEnvironment({}), policy }
      );
    } catch (error) {
      resolve({ error: String((error && error.message) || error) });
      return;
    }
    const timer = setTimeout(() => {
      try { sandbox.killSandboxed(child, true); } catch {}
      resolve({ timedOut: true, elapsedMs: Date.now() - started, output });
    }, 15000);
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: String((error && error.message) || error), output }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, elapsedMs: Date.now() - started, output }); });
  });
}

(async () => {
  console.log('后端=' + backend + '（policy: ' + sandbox.describe(policy) + '）');
  if (process.platform !== 'win32' || backend !== 'windows-job') {
    console.log('SKIP  (该机制只存在于 Windows Job 代理后端；当前平台/后端为 ' + process.platform + '/' + backend + ')');
    console.log('SANDBOX STDIN EOF TEST: PASS (skipped 1)');
    return;
  }
  const result = await run();
  check('子进程在 15 秒内拿到 stdin EOF 并退出（有 bug 时会挂住）', !result.timedOut,
    JSON.stringify({ elapsedMs: result.elapsedMs, output: String(result.output || '').slice(0, 120) }));
  check('退出码为 0 且打印了 EOF 标记', result.code === 0 && /STDIN-EOF/.test(String(result.output || '')), JSON.stringify(result));
  check('耗时在秒级（不是等超时）', (result.elapsedMs || 0) < 10000, (result.elapsedMs || 0) + 'ms');

  console.log(failures === 0 ? 'SANDBOX STDIN EOF TEST: PASS' : 'SANDBOX STDIN EOF TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SANDBOX STDIN EOF TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
