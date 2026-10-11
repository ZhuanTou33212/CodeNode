'use strict';
// 分支模型回归：main 是集成分支、yimi-branch 是交付分支，两个方向的同步都必须
// 显式、可快进、拒绝脏工作区。全部在临时裸仓库 + 克隆里跑，不联网、不碰本仓库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sync = require('../branch-sync.cjs');
const scriptPath = path.resolve(__dirname, '../branch-sync.cjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-branch-sync-')));
const originDir = path.join(root, 'origin.git');
const work = path.join(root, 'work');
const fixtureConfig = path.join(root, 'gitconfig');
fs.writeFileSync(fixtureConfig, '[user]\n\tname = fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n');
const savedEnv = {};
for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) savedEnv[key] = process.env[key];
// 隔离宿主的全局 git 配置：身份固定、不签名、不受 autocrlf 等本机设置影响。
process.env.GIT_CONFIG_GLOBAL = fixtureConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(options.env || {}) } });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`git ${args.join(' ')} 失败：${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}
function commit(cwd, file, content, message) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
}
const state = () => sync.collectState(work);
const headOf = ref => git(work, ['rev-parse', ref]);

function setUpRepository() {
  git(root, ['init', '--bare', '--initial-branch=main', originDir]);
  git(root, ['clone', originDir, work]);
  commit(work, 'README.md', 'v1\n', 'init');
  git(work, ['push', '-u', 'origin', 'main']);
  git(work, ['checkout', '-b', 'yimi-branch']);
  commit(work, 'feature.txt', 'delivery work\n', 'feat: delivery line work');
  git(work, ['push', '-u', 'origin', 'yimi-branch']);
}
// 模拟 Dependabot/外部贡献合进集成分支：main 前进一个提交，交付分支不跟。
let integrationBumps = 0;
function mergeIntoIntegration() {
  integrationBumps += 1;
  git(work, ['fetch', 'origin', '--prune']);
  git(work, ['checkout', 'main']);
  git(work, ['reset', '--hard', 'origin/main']);
  commit(work, 'package.json', `{"deps":"bumped-${integrationBumps}"}\n`, `chore(deps): bump fixture dependency (${integrationBumps})`);
  git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', 'yimi-branch']);
}

function checkPurePlan() {
  const base = { branch: 'yimi-branch', dirty: false, inProgress: false, integrationPending: 0, deliveryPending: 0, localUnpushed: 0, fastForwardable: true };
  assert.deepEqual(sync.planSync(base).integrate, { needed: false, allowed: false, blockers: [] });
  assert.equal(sync.planSync(base).publish.needed, false);
  const ahead = sync.planSync({ ...base, deliveryPending: 3 });
  assert.equal(ahead.publish.needed, true);
  assert.equal(ahead.publish.allowed, true);
  assert.equal(ahead.diverged, false);
  const behind = sync.planSync({ ...base, integrationPending: 2 });
  assert.equal(behind.integrate.allowed, true);
  assert.equal(behind.publish.needed, false);
  const diverged = sync.planSync({ ...base, integrationPending: 2, deliveryPending: 1, fastForwardable: false });
  assert.equal(diverged.diverged, true);
  assert.equal(diverged.integrate.allowed, true);
  assert.equal(diverged.publish.allowed, false);
  assert.match(diverged.publish.blockers.join('；'), /先 npm run branch:integrate/);
  for (const [field, label] of [['dirty', '已跟踪改动'], ['inProgress', '进行中的合并']]) {
    const blocked = sync.planSync({ ...base, [field]: true, integrationPending: 1 });
    assert.equal(blocked.integrate.allowed, false, label + '必须挡住 integrate');
  }
  const mergeInFlight = sync.planSync({ ...base, inProgress: true, integrationPending: 1, deliveryPending: 1, fastForwardable: false });
  assert.equal(mergeInFlight.publish.allowed, false, '进行中的合并必须挡住 publish');
  const dirtyButAhead = sync.planSync({ ...base, dirty: true, untracked: 3, deliveryPending: 1 });
  assert.equal(dirtyButAhead.publish.allowed, true, '未提交改动不挡 publish：push 不碰工作区');
  assert.match(sync.planSync({ ...base, dirty: true, integrationPending: 1 }).integrate.blockers.join('；'), /已跟踪改动/);
  const wrongBranch = sync.planSync({ ...base, branch: 'main', integrationPending: 1 });
  assert.equal(wrongBranch.integrate.allowed, false);
  assert.match(wrongBranch.integrate.blockers.join('；'), /yimi-branch/);
  const unpushed = sync.planSync({ ...base, deliveryPending: 2, localUnpushed: 1 });
  assert.equal(unpushed.publish.allowed, false, '还有未推送提交时不能只跑 npm run branch:publish');
  assert.equal(unpushed.publish.requiresUnpushedFlag, true);
  assert.equal(unpushed.publish.needed, true);
}

function checkStatusAndPublish() {
  const before = state();
  assert.equal(before.state.branch, 'yimi-branch');
  assert.equal(before.state.integrationPending, 0, '集成分支还没有新提交');
  assert.equal(before.state.deliveryPending, 1, '交付分支领先 1 个提交');
  assert.equal(before.state.localUnpushed, 0);
  assert.equal(before.state.fastForwardable, true);
  const rendered = sync.render(before.state, sync.planSync(before.state));
  assert.match(rendered, /集成分支 main/);
  assert.match(rendered, /交付分支 yimi-branch/);
  assert.match(rendered, /待 publish（yimi-branch → main）\s*：1 个提交/);
  assert.match(rendered, /npm run branch:publish/);
  const deliveryTip = headOf('yimi-branch');
  assert.equal(sync.runPublish(before.git, before.state, sync.planSync(before.state), {}), 0, '交付分支领先时必须能快进集成分支');
  assert.equal(git(originDir, ['rev-parse', 'main']), deliveryTip, '集成分支被快进到交付分支同一提交');
  const settled = state();
  assert.equal(settled.state.deliveryPending, 0);
  assert.equal(sync.runPublish(settled.git, settled.state, sync.planSync(settled.state), {}), 0, '两侧一致时 publish 是空操作');
  assert.equal(state().state.deliveryPending, 0, '空操作不改动任何分支');
}

function checkIntegrateThenPublish() {
  // 交付分支先自己前进，集成分支再前进：制造真正的双向分叉。
  commit(work, 'feature.txt', 'delivery work 2\n', 'feat: delivery line work 2');
  git(work, ['push', 'origin', 'yimi-branch']);
  mergeIntoIntegration();
  const diverged = state();
  assert.equal(diverged.state.integrationPending, 1);
  assert.equal(diverged.state.deliveryPending, 1);
  assert.equal(diverged.state.fastForwardable, false, '两侧都前进后不能再快进');
  const plan = sync.planSync(diverged.state);
  assert.equal(plan.diverged, true);
  assert.equal(plan.publish.allowed, false, '分叉时必须先 integrate 再 publish');
  const integrationTipBefore = headOf('origin/main');
  assert.equal(sync.runPublish(diverged.git, diverged.state, plan, {}), 1, '非快进的 publish 必须被本地拒绝');
  assert.equal(headOf('origin/main'), integrationTipBefore, '被拒绝的 publish 不改动集成分支');
  assert.equal(sync.runIntegrate(diverged.git, diverged.state, plan, {}), 0, '集成分支有新提交时必须能合并进交付分支');
  assert.equal(fs.readFileSync(path.join(work, 'package.json'), 'utf8'), '{"deps":"bumped-1"}\n', '集成分支的外部改动真的进了交付分支工作区');
  assert.equal(git(work, ['rev-list', '--merges', '--count', 'HEAD^..HEAD']), '1', '同步用合并提交保留来源');
  assert.equal(headOf('HEAD^2'), headOf('origin/main'), '合并的第二个父提交就是集成分支');
  const after = state();
  assert.equal(after.state.integrationPending, 0, 'integrate 后集成分支不再领先');
  const afterPlan = sync.planSync(after.state);
  assert.equal(afterPlan.integrate.needed, false);
  // 合并提交先落在交付分支本地；按交付约定先推送 origin/yimi-branch，再发布集成分支。
  assert.equal(afterPlan.publish.allowed, false, '未推送的合并提交不能直接推上集成分支');
  assert.equal(afterPlan.publish.requiresUnpushedFlag, true);
  assert.match(sync.render(after.state, afterPlan), /--allow-unpushed/);
  git(work, ['push', 'origin', 'yimi-branch']);
  const pushed = state();
  const pushedPlan = sync.planSync(pushed.state);
  assert.equal(pushed.state.localUnpushed, 0);
  assert.equal(pushedPlan.publish.allowed, true, 'integrate 并推送之后 publish 重新可快进');
  assert.equal(sync.runPublish(pushed.git, pushed.state, pushedPlan, {}), 0);
  assert.equal(headOf('origin/main'), headOf('yimi-branch'));
}

function checkGuards() {
  // 未推送的本地提交要显式确认，否则会把未发布内容一起推上集成分支。
  commit(work, 'local-only.txt', 'unpushed\n', 'feat: local only');
  const unpushed = state();
  const unpushedPlan = sync.planSync(unpushed.state);
  assert.equal(unpushed.state.localUnpushed, 1);
  assert.equal(unpushedPlan.publish.allowed, false);
  assert.equal(unpushedPlan.publish.requiresUnpushedFlag, true);
  assert.equal(sync.runPublish(unpushed.git, unpushed.state, unpushedPlan, {}), 1, '未推送提交必须要求显式放行');
  assert.equal(headOf('origin/main'), headOf('origin/yimi-branch'), '被拒绝时集成分支没有前进');
  assert.equal(sync.runPublish(unpushed.git, unpushed.state, unpushedPlan, { allowUnpushed: true }), 0, '显式放行后把交付线整条快进到集成分支');
  assert.equal(headOf('origin/main'), headOf('yimi-branch'));
  // 交付分支再次领先，集成分支也前进：分叉 + 已跟踪改动。
  commit(work, 'feature.txt', 'delivery work 3\n', 'feat: delivery line work 3');
  git(work, ['push', 'origin', 'yimi-branch']);
  mergeIntoIntegration();
  fs.writeFileSync(path.join(work, 'feature.txt'), 'edited but not committed\n');
  const dirty = state();
  assert.equal(dirty.state.dirty, true, '已跟踪改动被识别为脏工作区');
  assert.equal(dirty.state.untracked, 0);
  assert.equal(dirty.state.integrationPending, 1);
  assert.equal(dirty.state.deliveryPending, 1);
  const dirtyPlan = sync.planSync(dirty.state);
  assert.equal(dirtyPlan.integrate.allowed, false);
  assert.equal(dirtyPlan.publish.allowed, false);
  assert.match(dirtyPlan.integrate.blockers.join('；'), /已跟踪改动/);
  assert.match(dirtyPlan.publish.blockers.join('；'), /先 npm run branch:integrate/, 'publish 被挡的理由是分叉，不是未提交改动');
  const integrationTipBefore = headOf('origin/main');
  assert.equal(sync.runIntegrate(dirty.git, dirty.state, dirtyPlan, {}), 1, '已跟踪改动必须挡住 integrate');
  assert.equal(sync.runPublish(dirty.git, dirty.state, dirtyPlan, { allowUnpushed: true }), 1, '分叉时 publish 仍然被挡住');
  assert.equal(headOf('origin/main'), integrationTipBefore, '被拒绝的同步没有改动集成分支');
  // 恢复干净树后 integrate 成功并推送；随后证明未提交改动不影响 publish。
  git(work, ['checkout', '--', 'feature.txt']);
  assert.equal(state().state.dirty, false, '恢复到干净工作区');
  const clean = state();
  assert.equal(sync.runIntegrate(clean.git, clean.state, sync.planSync(clean.state), {}), 0);
  git(work, ['push', 'origin', 'yimi-branch']);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'dirty again\n');
  const dirtyPublish = state();
  const dirtyPublishPlan = sync.planSync(dirtyPublish.state);
  assert.equal(dirtyPublish.state.dirty, true);
  assert.equal(dirtyPublish.state.integrationPending, 0);
  assert.equal(dirtyPublishPlan.publish.allowed, true, '未提交改动不挡 publish');
  assert.equal(sync.runPublish(dirtyPublish.git, dirtyPublish.state, dirtyPublishPlan, {}), 0);
  assert.equal(headOf('origin/main'), headOf('yimi-branch'), '脏工作区下 publish 仍然只快进集成分支');
  git(work, ['checkout', '--', 'feature.txt']);
}

function checkCliContract() {
  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--integrate/);
  assert.match(help.stdout, /--publish/);
  const conflicting = spawnSync(process.execPath, [scriptPath, '--status', '--publish'], { encoding: 'utf8' });
  assert.equal(conflicting.status, 2, '同时选两个动作必须报用法错误');
  const unknown = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2, '未知参数必须报用法错误并退出 2');
}

function main() {
  checkPurePlan();
  console.log('BRANCH SYNC STAGE: plan');
  setUpRepository();
  checkStatusAndPublish();
  console.log('BRANCH SYNC STAGE: publish');
  checkIntegrateThenPublish();
  console.log('BRANCH SYNC STAGE: integrate');
  checkGuards();
  console.log('BRANCH SYNC STAGE: guards');
  checkCliContract();
  console.log('BRANCH SYNC: PASS (main 集成分支 / yimi-branch 交付分支的双向同步、仅快进发布、脏工作区与未推送守卫、CLI 参数契约)');
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; } finally {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-branch-sync-')) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
