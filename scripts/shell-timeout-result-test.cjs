/**
 * shell-timeout-result-test.cjs —— 命令超时/后台任务超时必须是失败，不能报 ok=true
 *
 * 回归 bug（P0，实测）：execute_shell 在超时强杀后返回
 *   AgentToolResult.ok('退出码 -1（超时强杀）…', { timedOut: true })
 * —— ok=true。模型看到「工具成功」会把被杀掉的命令当成已完成（实测：Windows 上
 * git 类命令在沙箱后端下一律挂到超时，于是「git 失败」被当成「git 成功」）。
 * poll_job 的后台超时分支同样把 'timeout' 当成功返回。
 *
 * 判据：超时 → ok=false + data.timedOut=true + code=TIMEOUT；正常退出 → ok=true。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { BACKGROUND_JOBS } = require('../electron/tools/impl/executeShellTool.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shell-timeout-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

function registry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['execute_shell', 'poll_job'] });
}
function context() {
  return new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal });
}

(async () => {
  // ---- (1) 正常命令：ok=true ----
  const ok = await registry().execute('execute_shell', { command: 'node -e "console.log(1+1)"', timeoutSeconds: 30 }, context());
  check('正常命令：ok=true 且带退出码 0', ok.ok === true && ok.data.exitCode === 0 && /2/.test(String(ok.text)), JSON.stringify({ ok: ok.ok, exitCode: ok.data.exitCode }));

  // ---- (2) 前台超时：ok=false（此前是 ok=true）----
  const started = Date.now();
  const timeout = await registry().execute(
    'execute_shell',
    { command: 'node -e "setTimeout(function(){}, 60000)"', timeoutSeconds: 1 },
    context()
  );
  const elapsed = Date.now() - started;
  check('前台超时：ok=false（不得谎报成功）', timeout.ok === false, JSON.stringify({ ok: timeout.ok, text: String(timeout.text).slice(0, 80) }));
  check('前台超时：code=TIMEOUT 且 data.timedOut=true', timeout.data.code === 'TIMEOUT' && timeout.data.timedOut === true, JSON.stringify(timeout.data));
  check('前台超时：文本明确说明已强制终止', /超时/.test(String(timeout.text)) && /强制终止|终止/.test(String(timeout.text)), String(timeout.text).slice(0, 80));
  check('前台超时：约 1 秒内返回（未挂到 60 秒）', elapsed < 15000, elapsed + 'ms');

  // ---- (3) 后台任务超时：poll_job 也必须报失败 ----
  const bg = await registry().execute(
    'execute_shell',
    { command: 'node -e "setTimeout(function(){}, 60000)"', async: true, timeoutSeconds: 10 },
    context()
  );
  check('后台启动：ok=true 且返回 jobId', bg.ok === true && !!bg.data.jobId, JSON.stringify(bg.data));
  const job = BACKGROUND_JOBS.get(bg.data.jobId);
  if (job) {
    // 直接推进到超时终态（等价于 JOB_TTL 到期后的状态），避免等待 10 分钟 TTL
    job.status = 'timeout';
    job.output += '\n…（后台任务超时，已强制终止）';
  }
  const polled = await registry().execute('poll_job', { jobId: bg.data.jobId }, context());
  check('后台任务超时：poll_job 返回 ok=false（此前把 timeout 当成功）', polled.ok === false, JSON.stringify({ ok: polled.ok, text: String(polled.text).slice(0, 90) }));
  check('后台任务超时：code=TIMEOUT 且 data.timedOut=true', polled.data.code === 'TIMEOUT' && polled.data.timedOut === true, JSON.stringify(polled.data));

  // 收尾：kill 掉那个还在 sleep 的后台子进程，否则它握住 stdio 让本用例进程挂到 60 秒才退出
  if (job && job.child) {
    try { sandbox.killSandboxed(job.child, true); } catch {}
  }
  BACKGROUND_JOBS.delete(bg.data.jobId);

  console.log(failures === 0 ? 'SHELL TIMEOUT RESULT TEST: PASS' : 'SHELL TIMEOUT RESULT TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SHELL TIMEOUT RESULT TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
