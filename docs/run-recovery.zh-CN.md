# 运行安全与恢复

[English](run-recovery.md) · [简体中文](run-recovery.zh-CN.md)

Run 是 CodeNode 的工作单元：一次带显式状态、可审计工具契约和崩溃后可恢复计划的 ReAct 循环。多 Agent 委派出来的每个子任务内部也用同一套循环，所以这一页也是多 Agent 层的基础。

## 一次默认运行怎么走

默认编码流程为：搜索符号或错误、读文件、修改、运行测试。

- `retrieve_context` 不常驻编码工具组，可通过 `discover_tools` 按需启用；本地检索不调用模型拆解 Query。`query_scalars` 是独立画布属性读取工具，不受 `rag.enabled` 影响。
- 普通文件读写和非删除画布编辑默认自动执行；高风险与工作树等操作保留审批。设置 → 常规可按项目切换普通工具自动执行。
- 对话显示「已编辑 N 个文件」及可展开差异，重复编辑同一文件只计一次；推理、任务轨迹和原始工具记录保留在运行数据中。
- 设置 → 检索可按项目开关本地检索、向量扩展和严格答案校验。向量与严格校验默认关闭；SQLite 向量支持和 Milvus SDK 不随默认依赖安装，需要时自行安装扩展并重新打包。显式启用的模型服务仍会产生额外请求与耗时。

## 角色、模型与预算

**设置 → 成本与模型**可为探查、实现、验证、审查和画布角色分别选择已接入模型，默认跟随对话所选主模型。小任务准入规则在本地判断：单步普通操作与明确的单文件读取交回主 Agent，不启动子模型。设置中可查看按任务／角色归属的 token、缓存命中、重试和成本，以及运行完成和局部校验结果；缺失价格时显示未知，不把完成等同于正确。

重复只读结果默认按引用复用，前提是正文仍完整保留在当前上下文；压缩或裁剪后会检查引用是否失效，需要原文时再次提供正文。各角色可配置轮次、累计 token 和单次输出上限，默认继承；「轻量探查预设」提供 6 轮／60000 总 token／8192 输出 token 的可选预算，不自动限制复杂探查。

## Run 状态

![单 Agent ReAct 运行状态与恢复](architecture/single-agent-react-state.png)

一次 Agent Run 从 `RUNNING` 开始：

- 模型给出最终答复时进入 `COMPLETED`。
- 模型提出工具调用时，先完成流式参数拼接和结构校验，再进入 `WAITING_TOOL` 执行工具，并把结果写回对话后回到 `RUNNING`。
- 需要审批或向用户提问时进入 `WAITING_USER`。
- `FAILED`、`CANCELLED` 和 `LIMIT_REACHED` 是其他终态。

图中的 **ACTIVE** 只是为了阅读方便画出的活动态分组，不是代码里的额外状态。普通工具失败会作为工具结果交还模型判断；流损坏、运行错误、用户取消或预算触顶才按各自终止规则处理。可选的 Observation/Blackboard 会整理工具结果，但不替代原始工具记录。

## 安全与恢复机制

工具由注册表校验参数、能力和确认策略。写入、命令和外部网络能力按各自契约执行，并留下审计记录；有副作用的操作使用幂等账本，避免未知结果被盲目重放。

恢复由 Run 事件、检查点和副作用账本共同决定：

1. `planResume` 读取旧 Run 的事件和检查点。
2. 安全且结果明确的步骤可以自动续跑。
3. 结果未知的写入或外部操作进入人工复核。
4. 继续执行会创建新 Run，旧 Run 保留原状态和证据。

断流重试是整轮重发，不会把半截结果拼到新请求后面。连接重试与断流重发共用单次调用的 HTTP 请求上限；每次实际请求前都从本次 Run 的 token 预算预留输入和最大输出额度。配置入口见 `config/agent.properties.example`。

## 代码位置

| 范围 | 代码 |
| --- | --- |
| 工具循环与 Run 状态机 | `electron/agent.cjs`、`electron/agentState.cjs` |
| 事件、检查点、恢复计划 | `electron/runStore.cjs`、`electron/runCheckpoint.cjs` |
| 副作用账本与回滚 | `electron/sideEffects.cjs`、`electron/runRollback.cjs` |
| 预算与成本归属 | `electron/requestBudget.cjs`、`electron/contextBudget.cjs`、`electron/costLedger.cjs`、`electron/costAttribution.cjs` |
| 权限、审批、沙箱 | `electron/tools/registry.cjs`、`electron/approvalRules.cjs`、`electron/sandbox.cjs` |

相关验收：`npm run test:resume`、`test:side-effect-idem`、`test:run-rollback`、`test:agent-limits`、`test:context-budget`、`test:sandbox`、`test:runtime-gate`（后者断言这些能力确实接线可用，而不只是源码里出现过）。设计背景见[借鉴建议文档](agent-harness-and-workflow-recommendations.md)。
