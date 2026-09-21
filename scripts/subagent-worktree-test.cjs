/**
 * subagent-worktree-test.cjs —— 子代理的工作树隔离（对照文档 §5 #7）
 *
 * 短板：此前「并行改代码」只有结果合并 + 租约串行化，两个子代理在同一份文件系统上干活。
 * 现在 `delegate_task(isolation:'worktree')` 让子代理在独立检出里改代码，主工作树逐字节不受影响。
 *
 * 判据（真临时 git 仓库 + 子代理 stub，终端判据是磁盘状态）：
 *   A 隔离生效：子代理看到的 projectRoot 是工作树；它写的文件**只**在工作树里
 *   B 结果诚实：文本给出路径/分支/改动清单，并明确写「这些改动不在主工作树里」+ 怎么合并/丢弃
 *   C 不静默降级：非 git 仓库时 isolation=worktree → 直接失败且**子代理根本没被调用**
 *   D 默认不变：不传 isolation → 仍在主工作树里跑（旧行为逐字节不变）
 *   E 可查询：get_subagent_task 的视图里带 worktree 信息
 *   F 审计：建/收尾都有 audit 事件（隔离是可回查的事实，不是口头承诺）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SubagentManager } = require('../electron/subagents.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const worktree = require('../electron/worktree.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-subagent-worktree-'));
const repo = path.join(base, 'repo');
const notRepo = path.join(base, 'not-a-repo');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(notRepo, { recursive: true });
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: repo, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

const baseCfg = {
  apiBase: 'http://scripted.local/v1',
  apiKey: 'k',
  model: 'm',
  maxTokens: 1024,
  tools: {},
  rag: { enabled: false },
  subagents: { maxRuns: 8, maxTasksPerRun: 8, maxConcurrentTasks: 2, totalTimeoutSeconds: 60, resultMaxChars: 4000 },
  limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
};

/**
 * 假的画布模型：信封要求世界状态快照带哈希，没有模型会被判「snapshot.hash 缺失」而拒收
 * （那是既有契约行为，与本轮隔离无关）。这里给一个最小的、可算哈希的模型。
 */
function makeModel() {
  return new GraphModel({ root: { nodes: [], edges: [] } });
}

function makeContext(projectRoot, audits, model) {
  return new AgentToolContext({
    projectRoot,
    confirm: async () => true,
    audit: (entry) => audits.push(String(entry)),
    sandbox: policy,
    signal: new AbortController().signal,
    // 注意：注入的是**模型对象本身**（context.model() 原样返回注入值）——
    // 传函数的话信封拿不到画布文档，会被判「snapshot.hash 缺失」而拒收（实测踩到）
    model: model === undefined ? makeModel() : model,
  });
}

(async () => {
  // 建一个最小 git 仓库
  await worktree.runGit(repo, ['init', '-q', '-b', 'main'], { policy });
  await worktree.runGit(repo, ['config', 'user.email', 't@example.com'], { policy });
  await worktree.runGit(repo, ['config', 'user.name', 'T'], { policy });
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
  await worktree.runGit(repo, ['add', '.'], { policy });
  await worktree.runGit(repo, ['commit', '-q', '-m', 'init'], { policy });

  /** 子代理 stub：记录它看到的 projectRoot，并在那里写一个文件 */
  function stubAgent(seen) {
    return {
      runAgentChat: async ({ tools }) => {
        const root = tools.context.projectRoot();
        seen.push(root);
        fs.writeFileSync(path.join(root, 'agent-made.txt'), 'from subagent\n');
        return { content: '隔离里干完了', toolCalls: [], usage: null, state: 'COMPLETED' };
      },
    };
  }

  // ==================== A. 隔离生效 ====================
  console.log('\n== A. 隔离生效 ==');
  let worktreePath = null;
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(repo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt' });
    manager.register(supervisor);
    const res = await supervisor.execute('delegate_task', { role: 'explorer', objective: '改点东西', isolation: 'worktree' }, ctx);
    check('[A] 任务成功', res.ok === true, String(res.text).slice(0, 60));
    check('[A] 子代理看到的 projectRoot 是工作树（不是项目根）', seen.length === 1 && path.resolve(seen[0]) !== path.resolve(repo) && seen[0].includes(path.join('.codenode', 'worktrees')), JSON.stringify(seen.map((s) => path.basename(String(s)))));
    worktreePath = seen[0];
    check('[A] 子代理写的文件**只**在工作树里（主工作树逐字节没变）', fs.existsSync(path.join(worktreePath, 'agent-made.txt')) && !fs.existsSync(path.join(repo, 'agent-made.txt')));
    // 主工作树里只允许出现 .codenode/（工作树元数据目录本身是新增的未跟踪目录），app.js 必须逐字节没变
    const status = String((await worktree.runGit(repo, ['status', '--porcelain'], { policy })).stdout).trim();
    check('[A] 主工作树里只有 .codenode/ 是新增的（业务文件逐字节没变）', status.split(/\r?\n/).filter(Boolean).every((l) => l.includes('.codenode/')) && fs.readFileSync(path.join(repo, 'app.js'), 'utf8') === 'console.log(1);\n', JSON.stringify(status));
  }

  // ==================== B. 结果诚实 ====================
  console.log('\n== B. 结果诚实 ==');
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(repo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt2' });
    manager.register(supervisor);
    const res = await supervisor.execute('delegate_task', { role: 'explorer', objective: '再改一遍', isolation: 'worktree' }, ctx);
    const text = String(res.text);
    check('[B] 文本给出隔离工作树路径与分支', /【隔离工作树】/.test(text) && /codenode\/task-/.test(text), text.split('\n').find((l) => l.includes('【隔离工作树】')) || text.slice(0, 60));
    check('[B] 明确写出「这些改动不在主工作树里」+ 合并方式', /不在\*\*主工作树/.test(text) && /git merge codenode\/task-/.test(text));
    check('[B] data.worktree 里带改动清单', res.data && res.data.worktree && Array.isArray(res.data.worktree.changed) && res.data.worktree.changed.some((c) => c.includes('agent-made.txt')), JSON.stringify(res.data && res.data.worktree && res.data.worktree.changed));
  }

  // ==================== C. 不静默降级 ====================
  console.log('\n== C. 不静默降级 ==');
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(notRepo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt3' });
    manager.register(supervisor);
    const res = await supervisor.execute('delegate_task', { role: 'explorer', objective: '非仓库隔离', isolation: 'worktree' }, ctx);
    check('[C] 非 git 仓库 → 任务失败（不假装隔离成功）', res.ok === false && /隔离工作树创建失败/.test(String(res.text)) && /NOT_A_GIT_REPO/.test(String(res.text)), String(res.text).slice(0, 90));
    check('[C] **子代理根本没被调用**（没有静默降级成共享工作树）', seen.length === 0, 'seen=' + seen.length);
    check('[C] 失败也给了下一步（显式改用 isolation=none）', /isolation=none/.test(String(res.text)));
    check('[C] 失败留了审计事件', audits.some((a) => /subagent_worktree_failed/.test(a)), JSON.stringify(audits.filter((a) => /worktree/.test(a))));
  }

  // ==================== D. 默认不变 ====================
  console.log('\n== D. 默认行为不变 ==');
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(repo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt4' });
    manager.register(supervisor);
    const res = await supervisor.execute('delegate_task', { role: 'explorer', objective: '不隔离' }, ctx);
    check('[D] 不传 isolation → 仍在主工作树里跑', res.ok === true && path.resolve(seen[0]) === path.resolve(repo), JSON.stringify(seen.map((s) => path.basename(String(s)))));
    check('[D] 文本里没有隔离段落', !/【隔离工作树】/.test(String(res.text)));
    check('[D] data.worktree 为 null（不编造隔离信息）', res.data && res.data.worktree === null, JSON.stringify(res.data && res.data.worktree));
    try {
      fs.rmSync(path.join(repo, 'agent-made.txt'));
    } catch {}
  }

  // ==================== E. 可查询 ====================
  console.log('\n== E. get_subagent_task ==');
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(repo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt5' });
    manager.register(supervisor);
    const res = await supervisor.execute('delegate_task', { role: 'explorer', objective: '查询用', isolation: 'worktree', taskId: 'task-lookup' }, ctx);
    check('[E] 指定 taskId 的任务被创建', res.ok === true, String(res.text).slice(0, 50));
    const got = await supervisor.execute('get_subagent_task', { taskId: 'task-lookup' }, ctx);
    check('[E] 视图里带 worktree（路径/分支/改动）', got.ok === true && got.data && got.data.worktree && /codenode\/task-lookup/.test(String(got.data.worktree.branch)), JSON.stringify(got.data && got.data.worktree && got.data.worktree.branch));
    check('[E] 视图里的工作树路径确实存在', fs.existsSync(String(got.data.worktree.path)));
  }

  // ==================== F. 审计 + 契约 ====================
  console.log('\n== F. 审计与契约 ==');
  {
    const audits = [];
    const seen = [];
    const ctx = makeContext(repo, audits);
    const supervisor = toolkit.buildDefaultRegistry();
    const manager = new SubagentManager({ agent: stubAgent(seen), toolkit, cfg: baseCfg, registry: supervisor, runId: 'run-wt6' });
    manager.register(supervisor);
    await supervisor.execute('delegate_task', { role: 'explorer', objective: '审计用', isolation: 'worktree' }, ctx);
    check('[F] 建有 subagent_worktree 审计', audits.some((a) => /subagent_worktree"/.test(a)), JSON.stringify(audits.filter((a) => /subagent_worktree/.test(a)).slice(0, 1)));
    check('[F] 收尾有 subagent_worktree_summary 审计（改动数/提交数）', audits.some((a) => /subagent_worktree_summary/.test(a)));
    const schema = supervisor.listTools().find((t) => t.name === 'delegate_task').inputSchema;
    check('[F] delegate_task 的 schema 暴露 isolation 枚举', JSON.stringify(schema.properties.isolation.enum) === JSON.stringify(['none', 'worktree']), JSON.stringify(schema.properties.isolation));
  }

  // 清场：把建出来的工作树都 force 掉（否则临时目录删不掉）
  for (const w of await worktree.managedWorktrees(repo, { policy })) {
    await worktree.removeWorktree(repo, { name: path.basename(w.path), force: true }, { policy });
  }
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'SUBAGENT WORKTREE TEST: PASS' : 'SUBAGENT WORKTREE TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SUBAGENT WORKTREE TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
