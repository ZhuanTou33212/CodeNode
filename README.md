# CodeNode

**把本地代码工程、Agent 对话和可视化工作流放在同一个桌面窗口。**

CodeNode 使用 Electron、React 和 React Flow 构建。你可以让 Agent 查找、阅读和修改项目文件，在画布上拆解并运行任务，并从工具记录、运行事件和恢复计划中核对实际发生了什么。工程保存在 `.cnode` 文件中；源代码仍保留在你选择的项目目录。

[快速开始](#快速开始) · [工作方式](#工作方式) · [多-agent-协作](#多-agent-协作) · [运行与恢复](#运行与恢复) · [开发与验证](#开发与验证)

![CodeNode Agent 对话与画布](docs/screenshots/agent-chat.png)

## CodeNode 能做什么

| 能力 | 在工作台中的用法 |
| --- | --- |
| 面向工程的 Agent | 读取、检索、编辑项目文件，执行获准的工具与命令，并展示调用过程。 |
| 可视化工作流 | 用 `start`、`task`、`stage`、`tool`、`scope` 等节点组织步骤和依赖，在画布中运行或继续工作流。 |
| 多 Agent 分工 | 主 Agent 按任务委派探查、实现、验证和审查；子任务按角色约束工具权限，结果需核对后才能传给下游。 |
| 项目上下文 | 检索项目文件和画布标量；可按配置使用本地索引、向量检索及外部检索能力。 |
| 可检查的运行记录 | 查看工具结果、Run 事件与检查点；中断后根据副作用记录选择自动续跑或人工复核。 |
| 多模型接入 | 在界面中配置 OpenAI 兼容、Anthropic、Gemini、Azure 等端点及本地服务。 |

## 快速开始

需要 **Node.js 22 或更新版本**及可运行 Electron 的桌面环境。

```powershell
git clone --branch yimi-branch https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` 会同时启动 Vite 和 Electron。CodeNode 的工程文件、工具和 Agent 依赖桌面主进程，单独打开网页并不能代替桌面应用。Windows 也可以双击仓库中的 `启动项目.bat`。

构建后运行桌面版：

```powershell
npm run start:prod
```

### 第一次使用

1. 在启动页选择**新建工程**、**打开工程**或**打开工程文件**；已有 `.cnode` 文件也可直接打开。
2. 在左侧 **Agent → 管理模型… → + 新增模型**中填写模型 ID、API 地址和 API Key，保存并设为当前模型。
3. 先试一个只读任务，例如：“找到项目入口文件，说明启动流程，并给出文件路径”。按 **Enter** 发送，**Shift+Enter** 换行。
4. 需要修改时说明范围和验收条件；查看工具调用与结果，按界面提示处理需要确认的操作。运行中可“插话”或“停止”。
5. 用 **Ctrl+S** 保存 `.cnode` 工程。任务中断后，在底部“运行”页查看恢复计划。

更完整的按钮路径和示例见[操作指南](docs/usage-guide.md)。

## 工作方式

**对话任务**由 Agent 依据当前项目和可用工具执行；**画布工作流**按节点连线组织执行顺序。二者可以在同一工作台中使用，但画一个 `stage` 节点不会立即启动子 Agent；聊天中的委派由主 Agent 调用 `delegate_task` 或 `delegate_tasks` 发起。

在空白画布按 **Shift+A** 添加节点，最小可运行链路是 `start → task → end`。选中节点填写目标，再从节点端口连线；顶部“运行”打开底部面板，在“连续执行”页启动工作流。“数据流”只计算节点输入和输出。节点类型与规则见[画布节点说明](docs/canvas-node.md)。

![CodeNode 工作流画布](docs/screenshots/codenode-canvas.png)

## 多 Agent 协作

主 Agent 自己运行 ReAct 循环，并在适合独立处理的多步任务中委派子 Agent。每个子 Agent 有自己的提示词、消息历史、角色权限、时限和预算；默认有界 FIFO 调度器最多同时运行 **3** 个子任务。安全只读任务可以并行，共享工作区写任务独占。

![多 Agent 协作调度与结果确认](docs/architecture/multi-agent-collaboration.png)

[查看可缩放 SVG](docs/architecture/multi-agent-collaboration.svg) · [架构与实现说明](docs/architecture/README.md)

| 角色 | 职责 | 边界 |
| --- | --- | --- |
| `explorer` | 定位文件、符号和证据 | 只读，不修改文件或运行命令 |
| `builder` | 在任务范围内实施修改 | 写操作受权限与确认策略约束 |
| `verifier` | 运行测试、构建和检查 | 不修改被测源码 |
| `reviewer` | 独立审查实现与边界情况 | 只读，不代替实现角色修复 |
| `canvas` | 修改和保存画布 | 不写项目源码文件 |

子 Agent 的回答先是**候选结果**。主 Agent 可读取任务信封、核对来源和产物，必要时让 `verifier` 独立复跑；只有经过确认且仍有效的摘要，才会通过 `dependsOnTaskIds` 传给下游。`merge_subagent_results` 汇总的是候选声明，不会合并 Git 代码。

修改项目文件时可选择 `isolation: "worktree"`，让子任务在独立 Git 工作树中执行。隔离改动不会自动进入主工作树：先用 `inspect_merge` 预览文件、分支版本和内容指纹，再确认 `merge`。主工作树须保持干净；发生冲突时工具会尝试回退合并并保留隔离分支。该模式要求项目是 Git 仓库，且不适用于 `canvas` 角色。操作步骤见[多 Agent 指南](docs/usage-guide.md#让多个-agent-分工)。

## 运行与恢复

单次 Agent Run 从 `RUNNING` 开始：模型要求调用工具时进入 `WAITING_TOOL`，工具结果写回对话后继续运行；等待审批或工具提问时进入 `WAITING_USER`。最终答复、系统错误、用户取消和预算触顶分别对应 `COMPLETED`、`FAILED`、`CANCELLED`、`LIMIT_REACHED`。

![单 Agent ReAct 运行状态与恢复](docs/architecture/single-agent-react-state.png)

图中的 **ACTIVE 是活动态分组，不是额外的代码状态**。普通工具失败通常会交还模型处理；观察汇总是工具循环的内部步骤，不代替原始工具记录。

中断后，CodeNode 根据 Run 事件、检查点和副作用账本生成恢复计划：安全的待办步骤可以自动续跑，结果未知的写入或外部操作需要人工复核。继续时创建新 Run，旧 Run 保留原状态。详见[架构说明](docs/architecture/README.md)和[恢复操作](docs/usage-guide.md#中断后继续)。

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
| `electron/tools/`、`electron/subagents.cjs` | 工具权限、确认、子代理委派与结果核对 |
| `electron/runStore.cjs`、`electron/runCheckpoint.cjs` | 运行事件、检查点和恢复计划 |
| `docs/` | 操作、架构、模型协议和发布说明 |

更多资料：[模型协议](docs/model-protocol-multi-provider-2026-09-23.md) · [项目检索](docs/agentic-rag-scalar-vector.md) · [发布流程](docs/release-process.md)

## 许可证

[MIT](LICENSE)
