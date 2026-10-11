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
| Qwen Code | `qwen` | `--acp`；使用 Qwen Code 原生 stdio ACP 入口 |
| OpenCode | `opencode` | `acp` |
| OpenClaw | `openclaw` | `acp`；需要可用 Gateway |
| Qoder | `qodercli`，缺失时回退 `qoder` | `--acp` |
| MiniMax Code | `mcode` | `acp`；要求 MiniMax Code 0.3.7 或更新版本 |
| Kimi Code | `kimi` | `acp`；要求 Kimi Code 0.31.0 或更新版本 |
| Hermes | `hermes` | `acp` |
| CodeBuddy | `codebuddy` | `--acp` |
| Codex | `codex-acp` | 空；需要已有 Codex CLI 和本机登录 |
| Claude Code | `claude-agent-acp`，缺失时回退旧名 `claude-code-acp` | 空；需要已有 Claude Code 登录 |
| DeepSeek Harness | `dsh` | `--profile acp`；可选已有 `DSH_HOME` |
| Pi | `pi-acp` | 空；需要 `pi` 本体。Pi 没有沙箱，`pi-acp` 也不发权限请求 |
| Muse Code | `muse` | `serve`；走 MSP 而不是 ACP，需要本机 Muse Code |
| 自定义 ACP | 用户填写现有命令或绝对路径 | 用户填写 JSON 参数数组 |

CodeNode 不下载 Agent、不使用 npx 自动安装。启动命令从 PATH/Windows npm global 解析，支持本机可执行文件及 npm JS/native shim（`.cmd` 垫片目标为 `.js`/`.mjs`/`.cjs`、Windows `.exe`，或带 Node shebang 的无扩展名启动器）；文档列出的别名只在本名缺失时回退，且不拼接 shell 命令。模型留空跟随 Agent 原生配置，认证、Skills 与原生工具由 Agent 自身管理。Windows 手动系统代理在没有显式代理环境变量时仅注入本轮子进程；不改系统或账户设置。

## BackendPort 统一契约

契约参考 [qwen-audio-agent BackendPort](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/backend/backend-port.mjs)：

- `describe`：身份、传输与能力；`start`：幂等准备连接，不发送模型 prompt；`health`：当前可用性。
- `submit`：提交一个 Task；`status`：运行时或 owner 范围内的 Task 状态；`cancel`：取消指定 Task。
- `respondAuthorization`／`respondInput`：回复当前 Task/owner 对应的待处理请求，拒绝跨 Task/owner、未知或重复回复。
- `subscribe`：订阅带 Task/owner 的 message/state/activity/authorization/input/artifact 事件；`close`：幂等释放连接与待处理请求。

内置执行器也通过 BackendPort 提交，内部继续使用 CodeNode 模型与工具循环。ACP 客户端共用初始化、会话创建/加载/恢复、文本及多媒体 prompt、权限、取消、配置和错误处理。Muse Code 用同一份契约接入，但传输层是 MSP 而不是 ACP（见下节）。后台调用实际使用上述契约，原 Codex app-server 与 DeepSeek SDK JSON-RPC 适配器已删除。

## 配置检测与迁移

「检测当前配置」只验证当前命令和参数的 ACP 初始化，不写入设置或发模型请求。

旧默认 `codex`／已保存的 Codex CLI 路径改为适配器命令，DeepSeek 的旧 `--profile sdk` 改为 `--profile acp`，保存后持久化为设置版本 2；其他自定义命令保留，需要用户确认它支持 ACP。旧 app-server/SDK Run 保留历史，但不能通过 ACP 恢复原线程——请复核旧 Run 和项目差异后新建 ACP 会话。不会静默转换会话 ID 或重放副作用。

## 对话、会话与运行记录

界面对话与 ACP 内部会话分别管理：

- 显式切换 Agent 会在项目 `backend.json` 持久化对话绑定与切换代次，不重建界面对话。
- 同一切换代次续用精确 ACP session ID；跨 Agent 或切换回来时使用新内部会话，并把可见历史与当前画布作为上下文交接。
- 切到 CodeNode 直接走自研模型循环，后续不会被旧外部会话接管。隔离 Task 新建内部会话。
- Muse Code 的会话编号只在本轮有效：它不写入可恢复的协议会话记录，因此每轮都新建 Muse 会话，并把可见历史与当前画布作为上下文交接。
- 结果未知时必须复核后显式恢复。
- Run 保存协议、会话、权限、状态、事件和项目文件指纹；代码修改必须通过独立本地校验。
- `max_tokens` 等非完成终态记为失败，不能充当完成证据。
- Goal admission、预算、写入范围、重启未知状态及验收证据规则继续生效，见[画布与目标](canvas-and-goals.zh-CN.md)。

## 权限与隔离

所有外部后端共用同一套 **权限请求策略**：只读拒绝扩权请求，写入逐次询问；ACP 走 `session/request_permission`，Muse Code 走 MSP 的 `approval/request`，语义一致。客户端文件读写在项目边界内运行，提交前检查文件指纹、编辑器草稿和 Task 写入范围；终端复用本地沙箱策略。

Agent 原生工具不由 CodeNode 全面拦截，ACP 权限不等于操作系统隔离，外部用量/费用可能未知。CodeNode 自身提供的本地隔离见[运行安全与恢复](run-recovery.zh-CN.md)。

**例外：Pi 不实现权限请求。** `pi-acp` 没有实现 ACP `session/request_permission`，Pi 官方也明确没有内置沙箱，它的 read/write/bash 直接以当前用户权限执行。所以只读和逐次审批都无法约束 Pi。CodeNode 不假装这两条生效：设置界面会在选择 Pi 时显示警告，能力快照返回 `permissionEnforcement: "unavailable"`，本轮开始前也会发一条 `backend_info` 说明。只在可信项目与可信提示词下使用 Pi。

## ACP 会话配置

在 **ACP 会话配置** 持久化 `authMethodId`、`modeId`、`configValues`、`mcpServers` 和 `codeNodeTools`。「读取 ACP 可选项」查询实际可用值，认证和控制按 Agent 声明能力执行。

图片、音频、资源发送前检查能力；未知客户端方法返回 `-32601`。form elicitation 支持结构化字段回复，单个字符串字段可直接输入文本；URL 认证或交互式终端登录由 Agent 自身处理。需要 CodeNode 画布与项目工具时，可显式启用本轮 MCP relay，复用现有角色、能力、范围、审批和取消门禁。

## Muse Code 与 MSP

Muse Code 不是 ACP Agent：它用 Meta 的 **Muse Session Protocol（MSP）**。CodeNode 启动 `muse serve` 子进程，在同一 stdio 上跑 MSP（换行分隔的 JSON-RPC 2.0），并把 MSP 的执行项、权限请求、补充输入、取消和最终消息映射到同一个 BackendPort。

- 握手：`initialize`（`clientInfo`）→ 校验 `schema.version === 1` → 通知 `initialized`。版本不符直接报错，不猜测。
- 会话：`session/start`（`commandId`/`sessionId` 为 UUIDv7，`workspaceRoot` 与可选 `modelId`）；写入模式下**不带** `approvalMode`，因此 Muse 用自身的默认审批模式，不会预授权。
- 任务：`turn/start`（`input` 文本与内联图片、`displayText`、`ifBusy: "queue"`）→ `item/*` 流式增量 → `turn/completed` 作为唯一权威终态。`item/delta` 逐段给出文本与推理，`item/completed` 只补齐增量没有覆盖的部分，不重复拼接。
- 权限：`approval/requested` 通知与 `approval/request` 服务端请求是同一件事的两条通道，后者只回空 `{}` 收据；真正的决定走 `approval/decide`，并带当前 `requirementId` 以避开多阶段竞态。只读模式直接选拒绝项，不问用户；写入模式逐次询问，且**只选单次允许**，不会把授权升级成会话或持久策略。
- 补充输入：`userInput/requested`／`userInput/request` 同理，回答走 `userInput/answer`（单选映射到选项 label，多选与自由文本按 Muse 声明字段回传），无回答时走 `userInput/cancel`。
- 取消：`turn/cancel` 只针对本轮自己启动的 `turnId`；没有 `session/close`，结束时关闭 stdin 让 Muse 自行 drain 后退出。
- 工作目录：Windows 上通常把 Muse 装在 WSL2 里，用 `wsl.exe` 作为启动命令；**工作区**字段填 Muse 在 Linux 内看到的路径，`workspaceRoot` 用它，未填则用项目目录。
- 限制：Muse 的会话编号不跨重启保存，也不注入 CodeNode 工具（不走 MCP relay）；附件目前只支持内联图片，其他类型会明确拒绝。工作区改动仍保留在所选项目中，由 CodeNode 独立核对文件差异与验收结果。

## 验收

离线：`npm run test:backend-port`、`test:backends`、`test:multi-backends`、`test:muse-backend`、`test:acp-full` 和 `test:backend-workflow`。双主题与设置持久化：`test:backend-ui`。

显式真实模型验收：`test:goal-auto-live`（OpenCode 自动推进）、`test:backend-live`（Codex ACP）、`test:backend-live-deepseek`（DeepSeek ACP）、`test:backend-live-agents`／`test:backend-live-workflow`（`--backends=` 可选 Qwen Code、Qoder、MiniMax Code、Kimi Code、CodeBuddy、Claude Code、Pi 等已安装后端）及 `test:backend-live-openclaw`；要求已有 Agent 和凭据，可能产生模型用量，不进入离线 CI。

参考：[qwen-audio-agent 后端接入](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/overview.md)、[各后台详细配置](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/configuration.zh.md)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)。本机 OpenCode 的真实模型路径已验证，缺少本机 codex-acp/dsh 不会被标记为实测通过。
