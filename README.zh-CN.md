# CodeNode

**把本地代码工程、Agent 对话和可视化工作流放在同一个桌面窗口。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhuanTou33212/CodeNode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

CodeNode 是一个基于 Electron 和 React 的本地开发工作台。工作流画布由 HTML Canvas 绘制节点、连线与网格，React Flow 保留交互与坐标管理；Agent 在桌面主进程中读取、检索和修改项目文件，画布负责组织任务与依赖，运行记录、工具结果和恢复计划都可以在界面中核对。

项目工程保存在 `.cnode` 文件中；源代码仍保留在你选择的项目目录。CodeNode 的桌面主进程负责文件、工具、模型和运行状态，单独打开网页不能替代桌面应用。

![CodeNode Agent 对话与画布](docs/screenshots/agent-chat.png)

**项目状态：** 1.0 之前的活跃开发版本，目前为单人维护。运行时依赖刻意保持很小——React、Zustand 和 `@xyflow/react`。

[设计重点](#设计重点可审计可续跑) · [核心能力](#核心能力) · [快速开始](#快速开始) · [单 Agent 架构](#单-agent-架构) · [多 Agent 协作](#多-agent-协作) · [工作流与检索](#工作流与检索) · [开发与验证](#开发与验证) · [Agent 后端](#agent-后端) · [目标管理与节点删除](#目标管理与节点删除)

## 设计重点：可审计、可续跑

多数 Agent 项目追求能力上限，CodeNode 同时要求一次运行必须能挺过崩溃、取消或错误改动，并且不谎报结果：

- **每次工具调用都落检查点。** 副作用账本用规范参数的哈希作为写入的幂等键，作用域钉在**原 Run** 上：续跑会跳过已提交的写入，并拒绝盲目重放结果未知的操作（[electron/sideEffects.cjs](electron/sideEffects.cjs)、[electron/runCheckpoint.cjs](electron/runCheckpoint.cjs)）。
- **画布同样是持久化的。** 节点执行前必须先落盘为 `prepared`，并对图版本做一次比较交换（CAS），中断的画布运行可以被核对而不是被猜测（[electron/workflowState.cjs](electron/workflowState.cjs)）。
- **子 Agent 的回答是候选结果，不是事实。** 它声明的产物会在进入下游之前与磁盘重新比对哈希（[electron/subagentEnvelope.cjs](electron/subagentEnvelope.cjs)）。
- **目标靠会失效的证据完成。** 验收证据带来源指纹、提交和环境；文件或条件一变，证据即失效（[electron/goalStore.cjs](electron/goalStore.cjs)）。
- **模型无法给自己扩权。** 写工具被禁止改审批文件，审批是服务端签发、绑定能力／范围／工具调用的令牌（[electron/approvalRules.cjs](electron/approvalRules.cjs)）。
- **后端可替换。** CodeNode 自研循环与外部 Agent（Codex、DeepSeek Harness、Hermes、OpenCode、OpenClaw、自定义）都通过同一份 ACP／BackendPort 契约提交。

工作台还附带一整套离线回归套件，当前集合用 `npm run test:list` 查看；默认门禁不需要网络，也不需要显示环境。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 面向工程的 Agent | 读取、检索、编辑项目文件，执行获准的工具和命令，并展示调用过程。 |
| 单 Agent ReAct 运行 | 以一次 Run 为边界处理模型响应、工具调用、审批、取消、失败和预算终止。 |
| 可恢复的运行记录 | 保存事件、检查点和副作用账本；中断后区分可续跑步骤与需要复核的外部操作。 |
| 可视化工作流 | 用 `start`、`task`、`stage`、`tool`、`scope` 等节点组织任务和依赖。 |
| 多 Agent 分工 | 主 Agent 可委派探查、实现、验证和审查任务；结果经核对后才能传给下游。 |
| [兼容 Trellis](docs/trellis-compatibility.md) | 选择已有任务、加载 PRD 与规范，恢复任务/运行关联；支持预览与冲突检查后的状态/日志/规范写回，以及绑定真实角色动作的画布流程。 |
| 流式回复 | SSE 增量逐字呈现，可在常规设置中开关和调速；保存完整回复，严格核验规则继续生效。 |
| 可选项目检索 | 本地词法与结构检索源码和文档；向量检索、重排与严格答案校验按场景显式启用。 |
| 多模型接入 | 支持 OpenAI 兼容、Anthropic、Gemini、Azure 等端点及本地服务。 |

## 快速开始

需要 **Node.js 22.12 或更新版本**以及可运行 Electron 的桌面环境；CI 使用 `.nvmrc` 指定的 22 系列。

```powershell
git clone https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` 会同时启动 Vite 和 Electron。已打包的 Windows 桌面版可直接运行 `release/win-unpacked/CodeNode.exe`；macOS 与 Linux 的打包目标已配置（`npm run dist:mac`、`npm run dist:linux`），但目前未作为发行版发布。

构建后运行桌面版：

```powershell
npm run start:prod
```

### 第一次使用

1. 在启动页选择**新建工程**、**打开工程**或**打开工程文件**；已有 `.cnode` 文件也可以直接打开。
2. 在左侧 **Agent → 管理模型…**选择供应商，粘贴 API Key，点击**获取模型**，从返回列表选择模型并点击**连接并使用**。无需手填模型 ID、API 地址、上下文或价格。
3. 先试一个只读任务，例如：“找到项目入口文件，说明启动流程，并给出文件路径”。按 **Enter** 发送，**Shift+Enter** 换行。
4. 需要修改时说明范围和验收条件；查看工具调用与结果，按界面提示处理需要确认的操作。运行中可以插话或停止。
5. 使用 **Ctrl+S** 保存 `.cnode` 工程。任务中断后，在底部“运行”页查看恢复计划。

## 单 Agent 架构

默认编码流程为搜索符号或错误、读文件、修改、运行测试。`retrieve_context` 不常驻编码工具组，可通过 `discover_tools` 按需启用；本地检索不调用模型拆解 Query。`query_scalars` 是独立画布属性读取工具，不受 `rag.enabled` 影响。

普通文件读写和非删除画布编辑默认自动执行；高风险与工作树等操作保留审批。设置 → 常规可按项目切换普通工具自动执行。对话显示“已编辑 N 个文件”及可展开差异，重复编辑同一文件只计一次；推理、任务轨迹和原始工具记录保留在运行数据中。

在设置的「检索」页可按项目开关本地检索、向量扩展和严格答案校验。向量与严格校验默认关闭；SQLite 向量支持和 Milvus SDK 不随默认依赖安装，需要时自行安装扩展并重新打包。显式启用的模型服务仍会产生额外请求与耗时。

单 Agent 是 CodeNode 的基本执行单元。多 Agent 委派出来的每个子任务，内部也使用同一套 ReAct 循环；先理解单 Agent 的状态、工具边界和恢复方式，再看多 Agent 的调度关系。

**设置 → 成本与模型**可为探查、实现、验证、审查和画布角色分别选择已接入模型，默认跟随对话所选主模型。小任务准入规则在本地判断，单步普通操作与明确的单文件读取交回主 Agent，不启动子模型。设置中可查看按任务／角色归属的 token、缓存命中、重试和成本，以及运行完成和局部校验结果；缺失价格时显示未知，不把完成等同于正确。

重复只读结果默认按引用复用，前提是正文仍完整保留在当前上下文；压缩或裁剪后会检查引用是否失效，需要原文时再次提供正文。各角色可配置轮次、累计 token 和单次输出上限，默认继承；“轻量探查预设”提供 6 轮／60000 总 token／8192 输出 token 的可选预算，不自动限制复杂探查。

![单 Agent ReAct 运行状态与恢复](docs/architecture/single-agent-react-state.png)

一次 Agent Run 从 `RUNNING` 开始：

- 模型给出最终答复时进入 `COMPLETED`。
- 模型提出工具调用时，先完成流式参数拼接和结构校验，再进入 `WAITING_TOOL` 执行工具，并把结果写回对话后回到 `RUNNING`。
- 需要审批或向用户提问时进入 `WAITING_USER`。
- `FAILED`、`CANCELLED` 和 `LIMIT_REACHED` 是其他终态。

图中的 **ACTIVE** 只是为了阅读方便画出的活动态分组，不是代码里的额外状态。普通工具失败会作为工具结果交还模型判断；流损坏、运行错误、用户取消或预算触顶才按各自终止规则处理。可选的 Observation/Blackboard 会整理工具结果，但不替代原始工具记录。

### 运行安全与恢复

工具由注册表校验参数、能力和确认策略。写入、命令和外部网络能力按各自契约执行，并留下审计记录；有副作用的操作使用幂等账本，避免未知结果被盲目重放。

恢复由 Run 事件、检查点和副作用账本共同决定：

1. `planResume` 读取旧 Run 的事件和检查点。
2. 安全且结果明确的步骤可以自动续跑。
3. 结果未知的写入或外部操作进入人工复核。
4. 继续执行会创建新 Run，旧 Run 保留原状态和证据。

断流重试是整轮重发，不会把半截结果拼到新请求后面。连接重试与断流重发共用单次调用的 HTTP 请求上限；每次实际请求前都从本次 Run 的 token 预算预留输入和最大输出额度。配置入口见 `config/agent.properties.example`。

## 多 Agent 协作

多 Agent 建立在上面的单 Agent Run 之上。主 Agent 根据任务需要调用 `delegate_task` 或 `delegate_tasks`，为子任务分配独立提示词、对话、角色权限、时限和预算。

![多 Agent 协作调度与结果确认](docs/architecture/multi-agent-collaboration.png)

[查看可缩放 SVG](docs/architecture/multi-agent-collaboration.svg)

默认有界 FIFO 调度器最多同时运行 **4** 个子任务，并与模型请求队列共用一个全局并发值。安全只读任务可以并行，共享工作区写任务独占；选择 `isolation: "worktree"` 时，写任务在独立 Git 工作树中执行，画布角色不支持该模式。

每次运行默认累计最多启动 **24** 个子任务，单批最多 **8** 个；达到 **75%**（18/24）时，主 Agent 会收到剩余额度提示，优先收敛计划、验证和总结。失败或启动后取消仍计入额度，请求级瞬态重试使用独立的共享重试预算。以上选项在 **设置 → 常规 → 全局调度** 集中保存，跨项目、跨重启和昼夜主题共用；桌面与命令行读取同一份用户级 `$CODENODE_HOME/agent-scheduling.json`（默认 `~/.codenode/agent-scheduling.json`）。

整任务重做使用 `inspect_subagent_retry` 核对执行版本、依赖和补偿计划，再用 `retry_subagent_task` 显式执行。重做保留 `taskId`，每次生成递增 Attempt 和独立 `executionId`，默认单任务最多 **3** 次、每次运行最多 **72** 次（均含首次）。重做不增加逻辑任务数，但消耗尝试额度及真实请求预算；文件补偿需批准，后续修改、未知副作用或已合入代码会阻止重做。运行面板保留尝试记录。

| 角色 | 职责 | 边界 |
| --- | --- | --- |
| `explorer` | 定位文件、符号和证据 | 只读，不修改文件或运行命令 |
| `builder` | 在任务范围内实施修改 | 写操作受权限与确认策略约束 |
| `verifier` | 运行测试、构建和检查 | 不修改被测源码 |
| `reviewer` | 独立审查实现与边界情况 | 只读，不代替实现角色修复 |
| `canvas` | 修改和保存画布 | 不写项目源码文件 |

子 Agent 的回答先是**候选结果**。主 Agent 可以读取任务信封、核对来源和产物，必要时让 `verifier` 独立复跑；只有经过确认且仍有效的摘要，才会通过 `dependsOnTaskIds` 传给下游。`merge_subagent_results` 汇总的是候选声明，不会自动合并 Git 代码。

使用隔离工作树时，先用 `inspect_merge` 预览文件、分支版本和内容指纹，再确认 `merge`。冲突或版本漂移会阻断下游，主工作树不会自动回滚其他任务的改动。

## 工作流与检索

画布工作流按节点连线组织执行顺序；对话任务则由 Agent 根据当前项目和可用工具执行。两者可以在同一工作台中使用，但画一个 `stage` 节点不会自动启动子 Agent。

工作流图的可见图层使用 Canvas 2D；节点选择、拖拽、连线命中、缩放及键盘操作继续由透明的交互层处理。选中图像、对象、范围或内嵌矢量画布节点时，其编辑控件临时显示在图层上方。保存格式仍是节点与边的数据，不依赖屏幕像素。

在空白画布按 **Shift+A** 添加节点，最小可运行链路是 `start → task → end`。选中节点填写目标，再从节点端口连线；顶部“运行”打开底部面板，在“连续执行”页启动工作流。“数据流”只计算节点输入和输出。

在对话框输入 `/plan 任务目标`，CodeNode 会用内置规划模型只读生成步骤，并在当前画布中建立可编辑的任务节点与依赖连线；生成后由用户检查，点击“连续执行”才开始运行。已有 Agent `update_plan` 计划也可从计划卡点击“生成可编辑工作流”导入一次；之后对画布的修改不会被计划卡覆盖。

输入 `/goal 目标描述` 会打开目标表单，先补充至少一条可核对的验收条件并创建 Goal；CodeNode 随后自动生成待确认的任务图预览，确认后才写入 Goal。目标详情中的“任务图”直接展示 `.codenode/goals.json` 的 Task 与 `dependsOn`，也可手工增加、编辑和连线。节点详情可以选择本阶段负责的 Goal 验收条件：未绑定整体条件的中间任务只提交本阶段证据，最终验收任务承接整体条件。点击节点可看 Agent 留下的阶段总结及当前验收证据；只有未运行、无下游依赖的 Task 能删除，已有 Run 或证据的 Task 保留历史。点击“开始执行 Goal”会按 Goal 原有的准入、预算、写入范围、结算和证据规则逐个执行，遇到等待、失败、证据不足或需要人工复核即停止后续阶段。规划模型与执行时选择的 Agent 后端分别配置。

![CodeNode 工作流画布](docs/screenshots/codenode-canvas.png)

本地 Agentic RAG 为项目文件建立 BM25 索引，可选向量后端（默认进程内 `memory`；也可以配置 SQLite 或 Milvus）。检索命中只帮助定位，引用仍需对应本轮实际读取的来源。设置入口在底部工作台的“检索设置”页。

工程容器 `.cnode` 保存画布、会话、工作区和完整性信息；`.codenode/` 保存项目级运行记录、索引和标量数据。模型列表保存在 Electron 用户数据目录，API Key 需要系统安全存储可用。

## 开发与验证

```powershell
npm run build       # TypeScript 检查、Vite 构建和图标检查
npm run check:js    # Electron 主进程与脚本的 JS 类型检查
npm test            # 核心回归测试
npm run verify      # build + check:js + 核心测试
npm run dist:win    # Windows 打包；另有 dist:mac / dist:linux
```

| 位置 | 内容 |
| --- | --- |
| `src/` | React 界面、画布和状态管理 |
| `electron/agent.cjs`、`electron/agentState.cjs` | Agent 工具循环与 Run 状态机 |
| `electron/tools/`、`electron/subagents.cjs` | 工具权限、确认、子 Agent 委派与结果核对 |
| `electron/runStore.cjs`、`electron/runCheckpoint.cjs` | 运行事件、检查点和恢复计划 |
| `docs/` | 最新设计建议、架构图片和评测数据 |

开发与验证入口见[参与开发](CONTRIBUTING.zh-CN.md)和[脚本目录](scripts/README.zh-CN.md)，CI 与门禁规则写在同样的文件里。

### Agent 后端

在 **对话栏顶部 → Chat／Agent 名称** 选择执行器：选中只是预览，点击“确认切换”才保存；切换保留同一条对话、消息、输入草稿和画布，下条消息由新 Agent 接手。运行或切换期间禁用入口。Agent 菜单只用于切换，不再放重复的连接设置入口；菜单以勾选标记当前 Agent；缺少本机启动命令或未配置的条目置灰显示“不可用”，只做命令探测、不发模型请求；完整连接仍在设置中检测。连接路径、参数、认证和 MCP 仍在 **设置 → Agent 连接** 中配置，可选择 CodeNode（自研 Agent）、Codex ACP、DeepSeek Harness ACP、Hermes、OpenCode、OpenClaw 或自定义 ACP Agent。所有外部后端统一走 ACP v1 stdio；界面、画布工作流和 Goal 自动推进使用同一条执行链。快捷切换有项目时只保存当前项目，未选择项目时保存本机默认。每个 Agent 的连接配置分别记住，切回时恢复已有命令、参数、模型和 ACP 设置；高级设置中仍可调整配置范围，项目可跟随本机设置。

| 后端 | 已安装的启动命令 | 默认参数 |
| --- | --- | --- |
| Codex | `codex-acp` | 空；需要已有 Codex CLI 和本机登录 |
| DeepSeek Harness | `dsh` | `--profile acp`；可选已有 `DSH_HOME` |
| Hermes | `hermes` | `acp` |
| OpenCode | `opencode` | `acp` |
| OpenClaw | `openclaw` | `acp`；需要可用 Gateway |
| 自定义 ACP | 用户填写现有命令或绝对路径 | 用户填写 JSON 参数数组 |

CodeNode 不下载 Agent、不使用 npx 自动安装。启动命令从 PATH/Windows npm global 解析，支持本机可执行文件及 npm JS/native shim；不拼接 shell 命令。模型留空跟随 Agent 原生配置，认证、Skills 与原生工具由 Agent 自身管理。Windows 手动系统代理在没有显式代理环境变量时仅注入本轮子进程；不改系统或账户设置。

后端统一契约参考 [qwen-audio-agent BackendPort](https://github.com/QwenAudio/qwen-audio-agent/blob/main/server/src/backend/backend-port.mjs)：

- `describe`：身份、传输与能力；`start`：幂等准备连接，不发送模型 prompt；`health`：当前可用性。
- `submit`：提交一个 Task；`status`：运行时或 owner 范围内的 Task 状态；`cancel`：取消指定 Task。
- `respondAuthorization`／`respondInput`：回复当前 Task/owner 对应的待处理请求，拒绝跨 Task/owner、未知或重复回复。
- `subscribe`：订阅带 Task/owner 的 message/state/activity/authorization/input/artifact 事件；`close`：幂等释放连接与待处理请求。

内置执行器也通过 BackendPort 提交，内部继续使用 CodeNode 模型与工具循环。ACP 客户端共用初始化、会话创建/加载/恢复、文本及多媒体 prompt、权限、取消、配置和错误处理。后台调用实际使用上述契约，原 Codex app-server 与 DeepSeek SDK JSON-RPC 适配器已删除。

“检测当前配置”只验证当前命令和参数的 ACP 初始化，不写入设置或发模型请求。旧默认 `codex`／已保存的 Codex CLI 路径改为适配器命令，DeepSeek 的旧 `--profile sdk` 改为 `--profile acp`，保存后持久化为设置版本 2；其他自定义命令保留，需要用户确认它支持 ACP。旧 app-server/SDK Run 保留历史，但不能通过 ACP 恢复原线程。请复核旧 Run 和项目差异后新建 ACP 会话；不会静默转换会话 ID 或重放副作用。

界面对话与 ACP 内部会话分别管理。显式切换 Agent 会在项目 backend.json 持久化对话绑定与切换代次，不重建界面对话；同一切换代次续用精确 ACP session ID，跨 Agent 或切换回来时使用新内部会话，并把可见历史与当前画布作为上下文交接。切到 CodeNode 直接走自研模型循环，后续不会被旧外部会话接管。隔离 Task 新建内部会话。结果未知时必须复核后显式恢复。Run 保存协议、会话、权限、状态、事件和项目文件指纹；代码修改必须通过独立本地校验。`max_tokens` 等非完成终态记为失败，不能充当完成证据。Goal admission、预算、写入范围、重启未知状态及验收证据规则继续生效。

所有外部后端共用 **ACP 权限请求策略**：只读拒绝扩权请求，写入逐次询问。客户端文件读写在项目边界内运行，提交前检查文件指纹、编辑器草稿和 Task 写入范围；终端复用本地沙箱策略。Agent 原生工具不由 CodeNode 全面拦截，ACP 权限不等于操作系统隔离，外部用量/费用可能未知。

在 **ACP 会话配置** 持久化 `authMethodId`、`modeId`、`configValues`、`mcpServers` 和 `codeNodeTools`。“读取 ACP 可选项”查询实际可用值，认证和控制按 Agent 声明能力执行。图片、音频、资源发送前检查能力；未知客户端方法返回 `-32601`。form elicitation 支持结构化字段回复，单个字符串字段可直接输入文本；URL 认证或交互式终端登录由 Agent 自身处理。需要 CodeNode 画布与项目工具时，可显式启用本轮 MCP relay，复用现有角色、能力、范围、审批和取消门禁。

离线验收：`npm run test:backend-port`、`test:backends`、`test:multi-backends`、`test:acp-full` 和 `test:backend-workflow`。双主题与设置持久化：`test:backend-ui`。显式真实模型验收：`test:goal-auto-live`（OpenCode 自动推进）、`test:backend-live`（Codex ACP）、`test:backend-live-deepseek`（DeepSeek ACP）及 `test:backend-live-workflow`（隔离源码任务）；要求已有 Agent 和凭据，可能产生模型用量，不进入离线 CI。

参考：[qwen-audio-agent 后端接入](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/backends/overview.md)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)。本机 OpenCode 的真实模型路径已验证，缺少本机 codex-acp/dsh 不会被标记为实测通过。

### 目标管理与节点删除

工作台顶部 **总览／对话** 按钮切换两张独立页面。总览采用简短项目简报、待处理事项与单列目标列表；无目标时不显示统计卡或常驻表单，点击新建或目标条目后才打开编辑窗口；对话页保留画布与聊天，仅在绑定任务时显示简短目标提示。两页都保持挂载，来回切换保留消息、输入草稿、画布、模型和未保存的目标表单。当前页面持久化于共用 UI 配置，也可在设置 → 常规 → 默认工作台调整。

删除整个节点：点击节点标题或边框后按 Delete／Backspace／X；Ctrl+Z 撤销。节点内部有图形选中时，Delete 只删图形；点击内部空白且只选中外层节点时，Delete 删除整节点。删完图形会清理外层选区，避免连续按键误删整节点；输入框与目标管理控件聚焦时不会删除画布节点。底部状态栏显示实际多选数量和当前删除对象；新增、加载、撤销和重做会同步视觉选区与实际选区。

[夜间效果](docs/validation/simple-overview-preview/dark.png) · [日间效果](docs/validation/simple-overview-preview/light.png)。`npm run test:workspace-ux-ui` 使用实际鼠标与键盘事件验证上述行为；打包验收证据见 [acceptance.json](docs/validation/workspace-ux-preview/acceptance.json)。

## 许可证

[MIT](LICENSE)
