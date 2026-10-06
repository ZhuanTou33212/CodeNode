'use strict';
/**
 * atomic-file-test.cjs —— 文件写盘的两条硬约束
 *
 * 原有判据：`atomicFile.atomicWriteFile` 覆盖写语义正确、不留 .tmp。
 * 本轮追加（增量审查 2026-09-19）：
 *   #9  `edit_file` / `write_file` 的 `expectedSha256` 校验此前只在 `context.confirm` **之前**做 ——
 *       确认框挂着时文件被外部改动，仍会被静默覆盖（TOCTOU 未收口）。判据：在 confirm 与 write
 *       之间改动文件 → 必须拒写（CONFLICT_STALE）且磁盘保持外部改动后的内容；无外部改动时照常写入（反向锁）。
 *       另一面：`edit_file` 不带 expectedSha256 时，确认期间新增的出现次数必须在写盘前重算。
 *   #23 `bulk_edit.create_files` 与 `write_analysis_md` 用裸 `fs.writeFileSync`（不 fsync / 不 rename /
 *       无备份），与 write_file / edit_file 的原子替换口径不一致。判据：静态门禁（不存在绕过
 *       atomicWriteFile 的写路径）+ 功能判据（落盘内容正确、无 .tmp 残留）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../electron/atomicFile.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { sha256OfFile } = require('../electron/tools/impl/shared.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-atomic-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);
const registry = toolkit.buildDefaultRegistryWithConfig({
  projectRoot: root,
  ragEnabled: false,
  toolsAllowed: ['write_file', 'edit_file', 'bulk_edit', 'write_analysis_md'],
});

/**
 * confirm spy：`onConfirm` 在**确认框挂着的这段时间**里执行 —— 这就是 #9 的 TOCTOU 窗口。
 * 返回值决定是否继续写入。
 */
function makeContext(onConfirm, approved) {
  const seen = [];
  return {
    seen,
    context: new AgentToolContext({
      projectRoot: root,
      confirm: async (level, what, detail) => {
        seen.push({ level, what, detail });
        if (typeof onConfirm === 'function') onConfirm(what, detail);
        return approved !== false;
      },
      audit: () => {},
      sandbox: policy,
      signal: new AbortController().signal,
      mutateWorkbench: async (fn) => {
        await fn({ addNode: () => ({ id: 'node-1' }) });
        return true;
      },
    }),
  };
}

(async () => {
  // ===================== 原有：atomicWriteFile 覆盖语义 =====================
  {
    const file = path.join(root, 'nested', 'file.txt');
    atomicWriteFile(file, 'first');
    check('atomicWriteFile：首次写入内容正确', fs.readFileSync(file, 'utf8') === 'first', '');
    atomicWriteFile(file, 'second'.repeat(1000));
    check('atomicWriteFile：覆盖写内容正确', fs.readFileSync(file, 'utf8') === 'second'.repeat(1000), '');
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'));
    check('atomicWriteFile：不留 .tmp 临时文件', leftovers.length === 0, JSON.stringify(leftovers));
  }

  // ===================== #9 write_file：TOCTOU 收口 =====================
  {
    const target = path.join(root, 'guarded.txt');
    fs.writeFileSync(target, 'ORIGINAL', 'utf8');
    const expected = sha256OfFile(target);
    const run = makeContext(() => fs.writeFileSync(target, 'EXTERNAL CHANGE', 'utf8'));
    const res = await registry.execute('write_file', { path: 'guarded.txt', content: 'NEW CONTENT', expectedSha256: expected }, run.context);
    check('#9 write_file：确认期间被外部改动 → 拒写（CONFLICT_STALE）',
      res.ok === false && res.data && res.data.code === 'CONFLICT_STALE',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code, text: String(res.text).slice(0, 80) }));
    check('#9 write_file：外部改动没有被静默覆盖（终态判据）',
      fs.readFileSync(target, 'utf8') === 'EXTERNAL CHANGE',
      JSON.stringify(fs.readFileSync(target, 'utf8')));
  }
  {
    // 反向锁：没有外部改动时照常写入（二次校验不能变成「一律拒写」）
    const target = path.join(root, 'clean-write.txt');
    fs.writeFileSync(target, 'ORIGINAL', 'utf8');
    const run = makeContext(null);
    const res = await registry.execute('write_file', { path: 'clean-write.txt', content: 'NEW CONTENT', expectedSha256: sha256OfFile(target) }, run.context);
    check('#9 write_file 反向锁：无外部改动时正常写入', res.ok === true && fs.readFileSync(target, 'utf8') === 'NEW CONTENT', JSON.stringify({ ok: res.ok, text: String(res.text).slice(0, 60) }));
  }
  {
    // expectedSha256='absent'：确认期间别人先建了文件 → 不得覆盖
    const target = path.join(root, 'absent.txt');
    const run = makeContext(() => fs.writeFileSync(target, 'CREATED BY SOMEONE ELSE', 'utf8'));
    const res = await registry.execute('write_file', { path: 'absent.txt', content: 'MINE', expectedSha256: 'absent' }, run.context);
    check('#9 write_file：expectedSha256=absent 而确认期间文件被建出 → 拒写', res.ok === false && res.data.code === 'CONFLICT_STALE', JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    check('#9 write_file：别人先建的文件未被覆盖', fs.readFileSync(target, 'utf8') === 'CREATED BY SOMEONE ELSE', JSON.stringify(fs.readFileSync(target, 'utf8')));
  }

  // ===================== #9 edit_file：TOCTOU 收口 =====================
  {
    const target = path.join(root, 'edit-guarded.txt');
    fs.writeFileSync(target, 'alpha beta', 'utf8');
    const expected = sha256OfFile(target);
    const run = makeContext(() => fs.writeFileSync(target, 'alpha beta gamma', 'utf8'));
    const res = await registry.execute('edit_file', { path: 'edit-guarded.txt', oldText: 'alpha', newText: 'ALPHA', expectedSha256: expected }, run.context);
    check('#9 edit_file：确认期间被外部改动 → 拒写（CONFLICT_STALE）',
      res.ok === false && res.data && res.data.code === 'CONFLICT_STALE',
      JSON.stringify({ ok: res.ok, code: res.data && res.data.code, text: String(res.text).slice(0, 80) }));
    check('#9 edit_file：外部改动没有被静默覆盖（终态判据）',
      fs.readFileSync(target, 'utf8') === 'alpha beta gamma',
      JSON.stringify(fs.readFileSync(target, 'utf8')));
  }
  {
    // 不带 expectedSha256 时：确认期间新增的出现次数必须在写盘前重算（文案里的「替换 N 处」不能是旧快照）
    const target = path.join(root, 'count-recompute.txt');
    fs.writeFileSync(target, 'X\n', 'utf8');
    const run = makeContext(() => fs.writeFileSync(target, 'X\nX\n', 'utf8'));
    const res = await registry.execute('edit_file', { path: 'count-recompute.txt', oldText: 'X', newText: 'Y' }, run.context);
    check('#9 edit_file：写盘前重算替换处数（确认期间新增的第 2 处也被替换）',
      res.ok === true && res.data.replaced === 2 && fs.readFileSync(target, 'utf8') === 'Y\nY\n',
      JSON.stringify({ ok: res.ok, replaced: res.data && res.data.replaced, disk: JSON.stringify(fs.readFileSync(target, 'utf8')) }));
  }
  {
    // 反向锁：无外部改动时 edit_file 照常工作
    const target = path.join(root, 'edit-clean.txt');
    fs.writeFileSync(target, 'hello world', 'utf8');
    const run = makeContext(null);
    const res = await registry.execute('edit_file', { path: 'edit-clean.txt', oldText: 'hello', newText: 'HI', expectedSha256: sha256OfFile(target) }, run.context);
    check('#9 edit_file 反向锁：无外部改动时正常替换', res.ok === true && res.data.replaced === 1 && fs.readFileSync(target, 'utf8') === 'HI world', JSON.stringify({ ok: res.ok, replaced: res.data && res.data.replaced }));
  }

  // ===================== #23 原子替换口径 =====================
  {
    const implDir = path.join(__dirname, '..', 'electron', 'tools', 'impl');
    for (const file of ['bulkEditTool.cjs', 'writeAnalysisMdTool.cjs']) {
      const src = fs.readFileSync(path.join(implDir, file), 'utf8');
      check('#23 静态门禁：' + file + ' 不存在绕过 atomicWriteFile 的裸 fs.writeFileSync', !/fs\.writeFileSync\(/.test(src), '');
      check('#23 静态门禁：' + file + ' 确实走 atomicWriteFile', /atomicWriteFile\(/.test(src), '');
    }
  }
  {
    const run = makeContext(null);
    const res = await registry.execute('bulk_edit', { action: 'create_files', list: [{ path: 'bulk/one.txt', content: 'BULK-1' }] }, run.context);
    const written = path.join(root, 'bulk', 'one.txt');
    check('#23 bulk_edit.create_files 落盘内容正确', res.ok === true && fs.readFileSync(written, 'utf8') === 'BULK-1', JSON.stringify({ ok: res.ok, text: String(res.text).slice(0, 60) }));
    const leftovers = fs.readdirSync(path.dirname(written)).filter((name) => name.includes('.tmp'));
    check('#23 bulk_edit.create_files 不留 .tmp（走的是临时文件 + rename）', leftovers.length === 0, JSON.stringify(leftovers));
  }
  {
    const run = makeContext(null);
    const res = await registry.execute('write_analysis_md', { content: '# 分析\n正文', name: '分析', relativePath: 'analysis/out.md' }, run.context);
    const written = path.join(root, 'analysis', 'out.md');
    check('#23 write_analysis_md 落盘内容正确', res.ok === true && fs.existsSync(written) && fs.readFileSync(written, 'utf8') === '# 分析\n正文', JSON.stringify({ ok: res.ok, exists: fs.existsSync(written), text: String(res.text).slice(0, 60) }));
    const leftovers = fs.readdirSync(path.dirname(written)).filter((name) => name.includes('.tmp'));
    check('#23 write_analysis_md 不留 .tmp', leftovers.length === 0, JSON.stringify(leftovers));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ATOMIC FILE: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('ATOMIC FILE: ERROR');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
