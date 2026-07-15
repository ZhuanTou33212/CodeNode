---
name: codenode-local-queue
description: Process a named or latest request submitted by CodeNode Desktop through the project-local .codenode file queue. Use when the user asks to process a CodeNode local request.
---

# CodeNode 本地申请槽

CodeNode Desktop 不使用 MCP，也不会自动唤醒 Codex。用户会手动说“处理 CodeNode 本地申请 request-...”或“处理最新 CodeNode 本地申请”。

## 领取申请

1. 从当前工作区向上查找 `.codenode/project.json`，只在该项目根目录内操作。
2. 指定编号时读取 `.codenode/queue/inbox/<requestId>/request.json`；“最新”表示按目录名降序选择第一个。
3. 先用 `scripts/local-queue.mjs claim <projectRoot> <requestId|latest>` 领取。脚本会校验 schema 3.0，并原子移动到 `queue/processing`，避免两个任务同时处理。
4. 只信任校验后的 `request.json`，不得从 `request.md` 标题重新猜测模式、动作、路径或节点引用。

## 模式隔离

- `executable-workflow`：先启用 `codenode-workflow-dsl` 规范化表达式和可达子图，再根据 `language` 只启用 Java、PowerShell、Go 中的一个 Skill。`build-node` 只制作目标节点；`build-program` 转译连接工作流、编译并按请求决定是否运行。
- `markdown-blueprint`：只分析项目结构并生成 `.md` 文件。节点仅表示项目、模块、文件、依赖、约束或章节；禁止启用语言 Skill、生成源代码、调用编译器或运行程序。

输出路径必须是 `output.workspaceRoot` 下的 `output.relativePath`。`requiresConfirmation: true` 时，在覆盖已有文件或执行生成程序前仍需遵守用户确认边界。

## 回写结果

1. 创建符合 `schemas/workflow-result.schema.json` 的 `result.draft.json`，保存到该申请的 `queue/processing/<requestId>/` 目录。
2. 编译/运行错误必须写入 `diagnostics[]`，尽量包含 `nodeId`、`file`、`line`、`column` 和 `message`；每个节点写入 `nodeResults[]`。
3. 运行 `scripts/local-queue.mjs complete <projectRoot> <requestId> <result.draft.json>`。脚本会原子写入 `.codenode/results/<requestId>/result.json`，然后把申请移动到 `completed` 或 `failed`。
4. 不要只在对话中汇报而遗漏结果文件；桌面程序依靠该文件把失败节点标红。
