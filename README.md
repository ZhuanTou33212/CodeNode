# CodeNode Desktop

CodeNode 是一个 **Java 21 / Swing 原生桌面节点工作台**：用可视化节点编排 AI 生成代码、分析项目结构，并通过本地申请槽 / 内嵌 Agent 与 AI 协作。运行链路不使用 HTML、浏览器、Electron 或 WebView。

```
桌面节点画布 → 项目 .codenode/queue → 本地 Skill / Codex App Server / 内嵌 Agent
            → .codenode/results → 代码槽审查
```

---

## 功能特性

### 画布与节点
- 节点拖拽、端口连线（方向/重复/类型校验，`any` 自适应、整数→数值兼容）、框选、多选、复制粘贴、撤销重做。
- 组（GROUP）、范围（SCOPE）、条件/计算节点、文件节点、资产节点与**资源组（ASSET_BUNDLE）**。
- 端口类型编辑器：任意增删输入/输出端口、命名、数据类型与必需标记。
- 节点标题按分类配色，同时显示分类与状态文字。

### 工程格式（`.cnode` 1.1）
- UTF-8 ZIP 容器（`mimetype` 首条目），含 `manifest / graph / workspace / output-profiles / integrity`（SHA-256）。
- 文件菜单：新建 / 打开 / 保存 / 另存为；已保存工程每 15 分钟自动保存，异常可从 `.codenode/recovery` 恢复。
- 未知字段忽略、缺失字段默认值、`有值才写`；1.0 兼容编辑、更高版本只读打开。详见 [CNODE_FORMAT.md](CNODE_FORMAT.md)。

### 项目全量解析（自动成图，符合项目结构）
- `ProjectScanner` 递归扫描源码与资产 → `ProjectGraphBuilder` **资产按目录聚为 ASSET_BUNDLE 资源组、源码按 package 归入 GROUP** → `AutoLayout` 拓扑分层布局。
- 资源组使用 **v2 bundleData**（`schemaVersion=2`，含 `memberCount / categoryStats / members[]`、sha256 前缀成员 id、crc32 校验和）。
- 画布上资源组显示成员数/分类徽章/成员预览，双击收起/展开，完整展开按 `members[]` 直接生成资产节点并按迁移规则更新下游连线；旧 v1 文件自动降级展示。

### 内嵌 Agent（工作台标签页）
- 与「节点图」「代码审查」并列的 **「内嵌 Agent」** 标签页，opencode 风格对话 UI（`❯` 输入、Enter 发送、彩色消息、推理折叠区、停止按钮）。
- 接入 **OpenAI 兼容 API**（默认 DeepSeek），支持 **双模型切换**（`deepseek-v4-flash` / `deepseek-v4-pro`，pro 为推理模型，带 `reasoning_content`）。
- 多轮流式对话，会话历史维护；配置存本地 `config/agent.properties`（**api_key 仅本地，不入库不提交**）。
- **25 个本地工具**，Agent 可按需调用：

| 类别 | 工具 |
|------|------|
| 工作台 | `get_workbench_model` · `create_nodes` · `workbench_edit` · `workbench_connect` · `workbench_structure` |
| 项目 | `scan_project`（`applyToWorkbench` 落画布）· `save_project` |
| 工程构建运行 | `project_info`（识别构建系统/入口类/JDK）· `build_project`（Gradle/Maven/纯javac）· `run_project`（可 JFR 实时追踪）· `list_tasks` |
| 文件 | `read_file` · `write_file` · `edit_file` · `find_files` · `search_files` · `list_directory` |
| 其他 | `execute_shell`（白名单+超时强杀）· `code_review` · `ask_user` · `fetch_url` · `compile_run` · `runtime_trace` · `write_analysis_md` · `ui_control` |

- 高危工具（`write_file` / `edit_file` / `execute_shell`）执行前弹确认框并写审计日志；`ask_user` 可向用户提问澄清。

### 申请与结果
- 本地申请槽（`.codenode/queue`）+ 结果轮询（`.codenode/results`）；错误映射回节点标红，输出面板显示文件/行/列。
- 工具栏 Agent 支持「本地申请槽」与「Codex 自动」（`codex app-server` stdio 协议，线程化多轮会话）。
- 独立 JAR 提供受限 `--mcp <projectRoot>` 模式，仅可读申请、写待审查结果。

---

## 开发运行

```powershell
# 设置 JDK（本机可用版本示例）
$env:JAVA_HOME = "E:\CodeNode\tools\jdk-21.0.12+8"

.\mvnw.cmd test          # 运行全部测试（含 Stage4.5 自检 Stage45Test）
.\mvnw.cmd package       # 打包
java -jar .\target\codenode-desktop.jar
```

## 独立程序镜像

```powershell
.\scripts\package-app.ps1 -JavaHome "E:\CodeNode\tools\jdk-21.0.12+8"
```

入口为 `dist\CodeNodeDesktop\CodeNodeDesktop.exe`，自带裁剪后的 Java 运行时。Windows 双击关联安装包由 `scripts/package-installer.ps1` 生成（需 WiX Toolset 3）。

---

## 内嵌 Agent 配置

1. 复制 `config/agent.properties.example` 为 `config/agent.properties`。
2. 填写 `api_base` / `api_key`（也可在应用内「内嵌 Agent → 设置」填写并保存）。
3. 顶部模型下拉可在 `models` 列出的模型间切换（默认双模型 `deepseek-v4-flash` / `deepseek-v4-pro`）。

Harness 组件也由同一份配置装配：`harness.components` 控制组件类别，`tools.sources` 控制内置/MCP 工具源，`harness.prompt_sections` 控制系统提示分段及顺序，`harness.compactor` 控制压缩策略，`harness.storage` 控制会话存储，`harness.loop` 控制 agent loop policy，`harness.listeners` 控制 trace 等监听器，`harness.plan_check_interval=0` 可关闭规划检查。完整示例见 `config/agent.properties.example`；修改后重启 Agent 会话生效。第三方 JAR 可实现 `HarnessExtension` 并通过 `META-INF/services/local.codenode.agent.components.HarnessExtension` 注册，启动时自动挂载。

> **安全**：`api_key` 仅存本地 `config/agent.properties`，该文件已被 `.gitignore` 排除，禁止提交到仓库。

---

## 使用

1. 选择项目目录并初始化本地申请槽。
2. 选择「代码工作流」或「Markdown 蓝图」，编排节点并填写 Prompt。
3. 提交选择的节点或组输出；结果进入代码审查，接受后成为活动代码。
4. 或在「内嵌 Agent」标签直接对话：让它**扫描项目并写入工作台**（`scan_project` 的 `applyToWorkbench`），它会按项目结构（资产=资源组、源码=包组）生成节点图；也能创建/编辑/连线节点、搜索/改文件、审查代码。

## 节点编辑快捷键

- `Shift+A`：节点库；`Shift+W`：快捷菜单；`Shift+D` 复制；`Delete`/`X` 删除；`Ctrl+X` 删除并重连。
- `Ctrl+S` 保存、`Ctrl+A` 全选、框选/加选/减选、滚轮缩放、`Z` 聚焦、`Ctrl+C/V/Z/Y` 复制粘贴/撤销重做。
- `G`：Blender 风格移动；`Ctrl+右键` 切断连线；`Ctrl+Shift+右键` / `Alt+右键` 插入整理点。
- `H` 折叠、`M` 详细模式、`N` 静音、`Home` 查看全部。
- 右侧「节点资源管理器」编辑端口；输出/错误/申请队列窗口可收起、浮动、重停靠。

---

## 项目结构

```
src/main/java/local/codenode/         桌面程序源码（Swing）
├── MainFrame / CanvasPanel           主窗口 / 画布
├── WorkflowModel                     工作流数据模型（节点/端口/代码槽/文件空间）
├── CnodeProjectCodec / CnodeRecoveryService   .cnode 编解码与恢复
├── ProjectScanner / ProjectGraphBuilder / AutoLayout   项目全量解析与自动成图
├── QueueService / ResultService      本地申请槽与结果轮询
├── CodexAppServerProvider / AgentProvider / AppServerMessages   Agent 会话链路
├── config/AgentConfig                Agent 本地配置
├── ui/agent + ui/settings            内嵌 Agent 对话 UI 与设置
└── agent/tools + agent/tools/impl    工具注册表与 25 个内置工具
src/main/java/local/codenode/project  JavaProject/JdkManager/BuildRunner/RunLauncher/TraceCollector（工程构建运行与实时追踪）
src/main/resources/schemas/           cnode-project-1.1.schema.json
src/test/java/local/codenode/         JUnit 测试（含 Stage45Test）
scripts/                              打包与安装脚本
```

## 测试

```powershell
.\mvnw.cmd test
```

包含工作流模型、编解码、队列/结果、项目分析、Stage3/4 回归与 Stage4.5 自检（`Stage45Test`：资源组 v2、AgentConfig、工具注册表与工具行为）。
