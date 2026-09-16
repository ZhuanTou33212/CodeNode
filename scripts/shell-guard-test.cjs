/**
 * shell-guard-test.cjs —— execute_shell 的越界写 / 网络约束必须在能力层 fail-closed
 *
 * 回归 bug（P0，2026-09-15 实测复现）：execute_shell 的白名单含 cmd / powershell / node /
 * npm / npx，而 Windows 后端（windows-job）**不隔离文件系统**（writeRoots 只对 Linux bwrap /
 * macOS sandbox-exec 生效）。于是
 *   cmd /c echo PWNED > <项目外路径>
 *   node -e "require('fs').writeFileSync('<项目外路径>','x')"
 * 两条命令都真的写成功了；唯一的兜底是用户点确认，而确认文案只说「执行命令」。
 *
 * 判据（终态口径）：
 *   - 越界写：工具 ok=false + code=PATH_OUT_OF_ROOT，且**磁盘上确实没有那个文件**；
 *   - 项目内写：仍然放行（不能过度修复成一律拒绝）；
 *   - 只读引用外部路径：不误伤（guard 只认显式写出口）；
 *   - sandbox.network=deny：疑似联网的命令直接拒绝（PERMISSION_DENIED）；
 *   - strict 模式：写目标含变量（无法静态判定）→ 拒绝；best-effort 下只提示。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-shell-guard-'));
const outsideDir = path.join(os.homedir(), 'codenode-shell-guard-out-' + process.pid);
const outside = path.join(outsideDir, 'pwned.txt');
fs.mkdirSync(outsideDir, { recursive: true });

/** 命令里用正斜杠（node / cmd 都认），避免反斜杠转义歧义 */
const slash = (p) => String(p).replace(/\\/g, '/');

function makePolicy(overrides) {
  return sandbox.resolvePolicy(
    Object.assign({ mode: 'best-effort' }, overrides || {}),
    { projectRoot: root, userDataDir: root },
  );
}

function registry(policy) {
  sandbox.setDefaultPolicy(policy);
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['execute_shell'] });
}

function contextWith(policy, confirm) {
  return new AgentToolContext({
    projectRoot: root,
    confirm: confirm || (async () => true),
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
}

(async () => {
  // ---- (1) 越界写：重定向到项目外的绝对路径 → 拒绝，且磁盘上没有该文件 ----
  {
    const policy = makePolicy();
    const command = 'cmd /c echo PWNED > ' + slash(outside);
    const res = await registry(policy).execute('execute_shell', { command }, contextWith(policy));
    check('(1) 越界写（cmd 重定向）被拒绝', res.ok === false && res.data && res.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('(1) 越界写未落盘（终态判据）', fs.existsSync(outside) === false, outside);
  }

  // ---- (2) 相对路径逃逸（.. 爬到 writeRoots 之外）→ 拒绝 ----
  {
    const policy = makePolicy();
    const escapeRel = ['..', '..', '..'].join(path.sep) + path.sep + 'codenode-escape-' + process.pid + '.txt';
    const escapeTarget = path.resolve(root, escapeRel);
    const res = await registry(policy).execute('execute_shell', { command: 'cmd /c echo X > ' + escapeRel }, contextWith(policy));
    check('(2) 相对逃逸写被拒绝', res.ok === false && res.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('(2) 相对逃逸未落盘', fs.existsSync(escapeTarget) === false, escapeTarget);
  }

  // ---- (3) 脚本 API 字面量越界写 → 拒绝 ----
  {
    const policy = makePolicy();
    const command = 'node -e "require(\'fs\').writeFileSync(\'' + slash(outside) + '\',\'x\')"';
    const res = await registry(policy).execute('execute_shell', { command }, contextWith(policy));
    check('(3) node -e writeFileSync 越界被拒绝', res.ok === false && res.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('(3) 越界写未落盘', fs.existsSync(outside) === false, outside);
  }

  // ---- (4) 项目内写：仍然放行（防止过度修复） ----
  {
    const policy = makePolicy();
    const inside = path.join(root, 'inside.txt');
    const command = 'cmd /c echo hello > ' + slash(inside);
    const res = await registry(policy).execute('execute_shell', { command }, contextWith(policy));
    check('(4) 项目内写仍放行', res.ok === true && fs.existsSync(inside), JSON.stringify({ ok: res.ok, exists: fs.existsSync(inside) }));
  }

  // ---- (5) 只读引用项目外路径：不误伤 ----
  {
    const policy = makePolicy();
    const command = 'node -e "console.log(require(\'fs\').existsSync(\'' + slash(outsideDir) + '\'))"';
    const res = await registry(policy).execute('execute_shell', { command }, contextWith(policy));
    check('(5) 只读引用项目外路径不误伤', res.ok === true && !/PATH_OUT_OF_ROOT/.test(String(res.data && res.data.code)), JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
  }

  // ---- (6) sandbox.network=deny：疑似联网的命令直接拒绝，不试连 ----
  {
    const policy = makePolicy({ network: 'deny' });
    for (const command of ['git push origin main', 'npm install', 'node -e "fetch(\'https://example.com\')"']) {
      const res = await registry(policy).execute('execute_shell', { command }, contextWith(policy));
      check('(6) network=deny 时拒绝联网命令：' + command.slice(0, 24), res.ok === false && res.data.code === 'PERMISSION_DENIED', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    }
    // 不联网的命令不受影响
    const safe = await registry(policy).execute('execute_shell', { command: 'node --version' }, contextWith(policy));
    check('(6) network=deny 不影响离线命令', safe.ok === true, JSON.stringify({ ok: safe.ok }));
  }

  // ---- (7) 网络策略为 inherit 时不拦截（只记录，交给隔离层/确认） ----
  {
    const analysis = shellGuard.analyzeShellCommand('git push origin main', { projectRoot: root, writeRoots: [root, os.tmpdir()] });
    check('(7) 分析层如实报出联网意图', analysis.network.length > 0 && analysis.outsideWrites.length === 0, JSON.stringify(analysis));
  }

  // ---- (8) 写法不对称：cp 的写目标是最后一个参数（源在项目外不该被误判） ----
  {
    const analysis = shellGuard.analyzeShellCommand('cp ' + slash(outside) + ' ./copy-in.txt', { projectRoot: root, writeRoots: [root, os.tmpdir()] });
    check('(8) cp 源在项目外、目标在项目内 → 不判越界', analysis.outsideWrites.length === 0, JSON.stringify(analysis));
  }

  // ---- (9) 确认文案带上静态审计提示（变量写目标 / 联网） ----
  {
    const policy = makePolicy();
    /** @type {string[]} */
    const details = [];
    const confirm = async (level, what, detail) => {
      details.push(String(detail || ''));
      return false; // 直接拒绝，避免真的执行
    };
    const command = 'node -e "require(\'fs\').writeFileSync(target,\'x\')"';
    await registry(policy).execute('execute_shell', { command }, contextWith(policy, confirm));
    check('(9) 确认文案提示写目标无法判定', details.some((d) => /静态审计提示/.test(d) && /无法静态判定/.test(d)), JSON.stringify(details));
  }

  // ---- (10) strict 模式：写目标含变量 → 拒绝；best-effort 下同一条命令只提示 ----
  {
    const strict = makePolicy({ mode: 'strict' });
    const command = 'node -e "require(\'fs\').writeFileSync(target,\'x\')"';
    const res = await registry(strict).execute('execute_shell', { command }, contextWith(strict, async () => true));
    check('(10) strict 模式拒绝无法判定的写目标', res.ok === false && res.data.code === 'PATH_OUT_OF_ROOT', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
  }

  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('SHELL GUARD TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('SHELL GUARD TEST: ERROR', e);
  process.exit(1);
});
