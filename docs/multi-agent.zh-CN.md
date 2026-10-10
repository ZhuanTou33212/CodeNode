# 多 Agent 协作

[English](multi-agent.md) · [简体中文](multi-agent.zh-CN.md)

多 Agent 建立在[运行安全与恢复](run-recovery.zh-CN.md)里的单 Agent Run 之上。主 Agent 按任务需要委派，每个子任务都有独立提示词、对话、角色权限、时限和预算。

## 委派

主 Agent 调用 `delegate_task` 或 `delegate_tasks` 并给子任务分配角色。有界 FIFO 调度器最多同时运行 **4** 个子任务，并与模型请求队列共用一个全局并发值：

- 安全只读任务可以并行；
- 共享工作区写任务独占；
- 选择 `isolation: "worktree"` 时，写任务在独立 Git 工作树中执行（画布角色不支持该模式）。

| 角色 | 职责 | 边界 |
| --- | --- | --- |
| `explorer` | 定位文件、符号和证据 | 只读，不修改文件或运行命令 |
| `builder` | 在任务范围内实施修改 | 写操作受权限与确认策略约束 |
| `verifier` | 运行测试、构建和检查 | 不修改被测源码 |
| `reviewer` | 独立审查实现与边界情况 | 只读，不代替实现角色修复 |
| `canvas` | 修改和保存画布 | 不写项目源码文件 |

## 额度与预算

每次运行默认累计最多启动 **24** 个子任务，单批最多 **8** 个；达到 **75%**（18/24）时，主 Agent 会收到剩余额度提示，优先收敛计划、验证和总结。失败或启动后取消仍计入额度。请求级瞬态重试使用独立的共享重试预算。

以上选项在 **设置 → 常规 → 全局调度** 集中保存，跨项目、跨重启和昼夜主题共用；桌面与命令行读取同一份用户级 `$CODENODE_HOME/agent-scheduling.json`（默认 `~/.codenode/agent-scheduling.json`）。

## 整任务重做

整任务重做使用 `inspect_subagent_retry` 核对执行版本、依赖和补偿计划，再用 `retry_subagent_task` 显式执行：

- 重做保留 `taskId`，每次生成递增 Attempt 和独立 `executionId`。
- 默认单任务最多 **3** 次、每次运行最多 **72** 次（均含首次）。
- 重做不增加逻辑任务数，但消耗尝试额度及真实请求预算。
- 文件补偿需批准，后续修改、未知副作用或已合入代码会阻止重做。
- 运行面板保留尝试记录。

## 结果是候选，不是事实

子 Agent 的回答先是**候选结果**。主 Agent 可以读取任务信封、核对来源和产物，必要时让 `verifier` 独立复跑；只有经过确认且仍有效的摘要，才会通过 `dependsOnTaskIds` 传给下游。子 Agent 声明的产物在进入下游之前会与磁盘重新比对哈希。`merge_subagent_results` 汇总的是候选声明，不会自动合并 Git 代码。

使用隔离工作树时，先用 `inspect_merge` 预览文件、分支版本和内容指纹，再确认 `merge`。冲突或版本漂移会阻断下游，主工作树不会自动回滚其他任务的改动。

## 代码位置

| 范围 | 代码 |
| --- | --- |
| 委派与调度 | `electron/subagents.cjs`、`electron/subagentScheduler.cjs` |
| 信封核对与尝试记录 | `electron/subagentEnvelope.cjs`、`electron/subagentAttempts.cjs` |
| 工作树隔离与合并 | `electron/worktree.cjs` |
| 调度设置 | `electron/schedulingSettings.cjs` |

相关验收：`npm run test:subagent`、`test:subagent-attempts`、`test:subagent-envelope`、`test:subagent-isolation`、`test:scheduler-parallel`、`test:multi-agent-integrity`、`test:worktree`、`test:subagent-worktree`、`test:scheduling`。真实外部 Agent 的实时验收：`npm run test:goal-auto-live`（见[后端](backends.zh-CN.md)）。
