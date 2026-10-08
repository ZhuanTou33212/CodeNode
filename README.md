# CodeNode

**把本地代码工程、Agent 对话和可视化工作流放在同一个桌面窗口。**

CodeNode 是一个基于 Electron、React 和 React Flow 的本地开发工作台。Agent 在桌面主进程中读取、检索和修改项目文件，画布负责组织任务与依赖，运行记录、工具结果和恢复计划都可以在界面中核对。

项目工程保存在 `.cnode` 文件中；源代码仍保留在你选择的项目目录。CodeNode 的桌面主进程负责文件、工具、模型和运行状态，单独打开网页不能替代桌面应用。

[快速开始](#快速开始) · [单 Agent 架构](#单-agent-架构) · [多 Agent 协作](#多-agent-协作) · [工作流与检索](#工作流与检索) · [开发与验证](#开发与验证)

![CodeNode Agent 对话与画布](docs/screenshots/agent-chat.png)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 面向工程的 Agent | 读取、检索、编辑项目文件，执行获准的工具和命令，并展示调用过程。 |
| 单 Agent ReAct 运行 | 以一次 Run 为边界处理模型响应、工具调用、审批、取消、失败和预算终止。 |
| 可恢复的运行记录 | 保存事件、检查点和副作用账本；中断后区分可续跑步骤与需要复核的外部操作。 |
| 可视化工作流 | 用 `start`、`task`、`stage`、`tool`、`scope` 等节点组织任务和依赖。 |
| 多 Agent 分工 | 主 Agent 可委派探查、实现、验证和审查任务；结果经核对后才能传给下游。 |
| 流式回复 | SSE 增量逐字呈现，可在常规设置中开关和调速；保存完整回复，严格核验规则继续生效。 |
| 可选项目检索 | 本地词法与结构检索源码和文档；向量检索、重排与严格答案校验按场景显式启用。 |
| 多模型接入 | 支持 OpenAI 兼容、Anthropic、Gemini、Azure 等端点及本地服务。 |

## 快速开始

需要 **Node.js 22.12 或更新版本**以及可运行 Electron 的桌面环境；CI 使用 `.nvmrc` 指定的 22 系列。

```powershell
git clone --branch yimi-branch https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` 会同时启动 Vite 和 Electron。已打包的 Windows 桌面版可直接运行 `release/win-unpacked/CodeNode.exe`。

根目录保留构建与协作入口，品牌资源归入 `assets/branding`。

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

在空白画布按 **Shift+A** 添加节点，最小可运行链路是 `start → task → end`。选中节点填写目标，再从节点端口连线；顶部“运行”打开底部面板，在“连续执行”页启动工作流。“数据流”只计算节点输入和输出。

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

开发与验证入口见[参与开发](CONTRIBUTING.md)和[脚本目录](scripts/README.md)。

### Agent 后端

在 **设置 → 常规 → Agent 后端** 选择 CodeNode 内置执行器或 Codex app-server。配置可保存为本机默认或当前项目覆盖，项目也可恢复跟随本机。默认使用内置执行器，已有模型配置和工具行为沿用原逻辑。

Codex 首版兼容经本机 schema 核对的 `0.135.0`、`0.160.0` 协议版本；依次自动查找 PATH 原生程序、桌面版自带运行时及 npm 安装的原生程序，也可指定可执行文件绝对路径。“检测已保存后端”会检查真实协议握手与账户状态；登录信息仍由本机 Codex 管理，握手成功不能代替模型可访问性验证。Codex 模型留空时使用其本机配置，工作目录固定为所选项目。默认只读，允许修改项目文件需在设置中选择；后端审批只对当前请求有效，中断等待真实终态，连接丢失与中断未确认会标记结果未知。

对话与画布文件任务共用这个入口。运行记录保存后端、协议、线程、执行、目录和权限；从运行列表恢复时先复核副作用并查询原执行状态，原执行仍在运行或状态无法核实时阻止重复启动。外部后端提供的补丁和独立扫描获得的文件内容指纹可在文件变更卡片中查看，代码修改复用本地独立校验。

首版外部后端未接入 CodeNode 画布修改工具、子 Agent、图片与 `/compact`；这些功能使用内置执行器。Codex 的权限与工具机制负责外部执行边界，CodeNode 工具注册表不拦截其全部操作；网络默认关闭，用户批准的命令仍需按显示范围审阅。外部用量按线程累计差额统计，费用显示未知，不承诺 CodeNode 的逐请求硬费用限制或自动副作用回滚。

离线协议与画布闭环：`npm run test:backends`、`npm run test:backend-workflow`；主题与持久化：`npm run test:backend-ui`；使用本机 Codex 登录执行真实只读任务：`npm run test:backend-live`（需要模型服务可访问，不进入离线 CI）。协议依据 [OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server) 和本机版本导出的 JSON Schema。

## 许可证

[MIT](LICENSE)
