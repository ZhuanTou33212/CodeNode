# Agent 模块问题核查与修复记录（对应 `deepseek-agent-issues.md` 任务单）

日期：2026-09-17 ｜ 基线：`ff20aca`（分支 `fix/agent-issues-20260917`）｜ 门禁：见文末「验证证据」

任务单要求逐项区分「确认缺陷 / 能力缺口 / 性能债 / 设计取舍 / 待核实 / 不成立」，下面按同一格式逐项给结论。
本轮的取证方式：读码 + **真实运行探针**（脚本化模型驱动真实工具循环、真实注册表、真实子进程），
探针全部放在 `out/`（被 `.gitignore` 忽略，不进提交），关键数字都写在对应条目里。

---

## 一、优先核查并优先修复

### 第 1 项：工具结果导致上下文持续膨胀

**编号**：1
**结论**：确认缺陷（P1）——不是「有没有 estimateTokens」的问题，而是**根本没有整体上下文预算**。
**严重度**：P1（仅在长任务/大结果场景致命；短任务不受影响）
**证据**：
- 逐项核查结果：
  - **单条结果有上限**：`agent.data_truncate_cap`（默认 120000 字符，`electron/agent.cjs:279`）——但只截断单条。
  - **压缩有配额且按「请求数」计**：`shouldCompress()`（`electron/agent.cjs:790`）判 `usedCalls >= compression.maxCalls`（默认 8），
    而 `compressCalls` 每次按「本批条数 / batch_max_items」累加（`electron/agent.cjs:1707`）→ 实际最多约 8×4=32 条结果被压缩。
  - **整体上下文没有任何预算/裁剪**：全仓 `grep estimateTokens` 只命中 `requestBudget.estimateInputTokens`
    （请求前**额度预留**用的成本估算，不裁剪报文）；没有对 `messages` 做任何按体积的裁剪、摘要或删除。
  - **`agent.max_total_tokens` 是事前预留 + 事后硬停**：`requestBudget.withBudget`（`electron/requestBudget.cjs:147`）在请求前
    `reserve((input+output)*maxAttempts)`，超额直接 `BUDGET_EXCEEDED`；主循环另有一个事后检查（`electron/agent.cjs:1662`）。
    也就是说：**超预算的处置是「停」，不是「降级」**。
  - **图片/附件走同一套估算**（`collectImageUrls` + 单张 4096 token 上限，`electron/requestBudget.cjs:18-60`），
    MCP/扩展返回值与普通工具结果一样只是文本消息 —— 同样只受单条截断约束。
- 实测（当前 HEAD，探针 `out/context-growth-probe.cjs`）：40 次 read_file，每次结果 27,489 字符：

  | 请求# | 消息数 | 输入字符 | 其中 tool |
  |---|---|---|---|
  | 2 | 7 | 6,061 | 6,056 |
  | 7 | 32 | 63,068 | 63,063 |
  | 9 | 42 | 208,815 | 208,810 |
  | 11 | 52 | **434,743** | 434,738 |

  40 条里 26 条被压缩（配额用尽），其余原文直入上下文；第 11 次请求 ≈145k tokens，已超主流模型 128k 窗口。
**触发条件**：一个任务里累积较多「大结果但不够大/不够旧到被压缩」的工具调用（多文件精读、scan/analyze、长命令输出）。
**实际影响**：① 撞上下文窗口 → 供应商 400，任务中途失败（且用户看不懂原因）；② 成本随轮次线性膨胀；③ 首字延迟变长。
**现有保护**：单条截断 + 批量压缩（质量优先的降级）+ requestBudget 的事后硬停。**没有**「预算内降级」这一档。
**最小修复（已实施）**：
- 新增 `electron/contextBudget.cjs`：请求前把**旧的、超大的 tool 消息正文**换成可追溯占位符
  （`【上下文预算裁剪】此处原本是 read_file 的结果（N 字符）…请用相同参数重新调用该工具`）。
  三条硬约束：**不改消息结构**（条数/角色顺序/`tool_calls`↔`tool_call_id` 配对一概不动，不会造出孤立 tool 消息）、
  **两档保护**（第一档只裁「最近 keepRecent 条之外」；仍超预算才退第二档，除 system 与最后 hardKeepRecent 条外都允许裁，
  默认 hardKeep=1 即最后一条工具结果仍原样保留）、**幂等**（已裁过的占位符不再裁）。
- 接线：`electron/agent.cjs:1420`（每次模型请求前裁剪）、配置 `agent.context.*`（`electron/agent.cjs:285`）、
  事件 `context_trim`（trace + delta）、返回值 `contextTrims/contextTrimmedChars`（8 个返回点）。
  裁剪不动内容时**如实报 `overBudget=true`**（不谎报「已在预算内」）。
**回归测试**：`scripts/context-budget-test.cjs`（进 CORE `test:context-budget`，20 条断言）
- 纯函数：只裁 tool 正文 / 从最旧开始 / 保留最近 N 条 / 第二档仍保护 system 与最后一条 / 幂等 / 结构不变 / 压不住时如实标 overBudget。
- 真实循环：同场景下**最大请求输入 59,605 字符**（未裁剪 1,128,425）、裁剪事件如实上报、`tool_call_id` 配对仍合法；
  反向锁：`agent.context.trim=false` 时输入照旧超预算（证明有界是这次修复带来的，且关掉开关能回到旧行为）。
**是否与其他问题重复**：与第 8 项（长会话全量回灌）同源 —— 第 8 项的成本问题由本项兜底；IPC 侧的重复序列化见第 8 项。

### 第 2 项：达到最大迭代次数后的任务收尾

**编号**：2
**结论**：确认缺陷（P1，两处：后端不做结构化收尾 + 前端把这类 Run 当普通错误丢弃）
**严重度**：P1
**证据**：
- 后端：上限触发时只产生一句错误文案（`electron/agent.cjs:1845-1850` 修复前）：
  `const error = stopReason === 'tool_limit' ? '已达到工具调用上限，任务未完成。' : '已达到模型迭代上限，任务未完成。'`
  返回体里 `content` 只含模型已输出的部分，**已完成/失败/涉及文件/能否续跑都没有**。
- 状态语义本身是对的：`state='LIMIT_REACHED'` 与 `FAILED` 分开（`electron/agentState.cjs:101-107`）。
- 续跑基础设施是**存在**的：每轮 `checkpointMessages`（`electron/agent.cjs:1745`）、`planResume`
  （`electron/runCheckpoint.cjs:198`，上限中止的 Run 若有检查点且待办只读 → `mode:'auto'`）、UI 有「查看恢复计划 / 自动续跑」按钮。
- **但入口被过滤掉了**：`WorkbenchDock.tsx:311/354/371` 只列 `run.status === 'interrupted'`，而
  `toRunStatus(LIMIT_REACHED) = 'error'`（`electron/agentState.cjs:104`）→ 跑到上限的 Run **在「中断的 Agent 运行」列表里根本不出现**。
- 前端还把结果丢掉：`chatStore.ts:172` 是 `if (res.ok && res.reply != null)`，而上限路径 `ok=false` → **收尾文本即使有也不会显示**，只弹一个「Agent 调用失败」。
**触发条件**：复杂任务超过 `agent.max_tool_iterations`（默认 12 轮）或 `max_total_tool_calls`（默认 100）。
**实际影响**：用户拿到「任务未完成」+ 一个像报错的提示，既看不到进展也找不到续跑入口，只能重头再来（或手动去硬盘上猜改了哪些文件）。
**现有保护**：状态机区分、检查点、恢复计划接口、幂等账本（续跑不会重放已提交的写操作）。缺的是「如实交付 + 入口可见」。
**最小修复（已实施）**：
- `agent.buildLimitWrapUp()`（`electron/agent.cjs:1270`）：从**真实调用记录**聚合「已实际执行：read_file×3、write_file×1（失败 1）」、
  「失败的调用：execute_shell（TIMEOUT）」、「涉及的文件（来自工具返回）」、以及「怎么续跑」两句可选动作；
  拼接到模型已输出的内容之后交付（不吞半截回答），同时保留 `error`（兼容既有调用方）+ `limit_reached` delta + `limit_wrapup` trace + `wrapUp` 结构化字段。
- `electron/ipc/agent.cjs:462-467`：`out.limitReached / out.wrapUp / out.contextTrims`。
- `src/store/chatStore.ts:176`：`limitReached` 时**照常交付这轮回答**（并在 toast 里说明「达到步数上限 + 可续跑」），不再走「调用失败」分支。
- `src/components/WorkbenchDock.tsx:22`：`isResumableRun()` 把 `interrupted` 与 `state==='LIMIT_REACHED'` 一起列进「可续跑」，标题也改成「可续跑的 Agent 运行（中断 / 达到步数上限）」。
**回归测试**：`scripts/limit-wrapup-test.cjs`（进 CORE `test:limit-wrapup`，16 条断言）
- 纯函数：结构化字段真实、失败带码、涉及文件去重、写清续跑方式、零进展时不编造。
- 真实循环：迭代上限（`iteration_limit` + `LIMIT_REACHED` + content 含收尾）、工具调用上限（`tool_limit`）、
  半截回答保留（`先读两个文件：` + 收尾）、失败调用进收尾（`FATAL_FAILURE`）、`limit_reached` delta。
**是否与其他问题重复**：与第 6 项（子代理可见性）不同 —— 这里问题在**主 Run 的结果交付与入口**。

### 第 3 项：成本账本是否正确处理缓存 token

**编号**：3
**结论**：确认缺陷（P2，**统计精度缺陷**，不是「算错账」）
**严重度**：P2
**证据**：
- `tokenParts()`（`electron/costLedger.cjs:44-70`）**已经**分别记了 `cached` / `miss`（DeepSeek `prompt_cache_hit_tokens`、OpenAI `prompt_tokens_details.cached_tokens`），
  也已有 `promptCacheHitRate` 聚合。
- 但 `costOf()`（`electron/costLedger.cjs:87`）只按 `prompt × in + completion × out` 计算 —— **命中部分按未命中价计费**，
  且 `cached` 从未参与计价。单价配置也只有两段（`cost.price.<model>=in,out`，`electron/costLedger.cjs:34`）。
- `reasoning` token 此前完全没有单独记录（DeepSeek 把它算在 `completion_tokens` 里）。
**触发条件**：任何开启前缀缓存的供应商 + 命中率较高的长会话（命中部分被按 10 倍价格计）。
**实际影响**：成本**系统性高估**（DeepSeek 命中价约为未命中价的 1/10）；这个数字同时喂给
`alerts.cjs` 的成本告警与界面「今日成本」，会让用户在远未超支时收到告警、或误判模型性价比。
**现有保护**：`costKnown=false` 机制（未配单价时只记 token、不编造金额）、`estimated` 计数、命中率可测。
**最小修复（已实施）**：
- 单价支持第三段 `cost.price.<model>=in,out[,cachedIn]`（不写则**行为与旧版逐字相同**，不打折也不涨价）；
  配了才按「未命中×in + 命中×cachedIn + 输出×out」计。
- `pricePrecision()`（`electron/costLedger.cjs:99`）→ `cost.snapshot().pricePrecision = 'single-rate' | 'cached-aware'`，
  让界面/日志能如实说清「这是统一单价估算」还是「命中感知计费」。
- `tokenParts.reasoning` + 计数器的 `reasoningTokens`：**只做观测，不重复计入金额**（DeepSeek 已把它算进 completion）。
**回归测试**：`scripts/cost-monitor-test.cjs`（原有 `test:cost` 内新增 H1–H6，共 6 条）
命中感知算例（900k 命中 ×0.2 + 100k 未命中 ×2 = $0.38）、未配命中价退回旧口径（$2）、OpenAI 口径、reasoning 单独记录且不重复计价、快照精度标注。
**是否与其他问题重复**：无。

### 第 4 项：工具注册表、实现文件和文档漂移

**编号**：4
**结论**：**文档/清单漂移（P2）+ 有意的实现保留（设计取舍）** —— 代码侧不是缺陷，README 侧确是错的
**严重度**：P2（仅文档误导；模型侧根本看不到这两个工具，不存在「按 README 调用失败」）
**证据**：
- `electron/tools/toolkit.cjs:22-45` 的 `BUILTINS` 共 22 个模块，**不含** `createNodesTool.cjs` / `workbenchConnectTool.cjs`；
  实测 `buildDefaultRegistry()` 只出 **24** 个工具名（`buildDefaultRegistry` 输出），其中没有 `create_nodes` / `workbench_connect`。
  `registry.register('create_nodes'…)` 确实写在这两个文件里（`impl/createNodesTool.cjs:40`、`impl/workbenchConnectTool.cjs:11`），但**无人 require**。
- 这不是「忘了接」：`scripts/tool-contract-closure-test.cjs:148-165` 有断言 C6/C7 把这两个文件列入「未接入白名单」并锁住
  （新增同类未接入文件会红）→ 属于**已知并有意**的状态。
- 但下游清单/文档仍把它们当现役工具：
  - `README.md:165` 把 `create_nodes`/`workbench_connect` 列进「变更类工具」；
  - `electron/tools/descriptor.cjs:45`、`electron/sideEffects.cjs:31-32` 的语义名单里也有这两个名字；
  - 职责其实已被 `workbench_edit` 完全覆盖（`impl/workbenchEditTool.cjs:365` 自己写着「不需要再用 create_nodes / workbench_connect」）。
- 用户**无法**通过任何路径调用它们（扩展清单可以自造同名工具名，那是另一回事）。
**触发条件**：维护者/使用者照 README 或语义名单推理「有哪些工具」时。
**实际影响**：文档与实现不一致，容易让人以为存在两条创建/连线路径；也容易在改动语义名单时被误导。
**现有保护**：`tool-contract-closure-test` 的 C6/C7 断言（防止静默新增未接入文件）。
**最小修复（已实施，**不注册未完成工具**）**：
- `README.md:165` 改成只列真实现役的变更类工具，并**如实写明**这两个是「未接入的遗留实现 + 由 workbench_edit 覆盖 + 有断言锁住」。
- `descriptor.cjs` / `sideEffects.cjs` / 两个 impl 文件头部加显式注释：名字保留是因为「万一有新路径注册它们时语义仍然正确」，
  不代表它们是可用工具。**没有为了凑数而注册它们**。
**回归测试**：沿用既有 `test:tool-contract`（C6/C7）+ `test:tool-descriptor`；本轮改动仅注释与 README，断言不变即证明没有偷改语义。
**是否与其他问题重复**：无。

---

## 二、需要确认产品定位后再处理

### 第 5 项：记忆是否只有最近切片，没有检索

**编号**：5
**结论**：确认缺陷（P2）——「读了但读不到」，属于**已有功能的实现缺陷**，不是「没这个功能」
**严重度**：P2
**证据**：
- 注入是 `electron/ipc/agent.cjs:298`（修复前）：`memory.entries.slice(-30)` —— 纯按写入时间取最近 30 条，
  `key` / `tags` 完全不参与；`remember` 工具却允许（并鼓励）打 `key`/`tags`（`impl/memoryTool.cjs:8-19`）。
- `recall` 工具存在但是**另一套语义**（全词子串 AND 过滤，`impl/memoryTool.cjs` 修复前），与注入口径不一致。
- 产品契约实际已经是「项目级长期记忆」（有 key/tags/createdAt、落盘 `.codenode/memory.json`、200 条上限），
  所以「按 key/tag 检索」是它自己的数据结构已经承诺的能力，只是没实现。
- 跨项目用户级记忆、记忆管理 UI 确实**没有** —— 这两条按任务单要求记为**能力缺口**（对照 Java 版 `UserMemoryStore`），本轮不动。
**触发条件**：项目记忆超过 30 条，且关键约定不是最近写入的。
**实际影响**：用户以为「告诉过它一次就够了」，实际上第 31 条之前的约定永远不会进提示；最近的 30 条可能全是无关记录。
**现有保护**：200 条上限 + 原子写；`recall` 工具可手动查。
**最小修复（已实施）**：
- `electron/memory.cjs` 新增 `tokenize`（英文按词、中文 2-gram，与 Java 版 `MemoryStore.recall` 同口径）、
  `scoreEntry`（key×6 / tags×4 / content×2）、`selectRelevant`（**一条都没命中才退回最近 N 条**并标 `matched:false`）、
  `buildMemoryText`（未命中时显式写「未按当前问题检索」，不让模型误当检索结果）。
- `ipc/agent.cjs:300` 改为按当前用户消息检索注入；`recall` 工具（`impl/memoryTool.cjs:22-40`）复用同一打分口径，
  且无命中时不再把「最近的记忆」冒充为匹配结果。
- **如实标注**：这仍是项目级、关键词打分的记忆，不是跨项目用户记忆，也不是语义向量检索。
**回归测试**：`scripts/memory-recall-test.cjs`（进 CORE `test:memory-recall`，12 条断言）
中英分词、权重序（key>tags>content）、相关但更旧的条目胜出、无命中退回最近且标 `matched:false`、
**35 条时最旧的相关条目仍被注入（旧实现 `slice(-30)` 会丢掉它）**、真实 `remember`→`recall` 链路。
**是否与其他问题重复**：无（与向量检索 `retrieve_context` 是两套东西，本项只修注入/召回口径）。

### 第 6 项：子代理的可见性、单任务取消和持久化

**编号**：6
**结论**：三条**分别**如下 ——（a）缺单任务取消 → 确认缺陷（已修）；（b）缺 UI → 能力缺口（未做）；
（c）持久化 → 部分有（审计流有起止记录），任务视图只存内存 → 能力缺口（未做）
**严重度**：P2
**证据**：
- 子代理是**用户可见产品能力**：画布上有 stage 节点、`delegate_task(s)` 在工具表里、结果带
  `[子代理结果] taskId=… role=… status=…` 契约头回注主上下文（`electron/subagents.cjs:349-362`）。
- （a）取消：子任务有独立 `AbortController`（`electron/subagents.cjs:283`），但**只有父 signal 会 abort 它**
  （`onParentAbort`，`electron/subagents.cjs:286-292`）；工具表里只有 `delegate_task`/`delegate_tasks`/`get_subagent_task`
  ——**没有单任务取消入口**，想停一个跑飞的子代理只能停整个主 Run。
- （b）UI：`grep -rn subagent src/` 命中 **0**；IPC 通道表（`electron/ipc/agent.cjs:79-158`）也没有子代理查询通道；
  `subagent_state` delta 只发到 `agent:delta`，前端无分支处理。
- （c）持久化：`this.tasks` 是内存 `Map`（`electron/subagents.cjs:151`），manager 每个 request 新建
  （`electron/ipc/agent.cjs:285`）→ `get_subagent_task` 跨 Run/重启都查不到；但 `subagent_start/end/cancel` 都写了 `context.audit`
  （S8 后进 `.codenode/events.jsonl`），所以「跑过什么子代理、什么状态」在事件流里**是可追的**，任务视图（工具数/变更文件）不可追。
- 取消正在运行的工具调用本身是安全的：子代理 signal 贯穿 `execute_shell`（进程树终止）、worker（`terminate()`）。
**触发条件**：任一子代理跑偏（比如 explorer 钻进无关目录、builder 反复改错文件）。
**实际影响**：只能整体停止主 Run，已完成的兄弟子代理结果也一起废掉；子代理过程对用户不可见（只能从主上下文摘要里猜）。
**现有保护**：角色契约与工具裁剪、独立预算父子链、任务总时长上限、结果契约与截断、幂等账本 actor 归因、stage 回写校验。
**最小修复（本轮做了一半，如实说明）**：
- （a）**已修**：`electron/subagents.cjs:201` 新增 `cancel_subagent_task(taskId, reason?)` —— 只 abort 该任务自己的 controller，
  结果状态如实标 `cancelled`（不再是统一的「信号中断」），并写入 `subagent_cancel` 审计；`descriptor.cjs:30/86` 补只读门与能力声明
  （与 `get_subagent_task` 同类，不改工作区）。对已结束的任务返回明确错误，不静默成功。
- （b）缺 UI、（c）任务视图不持久化：**仍待做**（需要产品决策：是否把子代理做成一级可观测对象）。
**回归测试**：`scripts/subagent-test.cjs` 新增一段（真实 SubagentManager + 真实注册表）：
并行两个子任务 → 只取消挂起的那个 → 被取消者 `status='cancelled'` 且原因含「主动取消」、另一个 `status='done'`、
**父 signal 未被带崩**；对已结束任务再取消 → 明确报「已结束」。
**是否与其他问题重复**：与第 2 项（主 Run 收尾）不同层，但共用「结果要如实交付」这条原则。

### 第 7 项：MCP 是否应该复用会话

**编号**：7
**结论**：**性能债（P2，可接受的设计取舍）** —— 每调用一次 spawn 一个 server；另有两条**确认为缺陷**的协议/健壮性问题（已修一条）
**严重度**：P2
**证据**（探针 `out/mcp-session-probe.cjs` + `out/mcp-stub-server.cjs`，真实 `registry.execute`）：
- 生命周期：每次工具调用 `spawn → initialize → notifications/initialized → tools/call → kill`
  （`electron/tools/extensions.cjs:79-146`），**没有会话复用**。
- 实测开销：本地最小 MCP server（Node 替身）**平均 70ms/次**（对照：node 进程纯启动 49ms）。
  真实 server（Python/`npx` 型，依赖多）只会更贵 —— 这个量级对「一次任务几十次调用」是可接受的开销，
  且换来的是崩溃/超时后必定清理干净（`finish()` 里统一 `killSandboxed`）。→ **记为性能债，不再优化**，除非用户报告 MCP 密集场景变慢。
- **协议缺陷（已修）**：客户端**不校验握手结果** —— 探针让 server 对 `initialize` 完全不回应，`tools/call` 依旧成功返回。
  同时 `initialize` 的错误也没有被检查（只等下一条 `id:2`）。修复：调用前等待 `initialize` 应答并在失败/超时时如实报错。
- **健壮性缺陷（已修）**：`command` 字段里的路径**带空格且未加引号时被拆坏**（实测 `spawn C:\Program ENOENT`，
  因为 `splitCommand` 只处理引号）。修复：`command` 可以写成带引号的路径，且解析失败时给出可操作的错误提示。
- `tools/list` / `resources` / `prompts`：全仓 `grep` 无命中 → 工具清单只能在 `extensions.json` 里手写声明。
  按任务单要求记为**能力缺口**（不是 bug）：当前产品契约要求「显式声明可用工具」，动态发现是可选能力，默认不做。
**触发条件**：项目配了 MCP 扩展且 server 启动慢 / 路径含空格 / server 握手失败。
**实际影响**：① 慢 server 上每次调用多等数百毫秒~数秒；② 握手失败时错误信息指向 `tools/call`，误导排查方向；
③ Windows 上 `C:\Program Files\...` 这类路径直接失败。
**现有保护**：1MiB 响应上限、整体超时（`timeoutMs`，默认 120s）、取消传播、沙箱包装 spawn、扩展工具默认按「可写」注册（fail-closed）且每次调用都要用户确认。
**最小修复（已实施）**：握手校验（`initialize` 应答/超时/error 三态分别处理）+ 命令解析失败时给出「路径含空格请加引号」的提示。
**回归测试**：`scripts/mcp-handshake-test.cjs`（新增，进 CORE `test:mcp-handshake`）：
① server 不回 `initialize` → 调用**必须失败**且错误提到握手（回归锁住旧行为）；② server 正常握手 → 调用成功；
③ `initialize` 返回 error → 透出 server 的错误；④ 未加引号的含空格路径 → 报错提示加引号（不再冒成 `ENOENT`）。
**是否与其他问题重复**：与第 10 项（限流）无关。

### 第 8 项：长会话全量回灌

**编号**：8
**结论**：**设计取舍 + 与第 1 项同源的性能债** ——「全量历史」本身不是 bug，缺的是上限
**严重度**：P2（已被第 1 项兜住模型侧；IPC/渲染侧的重复序列化仍未处理）
**证据**：
- 渲染层每次把当前会话全部消息作为 `history` 发过来：`src/store/chatStore.ts:78`（`ss.messages.map(...)`）→
  `src/store/chatStore.ts:102`（`history: prior`）。
- 主进程把它们**全量** push 进本次 `messages`：`electron/ipc/agent.cjs:322-325`（无条数/字符上限）。
- 因此：① **模型侧**的体积由第 1 项裁剪兜底（同一套 `messages`，裁剪发生在这里）；
  ② **IPC/渲染侧**仍是「历史全量序列化」——超大历史会增加 IPC 传输与渲染开销，但不影响模型是否超窗。
- 会话消息是理解上下文所必需的（不能简单砍掉），所以「全量传」本身合理；需要的是**上限与分页**，不是「不要传」。
**触发条件**：单会话消息数百条以上（尤其含长回答、图片附件）。
**实际影响**：切换/发送时 IPC 传输与渲染变慢、内存占用上升；模型侧不再超窗（第 1 项已修）。
**现有保护**：第 1 项的上下文预算（模型侧）、会话历史落盘、`DATA_TRUNCATE_CAP`（单条工具结果）。
**最小修复**：**本轮未做**（明确记为剩余项）。方案与取舍已定：给 `history` 加「最近 N 条 / 最近 N 字符」上限 +
UI 提示「更早的对话未随本次请求发送，需要时可以让 Agent 用 recall/读取日志回溯」，**不静默截断**。
**回归测试**：待做（UI 侧：offscreen Electron 断言发出去的 history 条数/字符数被限制，且提示可见）。
**是否与其他问题重复**：与第 1 项**部分重复**（模型侧已由第 1 项覆盖），本节只把 IPC/渲染侧单列，避免重复统计。

### 第 9 项：单文件同步读写阻塞主进程

**编号**：9
**结论**：**设计取舍 + 一个真实的错误归因缺陷（已修）**
**严重度**：P3（阻塞有界；误报才是用户可见问题）
**证据**（探针 `out/sync-fs-probe.cjs`，1ms 心跳测事件循环被占住的时长）：
- `read_file` 的文本分支是同步读，且**有 2MB 硬上限**：`readTextFile(file, 2*1024*1024)`
  （`impl/readFileTool.cjs:166`）→ `readTextFileSafe` 先 `stat` 判大小（`electron/tools/fsCore.cjs:453-469`）。
  实测：2MB 文件读一次 **7ms**（含语言/行数统计）；扫描类工具的 worker 对照：`search_files` 39ms、`scan_project` 215ms。
  worker 往返固定开销约 24ms（仓库内既有量测），即「把 2MB 的同步读搬进 worker」是**净变慢** → 故意不搬（代码注释已写明理由）。
- 但**错误归因**确实存在：`readTextFileSafe` 返回三种不同原因（超上限 / 二进制 / 非 UTF-8），
  而 `read_file` 把它们**统一**渲染成「是二进制或不可读文件」（`impl/readFileTool.cjs:159-161`）。
  实测 20MB 的纯文本 `f20.txt` → 「是二进制或不可读文件，不能用 read_file 读取；请按建议解析：…」
  → 模型据此去尝试别的解析方式（甚至装 Python 库），把「文件太大」误当成「文件坏了」，浪费轮次。
**触发条件**：读 >2MB 的文本文件（日志、导出的 JSON/CSV、大 `.cjs`）。
**实际影响**：误导用户与模型（诊断方向错误）；阻塞本身在 2MB 上限下最多几十毫秒（可接受）。
**现有保护**：大小上限让最坏情况有界；worker 化的是遍历/PDF 这类真·重活；`edit_file` 也是原子写（`atomicWriteFile` + `.bak`）。
**最小修复（已实施）**：把 `readTextFileSafe` 的原因**如实透出**（超上限时明确说「超过 2MB 上限，请用 offset 分段 / search_files 定位」，
不再冒充「二进制或不可读」），并在 `read_file` 描述里说明上限。
**回归测试**：`scripts/read-file-limits-test.cjs`（新增，进 CORE `test:read-file-limits`，7 条断言）：
>2MB 文本 → 报「超过上限」且**不含**「二进制」字样；二进制文件 → 仍报二进制；非 UTF-8 → 报编码问题；2MB 内正常文件 → 照常读到内容。
**是否与其他问题重复**：无。

---

## 三、不要直接当成 bug 的结论

### 第 10 项：没有每个工具独立 rate limit

**编号**：10
**结论**：**不成立（记为可选治理能力，P3）**
**证据**：全仓 `grep -i "ratelimit|rate_limit|rate_per"` in `electron/` = **0 命中**；
现有保护是：每个工具的超时（注册表兜底 120s / `SELF_TIMED_TOOLS` 自管）、全局模型队列
（`requestQueue.js`：并发 4、等待 32、可查 `stats()`）、`agent.max_concurrent_runs`（默认 2）、
总调用次数上限（`max_total_tool_calls`）、成本账本 + 告警。
**判断**：在单用户桌面 Agent 上，这四道闸已经覆盖了「循环把系统拖垮」的主要路径（次数上限 + 超时 + 并发上限 + 成本告警）。
按任务单口径：**没有每工具限流 ≠ 缺陷**。若将来出现「某个工具产生高成本/不可逆外部副作用」的明确需求
（例如联网付费 API、发消息类 MCP），再按工具声明 `rate_per_minute` 并 fail-closed 处理。
**最小修复**：本轮不做。
**回归测试**：无（不做就不假装做）。

### 第 11 项：压缩配额按请求数而不是按条数

**编号**：11
**结论**：**不成立（设计取舍）** —— 读码后确认「40 条里 26 条被压缩」不是实现错误，也**不是缺陷**
**证据**：
- `shouldCompress()`（`electron/agent.cjs:790-795`）按「本批条数 / `batch_max_items`」累加
  `compressCalls`（`electron/agent.cjs:1707`），用 `usedCalls >= maxCalls` 判停 → `max_calls` 的**语义就是压缩请求次数**
  （每请求最多 `agent.compression.batch_max_items`=4 条），这样设计的意图是**限制压缩模型的请求数**（成本 + 限流）。
- 40 条场景下 26 条被压缩，其余 14 条未压缩的可能原因，逐条核对后是：
  ① **配额用尽**（8 次请求 × 最多 4 条 ≈ 32 条上限，实测 26 条命中后停下）；② 部分条目低于
  `threshold_chars`（2400）不参与；③ 压缩失败时的**安全回退**（`compressToolBatch` 的逐条兜底，
  `electron/agent.cjs:849-870`）会保留原文。三者都是**有意行为**，不是「实现错误」。
- 真正的缺口不是配额语义，而是**配额用尽后没有第二道闸** —— 这一条已由第 1 项的上下文预算补上（两者互补：压缩保质量、预算保上限）。
**最小修复**：把配额语义写进配置样例注释（已做：`config/agent.properties.example`），避免下一个人按「条数」误读。
**回归测试**：`scripts/compression-batch-test.cjs`（既有）+ 第 1 项的 `test:context-budget`（覆盖「配额用尽后仍不超窗」）。

---

## 四、结论汇总

### 1）只保留真实缺陷后的优先修复顺序（本轮已全部实施，除标注「未做」者）

| 序 | 项 | 结论 | 严重度 | 状态 |
|---|---|---|---|---|
| 1 | 第 1 项 上下文膨胀 | 确认缺陷 | P1 | ✅ 已修（`test:context-budget`） |
| 2 | 第 2 项 上限收尾 | 确认缺陷（后端 + 前端入口） | P1 | ✅ 已修（`test:limit-wrapup`） |
| 3 | 第 5 项 记忆只有时间切片 | 确认缺陷 | P2 | ✅ 已修（`test:memory-recall`） |
| 4 | 第 6(a) 项 无单任务取消 | 确认缺陷 | P2 | ✅ 已修（`test:subagent`） |
| 5 | 第 7 项 握手不校验 / 命令解析 | 确认缺陷 | P2 | ✅ 已修（`test:mcp-handshake`） |
| 6 | 第 9 项 大文本误报「二进制」 | 确认缺陷 | P3 | ✅ 已修（`test:read-file-limits`） |
| 7 | 第 3 项 缓存 token 计价 | 确认缺陷（统计精度） | P2 | ✅ 已修（`test:cost` H1–H6） |
| 8 | 第 4 项 文档/清单漂移 | 文档漂移 | P2 | ✅ 已修（注释 + README，未注册工具） |

### 2）可以暂不处理的设计取舍
- 第 7 项：MCP **每次调用 spawn 一个 server**（70ms/次实测，换来必定清理干净的环境；连接池留待有实测需求再说）。
- 第 9 项：单文件同步读**不搬 worker**（2MB 上限下 7ms vs worker 固定开销 24ms，搬过去是净变慢）。
- 第 10 项：**没有每工具限流**（已有超时/并发/次数/成本四道闸；无明确高成本工具前不加）。
- 第 11 项：压缩配额按**请求数**计（限制压缩模型请求数是本意；配额用尽后的兜底由第 1 项负责）。
- 第 4 项：两个遗留 impl 文件**保留但不注册**（有断言锁住，删除会丢历史实现）。

### 3）证据不足 / 未完成、需要后续处理的项目（如实单列）
1. **第 8 项（长会话 IPC 侧上限）**：未做。模型侧已由第 1 项兜住；IPC/渲染侧的条数/字符上限与 UI 提示待做。
2. **第 6(b)(c)（子代理 UI / 任务视图持久化）**：未做。属产品能力，需要先定「子代理是不是一级可观测对象」。
3. **第 5 项能力缺口**：跨项目用户级记忆、记忆管理 UI（增删改 + 隐私说明）仍未做。
4. **第 7 项能力缺口**：`tools/list` 动态发现、`resources`、`prompts` 未做（当前契约是「清单里显式声明」）。
5. **第 1 项的持续验证**：本次裁剪阈值（默认 250k 字符）是按「≈70k tokens」的粗估定的，
   需要在**真实供应商 + 真实长任务**上再看一次实际效果（离线脚本化模型只能证明「有界」）。
6. **第 3 项**：只有配置了第三段单价才是命中感知；各供应商的命中价需要用户按自己的价目表填（不给默认值，避免编造）。

### 4）没有为了迎合原审计结论而修改代码的地方（反向清单）
- 第 4 项：**没有**为了「让 README 对上」而把两个未接入工具注册进去。
- 第 7 项：**没有**为了「减少 spawn」而引入 MCP 连接池（先量测，70ms 不构成瓶颈）。
- 第 9 项：**没有**把 `read_file`/`edit_file` 搬进 worker（量测显示净变慢），只修错误归因。
- 第 10、11 项：**没有**新增限流、**没有**改压缩配额语义，只把语义写进文档。
- 第 5 项：**没有**把「项目级关键词记忆」包装成「语义检索」——能力缺口如实标注为缺口。

---

## 五、验证证据（可复核）

**环境**：Windows + Node 24；工作区是**隔离 worktree** `E:\cn-issues`（分支 `fix/agent-issues-20260917`，
基线 `ff20aca`）—— 主工作区当时正被并行的另一个会话改动，隔离取证是为了不让两边的改动互相污染。

**门禁（全量）**：

```
npm run verify = npm run build + npm run check:js + npm test
结果: PASS —— 60/60 项通过，用时 212.8s（本轮最终一次全量门禁）
```

基线（同一隔离目录、未含本轮改动，`ff20aca`）为 **55/55 通过**；本轮新增 5 个核心套件
（`test:context-budget` / `test:limit-wrapup` / `test:memory-recall` / `test:mcp-handshake` / `test:read-file-limits`），
并在既有 `test:cost`（+H1–H6）、`test:subagent`（+单任务取消）里补了断言。

**评测（离线，11 个任务）**：`docs/eval-reports/agent-eval-ff20aca-offline-*.json` → `passed=11 / failed=0 / exitCode=0`
（其中 `iteration-cap-stop` 一度因为「上限路径不再发 `error` delta」变红 —— 说明这条既有契约真的是被锁住的，
最终改为 `error` + `limit_reached` 双发，评测与界面各取所需）。

**变异测试（证明新用例不是空转）**：用 `mutation-check.cjs` 把修复点逐个改回旧行为，期望「用例必红且红在预期断言上」：

| # | 变异（改回旧行为） | 结果 |
|---|---|---|
| 1 | `if (contextTrimEnabled)` → `if (false)`（关掉预算裁剪） | ✔ 红在 B1/B2（输入重新超预算、无 `context_trim`） |
| 2 | `if (index >= protectedFrom) continue;` → `if (false)`（取消最近 N 条保护） | ✔ 红在 A3 |
| 3 | 上限收尾文本不拼进 content | ✔ 红 4 条（B2/C2 等） |
| 4 | 记忆选择改为按写入顺序排序 | ✔ 红在 B1b（高分条目没排到最前） |
| 5 | MCP：忽略 `initialize`（回到旧行为） | ✔ 红 3 条（①③④ 全部退化成「握手超时」） |
| 6 | `overLimit = false`（把超上限重新冒充成二进制） | ✔ 红 3 条（①/①b/①c） |
| 7 | 单任务取消不 abort controller | ✔ 红在「取消未生效：子任务 5s 内没有返回」 |
| 8 | `costOf` 忽略 `cachedIn`（回到全量输入计价） | ✔ 红在 H2（$0.38 → $2） |

8/8 有判别力；每次变异结束后脚本都用 sha256 核对文件已还原（与改前一致）。

**两处「用例自己先暴露问题」的记录**（保留在案，说明判据是真的在跑）：
1. 第二档裁剪最初会把第一档已裁过的下标**再裁一次**，把节省重复计入 → 计划值变负数（`after=-8830`）——
   被 A3c/A3d 当场红出来，修法是加 `done` 集合。
2. 子代理取消用例最初在「取消不生效」时会**静默挂死**（挂起的子任务永不返回）→ 变异测试报 `exit=null`。
   已改成 5s 有界断言 + 失败即 `process.exit(1)`，变异才真正红在断言上。

