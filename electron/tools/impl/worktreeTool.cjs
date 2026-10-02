/**
 * worktreeTool.cjs —— 工作树隔离工具（对照 Codex / Claude Code 的 worktree 用法）
 *
 * 五个动作：
 *   · `list`   —— 看有哪些受管工作树、各自分支与未提交改动（只读，不确认）
 *   · `create` —— 在 `.codenode/worktrees/<name>` 建一份独立检出（**要确认**：会建目录与分支）
 *   · `inspect_merge` —— 预览待合并文件、两侧版本与主工作树状态（只读）
 *   · `merge` —— 复核版本后提交隔离改动并合并；冲突时尝试回退主工作树（**要确认**）
 *   · `remove` —— 移除工作树；有未提交改动时默认拒绝，必须显式 `force`（**要确认**：可能丢代码）
 *
 * 为什么建/删都要确认：它们都会改**仓库结构**（新增分支、删目录），而 `remove --force` 会真的丢代码。
 * 合并必须先 inspect_merge，再明确确认；不会在子代理结束时自动合并。
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
    '管理 git 隔离工作树：list/create/inspect_merge/merge/remove。先预览再确认合并；冲突时回退。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'inspect_merge', 'merge', 'remove'], description: '要做什么' },
        name: { type: 'string', description: '受管工作树名' },
        base: { type: 'string', description: 'create 的基线分支' },
        path: { type: 'string', description: 'remove 的受管路径' },
        force: { type: 'boolean', description: 'remove 时强制丢弃改动' },
        expectedTargetHead: { type: 'string', description: '预检返回的 targetHead' },
        expectedSourceHead: { type: 'string', description: '预检返回的 sourceHead' },
        expectedTargetBranch: { type: 'string', description: '预检返回的 targetBranch' },
        expectedPendingDigest: { type: 'string', description: '预检返回的 pendingDigest' },
        commitMessage: { type: 'string', description: '合并未提交改动时的提交说明' },
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

      if (action === 'inspect_merge') {
        const name = String((args && args.name) || '').trim();
        if (!name) return AgentToolResult.error('inspect_merge 需要 name');
        const preview = await worktree.inspectMerge(projectRoot, name, opts);
        if (!preview.ok) return AgentToolResult.error(preview.message, preview);
        const files = preview.files || [];
        const pending = preview.pending || [];
        return AgentToolResult.ok(
          '待合并：' + preview.branch + ' → ' + preview.targetBranch +
          '\n主工作树 HEAD：' + preview.targetHead + '\n隔离分支 HEAD：' + preview.sourceHead +
          '\n未提交内容指纹：' + preview.pendingDigest +
          '\n已有提交：' + preview.commits + '，未提交项：' + pending.length +
          '\n涉及文件：\n' + (files.length ? files.map((file) => '- ' + file).join('\n') : '（无）') +
          '\n核对后调用 merge，并原样传回两个 HEAD、targetBranch 和 pendingDigest；有未提交项时还需 commitMessage。',
          preview
        );
      }

      if (action === 'merge') {
        const name = String((args && args.name) || '').trim();
        if (!name || !args.expectedTargetHead || !args.expectedSourceHead || !args.expectedTargetBranch || !args.expectedPendingDigest) {
          return AgentToolResult.error('merge 需要 name、expectedTargetHead、expectedSourceHead、expectedTargetBranch、expectedPendingDigest；先调用 inspect_merge');
        }
        const preview = await worktree.inspectMerge(projectRoot, name, opts);
        if (!preview.ok) return AgentToolResult.error(preview.message, preview);
        const files = preview.files || [];
        const pending = preview.pending || [];
        if (preview.targetHead !== args.expectedTargetHead || preview.sourceHead !== args.expectedSourceHead ||
            preview.targetBranch !== args.expectedTargetBranch || preview.pendingDigest !== args.expectedPendingDigest) {
          return AgentToolResult.error('预览后分支版本已变化，请重新 inspect_merge');
        }
        const ok = await context.confirm(
          ConfirmationLevel.WRITE,
          '合并隔离工作树 ' + preview.branch,
          '将 ' + files.length + ' 个文件合并到 ' + preview.targetBranch + '。主工作树当前必须干净；' +
            (pending.length ? '会先提交隔离工作树的 ' + pending.length + ' 个未提交项；' : '') +
            '如有冲突将尝试 git merge --abort，隔离分支仍保留。'
        );
        if (!ok) return AgentToolResult.error('用户未批准，未执行合并');
        const merged = await worktree.mergeWorktree(projectRoot, args, opts);
        if (!merged.ok) return AgentToolResult.error(merged.message, merged);
        if (typeof context.audit === 'function') context.audit('worktree merge ' + merged.branch + ' -> ' + merged.targetBranch + ' (' + merged.head + ')');
        return AgentToolResult.ok(
          '已合并 ' + merged.branch + ' 到 ' + merged.targetBranch + '\n新 HEAD：' + merged.head +
            '\n涉及文件：' + (merged.files || []).join('、') + '\n隔离工作树仍保留，核验后可移除。',
          merged
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

      return AgentToolResult.error('未知 action：' + action + '（可选 list / create / inspect_merge / merge / remove）', { code: 'ARG_SCHEMA', tool: 'worktree' });
    }
  );
}

module.exports = { register };
