'use strict';
/**
 * 分支同步：main 是集成分支，yimi-branch 是交付分支。
 *
 *   main          集成分支，同时是 GitHub 默认分支。外部来源（Dependabot 的依赖
 *                 PR、fork 贡献）合并到这里，CI/门禁在 PR 上跑。
 *   yimi-branch   交付分支。日常开发、验证与打包交付都在这条线上。
 *
 * 两个方向都必须显式执行，脚本不会自动决定“要不要同步”：
 *
 *   npm run branch:status      只读报告：两侧各自领先多少、下一步该做什么
 *   npm run branch:integrate   集成分支 → 交付分支（在 yimi-branch 上做一次合并提交）
 *   npm run branch:publish     交付分支 → 集成分支（把 yimi-branch 快进推到 main）
 *
 * 安全口径：拒绝脏工作区与进行中的合并/变基；publish 只允许快进，永不 force；
 * 本地还有未推送提交时必须显式加 --allow-unpushed。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INTEGRATION = 'main';
const DELIVERY = 'yimi-branch';
const REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  return [
    '用法：node scripts/branch-sync.cjs <--status|--integrate|--publish> [选项]',
    '',
    '  --status              只读报告两侧差距与下一步（默认动作）',
    '  --integrate           把 origin/main 合并进交付分支 yimi-branch',
    '  --publish             把 yimi-branch 快进推到 origin/main',
    '  --no-fetch            不先 fetch（默认先 fetch --prune）',
    '  --allow-unpushed      publish 时允许连同未推送到 origin/yimi-branch 的提交一起推',
    '  --dry-run             只打印将要执行的 git 命令，不改动任何东西',
    '  --help                显示本说明',
  ].join('\n');
}

function gitRunner(cwd) {
  let trusted = false;
  const exec = (args, options = {}) => {
    const prefix = trusted ? ['-c', 'safe.directory=' + cwd.replace(/\\/g, '/')] : [];
    const result = spawnSync('git', [...prefix, ...args], {
      cwd, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
    });
    if (result.error) throw new Error('无法执行 git：' + result.error.message);
    // 仓库归属与当前用户不一致时 git 会拒绝所有命令。这里只对“正在操作的这一个仓库”
    // 做一次性放行，不写全局配置，也不使用 safe.directory=*。
    if (!trusted && /dubious ownership/i.test(String(result.stderr || ''))) {
      trusted = true;
      console.error('[branch-sync] git 报告仓库归属异常，本次运行临时放行 ' + cwd + '（未写入全局配置）');
      return exec(args, options);
    }
    return result;
  };
  const text = (args, options) => {
    const result = exec(args, options);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${String(result.stderr || '').trim()}`);
    return String(result.stdout || '');
  };
  return { exec, text };
}

function count(git, range) {
  const value = Number(git.text(['rev-list', '--count', range]).trim());
  return Number.isFinite(value) ? value : 0;
}

function collectState(cwd = REPO_ROOT, options = {}) {
  const git = gitRunner(cwd);
  const remotes = git.text(['remote']).trim().split('\n').filter(Boolean);
  if (!remotes.includes('origin')) throw new Error('仓库没有 origin 远程，无法比较集成分支与交付分支');
  if (options.fetch !== false) {
    const fetched = git.exec(['fetch', '--prune', 'origin']);
    if (fetched.status !== 0) {
      const detail = String(fetched.stderr || fetched.stdout || '').trim();
      // 只读报告用上次已知的 origin 状态仍可读；要动分支就必须拿到远端真相。
      if (!options.tolerateFetchFailure) throw new Error(`git fetch --prune origin 失败，不能基于过期的远端状态改动分支：${detail}`);
      console.error(`[branch-sync] 警告：git fetch 失败，以下数字基于上次已知的 origin 状态：${detail}`);
    }
  }
  if (git.text(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    console.error('[branch-sync] 这是浅克隆，领先/落后计数可能不完整；先执行 git fetch --unshallow');
  }
  if (git.exec(['rev-parse', '--verify', '--quiet', `refs/heads/${DELIVERY}`]).status !== 0) {
    throw new Error(`本地没有交付分支 ${DELIVERY}；先执行 git checkout -b ${DELIVERY} origin/${DELIVERY}`);
  }
  const integrationRef = 'origin/' + INTEGRATION;
  const deliveryRef = 'origin/' + DELIVERY;
  // 远端两分支的差距（对外可见状态）与“本地下一步该做什么”是两套口径：
  // integrate 之后合并提交还在本地，远端 yimi-branch 尚未前进。
  const [remoteIntegrationAhead, remoteDeliveryAhead] = git.text(['rev-list', '--left-right', '--count', `${integrationRef}...${deliveryRef}`])
    .trim().split(/\s+/).map(Number);
  const state = {
    cwd,
    branch: git.text(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    // 已跟踪改动才挡合并；未跟踪文件不会让 merge 丢东西（git 自己拒绝覆盖），
    // 单独计数只是为了如实展示。
    dirty: git.text(['status', '--porcelain', '--untracked-files=no']).trim().length > 0,
    untracked: git.text(['status', '--porcelain', '--untracked-files=all']).trim().split('\n').filter(line => line.startsWith('??')).length,
    inProgress: ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
      .some(name => fs.existsSync(git.text(['rev-parse', '--git-path', name]).trim())),
    integrationCommit: git.text(['rev-parse', '--short', integrationRef]).trim(),
    deliveryCommit: git.text(['rev-parse', '--short', deliveryRef]).trim(),
    localCommit: git.text(['rev-parse', '--short', DELIVERY]).trim(),
    remoteIntegrationAhead,
    remoteDeliveryAhead,
    integrationPending: count(git, `${DELIVERY}..${integrationRef}`),
    deliveryPending: count(git, `${integrationRef}..${DELIVERY}`),
    localUnpushed: count(git, `${deliveryRef}..${DELIVERY}`),
  };
  state.fastForwardable = git.exec(['merge-base', '--is-ancestor', integrationRef, DELIVERY]).status === 0;
  return { git, state };
}

// 纯函数：只看状态给结论，便于离线断言（不接触 git）。
function planSync(state) {
  // integrate 要动工作区：已跟踪改动必须先落地。
  const integrateBlockers = [];
  if (state.dirty) integrateBlockers.push('工作区有未提交的已跟踪改动，先提交或 stash');
  if (state.inProgress) integrateBlockers.push('有进行中的合并/变基，先完成或 git merge --abort');
  // publish 只推分支、不碰工作区，所以未提交改动不是理由；但半途的合并状态要拦。
  const publishBlockers = [];
  if (state.inProgress) publishBlockers.push('有进行中的合并/变基，先完成或 git merge --abort');
  if (state.branch !== DELIVERY) {
    const reason = `当前分支是 ${state.branch}，同步必须在交付分支 ${DELIVERY} 上执行`;
    integrateBlockers.push(reason); publishBlockers.push(reason);
  }
  if (state.integrationPending > 0) publishBlockers.push(`集成分支还有 ${state.integrationPending} 个提交没进交付分支，先 npm run branch:integrate`);
  if (!state.fastForwardable) publishBlockers.push('publish 只允许快进；集成分支已分叉，先 integrate');
  const requiresUnpushedFlag = state.localUnpushed > 0;
  return {
    diverged: state.integrationPending > 0 && state.deliveryPending > 0,
    integrate: { needed: state.integrationPending > 0, allowed: integrateBlockers.length === 0 && state.integrationPending > 0, blockers: integrateBlockers },
    // allowed 表示“直接跑 npm run branch:publish 就能成功”；需要额外开关时不算 allowed，
    // 免得计划说可以、执行却被守卫拦下。
    publish: { needed: state.deliveryPending > 0, allowed: publishBlockers.length === 0 && state.deliveryPending > 0 && !requiresUnpushedFlag,
      blockers: publishBlockers, requiresUnpushedFlag },
  };
}

function render(state, plan) {
  const lines = [
    `[branch-sync] ${state.cwd}`,
    `  集成分支 ${INTEGRATION}（默认分支，外部/Dependabot PR 落点）  ${state.integrationCommit}`,
    `  交付分支 ${DELIVERY}（日常开发与打包交付线）              ${state.deliveryCommit}`,
    `  本地 ${DELIVERY} / 当前分支 ${state.branch}                        ${state.localCommit}`,
    '',
    `  远端差距：origin/${INTEGRATION} 领先 ${state.remoteIntegrationAhead} 个提交，origin/${DELIVERY} 领先 ${state.remoteDeliveryAhead} 个提交`,
    `  待 integrate（${INTEGRATION} → ${DELIVERY}）：${state.integrationPending} 个提交`,
    `  待 publish（${DELIVERY} → ${INTEGRATION}）  ：${state.deliveryPending} 个提交`,
    `  未推送（${DELIVERY} → origin/${DELIVERY}）  ：${state.localUnpushed} 个提交`,
  ];
  if (state.dirty || state.untracked > 0) {
    lines.push(`  工作区：已跟踪改动 ${state.dirty ? '有' : '无'}，未跟踪 ${state.untracked} 项（只挡 integrate，不挡 publish）`);
  }
  if (plan.diverged) lines.push('', '  注意：两侧都已前进（分叉）。先 integrate 把集成分支并进交付线，再 publish 才能快进。');
  const next = [];
  if (plan.integrate.needed) next.push(plan.integrate.allowed ? 'npm run branch:integrate（集成分支有新提交）' : `npm run branch:integrate 当前不可用：${plan.integrate.blockers.join('；')}`);
  if (plan.publish.needed) {
    if (plan.publish.blockers.length) next.push(`npm run branch:publish 当前不可用：${plan.publish.blockers.join('；')}`);
    else if (plan.publish.requiresUnpushedFlag) next.push(`npm run branch:publish --allow-unpushed（本地还有 ${state.localUnpushed} 个提交未推送到 origin/${DELIVERY}）`);
    else next.push('npm run branch:publish（交付分支已验证，可快进集成分支）');
  }
  lines.push('', '下一步：' + (next.length ? '' : '两侧一致，无需同步。'));
  for (const item of next) lines.push('  - ' + item);
  return lines.join('\n');
}

function runIntegrate(git, state, plan, options) {
  if (!plan.integrate.needed) { console.log('[branch-sync] 集成分支没有新提交，无需 integrate。'); return 0; }
  if (!plan.integrate.allowed) { console.error('[branch-sync] 拒绝 integrate：' + plan.integrate.blockers.join('；')); return 1; }
  const message = `merge: 从集成分支 ${INTEGRATION} 同步 ${state.integrationPending} 个提交（外部 PR 与依赖更新）`;
  if (options.dryRun) { console.log(`[branch-sync] dry-run：git merge --no-ff origin/${INTEGRATION} -m "${message}"`); return 0; }
  const result = git.exec(['merge', '--no-ff', `origin/${INTEGRATION}`, '-m', message]);
  process.stdout.write(String(result.stdout || ''));
  process.stderr.write(String(result.stderr || ''));
  if (result.status !== 0) {
    console.error('[branch-sync] 合并未完成。若只是冲突：解决后 git commit；要放弃本次同步：git merge --abort');
    return 1;
  }
  console.log('[branch-sync] 已把集成分支合并进 ' + DELIVERY + '，推送：git push origin ' + DELIVERY);
  return 0;
}

function runPublish(git, state, plan, options) {
  if (!plan.publish.needed) { console.log('[branch-sync] 交付分支没有领先提交，无需 publish。'); return 0; }
  if (plan.publish.blockers.length) { console.error('[branch-sync] 拒绝 publish：' + plan.publish.blockers.join('；')); return 1; }
  if (plan.publish.requiresUnpushedFlag && !options.allowUnpushed) {
    console.error(`[branch-sync] 拒绝 publish：本地 ${DELIVERY} 还有 ${state.localUnpushed} 个提交未推送到 origin/${DELIVERY}。`
      + `\n先 git push origin ${DELIVERY}，或确认要一起推送时加 --allow-unpushed。`);
    return 1;
  }
  // 显式 refspec：推的是本地交付分支，目标固定为集成分支；不加 --force，非快进由服务端拒绝。
  const refspec = `refs/heads/${DELIVERY}:refs/heads/${INTEGRATION}`;
  if (options.dryRun) { console.log(`[branch-sync] dry-run：git push origin ${refspec}`); return 0; }
  const result = git.exec(['push', 'origin', refspec]);
  process.stdout.write(String(result.stdout || ''));
  process.stderr.write(String(result.stderr || ''));
  if (result.status !== 0) { console.error('[branch-sync] 推送失败：集成分支可能已被别人推进，重新 fetch 后再跑一次。'); return 1; }
  console.log(`[branch-sync] 已把 ${DELIVERY} 快进到 origin/${INTEGRATION}。`);
  return 0;
}

function main(argv) {
  const options = {
    action: 'status',
    fetch: true,
    allowUnpushed: argv.includes('--allow-unpushed'),
    dryRun: argv.includes('--dry-run'),
  };
  const requested = ['--status', '--integrate', '--publish'].filter(flag => argv.includes(flag));
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return 0; }
  if (requested.length > 1) { console.error('一次只能选一个动作：' + requested.join(' ')); console.error(usage()); return 2; }
  if (requested.length === 1) options.action = requested[0].slice(2);
  if (argv.includes('--no-fetch')) options.fetch = false;
  const unknown = argv.filter(arg => arg.startsWith('-') && !['--status', '--integrate', '--publish', '--no-fetch', '--allow-unpushed', '--dry-run', '--help', '-h'].includes(arg));
  if (unknown.length) { console.error('未知参数：' + unknown.join(' ')); console.error(usage()); return 2; }
  try {
    const { git, state } = collectState(REPO_ROOT, { fetch: options.fetch, tolerateFetchFailure: options.action === 'status' });
    const plan = planSync(state);
    console.log(render(state, plan));
    if (options.action === 'status') return 0;
    console.log('');
    if (options.action === 'integrate') return runIntegrate(git, state, plan, options);
    return runPublish(git, state, plan, options);
  } catch (error) {
    console.error('[branch-sync] ' + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

module.exports = { INTEGRATION, DELIVERY, REPO_ROOT, planSync, collectState, render, gitRunner, count, runIntegrate, runPublish, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
