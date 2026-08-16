# CodeNode 内置 Agent Harness 差距分析（缺失能力清单）

> 文档目的：梳理内置 Agent harness 相对主流 agent 框架（OpenAI Agents SDK / LangGraph、Claude Code、OpenHands、Cline、MCP 生态）**缺失或薄弱**的能力，每项给出现状、影响、主流做法与建议方案，并给出实施优先级。
> 范围：仅覆盖"没有的部分"；harness 的架构与既有优势参见代码注释与 `IMPLEMENTATION_STATUS.md`。
> 基准：分支 `0.16`，`src/main/java/local/codenode/agent/`。
> 实施状态：P0–P4 已于 2026-08-15 全部实现，见文末「实施记录」；本文保留原始缺口描述供对照。

## 背景：harness 现状速览

内置 Agent 是纯 Java 自研的 OpenAI function-calling 循环，无第三方依赖：

| 组件 | 路径 | 职责 |
|------|------|------|
| `AgentToolContext` | `agent/tools/AgentToolContext.java` | 依赖注入中枢：项目根/工作台模型/确认/审计/写回/撤销/权限/记忆 |
| `AgentToolRegistry` | `agent/tools/AgentToolRegistry.java` | 工具注册、参数校验、execute、转 OpenAI tools 格式 |
| `AgentToolkit` | `agent/tools/impl/AgentToolkit.java` | 默认注册 30+ 工具，按 `AgentConfig` 白名单过滤 |
| `AgentChatController` | `agent/AgentChatController.java` | 会话状态机、tool-calling 循环、滑动窗口+摘要、持久化 |
| `AgentSessionManager` | `agent/AgentSessionManager.java` | 多标签会话管理 |
| `CodeNodeMcpServer` | `CodeNodeMcpServer.java` | 将同一套工具暴露为 MCP server |

---

## 缺失能力清单

### 1. 不能消费外部 MCP 工具（最大的扩展性缺口）

- **现状**：harness 只做 MCP **server**（`CodeNodeMcpServer.registerToolBridge` 把自家工具暴露出去），没有 MCP **client** 能力。工具集在编译期锁死：`AgentToolkit.registerAll`（`AgentToolkit.java:58`）注册什么，agent 就只有什么。用户想给 agent 挂"查数据库/发邮件/浏览器"等外部工具只能改代码。
- **影响**：能力边界固定，无法复用 MCP 生态（当前已有数千个公开 MCP server）；`AgentToolRegistry` 的 `register(name, description, inputSchema, executor)` 与 MCP 工具模型天然同构，扩展成本低但一直没做。
- **主流做法**：Claude Desktop、Cline、Continue 均内置 MCP client，通过配置文件声明 `mcpServers`，启动时动态拉取工具并入工具列表。
- **建议方案**：接入 modelcontextprotocol/java-sdk，在 `AgentToolkit.buildDefaultRegistry` 之外新增 `McpClientToolSource`：配置里声明 server 列表 → 初始化 client → 把远端工具以 `ToolExecutor` 包装注册进 `AgentToolRegistry`（参数校验/超时/结果截断全部复用现有链路）。工具名前缀 `mcp__<server>__<tool>` 防冲突。
- **优先级**：P1

### 2. 共享 AgentToolContext 的并发副作用（正确性缺陷）

- **现状**：所有对话 tab 共享同一个 `AgentToolContext`（`AgentSessionManager.java:15` 注释明说 "shared AgentToolContext"；`MainFrame.java:243` 只构造一个实例）。但 context 里有两个**可变共享状态**：
  - `toolStopRequested`（`AgentToolContext.java:37`，AtomicBoolean）：**在一个 tab 点"停止"会取消所有 tab 正在执行的工具**（`AgentChatController.requestStop` → `toolContext.requestToolStop()`，`AgentChatController.java:677`）。
  - `permissionMemory`（`AgentToolContext.java:38`）：一个 tab 记住的权限确认在另一个 tab 也生效（跨会话泄漏）。
  - 附带：`questionHandler` 是全局 JOptionPane，多 tab 并发 ask_user 会互相抢弹窗。
- **影响**：多 tab 并行使用时行为不可预期，属于 bug 级问题。
- **主流做法**：会话隔离是 agent 框架的默认假设（每个会话独立 context 或 ThreadLocal）。
- **建议方案**：把 `toolStopRequested`、`permissionMemory` 下沉为 controller 级（或 ThreadLocal），context 只保留真正的全局只读依赖（projectRootSupplier、modelSupplier、audit 等）。`setSubagentManager` 已经是 ThreadLocal 模式（`AgentToolContext.java:44`、`:306`），照此办理即可。
- **优先级**：P0（先修正确性）

### 3. 没有显式的规划层（planning）

- **现状**：`runTurnLoop`（`AgentChatController.java:433`）是 `MAX_TOOL_LOOP=10` 的线性 ReAct 循环；"复杂任务分多步"只是 system prompt 里的规则（`:373` 规则 9），没有 plan-and-execute、没有 checkpoint/恢复。`TodoTools` 只做任务记录，harness 不强制"计划 → 执行 → 对照计划校验"。
- **影响**：长链路任务（如 Stage 4.5 的扫描→分析→写 md→验证）模型容易中途迷失目标或重复劳动；中途失败后无法从 checkpoint 恢复。
- **主流做法**：OpenHands/Claude Code 用显式 task list + 每步校验；LangGraph 支持图结构控制流（条件分支、循环、重试子图）。
- **建议方案**：低成本——在 `TodoTools` 之上加"计划校验"：工具循环每 N 轮注入当前任务清单与完成度，要求模型对照；高成本——plan-and-execute：首轮强制产出结构化计划（todo_add），执行中每轮把计划+进度注入 system prompt，收尾强制对照计划逐项确认。
- **优先级**：P3

### 4. 没有可观测性基础设施（trace 持久化）

- **现状**：`AgentExecutionTimeline` 只在内存中；`.codenode/agent-sessions/<sessionId>.json` 只存消息文本，**没有 token 用量、每工具耗时、工具调用链、失败原因的结构化记录**。出问题只能看聊天记录复盘。
- **影响**：无法回答"这次任务 agent 为什么绕了 8 步""哪个工具最慢/最常失败""一次任务烧了多少 token"；harness 调优（超时/重试/提示词）缺乏数据依据。
- **主流做法**：LangSmith / OpenTelemetry GenAI 语义约定：span 树（每个 LLM 调用、每个工具调用一个 span）+ 属性（模型、token、耗时、错误）。
- **建议方案**：在 `AgentExecutionTimeline` 上做 append-only trace 文件 `.codenode/agent-traces/<sessionId>.jsonl`，每行一个事件（llm_call / tool_call / tool_result / retry / summary），字段：时间戳、耗时、token、工具名、参数摘要、结果 ok、错误。UI 或脚本可离线分析。
- **优先级**：P2

### 5. 记忆没有相关性检索

- **现状**：`memoryStore().recall("", 3)`（`AgentChatController.java:394`）取最近 3 条塞进 system prompt；`KnowledgeGraph` 是手写图谱（DSL 解析 + 冲突检测），无向量/关键词检索。系统提示里"长期知识"注入也是 `overview()` 全量概览（`:414`）。
- **影响**：项目复杂后，与当前任务相关的记忆可能不在最近 3 条里；图谱概览随规模增长会撑爆 system prompt。
- **主流做法**：RAG——embedding 检索 + 按相关性截断；或至少 BM25 关键词打分。
- **建议方案**：低成本——给 `MemoryStore.recall` 加关键词打分（对当前 user 消息做分词，与 entry 标题/内容算重合度，取 top-K），不引入外部依赖；高成本——本地 embedding（如 ONNX 小模型）做向量检索。
- **优先级**：P3

### 6. 没有 eval / 能力回归基准

- **现状**：现有测试（`.cnode` 画布断言等）测的是**工具链正确性**，不是 **agent 能力**。改 harness（提示词/超时/重试策略/工具注册）后"任务成功率"没有度量手段，只能靠手感。
- **影响**：迭代 harness 是盲人摸象；一次"优化"可能悄悄降低某类任务的成功率而不自知。
- **主流做法**：OpenHands 的 SWE-bench 类任务集；Claude Code 的 capability tests（固定任务 + 判定脚本）。
- **建议方案**：建 `eval/` 目录：10–20 个固定任务（扫描→分析、构建→运行→trace、批量改文件、知识图谱冲突处理、子代理等），每个任务配"判定脚本"（断言画布结构/文件内容/工具调用序列），`mvn test` 里加一个 `AgentEvalSuite` 跑全套并输出通过率。harness 每次改动后跑一遍。
- **优先级**：P3（但建议在 P0/P1 之后立刻做，它是后续所有调优的依据）

### 7. 其他小缺口

| 缺口 | 现状 | 影响 | 建议 |
|------|------|------|------|
| 仅支持 OpenAI chat.completions 协议 | `OpenAiChatClient` 单一协议 | 换 Anthropic/Gemini 原生 API 要自写 client | ✅ 已实现：`AnthropicChatClient`（Messages API）+ `ChatClient` 接口 + `api_provider` 配置；Gemini 走 OpenAI 兼容端点即可 |
| 无多模态输入 | 工具结果与消息均为文本 | agent 看不到截图/画布渲染结果 | 若需，先支持 `ui_control` 截图回传 + vision 参数 |
| 无结构化输出约束 | 工具参数有 schema 校验，模型自由文本无约束 | 分析类任务的输出格式不稳定 | 对 `analyze_project`/`write_analysis_md` 等加"要求模型输出 JSON"的 harness 级二次校验（失败重试） |
| 本地摘要器为规则版 | `TextSummarizer` 本地实现（刻意避免额外 API 调用） | 长会话压缩质量有限，早期细节丢失 | 可接受；若质量成为瓶颈，改为可配置的 LLM 摘要通道 |
| 无全局用户记忆（跨项目） | `MemoryStore` 绑定 `projectRoot()` | 用户偏好、通用约定无法跨项目复用 | 新增 `~/.codenode/user-memory.md` 注入 system prompt |
| 无 checkpoint/恢复 | 会话 JSON 可恢复消息，但执行中途失败无法续跑 | 长任务中断后从零重跑 | 依赖规划层（缺口 3）落地后一并设计 |

---

## 实施优先级路线图

| 优先级 | 项 | 理由 | 状态 |
|--------|----|------|------|
| **P0** | 共享 context 并发隔离（缺口 2） | 正确性缺陷，多 tab 即触发 | ✅ 已实现 |
| **P1** | MCP client（缺口 1） | 扩展性收益最大，生态复用 | ✅ 已实现 |
| **P2** | trace 持久化（缺口 4） | 调优与排障的数据基础 | ✅ 已实现 |
| **P3** | eval 任务集（缺口 6） | 后续所有改动的度量依据 | ✅ 已实现 |
| **P3** | 规划层（缺口 3）、记忆检索（缺口 5） | 能力增强 | ✅ 已实现（低成本方案） |
| **P4** | 全局用户记忆 | 跨项目偏好复用 | ✅ 已实现 |
| **P5** | 请求重试退避 + Anthropic 协议适配 | 网络/限流抖动自愈；多协议接入 | ✅ 已实现 |

## 实施记录（2026-08-15）

### P0：会话级并发隔离
- 新增 `agent/AgentSessionScope.java`：会话级 `toolStopRequested` + `permissionMemory`。
- `AgentToolContext` 增加 ThreadLocal `setSessionScope/sessionScope`，`toolStopRequested()/permissionMemory()` 委托当前线程作用域，无绑定时回退共享兜底（MCP bridge 等非会话场景）。
- `AgentChatController` 每个实例持有独立 `sessionScope`；工具执行时绑定、结束后解绑（与 `setSubagentManager` 同模式）。一个 tab 停止只取消该 tab 的工具；权限确认记忆不跨 tab 泄漏。
- 测试：`AgentSessionScopeTest`（4 项）。

### P1：MCP client（零依赖 stdio 实现）
- 新增 `agent/mcp/McpStdioClient.java`：JSON-RPC 2.0 over stdio 子进程；`initialize` 握手、`tools/list`、`tools/call`；独立读线程 + 响应队列，请求串行、超时可控；`tools/call` 的 JSON-RPC error/超时转为 `isError` 结果而非崩溃。
- 新增 `agent/mcp/McpToolkit.java`：按 `AgentConfig` 配置连接并注册远端工具；原名注册，冲突自动加 `mcp__<server>__` 前缀。
- `AgentConfig` 新增 `mcp.servers` / `mcp.server.<name>`（`|` 分隔命令行）配置项；`MainFrame` 启动连接、退出关闭。
- `CodeNodeMcpServer` 补充标准 `main(String[])` 命令行入口（`java local.codenode.CodeNodeMcpServer <projectRoot>`）。
- 测试：`McpStdioClientTest`（5 项，以真实 CodeNodeMcpServer 子进程为对端）。

### P2：trace 持久化
- 新增 `agent/AgentTraceWriter.java`：append-only JSONL，`.codenode/agent-traces/<sessionId>.jsonl`。
- `AgentChatController` 埋点：`session_start` / `llm_call`（耗时 + usage）/ `tool_call`（工具、耗时、ok、结果摘要）/ `retry_nudge` / `plan_check` / `error` / `session_end`。
- `OpenAiChatClient` 捕获 SSE usage（`lastUsage()` 读后清除，不污染消息历史）。
- 测试：`AgentTraceWriterTest`（4 项）+ `AgentEvalSuite` 端到端验证事件齐全。

### P3：记忆相关性检索
- `MemoryStore.recall` 重写：query 关键词（英文词 + 中文 2-gram）打分，title 命中 ×3 / content 命中 ×1，按分排序；无命中退回最新条目；空 query 保持时间序。
- 测试：`MemoryRecallTest`（4 项）。

### P3：规划层（进度检查）
- `AgentChatController.runTurnLoop` 每完成 3 个工具步骤注入【进度检查】user 消息（`planCheckPrompt`：最近 8 步 + 任务清单 + 对照目标指引），防止长任务偏离。
- 测试：`AgentEvalSuite#planCheckInjectedEveryThreeSteps`。

### P3：eval 任务集
- 抽象 `agent/ChatClient.java` 接口（`OpenAiChatClient` 实现；`lastUsage()/abort()` 默认实现），`AgentChatController` 增加可注入 client 的测试构造。
- 新增 `AgentEvalSuite`（6 项确定性场景）：失败自愈重试、强制总结、规划层、trace 完整性、停止取消、连续失败多轮提示。**harness 能力回归基准：改 prompt/超时/重试策略后跑 `mvn test -Dtest=AgentEvalSuite` 即可发现回归。**

### P4：全局用户记忆
- 新增 `agent/UserMemoryStore.java`：`~/.codenode/user-memory.md` 追加式读写，截断 4000 字符；home 可注入（测试隔离）。
- 新增工具 `user_memory_save`（WRITE 级确认），注册进 `AgentToolkit`；`systemPrompt` 注入 `[User memory]` 段（截断 1500 字符）。
- 测试：`UserMemoryTest`（4 项）。

### P5：请求重试退避 + Anthropic 协议适配（2026-08-16）
- 新增 `agent/ChatHttpException.java`：带 HTTP 状态码（0=配置类错误不可重试；429/5xx 可重试）；`OpenAiChatClient` 与 `AnthropicChatClient` 统一抛它。
- 新增 `agent/RetryingChatClient.java`（ChatClient 装饰器）：网络层 IOException、HTTP 429/5xx 指数退避重试（base 1s ×2^n + 0~30% 抖动，上限 15s，默认 3 次）；4xx/配置错误/InterruptedException 不重试；重试前推送 `ChatEvent.system` 提示（新增 SYSTEM 事件，灰色展示），退避等待可中断（停止按钮立即打断）；abort/lastUsage 转发底层。
- 新增 `agent/AnthropicChatClient.java`：Anthropic Messages API 流式客户端（/v1/messages，x-api-key + anthropic-version 头）。转换：system 消息→顶层 system 参数；assistant tool_calls→content 块 tool_use；role=tool 消息→user 消息的 tool_result 块；工具 schema parameters→input_schema；首条非 user 自动前置空 user 消息。SSE 解析 message_start（usage 转 OpenAI 风格键）/content_block_start（tool_use id/name）/content_block_delta（text_delta、thinking_delta、input_json_delta）/error（rate_limit→429、overloaded→529）。max_tokens 必填（`AgentConfig.maxTokens()`，默认 8192）。
- `AgentConfig` 新增 `api_provider`（openai|anthropic，默认 openai）与 `max_tokens`；`AgentChatController` 按 provider 装配 client 并统一套 `RetryingChatClient`；`AgentSettingsPanel` 增加服务商下拉。
- 测试：`RetryingChatClientTest`（10 项：429/5xx/网络错误重试、4xx/配置错误不重试、退避递增、中断传播、转发）；`AnthropicChatClientTest`（10 项：SSE 解析、请求体/头转换、错误映射，本地 HttpServer 模拟对端）。
- 注意：本机 `HttpServer` 的 chunked 响应（sendResponseHeaders(-1)）在 `HttpURLConnection` 下读不到数据，测试须用固定 Content-Length。

### 已知取舍（未实现）
- 多模态输入、结构化输出二次校验：文档小缺口表中标注"可接受"，未实施。
- MCP client 仅支持 stdio transport（HTTP/SSE transport 未实现）。
- Gemini 原生协议未单独实现（其 OpenAI 兼容端点可覆盖）；如遇兼容问题再补适配。

## 相关文件索引

- `src/main/java/local/codenode/agent/tools/AgentToolContext.java`
- `src/main/java/local/codenode/agent/tools/AgentToolRegistry.java`
- `src/main/java/local/codenode/agent/tools/impl/AgentToolkit.java`
- `src/main/java/local/codenode/agent/AgentChatController.java`
- `src/main/java/local/codenode/agent/AgentSessionManager.java`
- `src/main/java/local/codenode/CodeNodeMcpServer.java`
- `src/main/java/local/codenode/MainFrame.java`（装配点：`:243` `:284`）
