'use strict';
/**
 * path-boundary-test.cjs —— 路径边界的 fail-closed
 *
 * 原有判据：`resolveInRoot` 拒绝「符号链接/junction 指向根外」「.. 逃逸」，放行根内新文件。
 *
 * 本轮追加（增量审查 2026-09-19 #17）：`read_file` 的敏感判定此前用**模型给的 relative**，
 * 之后才 `resolveInRoot`（它只保证 realpath 在根内）并跟随符号链接读取 —— 于是仓库自带一个
 * `notes.md -> .env` 的链接就能把凭据原文读进上下文、发给供应商。判据：realpath 指向敏感文件时读取必须被拒；
 * 普通文件不受影响（反向锁）。
 *
 * 平台说明：Windows 上创建**文件**符号链接需要开发者模式 / SeCreateSymbolicLinkPrivilege，
 * 拿不到权限时行为判据退化为「静态门禁」——断言读取路径的敏感判定确实作用在 realpath 上。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveInRoot } = require('../electron/tools/impl/shared.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-path-'));
const root = path.join(temp, 'project');
const outside = path.join(temp, 'outside');
const link = path.join(root, 'linked');

(async () => {
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(resolveInRoot(root, 'linked/new.txt'), null);
  assert.strictEqual(resolveInRoot(root, '../outside/new.txt'), null);
  assert.strictEqual(resolveInRoot(root, 'safe/new.txt'), path.join(root, 'safe/new.txt'));
  check('resolveInRoot：根外 junction / .. 逃逸被拒、根内新文件放行', true, '');

  // ===================== #17 read_file 的敏感判定走 realpath =====================
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1', 'utf8');
  fs.writeFileSync(path.join(root, 'normal.md'), 'hello boundary', 'utf8');
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: temp });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });

  // 行为判据：`notes.md` 是「改了个名字的 .env」——请求路径本身不敏感，realpath 才是
  let linked = false;
  try {
    fs.symlinkSync('.env', path.join(root, 'notes.md'), 'file');
    linked = true;
  } catch {}
  if (linked) {
    const res = await registry.execute('read_file', { path: 'notes.md' }, context);
    check('#17 notes.md -> .env 的符号链接被拒（凭据保护）',
      res.ok === false && /凭据保护/.test(String(res.text)),
      JSON.stringify({ ok: res.ok, text: String(res.text).slice(0, 80) }));
    check('#17 凭据原文没有进上下文（终态判据）',
      !/SECRET=1/.test(String(res.text)), String(res.text).slice(0, 60));
  } else {
    console.log('SKIP  #17 行为判据 —— 本机无法创建文件符号链接（Windows 未开开发者模式 / 无 SeCreateSymbolicLinkPrivilege）');
  }
  {
    // 静态门禁：权限受限平台上的替代判据 —— 敏感判定必须作用在 realpath 上
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'impl', 'readFileTool.cjs'), 'utf8');
    check('#17 读取路径的敏感判定作用在 realpath 上（静态门禁）',
      /path\.relative\(\s*fs\.realpathSync\(root\)\s*,\s*fs\.realpathSync\(file\)\s*\)/.test(src), '');
  }
  {
    // 反向锁：普通文件照常可读（realpath 判定不能误伤）
    const res = await registry.execute('read_file', { path: 'normal.md' }, context);
    check('#17 反向锁：普通文件仍可正常读取', res.ok === true && /hello boundary/.test(String(res.text)), JSON.stringify({ ok: res.ok, text: String(res.text).slice(0, 60) }));
  }

  if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('PATH BOUNDARY: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('PATH BOUNDARY: ERROR');
  console.error(error && error.stack ? error.stack : error);
  try {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
