# CodeNode Agent Harness 架构评估（分支 0.16）

> 基于 `src/main/java/local/codenode/agent/` 代码核对（2026-08-16）。
> 相关文档：[AGENT_HARNESS_GAP_ANALYSIS.md](./AGENT_HARNESS_GAP_ANALYSIS.md)

## 一、框架是什么

**自研的轻量 ReAct 式工具调用 harness**，不是 LangChain / AutoGen / Spring AI 那类现成框架——核心是一个手写的「LLM 工具调用循环」+ 一套深度绑定产品工作台的工具链。

| 层 | 组件 | 职责 |
|---|---|---|
| 模型抽象 | `ChatClient` / `OpenAiChatClient` | OpenAI 兼容 `chat.completions` 流式 + function calling，baseUrl 可配（205 行，自研） |
| 对话循环 | `AgentChatController.runTurnLoop` (:433, 775 行) | 状态机 IDLE→ACTIVE_RUNNING→IDLE；最多 10 轮工具循环、失败重试 nudge、强制总结、滑动窗口 + 摘要压缩 |
| 工具框架 | `AgentToolRegistry` + `AgentToolkit` + `AgentToolContext` | 45 处注册调用（约 34 个工具：run_project、graph_*、workbench_*、file/shell 等）；context 是 DI 中枢，Swing 回调全部以 Supplier/回调注入 |
| 记忆 | `MemoryStore` + `UserMemoryStore` + `KnowledgeGraph` + `TaskManager` | 项目记忆（关键词打分 recall）、全局用户记忆、知识图谱、任务清单，全部注入 system prompt |
| 扩展 | `McpStdioClient`/`McpToolkit`、`SubagentManager` | 零依赖 MCP stdio 客户端（P1）、子代理（共享工具与 context） |
| 工程质量 | `AgentTraceWriter`、`AgentEvalSuite`、权限分级确认、审计、undo、超时钳制 | P0–P4 缺口已全部落地 |

## 二、优势

1. **轻量零依赖**：不引入任何 agent 框架，Java 21 桌面应用内嵌无额外运行时成本；LLM 层只有 205 行，可读可改。
2. **可测试性设计得很好**：`ChatClient` 接口抽象 + `ScriptedChatClient`，`AgentEvalSuite` 用脚本化 client 做**确定性、无网络**的行为回归；`AgentToolContext` 无 Swing 依赖，测试可脱离 UI 驱动完整工具链。
3. **与产品深度耦合是最大护城河**：工具直接操作工作台模型（create_nodes、workbench_edit、graph 系列、run_project 带 beforeLaunch=compile），Agent 能真正改用户的思维导图画布并运行项目——这是通用框架给不了的。
4. **工程护栏齐全**：分级权限（LOW/WRITE/UI/HIGH + 白名单裁剪）、审计日志、可撤销（snapshotWorkbench + undo）、工具超时钳制、失败注入「换一种思路」重试提示、执行后强制总结、消息历史卫生处理（防 OpenAI API 400）。
5. **架构分层清楚**：context（注入）/ registry（注册与校验）/ controller（循环）/ client（模型）四层分离，MCP bridge 复用同一套工具注册，扩展点明确。

## 三、劣势

### 架构与演进

1. **自研协议实现有天花板**：只支持 OpenAI 兼容协议——无 Anthropic/Gemini 适配、无请求重试/退避、无并发请求管理；遇到 reasoning 类模型的非标准行为要自己跟进协议。
2. **核心循环单文件过重**：`AgentChatController` 775 行把 issue 判定、nudge、窗口调整、摘要、子代理全塞在一个类里，后续加特性（并行工具、human-in-the-loop 中断恢复）会越来越难。
3. **无生态红利**：新集成（新的 MCP server 类型、新记忆后端、新的模型供应商协议）都要手写，不像 LangChain 有现成集成。
4. **子代理是简化实现**：共享同一 context 与工具，无独立记忆/权限隔离，只是"嵌套 controller"，编排能力有限。

### 安全与并发

5. **权限模型是 fail-open 的**：`permissionAllowed` 在权限配置为空或未匹配类别时默认返回 true（AgentToolContext :136-139）；`confirmation` 处理器为 null 时直接放行（:123）。默认安全姿态是"允许"，实际防护依赖配置正确 + 用户弹窗判断，配置漏写即全线放行。
6. **无进程/网络级沙箱**：工具（execute_shell、run_project 等）运行在应用 JVM 内，`execute_shell` 仅有命令白名单（mvn/git/java/go/python 等）+ 危险命令分级确认，无 CPU/内存/网络资源限额，无子进程树清理保证——恶意或失控的 prompt 理论上可触达宿主机全部能力。
7. **工具串行执行，长任务阻塞循环**：一轮返回的多个 tool_calls 也是 for 循环逐个执行；build/run 类 300s 长任务期间整个对话循环阻塞，无并行工具执行、无中途进度间插。
8. **并发模型仍有残留风险**：context 里 `toolStopRequested`/`permissionMemory` 历史上是跨 tab 共享的（一个 tab 停止会取消所有 tab），P0 已用 `AgentSessionScope` + ThreadLocal 修复，但 MCP bridge 无绑定线程仍回退到共享兜底——多 tab 并发是已知薄弱面。

### 能力与体验

9. **记忆是关键词打分，不是真正的检索**：`MemoryStore.recall` 是英文词 + 中文 2-gram 打分，无向量化；长会话压缩用本地 `TextSummarizer`（非 LLM 摘要），信息损失明显。
10. **上下文与轮次硬限制**：`MAX_TOOL_LOOP=10` 轮上限、窗口仅保留最近 20 条消息；复杂任务 10 轮内完不成只能被强制总结收尾，长任务连续性依赖摘要质量。
11. **工具结果回传截断**：模型侧默认只收到截断到 4000 字符的结果（`MAX_TOOL_RESULT_CHARS`），大文件/大扫描结果的全貌不可见；虽有 resultStore + read_tool_result 可补救，但依赖模型自己"想起来"去读。
12. **eval 只验证 harness 逻辑，不覆盖真实模型**：`AgentEvalSuite` 用 ScriptedChatClient 确定性回归的是循环/重试/规划等框架行为，真实模型的工具选择与推理质量没有自动化回归，只能靠人工端到端。
13. **文档切换即断上下文**：`clearForDocumentSwitch`/`restoreContext` 使记忆与任务按文档隔离（TaskManager 按 documentId 存储），跨文档的连续任务上下文会丢失，多文档协作场景受限。
14. **无成本/token 预算控制**：会话无 per-session token/费用上限，长任务或失控循环可能消耗超出预期的调用量。

## 四、总结

作为「嵌入桌面产品、驱动真实工作台操作」的专用 agent，这个自研 harness 在工程护栏和产品耦合上做得比通用框架好；代价是协议兼容面窄、核心循环演进压力大、记忆与编排能力朴素。

**最值得优先投入的方向**（按风险排序）：
1. 安全姿态从 fail-open 改为显式配置（默认 deny 或启动时校验配置完整性）；
2. `AgentChatController` 拆分（循环/历史/规划/子代理各自成类），为并行工具与中断恢复铺路；
3. eval 增加真实模型冒烟回归（固定 prompt + 固定工具集，记录工具选择轨迹）；
4. 长会话记忆升级（LLM 摘要或向量检索）以支撑跨文档任务。
