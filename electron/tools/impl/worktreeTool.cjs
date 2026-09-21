/**
 * worktreeTool.cjs —— 工作树隔离工具（对照 Codex / Claude Code 的 worktree 用法）
 *
 * 三个动作：
 *   · `list`   —— 看有哪些受管工作树、各自分支与未提交改动（只读，不确认）
 *   · `create` —— 在 `.codenode/worktrees/<name>` 建一份独立检出（**要确认**：会建目录与分支）
 *   · `remove` —— 移除工作树；有未提交改动时默认拒绝，必须显式 `force`（**要确认**：可能丢代码）
 *
 * 为什么建/删都要确认：它们都会改**仓库结构**（新增分支、删目录），而 `remove --force` 会真的丢代码。
 * 为什么不自动合并：工作树的价值就是「主代理的工作树不受影响」——合并是主代理看到 diff 之后的决定，
 * 工具只负责如实报告「改了什么、提交了几个」。
 */
'use strict';

const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const worktree = require('../../worktree.cjs');

function render(row) {
  const parts = ['- ' + row.name, row.branch ? '分支 ' + row.branch : '（游离 HEAD）'];
  if (typeof row.changed === 'number') parts.push(row.changed ? row.changed + ' 个未提交改动' : '无未提交改动');
  if (typeof row.commits === 'number') parts.push(row.commits ? row.commits + ' 个新提交' : '无新提交');
  return parts.join('｜');
}

function register(registry) {
  registry.register(
    'worktree',
    'git 工作树隔离：create 建一份独立检出（子代理在里面改代码，主工作树不受影响）/ list 查看 / remove 移除（有未提交改动需 force）。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'remove'], description: '要做什么' },
        name: { type: 'string', description: '工作树名字（create/remove 用；会归一化成安全目录名）' },
        base: { type: 'string', description: 'create 的基线分支（默认当前分支）' },
        path: { type: 'string', description: 'remove 也可直接给路径（必须是受管目录下的）' },
        force: { type: 'boolean', description: 'remove 时丢弃未提交改动（默认 false）' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String((args && args.action) || '').trim();
      const projectRoot = context.projectRoot();
      const opts = {
        context,
        policy: typeof context.sandbox === 'function' ? context.sandbox() : null,
      };

      if (action === 'list') {
        const rows = await worktree.managedWorktrees(projectRoot, opts);
        // 新提交数按「相对主工作树的 HEAD」算 —— 之前写成 `HEAD~0..HEAD` 恒等于 0，
        // 数字看着正常其实是假的（判据当场抓到）
        const all = await worktree.listWorktrees(projectRoot, opts);
        const main = all.find((w) => path.resolve(w.path) === path.resolve(projectRoot));
        const base = (main && main.head) || 'HEAD';
        const detailed = [];
        for (const row of rows) {
          const changed = await worktree.changedFiles(row.path, opts);
          const commits = await worktree.commitCount(row.path, base, opts);
          detailed.push({ name: path.basename(row.path), path: row.path, branch: row.branch, changed: changed.length, commits, base });
        }
        if (!detailed.length) {
          return AgentToolResult.ok('当前没有受管工作树（.codenode/worktrees/ 为空）。用 action=create 建一个。', { worktrees: [], root: worktree.worktreesRoot(projectRoot) });
        }
        return AgentToolResult.ok(
          '受管工作树（' + detailed.length + '/' + worktree.MAX_WORKTREES + '）：\n' + detailed.map(render).join('\n'),
          { worktrees: detailed, root: worktree.worktreesRoot(projectRoot) }
        );
      }

      if (action === 'create') {
        const name = String((args && args.name) || '').trim();
        if (!name) return AgentToolResult.error('create 需要 name');
        const slug = worktree.slugify(name);
        const ok = await context.confirm(
          ConfirmationLevel.WRITE,
          '创建工作树 ' + slug,
          '将在项目里新建目录 .codenode/worktrees/' + slug + ' 与分支 codenode/' + slug + '（独立检出，主工作树不受影响）'
        );
        if (!ok) return AgentToolResult.error('用户未批准，未创建任何工作树（未执行任何操作）');
        const created = await worktree.createWorktree(projectRoot, { name, base: args.base }, opts);
        if (!created.ok) return AgentToolResult.error(created.message, { code: created.error, tool: 'worktree' });
        if (typeof context.audit === 'function') context.audit('worktree create ' + created.relativePath + ' (branch ' + created.branch + ')');
        return AgentToolResult.ok(
          '已创建隔离工作树：' + created.relativePath + '\n分支：' + created.branch + '（基线 ' + created.base + '）\n' +
            '在它里面改代码不会影响主工作树；改完用 action=list 看改动、或直接在该目录里跑测试，再决定合并（git merge ' + created.branch + '）还是移除。',
          { path: created.path, relativePath: created.relativePath, branch: created.branch, base: created.base }
        );
      }

      if (action === 'remove') {
        const target = String((args && (args.name || args.path)) || '').trim();
        if (!target) return AgentToolResult.error('remove 需要 name 或 path');
        const ok = await context.confirm(
          ConfirmationLevel.WRITE,
          '移除工作树 ' + target + (args.force ? '（force：丢弃未提交改动）' : ''),
          '将执行 git worktree remove' + (args.force ? ' --force' : '') + '，只允许操作 .codenode/worktrees/ 下的工作树'
        );
        if (!ok) return AgentToolResult.error('用户未批准，未移除任何工作树');
        const removed = await worktree.removeWorktree(projectRoot, { name: args.name, path: args.path, force: args.force === true }, opts);
        if (!removed.ok) {
          const extra = removed.changed ? '\n未提交改动：' + removed.changed.map((c) => c.status + ' ' + c.path).join('、') : '';
          return AgentToolResult.error(removed.message + extra, { code: removed.error, tool: 'worktree', managed: removed.managed || null });
        }
        if (typeof context.audit === 'function') context.audit('worktree remove ' + removed.path + (removed.discardedChanges ? ' (discarded ' + removed.discardedChanges + ')' : ''));
        return AgentToolResult.ok(
          '已移除工作树：' + removed.path + '（分支 ' + (removed.branch || '-') + ' 仍在，需要的话可 git branch -d 删掉）' +
            (removed.discardedChanges ? '\n注意：丢弃了 ' + removed.discardedChanges + ' 个未提交改动' : ''),
          { path: removed.path, branch: removed.branch, discardedChanges: removed.discardedChanges }
        );
      }

      return AgentToolResult.error('未知 action：' + action + '（可选 list / create / remove）', { code: 'ARG_SCHEMA', tool: 'worktree' });
    }
  );
}

module.exports = { register };
