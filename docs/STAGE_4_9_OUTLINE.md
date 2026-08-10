# Stage 4.9 设计方案：Agent 全权限操控 + 软件上下文注入 + 知识图谱/长期记忆 + .cnode 预留空间

> 状态：**设计方案（仅规划，未实施）**
> 关联：Stage4.6（Agent 短期记忆/工具调度）、Stage4.7/4.8（工程构建运行）
> 参考：Obsidian（双向链接/Wiki）、Codegraph（代码知识图谱）、openai/codex（Memento 压缩）、xAI/grok-build（分段压缩+记忆系统）
> 目标：让内嵌 Agent 掌握软件完整信息、获得对软件（含 UI）的最高权限控制，在 .cnode 预留持久化空间，并建立知识图谱 + 长期记忆，让 AI 快速定位文本、重启后仍能回忆；补齐子代理、任务清单与多对话窗口
> 说明：本大纲已并入原 Stage4.10 全部内容（分层知识图谱、精准摘要、长期记忆、多对话窗口、子代理、任务清单、测试标准）；已确认概念：DSL 解码器面向**对话内容**（非画布），画布只作辅助信息来源，复用并扩展现有 WorkflowDslService

---

## 〇、需求总览

1. **harness 动态注入软件信息**：版本/模式/项目/画布统计/JDK/Gradle/工具清单/图谱概览
2. **.cnode 预留持久化空间**：`agent-context.json`（会话上下文 ≤100万字）+ `agent-info.json`（软件只读快照）+ `knowledge-graph.dsl` / `knowledge-meta.json`（知识图谱）
3. **最高权限 + 全量 UI 控制**：ui_control 全量 action、权限分级、全局开关
4. **分层知识图谱（Obsidian 式）**：元素只连下一层、DSL 解码器面向对话内容、Agent DSL 工具精确定位
5. **精准摘要引擎**：关键词提炼 + 元数据，构建长期文本记忆
6. **长期记忆 + 清理机制**：重启回忆、三层记忆、临时缓存生命周期清理
7. **补齐**：子代理、to_do_list、多对话窗口
8. **补充需求**：状态栏活动指示、工具取消、参数化对话框、权限记忆、敏感过滤测试
9. **存储/项目共享文件栏 bug**：核实并修正

---

## 一、问题现状

| 现状 | 缺陷 |
|------|------|
| harness 系统提示只列出工具名与静态规则 | Agent 不知道软件版本、当前模式、当前项目路径、画布节点数、可用 JDK/Gradle 等**运行时信息**，只能靠逐个工具去猜 |
| `ui_control` 仅支持 7 个动作（view_all/focus/zoom/pan/resize/toggle_panel/new_content） | 无法操控**标签页切换、菜单、工具窗口停靠、新建/打开/保存工程、运行配置、构建运行面板**等，Agent 对软件的操控非常有限 |
| `.cnode` 只有 manifest/graph/workspace/output-profiles/integrity 五块 | **没有**会话上下文、软件信息、知识图谱持久化空间，Agent 重启后丢失对工程的认知 |
| 无权限分级 | 无法显式授予 Agent"最高权限"，只能受限于每个工具各自的确认逻辑 |
| 对话只存内存 + 临时文件 | 无长期记忆，重启即忘 |
| 无知识图谱/检索 | Agent 定位内容靠全盘扫描，耗时长、token 多 |

---

## 二、总体方案

```
┌─────────────────────────────────────────────────────────────┐
│ ① harness 动态注入软件信息 + 图谱概览（每次对话请求时生成）       │
│    版本/模式/项目路径/画布统计/JDK/Gradle/工具清单/根元素/摘要    │
├─────────────────────────────────────────────────────────────┤
│ ② .cnode 预留空间                                             │
│    ├─ agent-context.json   ← 会话上下文（≤1,000,000 字）      │
│    ├─ agent-info.json      ← 软件基本信息（只读快照）          │
│    ├─ knowledge-graph.dsl  ← 知识图谱 DSL 原文                 │
│    └─ knowledge-meta.json  ← 图谱结构化元数据（临时缓存）       │
├─────────────────────────────────────────────────────────────┤
│ ③ 最高权限：Agent 获得完整 UI 控制                            │
│    ├─ ui_control 扩展为全量 action（标签页/菜单/停靠/工程/运行）│
│    ├─ 权限分级：普通/高风险/全局开关                            │
│    └─ MainFrame 接线 agentUiAction 全量实现                   │
├─────────────────────────────────────────────────────────────┤
│ ④ 分层知识图谱 + 精准摘要 + 长期记忆                            │
│    ├─ ConversationGraphParser（对话内容 → DSL + 摘要/关键词）  │
│    ├─ TextSummarizer（规则 + 模型两级摘要）                    │
│    ├─ MemoryStore（三层记忆 + 清理机制）                       │
│    └─ graph_* 工具（精确定位）                                 │
├─────────────────────────────────────────────────────────────┤
│ ⑤ 多对话窗口 + 子代理 + 任务清单                                │
│    ├─ AgentSessionManager（同项目多开）                        │
│    ├─ SubagentManager + subagent_* 工具                      │
│    └─ TaskManager + todo_* 工具                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、① harness 动态注入软件信息

### 3.1 信息采集器 `AgentInfoSnapshot`

新增 `local.codenode.agent.AgentInfoSnapshot`，每次 `sendMessage` 时从 MainFrame 拉取实时快照，生成纯文本注入系统提示：

```
【软件信息】（生成于 <时间>）
- 版本: CodeNode Desktop 0.5.0  |  格式版本: cnode 1.1
- 当前模式: Markdown 请求模式  |  语言: java
- 当前工程: E:\...\xxx  (或 未设置)
- 已打开文档: 2 个  |  当前文档: xxx.cnode (只读/可编辑)
- 画布统计: 120 节点 / 45 边 / 3 组 / 2 资源组
- 已选节点: 1 个 (id=xxx)
- 工具总数: 25  |  JDK: 21.0.12 (E:\CodeNode\tools\jdk-21.0.12+8)
- Gradle: 8.14.4 (工具目录)  |  Maven: apache-maven-3.9.10
- 图谱: 根元素 [a,b,c]  |  元素总数 12  |  关键词索引 40
- 可用 UI 动作: view_all, focus, zoom, pan, resize, toggle_panel, switch_tab, open_project, save_project, run_project, ...
```

### 3.2 采集源（MainFrame 提供）

```java
public interface SoftwareInfoProvider {
    Map<String, Object> softwareInfo();    // 版本/模式/文档/画布统计
    Map<String, Object> environmentInfo(); // JDK/Gradle/Maven/工具目录
    Map<String, Object> graphOverview();   // 图谱根元素/元素数/关键词索引（来自 KnowledgeGraph）
}
```

MainFrame 实现并注入 `AgentToolContext`。AgentChatController 在 `systemPrompt()` 末尾拼接该文本（每次请求都是新的，反映实时状态）。

### 3.3 优点
- 零额外 API 调用（本地拼装）
- Agent 首次决策就具备完整上下文，减少无意义的 `project_info` / `get_workbench_model` / `graph_query` 探测
- 敏感信息（api_key 等）**绝不进入**快照

---

## 四、② .cnode 预留空间

### 4.1 设计原则
- **向后兼容**：`REQUIRED` 集合不变；新条目为**可选**，旧版本读到未知条目按"未知字段忽略"处理，新版本读到缺失条目按默认值处理。
- **完整性校验**：加入 `integrity.json` 的 SHA-256 计算，防篡改。
- **大小上限**：`agent-context.json` 单条目上限 **1,000,000 字符**（约 2 MB UTF-8），超出按滚动窗口裁剪；`agent-info.json` 上限 256 KB；`knowledge-meta.json` 上限 1 MB。

### 4.2 新增条目

**`agent-context.json`**（会话上下文，可读写、随工程保存）
```json
{
  "schemaVersion": 1,
  "sessionId": "uuid",
  "summary": "早期会话摘要（滑动窗口压缩后保留）",
  "lastUpdated": "2026-08-09T...",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "...", "reasoning": "..." },
    { "role": "tool", "tool_call_id": "...", "content": "..." }
  ],
  "maxChars": 1000000,
  "truncated": false
}
```
- 编码：`CnodeProjectCodec` 增加 `encodeAgentContext/decodeAgentContext`
- 交互：AgentChatController 的 `saveSessionFile`/`loadSessionFile` 改读/写此条目（替换当前 `.codenode/agent-sessions/` 目录方案，或二者并存）
- 裁剪：超过 1M 字符时，用现有 `compactHistory` 逻辑压缩早期消息、保留窗口

**`agent-info.json`**（软件基本信息快照，只读）
```json
{
  "schemaVersion": 1,
  "generator": "CodeNode Desktop 0.5.0",
  "formatVersion": "cnode 1.1",
  "capturedAt": "2026-08-09T...",
  "mode": "markdown-blueprint",
  "language": "java",
  "projectRoot": "E:\\...",
  "toolCount": 25,
  "jdk": "21.0.12",
  "gradle": "8.14.4",
  "maven": "apache-maven-3.9.10"
}
```
- 保存时快照写入；读取时 Agent 可用 `read_agent_info` 工具获取（或注入 harness）
- **只读**：Agent 不可修改，仅反映保存时刻环境

**`knowledge-graph.dsl`**（知识图谱 DSL 原文，见第五章）
**`knowledge-meta.json`**（图谱结构化元数据临时缓存，见第五/六章）

### 4.3 与现有 Agent 记忆的关系
| 现有 | 新增 |
|------|------|
| `messages` 内存列表 + `.codenode/agent-sessions/*.json` 临时文件 | `agent-context.json` 随 .cnode 工程持久化，换机器/换目录也带着 |
| `sessionSummary` 内存字符串 | 存入 `agent-context.json.summary` |
| 无软件信息持久化 | `agent-info.json` 只读快照 |
| 无知识图谱 | `knowledge-graph.dsl` + `knowledge-meta.json` |

---

## 五、③ 最高权限 + 全量 UI 控制

### 5.1 权限分级模型

| 级别 | 行为 | 现有工具示例 |
|------|------|-------------|
| `read` | 直接执行，无需确认 | read_file、find_files、get_workbench_model、project_info、graph_query |
| `write` | 执行前确认框 + 审计 | write_file、edit_file、create_nodes、save_project |
| `execute` | 白名单 + 确认 + 超时强杀 | execute_shell、build_project、run_project |
| `ui` | 界面操控，默认允许，高危动作确认 | ui_control（新增全量 action） |
| `system` | 全局开关控制（见 5.3） | 所有工具的总闸 |

分级通过 `AgentConfig` 新增配置：
```properties
agent.permissions=ui:allow,write:confirm,execute:confirm,system:enabled
```

### 5.2 `ui_control` 全量 action 扩展

在现有 7 个基础上新增：

| action | 能力 | 实现点 |
|--------|------|--------|
| `switch_tab` | 切换工作台标签页（节点图/代码审查/内嵌 Agent） | workbenchTabs.setSelectedIndex |
| `open_document` / `close_document` | 新建/打开/关闭文档 tab（支持 path 参数） | newDocumentTab / openProject / closeDocument |
| `save_document` | 保存当前工程 | saveProject |
| `dock_panel` | 工具窗口停靠/浮动/合并（文件浏览器/输出/文件变更/队列/工程运行） | ToolWindow.redock / dock / floatWindow |
| `run_config` | 读取/创建运行配置 | ProjectRunPanel 暴露配置模型 |
| `build_project` / `run_project` / `stop_run` | 构建/运行/停止当前工程 | ProjectRunPanel 或 RunLauncher |
| `select_node` | 选中指定节点 | canvas.selectNodes |
| `open_menu` | 触发菜单项（如"分析项目(A)"） | 菜单派发 |
| `read_ui_state` | 读取当前 UI 状态（选中 tab/面板可见性/窗口大小） | 新增快照返回 |
| `new_agent_tab` / `close_agent_tab` / `switch_agent_tab` | 多对话窗口管理 | AgentSessionManager |

MainFrame 的 `agentUiAction` switch 逐一实现（现有 7 个保留，新增走同一入口）。

### 5.3 全局权限开关

- `AgentConfig`：`agent.permissions`，允许用户完全关闭 Agent 的 UI 操控（默认开启）
- 审计：所有 `ui_control` 执行写入审计日志
- 高危动作（open_document 覆盖、dock_panel 重排、run_project 启动长驻进程）执行前确认

### 5.4 权限边界（安全底线）
- **不暴露** api_key、密码、文件系统绝对根路径外的写权限
- `execute_shell` 仍白名单
- `run_project` 只能运行用户已打开工程的运行配置
- 所有写操作可撤销（复用 undo/redo）或确认

---

## 六、④ 分层知识图谱模型（Obsidian 风格）

### 6.1 核心概念

```
元素（节点）= 一段可被定位的内容（对话中的知识点 / 文件 / 代码段 / 画布节点组）
连接（边）  = 父子/包含关系，严格分层：每个元素只连接"下一层"元素
摘要（S）   = 每个元素的精炼描述（元数据）
关键词（K） = 元素可被检索的标识（类名/文件名/知识点标签）
```

### 6.2 分层规则

元素 `abcdefg` 的分层连接：
```
abcdefg                 ← 顶层元素清单
a(b, c, d, e)           ← a 的下层是 b,c,d,e（本层元素，互不连接）
b(f, g)                 ← b 的下层是 f,g
c(f, g)                 ← c 的下层是 f,g
```

规则：
- 元素只声明与**直接下层**的连接（`a(b,c,d,e)`）
- **同一层**元素之间**不连接**（b 和 c 是 a 的两个子，互不连线）
- 越层不连：a 不直接连 f,g；f/g 只从 b/c 到达
- 根元素列表：`abcdefg`（无括号 = 顶层元素清单）

### 6.3 DSL 语法设计（复用/扩展 WorkflowDslService 规则）

现有 `WorkflowDslService.decode()` 已产出 `c(a,b)` 形式的**嵌套调用 DSL**（节点依赖树）。本设计**沿用同一括号嵌套语法**，扩展到对话内容，并补充摘要/关键词元数据：

```
# 顶层元素清单（对话主题列表）
abcdefg

# 分层连接（父(子1,子2,...)）——与画布 DSL 的 a(b,c) 形式一致
a(b, c, d, e)
b(f, g)
c(f, g)

# 元素摘要与关键词（扩展补充的元数据段）
a.summary: 对话主题 A：……
b.summary: 子主题 B：……
b.keywords: 关键词1, 关键词2
```

DSL 语法（BNF 草案）：
```
document      := (element-list | edge | meta)*
element-list  := IDENT+                    # 无括号顶层元素
edge          := IDENT "(" IDENT ("," IDENT)* ")"
meta          := IDENT "." ("summary"|"keywords") ":" TEXT
IDENT         := [A-Za-z_][A-Za-z0-9_]*
TEXT          := 除换行外的任意字符
```

### 6.4 `knowledge-meta.json`（解码后结构化元数据，临时缓存）

```json
{
  "schemaVersion": 1,
  "roots": ["a"],
  "elements": [
    { "id": "a", "parent": null, "children": ["b","c","d","e"], "summary": "…", "keywords": ["输入"] },
    { "id": "b", "parent": "a", "children": ["f","g"], "summary": "…", "keywords": ["计算"] }
  ],
  "layerIndex": { "0": ["a"], "1": ["b","c","d","e"], "2": ["f","g"] },
  "keywordIndex": { "计算": ["b"], "输出": ["f"] }
}
```

---

## 七、⑤ DSL 解码器：面向对话内容 + 结合画布

### 7.1 职责定位（已确认）

> **DSL 解码器适用于对话内容，而非画布内容。**

- **输入**：一段对话/文本（用户消息、Agent 回复、分析结果）
- **解码**：把文本内容按语义拆分为分层元素（`a(b,c,d)` 嵌套），生成图谱片段
- **结合画布**：Agent 可在调用解码器时附上画布关键信息（`get_workbench_model` 的结果、选中节点、组结构），作为**附加上下文**辅助解码，但解码对象始终是对话文本

### 7.2 `ConversationGraphParser`（新增，对话内容解码）

```
输入: 对话文本 + 可选画布上下文
  → 分词/分块（按话题、段落、代码块）
  → 元素提取（主题/实体/文件/节点）
  → 分层（父→子 包含关系）
  → 摘要 + 关键词提炼
  → 输出: KnowledgeGraph 片段（DSL + 元数据）
```

### 7.3 与现有 `WorkflowDslService` 的关系（扩展而非覆盖）

| 现有 | 本设计 |
|------|--------|
| `WorkflowDslService.decode()`：画布节点依赖树 → `c(a,b)` DSL | **保留不动**，画布 DSL 仍服务画布 |
| `WorkflowDslService.decodeArchitecture()`：项目架构 | **保留不动** |
| — | 新增 `ConversationGraphParser`：**对话内容** → 同款 `a(b,c)` DSL + 摘要/关键词 |

**复用方式**：
- 两个解析器共享同一**括号嵌套语法**（`a(b,c)`），使"画布结构"与"对话知识"可互相映射
- `ConversationGraphParser` 内部复用 `WorkflowDslService` 的构建思路（递归嵌套），但输入是文本而非画布模型
- 画布信息通过参数注入对话解析器（`canvasContext`），不改变原 `WorkflowDslService` 签名

---

## 八、⑥ Agent 的 DSL 工具（精确定位）

| 工具 | 作用 | 关键参数 |
|------|------|---------|
| `graph_root` | 获取图谱根元素与层级概览 | — |
| `graph_query` | 按关键词/元素 id 查询，返回摘要+连接+定位 | `query`、`layer` |
| `graph_traverse` | 从某元素向下遍历，返回子孙层级 | `rootId`、`depth` |
| `graph_path` | 定位元素到实际位置（对话片段/文件:行/节点 id） | `elementId` |
| `graph_summarize` | 生成/刷新某元素摘要 | `elementId` |

Agent 用法（harness 规则）：
- 需要"XX 在哪" → `graph_query { query: "XX" }` → 返回摘要+定位，比全盘扫描快
- 需要"某主题的子结构" → `graph_traverse`
- 定位到文件/片段 → `read_file` / 对话引用精确读取
- **Agent 解码对话**：当用户贴入长文本，Agent 可调用 `graph_summarize`（内部走 ConversationGraphParser）生成图谱条目

---

## 九、⑦ 精准摘要引擎（Codegraph 式）

### 9.1 `TextSummarizer`

**A. 规则摘要（快，本地，无 LLM）**——自动建图：
- 提取：标题/首段、类名、方法名、imports、package、URL、数字、专有名词
- 关键词：TF 统计 + 停用词过滤 + 驼峰拆分（`Minecraft_sourceFile` → `minecraft, source, file`）
- 输出 `{ title, summary, keywords[], entities[], refs[] }`

**B. 模型摘要（准，调 LLM）**——记忆固化：
- 复用 `OpenAiChatClient`，交接摘要 prompt（借鉴 codex）：
  > 当前进度、关键决策、重要约束、待办、关键数据/引用
- 输出规范化 JSON 元数据，存入图谱

### 9.2 摘要粒度（借鉴 grok）

| 级别 | 内容 |
|------|------|
| `None` | 仅统计 |
| `Minimal` | 每元素一行签名 |
| `Balanced`（默认） | 截断文本 + 关键词 |
| `Verbose` | 完整内容（限长截断） |

---

## 十、⑧ 长期记忆系统（含清理机制）

### 10.1 三层记忆

| 层 | 存储 | 作用域 | 生命周期 | 清理策略 |
|----|------|--------|---------|---------|
| **项目长期记忆** | `.cnode` 内 knowledge-graph.dsl + knowledge-meta.json | 随工程走 | 永久（仅固化内容） | 见 10.5 |
| **本地记忆** | `.codenode/memory/<project-hash>/` 下 Markdown | 本机该工程 | 跨会话 | 按大小/TTL 清理 |
| **会话记忆** | agent-context.json + agent-sessions | 本次 | 会话级 | 会话结束清理 |

### 10.2 回忆流程（重启恢复）

```
打开 .cnode
  → 读 knowledge-meta.json（快速，仅固化条目）
  → 图谱入内存
  → Agent 启动注入：根元素 + 顶层摘要 + 任务清单
  → Agent 需要细节时 graph_query 定位
```

### 10.3 固化时机

- 会话结束：自动存对话**元数据摘要**（无 LLM，低开销）
- Agent 任务完成：`graph_summarize` 固化新发现
- 超阈值：旧段摘要进图谱（借鉴 codex/grok 压缩）

### 10.4 检索

- 关键词精确 → `keywordIndex` 哈希 O(1)
- 语义模糊 → 图谱遍历 + 摘要匹配（TF/余弦，可选 LLM 精排）

### 10.5 防止 JSON 冗杂（开启/关闭清理 + 调用时临时存储）

**问题**：若 knowledge-meta.json 每次都把全部对话上下文写入，长时间使用会积累大量垃圾条目、文件膨胀、加载变慢。

**方案：两层分离 + 生命周期清理**——`knowledge-meta.json` 只作为**临时工作缓存**，固化内容单独存放。

**A. 两套文件，职责分离**

| 文件 | 性质 | 内容 | 何时写 |
|------|------|------|--------|
| `knowledge-meta.json` | **临时缓存** | 本次会话调用 DSL 时生成的图谱片段 | DSL 工具调用时写入 |
| `knowledge-graph.dsl` + `.codenode/memory/` | **固化记忆** | 用户/Agent 明确固化、摘要提炼后的长期条目 | graph_summarize / 会话结束 |

**B. knowledge-meta.json 生命周期（临时缓存）**

```
程序启动
  → 清空/忽略 knowledge-meta.json（旧缓存已过期）
程序关闭（或切换项目）
  → 清空 knowledge-meta.json（不留垃圾）
会话中
  → Agent 调用 DSL（graph_query/summarize）时，按需写入临时缓存
  → 仅供"本次运行内后续调用"复用，不跨会话
```

- **启动时**：不加载旧临时缓存（或仅校验存在性），避免垃圾累积
- **关闭时**：删除/清空临时缓存；固化内容保留在 knowledge-graph.dsl / memory
- **调用时**：DSL 解码结果临时写入 JSON，供本次会话后续 `graph_query` 复用（避免重复解析同一段文本）；下次启动重新生成

**C. 固化内容的写入门槛（防垃圾）**
- 只有显式固化才写长期区：
  - Agent 调用 `graph_summarize`（模型摘要级，质量门槛）
  - 会话结束的元数据摘要（低开销，但仅统计+关键词，不存全文）
  - 用户手动"加入记忆"
- 规则摘要（快但糙）默认只进**临时缓存**，不自动固化

**D. 上限保护**
- knowledge-meta.json 单文件上限（如 1MB / 5000 元素），超限淘汰最旧临时条目
- 固化区条目数上限 + 关键词去重，避免重复元素

---

## 十一、⑨ 多对话窗口（Agent 页多开，同一项目内）

### 11.1 需求
> 目前只有一个对话窗口；需要 Agent 对话页**多开**，但多开页面**始终在同一项目内**。

### 11.2 设计

- `AgentChatPanel` 支持多实例：`List<AgentChatController>` 由 `AgentSessionManager` 管理
- 每个对话页 = 一个独立 `AgentChatController`（独立 messages 历史、独立 sessionId）
- **共享**：
  - 同一 `AgentToolContext`（同一项目根、同一 WorkflowModel 引用、同一确认/审计回调）
  - 同一 `AgentConfig`（模型/API）
  - 同一 `TaskManager`（任务清单跨窗口可见）
  - 同一 `KnowledgeGraph`（图谱跨窗口共享）
- **隔离**：messages 历史、子代理集合（subagent 归属发起它的窗口）

### 11.3 UI

- 工作台标签页内嵌一个 `JTabbedPane`（"对话 1 / 对话 2 / ＋"）
- 新增：`new_agent_tab` / `close_agent_tab` / `switch_agent_tab`（也可加进 ui_control action）
- 每个 tab 独立：输入框、发送、停止、推理折叠区、状态栏
- 同一项目内：所有 tab 共用项目根；打开新项目时，全部 tab 同步切到新项目（或提示）

### 11.4 数据

- `AgentSessionManager` 管理：创建/销毁/切换对话，持久化各 tab 的会话到 agent-context.json（按 sessionId 区分）

---

## 十二、⑩ 子代理（Subagent）+ 任务清单（to_do_list）

### 12.1 子代理

- `SubagentManager`：每个子代理 = 独立 `AgentChatController`（独立上下文窗口）
- 主代理 spawn 子代理，传入：任务 + 注入上下文（相关图谱片段/文件）
- 子代理可调用现有工具，只把**结论摘要**返回主代理

工具：
| 工具 | 作用 |
|------|------|
| `spawn_subagent` | 启动子代理，返回 subagent_id；参数：task、context |
| `subagent_wait` | 等待子代理完成，返回结果摘要 |
| `subagent_list` | 列出进行中的子代理与状态 |
| `subagent_cancel` | 取消子代理 |

### 12.2 任务清单

- `TaskManager`（内存 + 持久化 `.codenode/tasks/<documentId>.json`）：
  ```json
  { "tasks": [ { "id":"t1","desc":"扫描项目","status":"done","note":"120 节点" },
               { "id":"t2","desc":"分析架构","status":"in_progress" } ] }
  ```
工具：`todo_list` / `todo_add` / `todo_update` / `todo_clear`

harness 集成：系统提示末尾注入任务清单；Agent 规划先 `todo_add`，每步 `todo_update`。

---

## 十三、⑪ 合并其他 Agent 优势

| 借鉴 | 落地 |
|------|------|
| Obsidian 双向链接 | 分层连接 + 摘要，反向经 parent 可达 |
| Codegraph 预索引 | `.cnode` 内预生成 knowledge-meta.json |
| codex Memento | 会话压缩生成交接摘要，存回图谱 |
| grok 分段+记忆 | 旧段写 Markdown + 索引；压缩前 memory flush |
| grok 关键词提取 | 从总结节提取关键词 + 停用词表 |
| grok 工具结果剪枝 | 旧工具结果裁剪头尾，最近 N 轮不剪 |

---

## 十四、补充需求（后续追加）

以下为评审后补充的 Stage4.9 增强内容，与上述各块并列实施。

### 14.1 状态栏 Agent 活动指示

**问题**：Agent 正在执行工具时，用户只能在"推理折叠区"看到工具日志，主界面状态栏无指示。

**方案**：
- `ChatListener` 增加活动状态：工具开始时发 `ChatEvent.state(ACTIVE_RUNNING)` + 工具名，结束后恢复
- MainFrame 状态栏显示"Agent 正在执行：<工具名>"；无活动时恢复"就绪"
- AgentChatPanel 顶部/底部状态条同步显示当前正在执行的工具
- 复用现有 `ChatEvent` 的 STREAM/TOOL_CALL 事件，无需新增事件类型（或新增 `ChatEvent.toolProgress(name)` 轻量事件）

### 14.2 工具调用可中途取消

**问题**：现在只能"停止整轮"（requestStop），长工具执行时无法单独取消单个工具。

**方案**：
- `AgentToolContext` 增加 `requestToolStop()` / `toolStopRequested()`
- `executeToolWithTimeout` 循环中每步检查 `toolStopRequested()`，超时/停止则立即中断该工具
- UI：Agent 对话面板在工具执行期间提供"取消当前工具"按钮（区别于"停止整轮"）
- 工具内部可感知取消（如 ProcessRunner 检查取消标志 → destroyForcibly）

### 14.3 ui_control 的参数化对话框

**问题**：`open_document` / `save_document` 等需要选路径的动作，若弹原生文件框会阻塞/无法被 Agent 参数驱动。

**方案**：
- 这些 action 全部支持**参数传路径**：`open_document { path: "E:\\xxx\\a.cnode" }` 直接打开，不弹框
- 仅当 path 参数缺失时才回退到 JFileChooser
- schema 中为相关 action 增加 `path` 参数说明
- MainFrame `agentUiAction` 实现：有 path 走参数路径，无 path 走选择器

### 14.4 权限记忆（session 级）

**问题**：用户在某工程批准过某操作后，同类操作仍反复询问。

**方案**：
- `AgentConfig` 或内存级 `PermissionMemory`：记录 `(工程hash, 工具名, 操作签名) → 批准/拒绝`
- 同一 session 内，已批准的高危操作签名不再二次确认（签名=工具名+关键参数哈希）
- 会话结束/切工程清空（session 级，不持久化跨会话）
- 界面提供"本次会话内记住批准"的开关（默认开）

### 14.5 AgentInfoSnapshot 敏感过滤测试

**问题**：软件信息注入必须保证不泄露敏感数据。

**方案**：
- `AgentInfoSnapshot` 输出白名单：仅版本/模式/项目名/画布统计/JDK版本/工具数/UI动作等
- **明确排除**：api_key、api_base、密码、完整文件系统绝对路径（显示相对路径或项目名）
- 新增测试 `AgentInfoSnapshotTest`：
  - 快照文本不含 api_key / api_base / 密码字段
  - 快照不含 `E:\` 等绝对路径前缀（或已脱敏）
  - 快照含预期的版本/模式/画布统计字段

---

## 十五、存储位置与项目位置共享文件栏（BUG）

> 需求：软件本身的存储位置和项目位置共享一个文件栏；若属实，作为 Stage4.9 的 bug 修复。

### 15.1 需核实

- 检查 `JFileChooser` 打开/保存对话框的初始目录：
  - "选择申请项目目录"（chooseProject）用 `project.getText()` 作初始目录
  - 打开/保存 `.cnode`（openProject/saveProjectAs）可能共享同一 chooser 初始目录
- 确认是否"项目路径"与".cnode 文件路径"被同一个文件栏（JFileChooser）复用

### 15.2 修复方案（若确认）

- 拆分为**两个独立的 JFileChooser 实例**：
  - `projectChooser`（目录选择，默认最近项目目录）
  - `documentChooser`（文件选择，默认最近文档目录）
- 分别记住各自最近目录（Preferences）
- 若当前已是分离实现，则该需求不适用（忽略）

---

## 十六、总体架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                          CodeNode 桌面                             │
│                                                                  │
│  ┌───────────────┐   ┌─────────────────┐   ┌──────────────────┐  │
│  │ 分层知识图谱     │   │ 精准摘要引擎       │   │ 长期记忆系统        │  │
│  │ KnowledgeGraph │   │ TextSummarizer   │   │ 三层记忆+检索       │  │
│  │ (对话+画布DSL)  │   │ (规则+模型两级)    │   │ 会话/项目/本地       │  │
│  └───────┬───────┘   └────────┬────────┘   └────────┬─────────┘  │
│          │                     │                     │            │
│          ▼                     ▼                     ▼            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                Agent 工具层（新增 13+ 个）                   │  │
│  │  graph_*（root/query/traverse/path/summarize）             │  │
│  │  subagent_*（spawn/wait/list/cancel）                     │  │
│  │  todo_*（list/add/update/clear）                          │  │
│  └───────────────────────────────────────────────────────────┘  │
│          │                                                      │
│          ▼                                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │        AgentSessionManager（新增：多对话窗口）               │  │
│  │  AgentChatController×N（同项目、共享图谱/任务/上下文）        │  │
│  └───────────────────────────────────────────────────────────┘  │
│          │                                                      │
│          ▼                                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  WorkflowDslService（保留）→ 画布DSL a(b,c)                  │  │
│  │  ConversationGraphParser（新增）→ 对话DSL a(b,c)+摘要/关键词  │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 十七、测试标准与测试流程

### 17.1 测试标准（Test Standards）

**总体原则**：分层覆盖（单元→集成→回归→端到端），每个新模块必须有对应测试；测试不依赖真实 LLM 网络调用（用 mock/stub）。

**A. 单元测试标准（每模块必须）**
| 模块 | 必须覆盖的断言 |
|------|--------------|
| `KnowledgeGraph` | 元素/连接正确；分层校验通过/拒绝；遍历返回正确层级；检索 O(1) 命中 |
| `ConversationGraphParser` | 给定对话文本 → 正确的 `a(b,c)` DSL；分层不越层；摘要/关键词生成；画布上下文注入后结果包含画布信息 |
| `TextSummarizer` | 规则摘要提取标题/类名/关键词正确；停用词过滤；驼峰拆分；空输入/超长输入边界 |
| `CnodeProjectCodec` | knowledge-graph.dsl / knowledge-meta.json / agent-context.json / agent-info.json 编解码往返一致；缺失条目默认值；超大文件上限拦截 |
| 工具 graph_* | 每个工具参数校验、命中/未命中返回、错误返回 |
| `SubagentManager` | 子代理创建/完成/取消；结果摘要截断；并发上限 |
| `TaskManager` | todo 增删改查；状态流转；持久化往返 |
| `AgentSessionManager` | 多窗口创建/切换/关闭；同项目共享、消息隔离 |
| 记忆清理 | 启动清空临时缓存；关闭清空；固化内容保留；上限淘汰最旧 |
| `AgentInfoSnapshot` | 敏感过滤（无 api_key/绝对路径）；字段正确 |
| `PermissionMemory` | 批准/拒绝记忆；签名命中；session 结束清空 |

**B. 集成测试标准**
- DSL 工具在真实 `AgentToolkit` 注册并可用
- `graph_summarize` 产出可写回 knowledge-meta.json 且可被 `graph_query` 检索
- 多窗口：窗口 A 添加任务，窗口 B 可见；A 消息不影响 B
- 子代理结果可被主代理读取

**C. 回归标准**
- 现有全部测试（当前 136 个）必须保持通过
- 特别是 `WorkflowDslServiceTest`（确认未覆盖原画布 DSL）、`AgentEnhancementTest`（对话窗口/工具）、`ProjectBuildRunTest`

**D. 端到端（手工）标准**
- 打开工程 → 图谱注入 → Agent 用 graph_query 定位真实内容
- 重启程序 → 仍能回忆（固化内容）
- 临时缓存开启/关闭清理生效（文件大小回落）
- 多对话窗口同项目操作
- 存储/项目文件栏分离（bug 修复验证）

### 17.2 测试流程（Test Flow）

```
① 单元测试（mvnw test，JUnit）
   ├─ 新增模块测试（每个类 ≥ 对应用例）
   ├─ 全量回归（确保 136 不破，增量到 N）
   └─ 门禁：全部通过才允许提交

② 集成测试（同 mvnw test，新增 XXTest）
   ├─ 工具注册/调用链
   ├─ 多窗口/子代理/任务管理器
   └─ 记忆往返

③ 手工验收清单（.md 文档，逐项勾选）
   ├─ 对话页多开
   ├─ DSL 定位真实内容
   ├─ 重启记忆恢复
   ├─ 临时缓存清理（观察文件大小）
   └─ 存储/项目文件栏分离（bug）

④ 性能/占用抽查
   ├─ knowledge-meta.json 大小上限内
   ├─ 100 万字上下文下加载/检索耗时可接受
   └─ 临时缓存清理后无残留垃圾
```

**测试产物**：
- JUnit：`src/test/java/local/codenode/` 下新增 `KnowledgeGraphTest` / `ConversationGraphParserTest` / `TextSummarizerTest` / `SubagentManagerTest` / `TaskManagerTest` / `AgentSessionManagerTest` / `MemoryLifecycleTest` / `AgentInfoSnapshotTest` / `PermissionMemoryTest`
- 手工清单：`docs/TEST_CHECKLIST_4_9.md`
- 性能抽查脚本（可选）：`scripts/perf-context.ps1`

**验收门禁（Definition of Done）**：
1. 单元 + 集成 + 回归全部通过（mvnw test 绿）
2. 手工清单全勾选
3. knowledge-meta.json 经"开启→使用→关闭"后无垃圾残留（文件回落/清空）
4. 固化记忆在重启后可被 graph_query 检索到
5. 原画布 DSL（WorkflowDslService）行为不变
6. AgentInfoSnapshot 敏感过滤测试通过

---

## 十八、实施清单

| 模块 | 内容 | 依赖 |
|------|------|------|
| `AgentInfoSnapshot` | 软件/环境信息采集 + 文本化 + 敏感过滤 + 图谱概览 | MainFrame 提供 source |
| `AgentToolContext` | 注入 `softwareInfoProvider`；工具取消标志；权限记忆 | — |
| `AgentChatController` | systemPrompt 追加实时快照；save/load 改 .cnode 上下文；工具执行循环支持取消 | — |
| `CnodeProjectCodec` | `agent-context.json`/`agent-info.json`/`knowledge-graph.dsl`/`knowledge-meta.json` 编解码 + integrity | — |
| `WorkflowModel` 或独立模型 | 上下文存储模型（1M 字符滚动窗口） | — |
| `KnowledgeGraph` | 图谱模型 + 遍历/检索 | — |
| `ConversationGraphParser` | 对话内容 → DSL + 摘要/关键词；可注入画布上下文 | WorkflowDslService（复用语法） |
| `TextSummarizer` | 规则摘要 + 模型摘要 | OpenAiChatClient |
| 工具 graph_* | 5 个图谱工具 | AgentToolkit |
| `MemoryStore` | 三层记忆读写 + 回忆注入 + 清理（启动清/关闭清/上限淘汰） | — |
| `AgentSessionManager` | 多对话窗口（同项目共享） | AgentChatController |
| 工具/action new_agent_tab 等 | 多开对话 UI | AgentChatPanel |
| `SubagentManager` | 子代理生命周期 | AgentChatController |
| 工具 subagent_* | 4 个子代理工具 | — |
| `TaskManager` | 任务清单持久化 | — |
| 工具 todo_* | 4 个任务工具 | — |
| harness | 注入图谱概览 + 任务清单；压缩写记忆 | AgentChatController |
| `UiControlTool` | action 枚举扩展 + schema（含 path 参数） | — |
| `MainFrame.agentUiAction` | 新增 action 全量接线（含参数化路径回退） | 各 UI 组件 |
| `AgentConfig` | `agent.permissions` 解析 | — |
| 状态栏活动指示 | 工具执行中状态栏显示工具名 | ChatEvent/MainFrame |
| 工具取消 | 取消按钮 + executeToolWithTimeout 支持取消 | AgentToolContext |
| `PermissionMemory` | session 级权限记忆 | AgentToolContext |
| 存储/项目文件栏 bug | 核实并修复共享文件栏 | MainFrame |
| 测试 | 见第十七章：单元/集成/回归/手工/性能 | — |

---

## 十九、关键决策点（需确认）

1. **上下文持久化位置**：替换现有 `.codenode/agent-sessions/` 目录方案，还是**并存**（目录存临时、.cnode 存工程级）？
2. **1M 字上限的裁剪策略**：滑动窗口 + 摘要（沿用 4.6），超出时**丢弃最旧**还是**压缩为摘要**？
3. **Agent 最高权限的默认值**：UI 操控默认允许，还是默认需确认？
4. **agent-info.json 写入时机**：仅保存时快照，还是每次打开工程时刷新？
5. **风险等级**：`run_project` 等启动外部进程的动作，是否需要单独的"启动外部程序"确认开关？
6. **权限记忆作用域**：仅"同一工程同一 session"，还是"同一工程跨 session"（存本地）？
7. **工具取消粒度**：取消当前工具后，是让 Agent 重新思考换方案，还是直接结束该工具并继续流程？
8. **对话内容的分块粒度**：按话题/段落/代码块？是否需要用户显式标注结构？
9. **多对话窗口持久化**：每个 tab 的会话存独立文件，还是合并进一个 agent-context.json？
10. **子代理模型与并发**：同模型 or 可指定？并发上限？
11. **摘要频率**：规则摘要每次会话都跑，模型摘要仅手动/固化时？
12. **图谱与画布映射**：对话图谱元素可否反向链接到画布节点（需节点 id）？
13. **临时缓存上限**：knowledge-meta.json 单文件上限（1MB / 5000 元素）是否合适？
14. **清理时机**：是否每次启动+关闭都清空临时缓存，还是仅关闭时清空（启动时保留供断点续跑）？
15. **存储/项目文件栏 bug**：是否需要我先去核实是否为真 bug？

---

*（方案待确认后实施，先不制作）*
