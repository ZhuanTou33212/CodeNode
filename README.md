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
| 可选项目检索 | 本地词法与结构检索源码和文档；向量检索、重排与严格答案校验按场景显式启用。 |
| 多模型接入 | 支持 OpenAI 兼容、Anthropic、Gemini、Azure 等端点及本地服务。 |

## 快速开始

需要 **Node.js 22 或更新版本**以及可运行 Electron 的桌面环境。

```powershell
git clone --branch yimi-branch https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` 会同时启动 Vite 和 Electron。Windows 也可以双击仓库中的 `启动项目.bat`。

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

更完整的按钮路径和示例见[操作指南](docs/usage-guide.md)。

## 单 Agent 架构

默认编码流程为搜索符号或错误、读文件、修改、运行测试。`retrieve_context` 不常驻编码工具组，可通过 `discover_tools` 按需启用；本地检索不调用模型拆解 Query。`query_scalars` 是独立画布属性读取工具，不受 `rag.enabled` 影响。

普通文件读写和非删除画布编辑默认自动执行；高风险与工作树等操作保留审批。设置 → 常规可按项目切换普通工具自动执行。对话显示“已编辑 N 个文件”及可展开差异，重复编辑同一文件只计一次；推理、任务轨迹和原始工具记录保留在运行数据中。

在设置的「检索」页可按项目开关本地检索、向量扩展和严格答案校验。向量与严格校验默认关闭；SQLite 向量支持和 Milvus SDK 不随默认依赖安装，需要时自行安装扩展并重新打包。显式启用的模型服务仍会产生额外请求与耗时。

单 Agent 是 CodeNode 的基本执行单元。多 Agent 委派出来的每个子任务，内部也使用同一套 ReAct 循环；先理解单 Agent 的状态、工具边界和恢复方式，再看多 Agent 的调度关系。

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

[查看可缩放 SVG](docs/architecture/multi-agent-collaboration.svg) · [架构与实现说明](docs/architecture/README.md)

默认有界 FIFO 调度器最多同时运行 **3** 个子任务。安全只读任务可以并行，共享工作区写任务独占；选择 `isolation: "worktree"` 时，写任务在独立 Git 工作树中执行，画布角色不支持该模式。

| 角色 | 职责 | 边界 |
| --- | --- | --- |
| `explorer` | 定位文件、符号和证据 | 只读，不修改文件或运行命令 |
| `builder` | 在任务范围内实施修改 | 写操作受权限与确认策略约束 |
| `verifier` | 运行测试、构建和检查 | 不修改被测源码 |
| `reviewer` | 独立审查实现与边界情况 | 只读，不代替实现角色修复 |
| `canvas` | 修改和保存画布 | 不写项目源码文件 |

子 Agent 的回答先是**候选结果**。主 Agent 可以读取任务信封、核对来源和产物，必要时让 `verifier` 独立复跑；只有经过确认且仍有效的摘要，才会通过 `dependsOnTaskIds` 传给下游。`merge_subagent_results` 汇总的是候选声明，不会自动合并 Git 代码。

使用隔离工作树时，先用 `inspect_merge` 预览文件、分支版本和内容指纹，再确认 `merge`。冲突或版本漂移会阻断下游，主工作树不会自动回滚其他任务的改动。操作步骤见[多 Agent 指南](docs/usage-guide.md#让多个-agent-分工)。

## 工作流与检索

画布工作流按节点连线组织执行顺序；对话任务则由 Agent 根据当前项目和可用工具执行。两者可以在同一工作台中使用，但画一个 `stage` 节点不会自动启动子 Agent。

在空白画布按 **Shift+A** 添加节点，最小可运行链路是 `start → task → end`。选中节点填写目标，再从节点端口连线；顶部“运行”打开底部面板，在“连续执行”页启动工作流。“数据流”只计算节点输入和输出。节点类型与规则见[画布节点说明](docs/canvas-node.md)。

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
| `docs/` | 操作、架构、模型协议和发布说明 |

更多资料：[模型协议](docs/model-protocol-multi-provider-2026-09-23.md) · [项目检索](docs/agentic-rag-scalar-vector.md) · [发布流程](docs/release-process.md) · [生产能力补齐记录](docs/production-gap-roadmap.md) · [模型路由说明](docs/model-routing.md)

## 许可证

[MIT](LICENSE)
