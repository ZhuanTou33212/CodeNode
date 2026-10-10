# Multi-agent collaboration

[English](multi-agent.md) · [简体中文](multi-agent.zh-CN.md)

Multi-agent work builds on the single-agent run described in [run safety and recovery](run-recovery.md). The main agent delegates when a task needs it, and every subtask gets its own prompt, conversation, role permissions, deadline and budget.

## Delegation

The main agent calls `delegate_task` or `delegate_tasks` and assigns each subtask a role. A bounded FIFO scheduler runs at most **4** subtasks concurrently and shares one global concurrency value with the model request queue:

- safe read-only tasks run in parallel;
- tasks that write to a shared workspace take it exclusively;
- with `isolation: "worktree"` a writing task runs in its own Git worktree (canvas roles do not support that mode).

| Role | Responsibility | Boundary |
| --- | --- | --- |
| `explorer` | Locate files, symbols and evidence | Read-only; no file changes, no commands |
| `builder` | Implement changes within the task scope | Writes constrained by permissions and confirmation policy |
| `verifier` | Run tests, builds and checks | Does not modify the code under test |
| `reviewer` | Independently review the implementation and edge cases | Read-only; does not fix what the builder wrote |
| `canvas` | Edit and save the canvas | Does not write project source files |

## Limits and budgets

Each run starts at most **24** subtasks by default, at most **8** per batch; at **75%** (18/24) the main agent is told how much budget remains so it converges on planning, verification and summarising. Failed or cancelled-after-start subtasks still count. Request-level transient retries draw on a separate shared retry budget.

These options are stored together in **Settings → General → Global scheduling**, shared across projects, restarts and both themes; the desktop app and the CLI read the same user-level `$CODENODE_HOME/agent-scheduling.json` (default `~/.codenode/agent-scheduling.json`).

## Redoing a task

Redoing a whole task uses `inspect_subagent_retry` to check the execution version, dependencies and compensation plan, then `retry_subagent_task` to run it explicitly.

- The redo keeps the `taskId`, increments Attempt and creates a fresh `executionId`.
- Defaults are **3** attempts per task and **72** per run (both including the first).
- A redo does not add a logical task but consumes attempt allowance and real request budget.
- File compensation needs approval, and later edits, unknown side effects or already-merged code block it.
- The run panel keeps the attempt history.

## Results are candidates

A subagent's answer is a **candidate result**. The main agent can read the task envelope, check the source and artifacts, and have `verifier` re-run the work independently; only a confirmed and still-valid summary is passed downstream through `dependsOnTaskIds`. Declared artifacts are re-hashed against disk before they are used. `merge_subagent_results` summarises candidate claims — it never merges Git code for you.

When you use isolated worktrees, preview files, branch versions and content fingerprints with `inspect_merge` first, then confirm `merge`. Conflicts or version drift block downstream work, and changes from other tasks in the main worktree are never rolled back automatically.

## Where it lives

| Area | Code |
| --- | --- |
| Delegation and scheduling | `electron/subagents.cjs`, `electron/subagentScheduler.cjs` |
| Envelope verification and attempts | `electron/subagentEnvelope.cjs`, `electron/subagentAttempts.cjs` |
| Worktree isolation and merge | `electron/worktree.cjs` |
| Scheduling settings | `electron/schedulingSettings.cjs` |

Relevant acceptance: `npm run test:subagent`, `test:subagent-attempts`, `test:subagent-envelope`, `test:subagent-isolation`, `test:scheduler-parallel`, `test:multi-agent-integrity`, `test:worktree`, `test:subagent-worktree`, `test:scheduling`. Live acceptance against a real external agent: `npm run test:goal-auto-live` (see [backends](backends.md)).
