# Agent 后端

[English](backends.md) · [简体中文](backends.zh-CN.md)

CodeNode 可以跑自研 Agent 循环，也可以把同一条对话交给外部 Agent，统一走 **ACP v1（stdio）**。界面、画布工作流和 Goal 自动推进都使用同一条执行链，只是执行器不同。

## 选择执行器

在 **对话栏顶部 → Chat／Agent 名称** 选择执行器：

- 选中只是预览，点击「确认切换」才保存。
- 切换保留同一条对话、消息、输入草稿和画布，下条消息由新 Agent 接手。
- 运行或切换期间禁用入口。
- 菜单只用于切换，不再放重复的连接设置入口；以勾选标记当前 Agent。
- 缺少本机启动命令或未配置的条目置灰显示「不可用」。该判断只做命令探测、不发模型请求；完整连接仍在设置中检测。
- 快捷切换有项目时只保存当前项目，未选择项目时保存本机默认。
- 每个 Agent 的连接配置分别记住，切回时恢复已有命令、参数、模型和 ACP 设置；高级设置中仍可调整配置范围，项目可跟随本机设置。

连接路径、参数、认证和 MCP 在 **设置 → Agent 连接** 中配置。

| 后端 | 已安装的启动命令 | 默认参数 |
| --- | --- | --- |
| Codex | `codex-acp` | 空；需要已有 Codex CLI 和本机登录 |
| DeepSeek Harness | `dsh` | `--profile acp`；可选已有 `DSH_HOME` |
| Hermes | `hermes` | `acp` |
| OpenCode | `opencode` | `acp` |
| OpenClaw | `openclaw` | `acp`；需要可用 Gateway |
| 自定义 ACP | 用户填写现有命令或绝对路径 | 用户填写 JSON 参数数组 |

CodeNode 不下载 Agent、不使用 npx 自动安装。启动命令从 PATH/Windows npm global 解析，支持本机可执行文件及 npm JS/native shim；不拼接 shell 命令。模型留空跟随 Agent 原生配置，认证、Skills 与原生工具由 Agent 自身管理。Windows 手动系统代理在没有显式代理环境变量时仅注入本轮子进程；不改系统或账户设置。

## BackendPort 统一契约

契约参考 [qwen-audio-agent BackendPort](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/backend/backend-port.mjs)：

- `describe`：身份、传输与能力；`start`：幂等准备连接，不发送模型 prompt；`health`：当前可用性。
- `submit`：提交一个 Task；`status`：运行时或 owner 范围内的 Task 状态；`cancel`：取消指定 Task。
- `respondAuthorization`／`respondInput`：回复当前 Task/owner 对应的待处理请求，拒绝跨 Task/owner、未知或重复回复。
- `subscribe`：订阅带 Task/owner 的 message/state/activity/authorization/input/artifact 事件；`close`：幂等释放连接与待处理请求。

内置执行器也通过 BackendPort 提交，内部继续使用 CodeNode 模型与工具循环。ACP 客户端共用初始化、会话创建/加载/恢复、文本及多媒体 prompt、权限、取消、配置和错误处理。后台调用实际使用上述契约，原 Codex app-server 与 DeepSeek SDK JSON-RPC 适配器已删除。

## 配置检测与迁移

「检测当前配置」只验证当前命令和参数的 ACP 初始化，不写入设置或发模型请求。

旧默认 `codex`／已保存的 Codex CLI 路径改为适配器命令，DeepSeek 的旧 `--profile sdk` 改为 `--profile acp`，保存后持久化为设置版本 2；其他自定义命令保留，需要用户确认它支持 ACP。旧 app-server/SDK Run 保留历史，但不能通过 ACP 恢复原线程——请复核旧 Run 和项目差异后新建 ACP 会话。不会静默转换会话 ID 或重放副作用。

## 对话、会话与运行记录

界面对话与 ACP 内部会话分别管理：

- 显式切换 Agent 会在项目 `backend.json` 持久化对话绑定与切换代次，不重建界面对话。
- 同一切换代次续用精确 ACP session ID；跨 Agent 或切换回来时使用新内部会话，并把可见历史与当前画布作为上下文交接。
- 切到 CodeNode 直接走自研模型循环，后续不会被旧外部会话接管。隔离 Task 新建内部会话。
- 结果未知时必须复核后显式恢复。
- Run 保存协议、会话、权限、状态、事件和项目文件指纹；代码修改必须通过独立本地校验。
- `max_tokens` 等非完成终态记为失败，不能充当完成证据。
- Goal admission、预算、写入范围、重启未知状态及验收证据规则继续生效，见[画布与目标](canvas-and-goals.zh-CN.md)。

## 权限与隔离

所有外部后端共用 **ACP 权限请求策略**：只读拒绝扩权请求，写入逐次询问。客户端文件读写在项目边界内运行，提交前检查文件指纹、编辑器草稿和 Task 写入范围；终端复用本地沙箱策略。

Agent 原生工具不由 CodeNode 全面拦截，ACP 权限不等于操作系统隔离，外部用量/费用可能未知。CodeNode 自身提供的本地隔离见[运行安全与恢复](run-recovery.zh-CN.md)。

## ACP 会话配置

在 **ACP 会话配置** 持久化 `authMethodId`、`modeId`、`configValues`、`mcpServers` 和 `codeNodeTools`。「读取 ACP 可选项」查询实际可用值，认证和控制按 Agent 声明能力执行。

图片、音频、资源发送前检查能力；未知客户端方法返回 `-32601`。form elicitation 支持结构化字段回复，单个字符串字段可直接输入文本；URL 认证或交互式终端登录由 Agent 自身处理。需要 CodeNode 画布与项目工具时，可显式启用本轮 MCP relay，复用现有角色、能力、范围、审批和取消门禁。

## 验收

离线：`npm run test:backend-port`、`test:backends`、`test:multi-backends`、`test:acp-full` 和 `test:backend-workflow`。双主题与设置持久化：`test:backend-ui`。

显式真实模型验收：`test:goal-auto-live`（OpenCode 自动推进）、`test:backend-live`（Codex ACP）、`test:backend-live-deepseek`（DeepSeek ACP）及 `test:backend-live-workflow`（隔离源码任务）；要求已有 Agent 和凭据，可能产生模型用量，不进入离线 CI。

参考：[qwen-audio-agent 后端接入](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/overview.md)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)。本机 OpenCode 的真实模型路径已验证，缺少本机 codex-acp/dsh 不会被标记为实测通过。
