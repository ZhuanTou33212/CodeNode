# CodeNode

CodeNode 是一个面向本地工程的桌面 Agent 工作台：用对话让 Agent 读写项目，用节点画布编排工作流，并在同一处查看工具调用、运行记录和恢复计划。桌面端由 Electron、React 和 React Flow 构成。

## 架构图

### 单 Agent：ReAct 状态与恢复

![单 Agent ReAct 运行状态与恢复](docs/architecture/single-agent-react-state.png)

模型提出工具调用后，运行从 `RUNNING` 进入 `WAITING_TOOL`；工具结果写回对话，再回到 `RUNNING`。需要确认时进入 `WAITING_USER`；回答完成、出错、取消和达到上限各有明确终态。旧 Run 的检查点与副作用记录决定能否安全续跑。

### 多 Agent：委派、隔离与结果确认

![多 Agent 协作调度与结果确认](docs/architecture/multi-agent-collaboration.png)

主 Agent 通过 `delegate_task / delegate_tasks` 分工；每个子 Agent 都有自己的 ReAct 循环、角色权限和任务上下文。只读任务可按规则并行，共享写任务独占。子 Agent 的结果先是候选，主 Agent 核对确认后才传给依赖它的任务。

> 图中的 **ACTIVE 是活动态分组，不是代码状态**。画布上的 `stage` 节点也不等于立即启动子 Agent。实现细节见 [架构说明](docs/architecture/README.md)。

## 快速开始

需要 Node.js **22** 和桌面环境：

```powershell
git clone --branch yimi-branch https://github.com/ZhuanTou33212/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

`npm run dev` 同时启动 Vite 和 Electron；只打开网页无法使用工程文件和 Agent。Windows 也可双击 `启动项目.bat`。使用构建版可运行 `npm run start:prod`。

## 5 分钟上手

1. 启动页选“新建工程”“打开工程”或“打开工程文件”；已有工程也可从“最近打开”手动进入。
2. 左侧 **Agent** 页打开模型下拉框 →“管理模型…”→“+ 新增模型”，填写模型 ID、API 地址和 API Key，保存并设为当前模型。
3. 输入任务并按 **Enter** 发送；**Shift+Enter** 换行。运行中可“插话”纠偏或“停止”；写入与外部操作按提示确认。
4. 编排画布时按 **Shift+A** 添加节点，连成 `start → task → end`；顶部“运行”打开底部面板，再点“运行工作流”。“数据流”只计算节点输入输出。
5. 点“保存”或按 **Ctrl+S** 保存 `.cnode`。任务中断时到“运行”页点“查看恢复计划”，按提示选择自动续跑或人工复核。

详细按钮、示例任务、多 Agent 分工与恢复操作见 [操作指南](docs/usage-guide.md)。

## 开发与文档

```powershell
npm run build       # 类型检查与构建
npm run check:js    # 主进程和脚本静态检查
npm run verify      # 完整门禁
npm run dist:win    # Windows 打包；macOS / Linux 对应 dist:mac / dist:linux
```

- [架构说明](docs/architecture/README.md)
- [操作指南](docs/usage-guide.md)
- [画布节点](docs/canvas-node.md)
- [模型协议](docs/model-protocol-multi-provider-2026-09-23.md)
- [发布流程](docs/release-process.md)
- [MIT License](LICENSE)
