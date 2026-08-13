# CodeNode Desktop 已实现功能清单（Stage 0 → 4.9）

> 生成时间：2026-08-12
> 基准：`codenode-desktop` 工作树（HEAD `cfac752`，Stage4.9 + Agent 执行时间线），含当前未提交改动
> 验证：`mvnw test` **148 项全部通过**（25 个测试套件）；pom/打包版本 `0.1.5`，应用分支 `0.16`
> 说明：本清单核对"文档规划"与"代码实际实现"，区分【已实现】【部分实现】【仅方案】

---

## 一、阶段总览

| 阶段 | 主题 | 状态 |
|------|------|------|
| Stage 0 | Codex 插件骨架 / 双工作模式 / 原生桌面 + 本地申请槽 | ✅ 已实现 |
| Stage 1 | 可视化画布 / 节点检查器 / 端口配置 / 停靠工具窗口 | ✅ 已实现 |
| Stage 2 | 范围/条件/计算节点、代码槽、组输出、协议 4.0、Agent Provider | ✅ 已实现（主体） |
| Stage 4.3 | 资源组 ASSET_BUNDLE v2 bundleData | ✅ 已实现 |
| Stage 4.5 | 全量扫描成组 + 内嵌 Agent + harness | ✅ 已实现 |
| Stage 4.6 | Agent 长上下文 + 工具稳定 + 画布读取 + 组紧凑布局 | ✅ 已实现 |
| Stage 6 | 固定文件分析 + 文件类型解析指引 + harness/工具设置 | ✅ 已实现 |
| Stage 4.7 | 实时运行追踪（工程构建运行 + JFR 追踪） | ✅ JFR 外部采样与解析已验证 |
| Stage 4.8 | 文件浏览器 + 多文档 tab + 右侧面板可拖拽 + 工程构建运行 | ◑ 主体完成，调试/打包/测试运行器仍待补 |
| Stage 4.9 | Agent 权限、动态上下文、.cnode 会话/长期知识、UI 控制、工具取消与状态时间线 | ◑ 主体完成；分层知识图谱、长期记忆与多项目隔离已完成，子代理/任务清单/多对话窗口待后续 |

---

## 二、画布与节点（已实现）

- 节点拖拽、端口连线（方向/重复/类型校验，`any` 自适应、整数→数值兼容）、框选、多选、复制粘贴、撤销重做
- 组（GROUP）、范围（SCOPE）、条件/计算节点、文件节点、资产节点与**资源组 ASSET_BUNDLE（v2 bundleData：schemaVersion=2、memberCount、categoryStats、members[] 含 crc32/sha256）**
- 端口类型编辑器：任意增删输入/输出端口、命名、数据类型、必需标记
- 节点标题按分类配色，同时显示分类与状态文字；组紧凑布局（280×150）
- 范围/条件/计算节点规范（`.cnode` 1.1：nodeKind、valueType、operation、scope.regions[]、conditionPortId）
- 节点检查器可编辑：名称、提示词、内嵌代码、端口数量/名称/类型、语言；删除端口联动删边

---

## 三、工程格式与持久化（已实现）

- `.cnode` UTF-8 ZIP 容器（mimetype 首条目），含 manifest/graph/workspace/output-profiles/integrity（SHA-256）
- 文件菜单：新建/打开/保存/另存为；每 15 分钟自动保存；异常从 `.codenode/recovery` 恢复
- 未知字段忽略、缺失字段默认值、`有值才写`；1.0 兼容编辑、更高版本只读打开
- `workspace.json.selection.nodeIds` 多选顺序保存

---

## 四、项目全量解析与自动成图（已实现）

- `ProjectScanner`：递归扫描源码与资产，忽略缓存/构建目录
- `ProjectGraphBuilder`：资产按目录聚为资源组、源码按 package 归入 GROUP
- `AutoLayout`：拓扑分层布局；`HierarchyLayout`：嵌套组递归布局
- `DirectoryGraphBuilder`：目录→组、资产叶子目录→资源组、文件→FILE/ASSET 带相对路径
- 资源组解组（`ungroupAssetBundleToGroup`）、批量建边（`connectNoRecompute`）、O(1) 节点索引（`nodeIndex`）
- `ScanDiagnostics`：分环节诊断 + 看门狗，卡死写 HANG 报告（`.codenode/full-scan-diag.log`）

---

## 五、内嵌 Agent（已实现主体）

### 5.1 对话与配置
- 内嵌 Agent 标签页（opencode 风格：`❯` 输入、Enter 发送、彩色消息、推理折叠区、停止按钮）
- OpenAI 兼容 API（默认 DeepSeek），双模型切换（flash / pro，pro 带 reasoning_content）
- 多轮流式会话、会话历史维护；配置存本地 `config/agent.properties`（api_key 仅本地）

### 5.2 短期记忆（Stage4.6，已实现）
- 滑动窗口（发送前 system + 最近 20 条 + 历史摘要占位）
- 消息 > 阈值触发摘要（模型摘要，失败回退本地规则摘要）

### 5.3 项目长期知识（Stage4.9，已实现）
- `TextSummarizer`：离线提取标题、摘要、关键词、代码实体与文件/URL 引用
- `ConversationGraphParser`：按标题、段落、编号项和代码块拆分长文本，生成分层 `parent(child...)` DSL
- `KnowledgeGraph`：严格父子层级、循环/多父校验、关键词查询、遍历与定位
- `graph_root/query/traverse/path/summarize` 已注册为 Agent 工具；参数由 JSON Schema 在执行前校验
- `.cnode` 保存 `knowledge-graph.dsl` / `knowledge-meta.json` 并纳入 integrity；重启后从 DSL 恢复
- 文档标签独立持有 `AgentContext + KnowledgeGraph`，切换时快照/恢复，防止跨项目串记忆
- 会话持久化到 `.codenode/agent-sessions/<sessionId>.json`；新建/继续会话
- 工具结果截断到 4000 字符

### 5.3 工具调度稳定性（已实现）
- tool_calls 配对校验、单工具异常兜底不中断
- 失败/空结果自动注入"重新思考"提示并继续（上限 5 次）
- **工具执行带超时保护**（独立线程，默认 60s，长耗时工具 300s，可自设 timeoutSeconds 上限 600s）
- 强制总结：执行过工具后补一轮"请总结"确保最终答案
- 答案兜底：最后一条仅推理无正文时，自动提取推理作为正式答案

### 5.4 确认与权限（已实现）
- 分级确认 `ConfirmationLevel`（LOW/WRITE/HIGH）：项目内常规操作直接放行，仅敏感操作（删除/git 危险命令/跨目录/超范围）确认
- 确认文案用**自然语言解释在做什么**（非代码字符串）
- 写文件自动备份 `.bak` + 审计日志；execute_shell 白名单 + 超时强杀

### 5.5 文件变更预览（已实现，Opencode 式）
- 「文件变更」面板替换原错误列表栏位：Agent 写/改文件后显示增删改记录
- git 工程显示 `git status --short` + `git diff --stat`
- 错误报告与运行报告合并进「输出与运行报告」面板

### 5.6 25 个工具
| 类别 | 工具 |
|------|------|
| 工作台 | get_workbench_model / create_nodes / workbench_edit / workbench_connect / workbench_structure |
| 项目 | scan_project（applyToWorkbench 落画布）/ save_project |
| 工程构建运行 | project_info / build_project / run_project（可 JFR 追踪）/ list_tasks |
| 文件 | read_file / write_file / edit_file / find_files / search_files / list_directory |
| 其他 | execute_shell / code_review / ask_user / fetch_url / compile_run / runtime_trace / write_analysis_md / ui_control |

### 5.7 文件分析（Stage6，已实现）
- `FileTypeDetector`：magic bytes 校验（PNG/.class/ZIP/PDF 等 26 种）+ 文本/二进制判定
- `FileContentAnalyzer`：analyzeFile 统一入口（二进制拒绝/大文件截断/YAML-MD-properties 摘要），Java 类/函数/变量/imports 提取
- read_file 读前类型检测，二进制拒绝给解析建议；analyze=true 结构化摘要
- AgentConfig：tools.enabled/disabled、read_file.max_lines、file_analysis.max_lines、harness.extra_prompt

---

## 六、工程构建运行（4.7/4.8，部分实现）

### 6.1 工程模型与构建（已实现）
- `JavaProject`：识别 Gradle/Maven/纯 Java、源集、模块、main 入口扫描、MC 模组识别（Forge/Fabric/NeoForge）
- `JdkManager`：扫描 JAVA_HOME/常见路径/~/.codenode/jdks，读 release 版本
- `ToolLocator`：统一工具目录（默认 `E:\CodeNode\tools`，CODENODE_TOOLS 可覆盖）优先取 JDK/Gradle/Maven/javac
- `BuildRunner`：Gradle/Maven/纯 javac 三路构建，流式日志 + `文件:行:列` 错误定位 + 超时强杀
- `ProcessRunner`：子进程底层 + PATH 探测 + ~/.gradle 发行版兜底

### 6.2 运行与追踪（部分实现）
- `RunConfig` + `RunLauncher`：入口类/JAR/Gradle 任务/Maven 目标；非阻塞 `launch()` 长驻进程 + 手动停止
- 运行任务下拉：`gradle tasks --all` 收集 runClient/runServer 等（含模块前缀，默认主工程 runClient）
- `TraceCollector`：JFR 记录解析（方法采样 Top），jdk.jfr 缺模块时优雅降级
- 运行前自动编译（缺产物时先 javac）

### 6.3 工具目录部署（已完成）
- Gradle 8.14.4 已装入 `E:\CodeNode\tools\gradle-8.14.4`（Forge 1.20.1 需要 8.x）
- 修复：工程缺 gradle-wrapper.jar 时自动改用工具目录发行版

### 6.4 待补（方案内未落地）
- 完整字节码插桩 Agent（4.7 方案 A）——目前仅 JFR 外部采样
- ArtifactBuilder（JAR 打包）、TestRunner、Debugger、CodeAssistant（4.8 方案未实施）

---

## 七、UI 与交互（已实现）

- 左侧文件浏览器（JTree 目录树，懒加载、双击导入画布+代码栏打开、拖拽生成节点）
- 多文档 tab（JTabbedPane）：新建/打开/关闭多个项目，启动空白
- 右侧面板分隔线可拖拽缩放（自定义 divider）
- 工具窗口：文件浏览器/节点资源管理器/输出与运行报告/文件变更/申请队列/工程构建运行，可收起/浮动/重停靠
- 停靠布局（LEFT/RIGHT/TOP/BOTTOM）、tab 分组、暗色主题（UiTheme）
- 节点快捷键体系（Shift+A 库、Shift+D 复制、H 折叠、M 静音、Z 聚焦、Ctrl+右键切连线等）
- 状态栏、进度条、最近打开、错误/运行报告合并

---

## 八、申请与结果（已实现）

- 本地申请槽 `.codenode/queue`（staging→inbox 原子移动）+ 结果轮询 `.codenode/results`
- 错误映射回节点标红，输出面板显示文件/行/列
- 工具栏 Agent：本地申请槽 / Codex 自动（codex app-server stdio，线程化多轮会话）
- 独立 JAR `--mcp` 受限模式（仅可读申请、写待审查结果）

---

## 九、仅方案（未实施）

| 文档 | 内容 | 状态 |
|------|------|------|
| `STAGE_4_9_OUTLINE.md` | Agent 全权限 UI 控制、软件信息注入 harness、.cnode 预留 agent-context.json/agent-info.json、权限分级+全局开关、状态栏活动指示、工具取消、参数化对话框、权限记忆、敏感过滤测试；**并入原 4.10**：分层知识图谱 DSL、对话内容解码器、精准摘要、长期记忆、多对话窗口、子代理、to_do_list、清理机制、测试标准 | 📋 方案（部分已先行：分级确认/超时/文件变更面板） |
| `STAGE_4_7_OUTLINE.md` | 实时运行追踪（字节码插桩 Agent/JFR 采样） | 📋 方案（JFR 部分已落地） |
| `STAGE_4_7_OUTLINE.md` | 实时运行追踪（字节码插桩 Agent/JFR 采样） | 📋 方案（JFR 部分已落地） |
| `STAGE_4_8_OUTLINE.md` | 完整 IntelliJ 式工程环境（打包/调试/测试/代码辅助/工程树） | 📋 方案（工程构建运行部分已落地） |

---

## 十、已知差异 / 待办

1. **版本号不一致**：pom `0.1.3`、git 提交"0.13"、应用自报/打包脚本 `0.5.0`——三处不一致，需统一
2. **游离编译产物**：根目录 `local/codenode/MainFrame.class` 未提交（验证残留）
3. **未提交改动**：工程构建运行（project 包 + 工具 + ProjectRunPanel/FileChangePanel + 测试）及 4.9 outline 均未提交
4. **4.7 字节码插桩**未做（仅 JFR 采样）
5. **4.8 打包/调试/测试运行器/代码辅助**未做
6. **4.9 全量 ui_control action**未做（当前 7 个基础 action）
7. **4.9 子代理/任务清单/同项目多对话窗口**未做；项目级会话隔离与长期图谱已完成
9. **存储与项目文件栏共享**：需核实是否为真 bug（Stage4.9 需求）
