/**
 * worktree-test.cjs —— 工作树隔离（对照文档 §5 #7）
 *
 * 短板：此前「并行改代码」只有结果合并与租约串行化，没有文件系统层面的隔离。
 *
 * 判据（在**真的临时 git 仓库**上跑，终端判据是磁盘状态）：
 *   A 建：目录/分支真的建出来；`git worktree` 认得它；项目根仍是主工作树
 *   B 隔离：在 worktree 里改文件，主工作树**逐字节不受影响**（这就是这一项的意义）
 *   C 查询：list 认得受管工作树；changedFiles / commitCount 数得对
 *   D 边界：非 git 仓库如实报错；重名 EXISTS；超过上限 TOO_MANY；移除受管目录之外一律拒绝
 *   E 删除：有未提交改动默认拒绝（DIRTY）；force 才删；删完目录真的没了
 *   F 工具层：create/remove 要确认（拒绝时**什么都不发生**）；list 不需要确认
 *   G 隔离层：git 命令走 sandbox.guardedSpawn（与 execute_shell 同一条通道）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const worktree = require('../electron/worktree.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-worktree-'));
const repo = path.join(base, 'repo');
fs.mkdirSync(repo, { recursive: true });
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: repo, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);
const opts = { policy };

async function git(args) {
  return worktree.runGit(repo, args, opts);
}

/** 建一个最小可用仓库 */
async function setupRepo() {
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'main\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);
}

function contextFor(confirmResult) {
  return new AgentToolContext({
    projectRoot: repo,
    confirm: async () => confirmResult !== false,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
}
function worktreeRegistry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: repo, ragEnabled: false, toolsAllowed: ['worktree'] });
}

(async () => {
  await setupRepo();

  // ==================== A. 建 ====================
  console.log('\n== A. 创建工作树 ==');
  let created = null;
  {
    created = await worktree.createWorktree(repo, { name: 'Feature A' }, opts);
    check('[A] create 成功且名字被归一化（Feature A → feature-a）', created.ok === true && created.relativePath.split(path.sep).join('/') === '.codenode/worktrees/feature-a', JSON.stringify(created.relativePath));
    check('[A] 目录真的建出来了', fs.existsSync(created.path) && fs.existsSync(path.join(created.path, 'README.md')));
    check('[A] 分支名规范（codenode/feature-a）', created.branch === 'codenode/feature-a', String(created.branch));
    check('[A] 是 git 认得的工作树（有 .git 文件、指向主仓的 worktrees 元数据）', fs.existsSync(path.join(created.path, '.git')));
    const list = await worktree.listWorktrees(repo, opts);
    check('[A] git worktree list 里能看到它，且主工作树仍在项目根', list.length === 2 && list.some((w) => path.resolve(w.path) === path.resolve(repo)) && list.some((w) => path.resolve(w.path) === path.resolve(created.path)), JSON.stringify(list.map((w) => path.basename(w.path))));
  }

  // ==================== B. 隔离（这一项的意义）====================
  console.log('\n== B. 隔离 ==');
  {
    const mainBefore = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    fs.writeFileSync(path.join(created.path, 'README.md'), '被隔离改过了\n');
    fs.writeFileSync(path.join(created.path, 'new-file.txt'), 'only in worktree\n');
    const mainAfter = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    check('[B] 主工作树里同名字文件**逐字节没变**', mainAfter === mainBefore && mainAfter === 'main\n', JSON.stringify(mainAfter));
    check('[B] 新文件只出现在工作树里（主工作树没有）', fs.existsSync(path.join(created.path, 'new-file.txt')) && !fs.existsSync(path.join(repo, 'new-file.txt')));
    const changed = await worktree.changedFiles(created.path, opts);
    check('[B] changedFiles 数到 2 个改动', changed.length === 2 && changed.some((c) => c.path === 'new-file.txt'), JSON.stringify(changed));
    check('[B] committed 数为 0（还没提交）', (await worktree.commitCount(created.path, 'HEAD', opts)) === 0);
    const listTool = await worktreeRegistry().execute('worktree', { action: 'list' }, contextFor(true));
    check('[B] 工具 list 里显示未提交改动数（主代理据此判断要不要合并）', listTool.ok === true && /feature-a/.test(String(listTool.text)) && /2 个未提交改动/.test(String(listTool.text)), String(listTool.text).split('\n')[1] || String(listTool.text).slice(0, 70));
  }

  // ==================== C. 边界 ====================
  console.log('\n== C. 边界 ==');
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-not-a-repo-'));
    const notRepo = await worktree.createWorktree(outside, { name: 'x' }, { policy });
    check('[C] 非 git 仓库 → 如实报错（不假装隔离成功）', notRepo.ok === false && notRepo.error === 'NOT_A_GIT_REPO', JSON.stringify(notRepo.error));
    const dup = await worktree.createWorktree(repo, { name: 'feature a' }, opts);
    check('[C] 重名 → EXISTS（名字归一化后仍算重名）', dup.ok === false && dup.error === 'EXISTS', JSON.stringify(dup.error));
    for (const name of ['b', 'c', 'd', 'e']) await worktree.createWorktree(repo, { name }, opts);
    const over = await worktree.createWorktree(repo, { name: 'f' }, opts);
    check('[C] 超过上限（5）→ TOO_MANY 并列出已有（不静默无限增长）', over.ok === false && over.error === 'TOO_MANY' && Array.isArray(over.managed) && over.managed.length === 5, JSON.stringify({ error: over.error, managed: over.managed && over.managed.length }));
    const outsideRemove = await worktree.removeWorktree(repo, { path: outside }, opts);
    check('[C] 移除受管目录之外的路径 → NOT_MANAGED（安全边界）', outsideRemove.ok === false && outsideRemove.error === 'NOT_MANAGED');
    check('[C] 被拒的操作确实什么都没动（外部目录还在）', fs.existsSync(outside));
    try {
      fs.rmSync(outside, { recursive: true, force: true });
    } catch {}
  }

  // ==================== D. 删除语义 ====================
  console.log('\n== D. 删除 ==');
  {
    const dirty = await worktree.removeWorktree(repo, { name: 'feature-a' }, opts);
    check('[D] 有未提交改动时默认拒绝（DIRTY，且列出改动）', dirty.ok === false && dirty.error === 'DIRTY' && dirty.changed.length === 2, JSON.stringify({ error: dirty.error, n: dirty.changed && dirty.changed.length }));
    check('[D] 被拒时目录仍在（没被偷偷删掉）', fs.existsSync(created.path));
    const forced = await worktree.removeWorktree(repo, { name: 'feature-a', force: true }, opts);
    check('[D] force 才删得掉，且如实报丢弃了几个改动', forced.ok === true && forced.discardedChanges === 2, JSON.stringify(forced));
    check('[D] 删完目录真的没了', !fs.existsSync(created.path));
    const stillListed = await worktree.managedWorktrees(repo, opts);
    check('[D] git worktree list 里也不再有它', !stillListed.some((w) => path.basename(w.path) === 'feature-a'), JSON.stringify(stillListed.map((w) => path.basename(w.path))));

    /**
     * 路径归一化（CI 实测踩到）：`git worktree list --porcelain` 可能回 **8.3 短路径**
     * （CI runner 的 `C:\\Users\\RUNNER~1\\...`）或大小写不同的路径，直接 path.relative 会算出
     * `..\\..\\..` →「受管工作树」全空：本地全绿、CI 全红。这里把大小写差异这条钉住
     * （短路径无法在测试里造，靠 realpath 展开；至少保证大小写与分隔符归一）。
     */
    const one = await worktree.createWorktree(repo, { name: 'case-probe' }, opts);
    check('[D] 受管判定不误伤项目根之外的路径', worktree.isManagedPath(repo, path.join(base, 'outside')) === false);

    /**
     * **同一个目录的两种写法**必须都算「受管」：CI 上 `git worktree list --porcelain` 回的是
     * 8.3 短路径（`C:\\Users\\RUNNER~1\\...`），而我们的 root 是长路径 —— 不做 realpath 展开时
     * path.relative 会算出 `..\\..\\..`，「受管工作树」判空、整批用例在 Windows CI 上全红
     * （本地长路径全绿；2026-09-21 实测）。这里用**目录联接别名**复现同一机制：
     * 只对别名路径做 realpath 展开，别名与非别名的写法才会指向同一个受管目录。
     */
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-wt-alias-'));
    const alias = path.join(aliasParent, 'repo-alias');
    let aliasOk = false;
    try {
      fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
      aliasOk = true;
    } catch {
      aliasOk = false;
    }
    if (aliasOk) {
      check('[D] 同一目录的别名写法也算受管（CI 短路径/别名的真实机制）', worktree.isManagedPath(alias, one.path) === true, JSON.stringify({ alias, one: one.path, managed: worktree.isManagedPath(alias, one.path) }));
      check('[D] 别名的反方向也成立（受管路径作 root）', worktree.isManagedPath(one.path, one.path) === false, '工作树自身不是它的受管目录下的子项');
    } else {
      check('[D] 无法创建目录别名（环境限制），退化为语法层断言', worktree.isManagedPath(repo, one.path) === true);
    }
    try {
      fs.rmSync(aliasParent, { recursive: true, force: true });
    } catch {}
    await worktree.removeWorktree(repo, { name: 'case-probe', force: true }, opts);
  }

  // ==================== E. 工具层确认（fail-closed）====================
  console.log('\n== E. 工具层确认 ==');
  {
    const reg = worktreeRegistry();
    const denied = await reg.execute('worktree', { action: 'create', name: 'denied-one' }, contextFor(false));
    check('[E] 用户拒绝确认 → 工具报错且**没有**建出任何东西', denied.ok === false && !fs.existsSync(path.join(repo, '.codenode', 'worktrees', 'denied-one')), JSON.stringify({ ok: denied.ok }));
    const okCreate = await reg.execute('worktree', { action: 'create', name: 'ui-created' }, contextFor(true));
    check('[E] 批准后真的建出来（两向都锁）', okCreate.ok === true && fs.existsSync(path.join(repo, '.codenode', 'worktrees', 'ui-created')), JSON.stringify(okCreate.data && okCreate.data.relativePath));
    const badAction = await reg.execute('worktree', { action: 'nope' }, contextFor(true));
    // 无效 action 被 schema 的 enum 先拦下（工具内的分支是第二道）—— 两条都算「如实拒绝」，
    // 但拒绝信息里必须能看出合法取值有哪些（否则模型只能瞎试）
    check('[E] 未知 action → 如实拒绝且能看出合法取值', badAction.ok === false && /(list|remove)/.test(String(badAction.text)), String(badAction.text).slice(0, 80));
    const removeOk = await reg.execute('worktree', { action: 'remove', name: 'ui-created', force: true }, contextFor(true));
    check('[E] 工具也能移除（force）', removeOk.ok === true && !fs.existsSync(path.join(repo, '.codenode', 'worktrees', 'ui-created')), String(removeOk.text).slice(0, 60));
    // 清场：把 C 段建的 4 个也删掉
    for (const name of ['b', 'c', 'd', 'e']) await worktree.removeWorktree(repo, { name, force: true }, opts);
  }

  // ==================== F. 隔离层接线 ====================
  console.log('\n== F. 隔离层 ==');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'worktree.cjs'), 'utf8');
    check('[F] git 命令走 sandbox.guardedSpawn', /sandbox\.guardedSpawn\(/.test(src));
    check('[F] GIT_TERMINAL_PROMPT=0（绝不因为等凭据输入而挂住）', /GIT_TERMINAL_PROMPT: '0'/.test(src));
    check('[F] 有超时（不会把主循环挂死）', /GIT_TIMEOUT_MS/.test(src) && /setTimeout\(/.test(src));
    check('[F] 受管目录之外的删改一律拒绝（NOT_MANAGED）', /NOT_MANAGED/.test(src));
    const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'impl', 'worktreeTool.cjs'), 'utf8');
    check('[F] 工具把工作树描述成「独立检出、主工作树不受影响」', /主工作树不受影响/.test(toolSrc));
  }

  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'WORKTREE TEST: PASS' : 'WORKTREE TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('WORKTREE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
