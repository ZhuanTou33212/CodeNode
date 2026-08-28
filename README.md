# CodeNode Next

CodeNode 重构版：以 **DeepSeek Harness（DSH）** 为目标的 Agent 工作台。

> 当前里程碑：**Agentic RAG**。采用 Electron + React + React Flow 重构原 Java/Swing 版本，
> 保留节点画布操作逻辑（Blender 风格），并将节点语义改为「Agent 工作流可视化」。
> 完整重构方案见 `REFACTOR_PLAN_DSH.md`（在仓库 `codenodeNew` 分支历史/工作区）。

## 技术栈

```
桌面壳      Electron（主进程 Node.js + 内嵌 Chromium，无外部浏览器）
前端        React 18 + TypeScript + Vite
画布        React Flow（@xyflow/react）+ zustand
工程格式    .cnode（ZIP 容器 + mimetype + manifest/graph/workspace/integrity + SHA-256）
```

## 功能特性

### 画布（Blender 风格操作）
- 鼠标中键 / 右键拖动画布，左键框选，滚轮缩放
- `Shift+A` 光标处弹出节点菜单（入口 / 出口 / 任务 / 阶段 / 工具 / 范围 / 文件 / 对象）
- 节点拖拽、端口连线（右侧拖出 → 左侧，箭头 + 动画）
- **端口规则**：`start`（入口）只有输出端口、没有输入端口；`end`（出口）只有输入端口、没有输出端口
- **对象节点**（`object`）：专门用于表示/存储对象名称（数据对象、配置对象、实体名），对象名称填在 `objectName` 字段
- 快捷键：`Ctrl+Z/Y` 撤销重做、`Ctrl+D` 复制、`Del`/`X` 删除、`Home`/`Z` 聚焦全部、`Escape` 关闭菜单
- 节点状态（待执行 / 执行中 / 已完成 / 失败 / 阻塞）实时着色

### 工程文件（专属 `.cnode` 格式，参考原版 .cnode）
- UTF-8 ZIP 容器，`mimetype` 首条目：`application/vnd.codenode.project+zip`
- 条目：`mimetype` / `manifest.json` / `graph.json` / `workspace.json` / `integrity.json`
- `integrity.json` 记录各文件 SHA-256，打开时校验完整性（篡改会提示）
- 宽松读取：未知字段忽略、缺失字段默认值、更高版本只读打开
- 保存确定性写入当前工程文件；重启自动恢复上次工程
- 格式 Schema：`src/resources/schemas/cnode-project-1.0.schema.json`

### 项目管理器（左栏，Unity 风格）
- 选择项目目录 → 递归文件树（忽略 node_modules/.git/dist 等），点击文件预览内容
- 面板可收起 / 拖拽调宽；`.cnode` 工程文件在树中高亮

### 工程工作台（底部 Dock）
- 代码编辑器：项目文件可直接编辑、保存，覆盖前自动生成 `.bak` 备份
- Diff：逐行显示未保存修改；搜索：按项目内容返回文件与行号结果
- 编辑器支持多文件标签、基础语法着色、Tab 缩进、基础问题诊断/补全和外部修改冲突处理
- 终端：在项目根目录执行跨平台白名单命令，可运行构建、测试与 Git 操作
- 终端采用主进程流式会话，支持实时输出、停止和超时终止
- 工作流运行：按画布 DAG 拓扑连续推进节点；Prompt 以 `run:` 或 `$` 开头时执行真实命令
- 工作流节点：task/stage/tool 有 Prompt 时调用 Agent，无命令或 Agent 配置时明确阻塞；失败/停止后可从 run-state 继续
- 检查点：工作流运行前后自动保存到 `.cnode`，同时保留最近 30 个本地项目检查点
- 长期记忆：Agent 可用 `remember` / `recall` 管理项目 `.codenode/memory.json`
- 扩展：内置工具、项目进程扩展、MCP stdio JSON-RPC、Skills 上下文和 before/after Hooks 统一接入

项目扩展清单示例：

```json
{
  "extensions": [
    {
      "name": "project_lint",
      "kind": "Skills",
      "description": "运行项目自定义检查",
      "command": "node scripts/project-lint.cjs",
      "parameters": { "type": "object", "properties": {} }
    }
  ]
}
```

扩展进程的参数同时会通过 `CODENODE_TOOL_ARGS` 环境变量传入；写入型扩展仍会经过确认、审计和项目根目录隔离。MCP 扩展使用 `tools` 数组声明可调用工具，Skills 使用 `instructions` 字段注入项目上下文，Hooks 使用 `hooks.before` / `hooks.after`。

### 检查器（右上角悬浮角标）
- 默认显示悬浮角标（节点数 / 选中提示），点击展开为检查器浮层，可编辑节点名称 / 状态 / 目标说明

### Agentic RAG（本地项目检索）
- Agent 可把主问题、符号名、业务词和技术词作为多个查询，一次完成 RRF 融合排序
- 本地增量索引复用未变化分块；文件工具写入后显式失效，外部变化由 mtime 自动发现
- BM25 + 路径/短语/覆盖率排序 + 可插拔向量层（默认 local 确定性哈希向量，可切 openai/ollama），覆盖源码符号、自然语言与中文，无需向量数据库或云服务
- `retrieve_context` 支持 `mode=auto/file/vector/hybrid/scalar`：scalar 模式走本地标量精确查询，vector/hybrid 把向量余弦分融合进排序
- 返回高/中/低可信度、查询覆盖率、候选规模与 `path#Lx-Ly` 来源锚点
- 低可信度会驱动 Agent 改写查询、限定目录或深读文件，不会强行把弱结果当答案
- 检索片段被标记为不可信数据，项目文件内的提示注入不会被当作 Agent 指令
- 默认硬排除 `.env`、SSH/证书密钥、凭据、`.codenode` 记录、依赖与构建产物
- `rag.include` / `rag.exclude` 可配置范围，其他 `rag.*` 控制分块、Top-K、查询数、质量门槛与向量层（`rag.embed_provider/dim/model/base/key/top_k/vector_weight`）

### 本地标量（画布精准数据，不入云）
- 画布节点的完整属性（name/label/prompt/goal/members/filePath 等）在画布工具执行时写入工程 `.codenode/scalars.json`，不随工具结果返回云端
- Agent 需要精准数据时用 `query_scalars key=node:<id>`（或 `retrieve_context mode=scalar`）在本地读取
- 标量来源以 `scalar:<key>` 引用；`.codenode` 目录被 RAG 硬排除，标量不会泄漏进文件索引

### 工具结果子代理压缩
- 工具返回的原始结果超过阈值（默认 2400 字符）时，经一次独立 LLM 调用（子代理，不共享主对话上下文）压缩成关键信息摘要再进入上下文，避免大量数据挤压上下文
- 压缩保留文件路径/行号引用、符号名、错误信息、状态与节点 id；`retrieve_context`/`query_scalars`/`ask_user` 默认不压缩以保证引用保真
- 单轮压缩调用数、目标长度、排除列表由 `agent.compression.*` 配置控制；失败自动降级为截断

### Agent 节点建模规则（写入系统提示 + workbench_edit 工具，创建节点时强制遵守）
- 一条完整节点链路必须有 `start`（开始，只有输出端口）与 `end`（结束，只有输入端口），且**必须真正连线成链**：start 连线到第一个执行节点、最后一个执行节点连线到 end，使 start/end 作为链路入口/出口而非游离节点
- 条件判断 / 分支 / 重复循环 → 用 `scope`（范围）节点包裹，并**必须把子链路节点 id 加入 scope 的 `members`**（`add_members`/`set_members`，或 create 时传 `members`），否则节点不会显示在范围节点内
- 需要子代理负责部分工作（文件探查、项目审核、独立分析、测试执行等）→ 用 `stage`（阶段）节点
- 需要使用某个对象（数据对象 / 配置对象 / 实体名）→ 用 `object`（对象）节点，名称填 `objectName`
- 节点类型按语义选择，禁止一律建 task；创建前先 `get_workbench_model` 读取当前画布并复用已有节点（画布为空时不读取）
- `workbench_edit` 的 `create` 支持**自定义 id**（如 `id:"start-1"`），同一批 operations 内即可用该 id 连线或放进 scope
- 收到需求先做「需求拆分」：对象 → object、独立工作 → stage、条件/循环 → scope（并加入 members）、具体步骤 → task/tool，最后 start 开头、end 结尾连成完整链路
- 所有画布操作（新建 / 连线 / 移动 / 删除 / 放进范围节点 / 改名设属性）都由 Agent 通过 `workbench_edit` 执行，不能只停留在文字描述

### 节点颜色 / 排布 / 范围节点
- **颜色按类型判定**：start 绿、end 红、task 蓝、stage 紫、tool 橙、file 橙红、object 青、scope 紫；Agent 建节点自动按类型上色，渲染端缺失 accent 时也按类型回退，用户与 Agent 节点颜色一致
- **自动整理（Blender Node Arrange 风格）**：先按连通分量分块，块内按依赖分层为列、列内按前驱重心排序，互不关联的分量各自成块；`scope` 与其成员视为同一分量，成员会按实际包围盒被范围节点包裹（成员在左/上时也会向左/上扩展）
- **Agent 输出排布**：Agent 改图后改用分块自动整理（而非全部排成一排），并按制作顺序分区；新建节点未给坐标时自动错位，不再全部堆在 (120,120)（修复重启后节点聚到画面中心）
- **范围节点**：有输入/输出端口，可参与链路连线；显示子节点数量；拖动 scope 时其成员跟随移动（父级容器）

### 画布节点读写一致性
- `get_workbench_model` 不在只读缓存内，任何时刻都读实时画布模型
- 变更类工具（`workbench_edit`/`create_nodes`/`workbench_connect`/`bulk_edit`/`write_file`/`edit_file`/`save_project`/`ui_control` 等）执行成功后自动清空只读结果缓存，避免「写入成功但读到旧数据/0 节点」
- `query_scalars`/`retrieve_context` 的 `prefix=node:<部分id>` 在严格前缀无命中时，会按「同类型 key 的 id 是否包含该片段」回退，命中 `node:<type>-<部分id>-<rand>`
- **链路完整性**：`workbench_edit` 会在结果中提示「不在 start→end 完整路径上的节点」，驱动 Agent 补全连线

### 长任务执行（后台 + 轮询）与工具失败处理
- `execute_shell` 支持 `async=true`：长任务后台执行，**立即返回 jobId**，不再前台硬等；`timeoutSeconds` 可按预估时长调大（默认 30）
- 新增 `poll_job jobId=… waitSeconds=…`：轮询后台任务状态（running/done/error/timeout）、已输出内容与退出码，任务结束自动清理
- 核心原则：**工具失败 ≠ 任务失败**。任何 error 先做三件事：①分析原因 ②修正参数或换工具 ③重试，直到成功或确实无路可走
- 失败分类：参数错→修正重调；文件/节点/路径不存在→先探查（`list_directory`/`find_files`/`get_workbench_model`/`query_scalars`）再重试；命令不在白名单→换等价命令；执行超时→调大 `timeoutSeconds` 或 `async=true`+`poll_job`

### 画布与会话解耦（独立工作系统）
- 画布不再与每条新对话绑定：Agent 每一轮都读取**当前画布**内容
- **就地修改**：Agent 在当前画布上做了修改（保留了画布已有节点）时，直接应用到当前画布，不新开画布；修改后当前画布保持 active
- **新开画布**：仅发生在「用户手动新建」或「Agent 输出了与当前画布完全无关的全新内容 / 当前画布为空时创建内容」两种情况
- **空画布不读取**：当前画布没有任何节点时，Agent 不调用 `get_workbench_model`，直接按需求创建完整链路；画布有节点时先读取现状再修改/补充
- 跨会话持久：下一次对话仍读取同一块画布，节点不会因新对话丢失

## 开发运行

```powershell
# 需要 Node.js 18+（本项目自带 tool/node，见工作区）
npm install          # 安装依赖
npm run dev          # 开发模式（Vite HMR + Electron）
npm run build        # 类型检查 + 构建到 dist/
npm start            # 生产模式（加载 dist/）
npm start:prod       # 先构建再启动
```

> 国内网络建议保留 `.npmrc`（npmmirror 源 + Electron 镜像）。

### 打包 + 控制台面板（cmd 一起打开）
```powershell
npm run dist        # 构建 + 打包 portable exe + 生成「CodeNode 控制台.cmd」
npm run dist:mac    # macOS DMG + ZIP（需要桌面发行环境；CI 会自动使用项目级缓存）
npm run dist:linux  # Linux AppImage + deb
```
- 打包后在 `release/` 与 `release/win-unpacked/` 生成 **`CodeNode 控制台.cmd`**。
- **桌面快捷方式指向该 .cmd**（而不是直接指向 exe），双击即可同时打开：
  - CodeNode 应用本体；
  - 一个 cmd 控制台面板，实时跟随显示应用日志（`<exe 目录>/logs/console.log`）。
- 日志由主进程 `setupConsoleLog()` 写入（`electron/main.cjs`），打包 exe 无附着控制台也能留痕。
- 如已打包但缺启动器，可单独运行 `npm run launcher` 重新生成。

### 撤销/重做（Ctrl+Z / Ctrl+Y）
- 撤销只记录**节点操作**：移动、连线、断连、删除、复制、新增、检查器中的编辑。
- 画布级操作（Ctrl+L 横排 / Ctrl+Shift+A 自动整理、聚焦视图）**不写入撤销历史**。
- 编辑字段聚焦时记录一次快照，编辑过程本身是单步可撤销。

## 项目结构

```
electron/           Electron 主进程 / 预加载 / .cnode 编解码
src/
  components/       画布、项目管理器、检查器、工具栏、状态栏、添加菜单
  lib/              项目生命周期（新建/打开/保存）
  nodes/            画布节点类型与模板
  resources/schemas/.cnode 格式 JSON Schema
  store/            zustand：图模型 / 项目 / UI 状态
  types.ts          节点数据类型
scripts/            冒烟测试
```

## 测试

```powershell
# DOM 冒烟（加载 dist/，校验画布/面板/控件；无 GUI 的 CI 会明确跳过）
npm run test:smoke
# 主进程自检（验证 preload + IPC + .cnode 保存/加载/完整性）
$env:CODENODE_TEST=1; node_modules\electron\dist\electron.exe .
# Agentic RAG 端到端测试（多查询融合、质量诊断、范围策略、安全排除、显式/自动刷新）
node scripts/rag-test.cjs
# 引用白名单与提示注入防护规则测试
node scripts/rag-grounding-test.cjs
# 标量库 / 可插拔向量 / 子代理压缩 端到端测试
node scripts/scalar-vector-test.cjs
# 画布节点读写一致性（缓存失效）回归测试
node scripts/cache-consistency-test.cjs
# 画布-会话解耦（就地修改 vs 新开画布 / 不复活已删节点）回归测试
node scripts/session-canvas-test.cjs
# workbench_edit 建模能力（scope members / 自定义 id / start-end 连线）回归测试
node scripts/workbench-model-test.cjs
# 自动整理（连通分量分块 / scope 包裹）回归测试
node scripts/arrange-test.cjs
# 长任务后台执行 + poll_job 轮询 回归测试
node scripts/background-job-test.cjs
# 构建后验证来源校验徽标渲染
npm run test:rag-ui
```

## 路线图

- [x] 基础画布 + 基础 UI + `.cnode` 专属格式
- [x] Agent 引擎 + 工具循环 + 本地 Agentic RAG
- [x] 长期记忆（remember / recall）
- [x] 节点 = Agent 工作流：进度 / 顺序 / 结果摘要可视化
- [x] Agent 通过工具控制画布（创建 / 连线 / 推进状态）
- [x] 打包分发配置（electron-builder）与 `.cnode` 文件关联；实际签名/发布由 CI 或发行机执行
