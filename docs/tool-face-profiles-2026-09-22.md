# 主 Agent 工具面分层 + 结果单份投影 + 记忆注入预算（阶段 A）

> 落地日期：2026-09-22
> 前置审计：`docs/token-efficiency-harness-comparison-2026-09-22.md`（Token 效率审计与主流 Harness 对比）
> 代码基线：`9f5edb9`（审计文档口径）→ 本次改动落在 `436cbd3` 之后
> 判据：`test:token-overhead`（A–I 九组）、`test:tool-projection`（A–G 七组）

## 1. 这次到底改了什么

审计的结论是「不是没压缩，而是**压缩前每轮已经背着过宽的固定工具面和若干重复内容**」。阶段 A 只做
**确定性收益**，不引入任何新的模型调用：

| # | 改动 | 一句话 |
|---|---|---|
| P0-1 | **工具面按任务分层**（`tools/profiles.cjs` + 注册表暴露面 + `discover_tools`） | 33 个 schema 不再无条件常驻；用不到的能力不占每轮预算，需要时一条查询取回 |
| P0-2 | **工具结果只向模型投影一次**（`AgentToolResult.modelContent`） | `text` 与 `data` 说的是同一件事时不再发两遍 |
| P1-2 | **记忆自动注入有预算、有命中才注入** | 无关键词命中不再回退「最近 30/20 条」当固定税 |
| — | **规则面与工具面同源** | 规则点名的工具不在面里时，规则一起收敛（否则模型照着规则调不存在的工具） |

## 2. 复跑方法（数字口径）

与审计文档 §3.1 同一条装配路径，全部是本地只读探针：

```bash
node scripts/token-overhead-test.cjs        # 基线 + 各 profile 的固定输入 + 负向 + 变异 + 真实请求体
node scripts/tool-result-projection-test.cjs # 单份投影 + 重复率 + 负向（真实执行 search_files/execute_shell）
```

口径：`toolkit.buildDefaultRegistryWithConfig(...)` → `SubagentManager.register(...)` →
`registry.toOpenAiTools()` → `agent.buildSystemPrompt(...)` → `compaction.estimateTokens(...)`。
「固定输入」= system（含工具引导）+ 该面的 tool schema，**不含**用户历史与工具结果。
请求体数字来自 `scripts/lib/scripted-model.cjs` 记录的真实 `body`（真实 `runAgentChat` 工具循环）。

## 3. 实测数字（2026-09-22）

### 3.1 基线（33 工具；与审计 §3.2 一致，±1.3% 估算器漂移）

| 项目 | 纯代码请求 | 画布请求 |
|---|---:|---:|
| 工具数 | 33 | 33 |
| schema | 7,261 tokens / 20,674 字符 | 同 |
| 固定输入 | **9,493** | **10,232** |

### 3.2 裁剪后

| 场景 | profile | 工具数 | schema tokens | 固定输入 | 降幅 |
|---|---|---:|---:|---:|---:|
| 纯代码 | core + code | 19 | 3,667 | **5,327** | **−43.9%** |
| 画布 | core + code + canvas | 26 | 5,997 | 8,891 | −13.1% |
| 调研（提问含联网/搜索词） | core + code + research | 21 | 3,848 | 5,526 | −41.8% |
| 编排（提问含子代理/并行词） | core + code + orchestration | 25 | 4,885 | 6,716 | −29.3% |

**真实请求体**（同一条 run，只有工具面不同）：

```
未裁剪：tools=33，单轮输入 7,285 tokens
裁剪后：tools=19，单轮输入 3,692 tokens   ← 单轮 −49.3%
```

### 3.3 工具结果单份投影（真实执行，不是构造字符串）

| 工具 | 旧口径字符 | 投影后字符 | 省 |
|---|---:|---:|---:|
| `search_files` | 712 | 328 | −53.9% |
| `find_files` | 416 | 181 | −56.5% |
| `execute_shell` | 217 | 14 | −93.5% |

投影后**没有 `[data]` 段**（重复率 0，满足验收线 `<5%`）；结构化 `data` 仍完整交给 UI / 审计 /
回放 / 子代理合并 —— 省的是重复，不是数据。`get_subagent_task` 的 `JSON.stringify(view)` + `view`
同样收敛成一份。

### 3.4 记忆注入

| 项目 | 旧 | 新（默认） |
|---|---|---|
| 无关键词命中 | 回退最近 30（项目）+ 20（用户）条 | **注入为空**（要看最近的记忆用 `recall`） |
| 单条上限 | 无 | 400 字符（超出截断并标注） |
| 整段上限 | 无 | 两类**合计** 2,000 tokens |

选择器语义（`selectRelevant` / `buildMemoryText`）**没动** —— `recall` 工具与既有用例依赖
「无命中退回最近 N 条」；自动注入走新入口 `buildMemoryInjection`。要旧行为可配
`agent.memory_inject=recent`。

## 4. 验收对照

| 审计验收项 | 结果 |
|---|---|
| 纯代码固定输入 ≤5,500 tokens | ✅ 5,327 |
| 画布固定输入 ≤6,000 tokens | ❌ **8,891**（见 §5） |
| 搜索 / shell 结果重复率 <5% | ✅ 0（无 `[data]` 段） |
| 现有安全 / 恢复 / 工具契约测试全绿 | ✅ `npm test` **96/96**；`check:js` 0 错误；`build` 通过 |
| 6 轮任务总输入下降 ≥35%（阶段 C 目标） | 单轮 −49.3%（真实请求体）；6 轮端到端留给 `test:eval` 真机评测 |

## 5. 未达项与取舍（如实列出）

1. **画布档只有 −13.1%（文档估的是 −48%）**。原因不是实现没做，而是两条纪律：
   - **规则点名的工具必须留在面里**：常驻运行规则 4/5/17/18 直接点名
     `scan_project` / `analyze_project` / `retrieve_context` / `read_file` / `find_files` /
     `list_directory` / `execute_shell` 等；把它们从画布轮裁掉，模型会**照着规则调一个不存在的工具**
     （未知工具失败 + 白烧一轮），这是真实故障模式，不只是浪费。
   - 画布轮的常驻面因此仍带 `retrieve_context`（528）、`execute_shell`（312）等「画布任务也真会用」的工具；
     而画布专属面本身就不便宜（`workbench_edit` 单个 1,073）。
   要更激进可以显式配 `agent.tool_profile=core,canvas`（自行承担规则悬空：那几行规则会一并收敛成占位/省略）。
   真要拿到 −48%，得先把常驻运行规则拆成**按工具面分层的规则块**（审计 §4 P1-1 / 阶段 C 的范围）。
2. **`ask_user` 留在常驻面**（110 tokens）：规则 16 明确「不要调用 ask_user，直接自然语言提问」，
   按文档可以裁掉；但它是交互能力的兜底，110 tokens 不值得拿能力换。
3. **失败结果不做投影**：失败 `[data]` 里的 `code` / `retryable` / `userActionRequired` 是主循环的判据，
   省它会把「可修正的失败」变成「看不出为什么失败」。
4. **`discover_tools` 只在裁剪生效时注册**（不在 `BUILTINS` 里）：否则 `agent.tool_profile=off`
   的请求体会多出一个工具 schema，「不触发时逐字节不变」就不成立。

## 6. 负向判据（不触发时行为逐字节不变）

用改动前的代码（`git archive HEAD` 另存一份）与本工作树**同进程对照**，全部逐字节相同：

- 工具面 JSON（26 / 31 / 33 工具三种装配）；
- `buildSystemPrompt` 三态（纯代码 / 画布 / 带用户级记忆）；
- `buildToolGuide`；
- `buildToolContent` 各形态（ok+data / 重复调用 / 失败 / partial / 标量工具）；
- `buildMemoryText` / `selectRelevant`；
- `loadConfig` 全部既有键（唯一差异是**新增**的 `tools.toolProfile` 与 `memory`）。

另外 `test:prompt-layers` 的 schema 棘轮（≤17,000 字符）在未裁剪路径上**原值未动**（15,896），
说明「默认全量面」没有被悄悄改动。

## 7. 配置

```properties
# 工具面分层：auto（默认，按任务确定性裁剪）| off（不下发裁剪，与没有这个功能逐字节一致）
#              | core,code,canvas（显式指定，core 永远在内，不做关键词推断）
agent.tool_profile=auto

# 记忆自动注入的预算（阶段 A）
agent.memory_top_k=5                  # 项目记忆 top-k（旧值 30）
agent.user_memory_top_k=3             # 用户级记忆 top-k（旧值 20）
agent.memory_max_chars_per_entry=400  # 单条字符上限
agent.memory_budget_tokens=2000       # 两类记忆合计 token 上限
agent.memory_inject=matched           # matched（默认，有命中才注入）| recent（旧行为）
```

## 8. 涉及文件

- 新增：`electron/tools/profiles.cjs`（profile 名单 + 确定性路由，纯函数）、
  `electron/tools/impl/discoverToolsTool.cjs`（取回入口）、
  `scripts/token-overhead-test.cjs`、`scripts/tool-result-projection-test.cjs`
- 修改：`electron/tools/registry.cjs`（暴露面 / schema 缓存 + 哈希 / `toOpenAiTools(names)`）、
  `electron/tools/toolkit.cjs`（`registerDiscoverTool`）、`electron/tools/result.cjs`（`modelContent`）、
  `electron/agent.cjs`（`buildToolContent` 投影 + 规则门控 + `parseMemoryConfig` + `tools.tool_profile`）、
  `electron/ipc/agent.cjs`（定面 + 工具引导按暴露面 + 记忆预算 + `tool_face` run 事件）、
  `electron/memory.cjs`（`buildMemoryInjection`）、`electron/userMemory.cjs`、
  `electron/subagents.cjs`（子代理视图单份投影）、
  `electron/tools/impl/{findFilesTool,searchFilesTool,executeShellTool}.cjs`、
  `scripts/user-memory-test.cjs`（接线判据跟进新入口）、`scripts/run-all-tests.cjs`、`package.json`

## 8.1 续跑（resume）边界：同一 run 的工具面只增不减

续跑时 `intentPolicy` 为空（续跑不分类，见 `ipc/agent.cjs` 的注释），画布层可能因此从「意图 rescue 回来」
变成「省掉」→ 若在续跑时**重新裁一次面**，同一 run 的后半程会**比前半程更窄**：模型上一轮刚调过的工具
突然从 schema 里消失，而历史里还留着对它的调用（前缀也白改一次）。**这是本轮修掉的真实缺陷。**

口径（`profiles.resolveToolProfiles`）：

| 续跑时的情况 | 判定 | 结果 |
|---|---|---|
| 原 run 记录里有生效过的 `tool_face` | `source='resume'` | **原样沿用**那个面（profile 名归一化，未知名忽略） |
| 读不到（旧版本 run / 记录缺失 / 只有未裁剪事件） | `source='resume-full'` | **退回全量面**（不裁剪）—— 「不知道原来有什么」时，多带 schema 只是多花钱，缩窄是能力静默消失 |

`resume` / `resume-full` 的优先级高于显式配置 `agent.tool_profile`（进行中的 run 不受配置改动影响）；
`off` 仍然最高（不裁剪）。判据见 `test:token-overhead` 的 J 组（含「不加 `resuming` 就会得到 auto 面」的
判别力断言，以及真的从 run 记录里读回那个面）。

## 8.2 其余内置工具没有重复回灌（已用探针确认）

除本次投影的 4 个工具外，其余内置工具逐个量过（真实执行 + 比对 `text` 与 `data`）：

- `read_file`：`data` 只有元数据（`path/language/binary/lineCount/truncated/offset/startLine/endLine`，约 128 字符），
  正文只出现一次 —— 这些元数据正是模型分页决策的依据，**不该省**；
- `list_directory`：`data = {count, offset, path}`（35 字符），不是列表本身；
- `scan_project` / `analyze_project` / `project_info` / `code_review`：`data` 是**载荷本身**（树 / 统计 / 结构化分析），
  文本里只有一行摘要 —— 不是重复。

结论：审计点名的 4 个就是全部重复项，没有遗留。

## 8.3 P1-1 前缀重排 + 规则按面分层（第二批，同日）

**目标**：`prompt` cache 命中的是**请求前缀**。重排前「画布清单 / 项目记忆 / 用户记忆」紧跟回复约束
—— 每个提问都会改写第 3 段，等于把后面所有稳定内容（运行规则 ≈3.3k 字符、soul、工具引导）一起踢出缓存。
审计 P1-1 的原话也是「这**主要降低计费与延迟**，不减少上下文占用」—— 本次就是这条。

### 装配顺序（`agent.cjs` 的 `PROMPT_SECTIONS` 是唯一来源）

```
稳定前缀（同一项目 + 同一工具面 → 逐字节相同）
  【回复与编码约束】→【运行规则】→【灵魂设定】→【可用工具】
---- cache boundary ----
动态区段（每轮/每提问可能变）
  【任务相关规则】→【项目 Skills】→【项目长期记忆】→【用户级记忆】→【当前画布节点清单】
```

未登记的新段落一律按**动态**处理（fail-open：宁可放到边界之后，也不让它打断稳定前缀）。

### 规则块拆两段：只搬整行、正文零改字

`RUNTIME_RULE_GATES`（工具面门控：点名了未暴露工具的规则要不要留）与 `TASK_RULE_NUMBERS`
（这行算稳定段还是任务段）**指向同一批编号**（2/6/7/12/19/20），所以一条规则要么两处都登记、要么都不登记。
`splitRuntimeRules()` 只按编号搬运整行 + 把画布建模块（或占位）按编号 14 的位置插进任务段：

- 编号并集**完整**：未裁剪 = 1..19；裁剪（缺 workbench_edit/query_scalars）= 1,3,4,5,7,8,9,10,11,13,14,15,16,17,18,20（2/6/12/19 被门控摘掉，20 是 `discover_tools` 的取回说明）；
- 两段规则行的**集合与拆分前逐字节相同**（用例直接断言，防「搬运时漏行/改字」）；
- 新增字符只有任务段标题（+48 字符）。

### 实测（探针，同一项目、同一工具面）

| 场景 | 重排前公共前缀 | 重排后 |
|---|---:|---:|
| 只改画布内容 | 385 / 5,116 字符（7.5%） | **5,090（99.5%）** |
| 只改记忆 + 技能 + 用户记忆 | 372 / 5,091 字符（7.3%） | **5,001（97.3%）** |
| 跨任务类型（纯代码 vs 画布） | 344 字符 | **2,325 字符** |

规则行「零改字」核对：旧 23 行 / 新 23 行，**集合完全相同**；提示词总长 5,046 → 5,094（+48 = 任务段标题）。
稳定前缀 ≈2,434 字符 ≈1,248 tokens（示例中占 system 的 49%；记忆吃满 2k 预算时约 38%）。
**计费降幅取决于供应商的缓存价**（`costLedger` 已在记 `prompt_cache_hit_tokens`），本次没有做真机 A/B
（需要供应商凭据；`test:eval:model` 是那条路径）。

### 已知边界（不假装做到了）

- 跨任务类型的公共前缀**止于工具引导段**（面不同 → 引导不同）。要再涨就得把引导段也移到边界之后，
  代价是「同一任务类型的稳定前缀」短 288 字符 —— 按现口径不划算，故保留（棘轮判据按实测 2,300）。
- 供应商侧的显式 cache breakpoint（Anthropic 风格 `cache_control`）**没有做**：本 harness 走
  OpenAI 兼容面，DeepSeek / OpenAI 都是**自动前缀缓存**，没有可传的 cache key，重排就是全部杠杆。

## 8.4 第三批：成本归因 / 压缩收益 / 输出分档 / 压缩尾部（同日）

| 项 | 口径 | 判据 |
|---|---|---|
| **P2-2 成本按层归因** | 每次主请求记：`system_static / system_dynamic / tool_schema / memory / rag / project_state / history_user / history_assistant / tool_result / attachment` 十层 + 每种工具的 `raw → model` 投影 + 压缩的 `costTokens → savedTokens` + 供应商报的缓存命中/未命中；**缓存未命中时记「第一个变化的 prompt 区段」**（`agent.splitPromptSections` + 段落比对） | `test:cost-attribution`（守恒、层归属、fail-safe、区段定位、**真 run + 真账本**端到端） |
| **P1-3 压缩收益驱动** | 主口径改 **token**（出厂 8,000，旧的字符阈值降为下界）；`剩余轮数 × (R − S) > (R + S)` 才算得过来；剩余轮数 ≤1 **永不压**；同类工具累计净亏（≥2 次）自动降级为确定性裁剪；记 `netTokensSaved`（收益口径）与 `netTokensImmediate`（单轮差），成本只用供应商**实报** usage；跳过原因进 `compression_skipped` 事件 | `test:compression-roi`（含审计那条 4.33 轮的算式、判别力、端到端压/不压） |
| **P2-1 输出预算分档** | 上一轮调过工具 → tool 档（12k）；否则（首轮/交付/续写）→ final 档（32k）；两档**只往下压**、永不越过 `agent.max_tokens`；正文为空却被截断（reasoning 吃光额度）→ **加预算重试一次**，而不是「从断点接着写」一段不存在的内容（有正文才走补问） | `test:output-budget`（真请求体 max_tokens、负向开关、加预算重试与消息条数） |
| **P1-4 无损操作尾部** | 压缩后的历史 = `[system] → [人话] → [摘要信封] → [最近无损操作组]`；操作组 = `assistant(tool_calls)` + `tool_call_id` 对得上的结果，**绝不切开**，孤儿 tool 消息一条不留；按 token 预算整组取；触发线统一进 `min(window×ratio, inputLimit−buffer, window−max(outputReserve, buffer))` | `test:compaction-tail`（原子配对、预算、两种超预算口径、**压不下来时自动收窄**、结构与接线、公式负向） |

**尾部与「压缩必须真的压下来」的配合**（这条是被现有 `test:compaction` 抓出来的真缺陷）：
第一版实现让尾部把预算吃光 → 压缩后仍超窗 → **主请求一次都发不出去**（预检直接判超窗）。
现在的口径是两段式：

1. **默认「最新操作逐字优先」**（`tail_allow_oversized` 默认 true）：单个操作组超过尾部预算时仍整组保留 ——
   真实场景里一个操作组经常就超过 8k~15k，默认丢弃等于让这个能力几乎不生效；
2. **压不下来就严格重算一次**：若压完仍 ≥ 触发线，按「固定部分（system + 人话 + 摘要）之外的余量」
   用**严格预算**重算尾部（这一次会整组丢弃超预算的大组），纯计算、不额外花模型调用，并在 trace 里
   记 `tailShrunk` / `tailDroppedForLimit`。端到端判据：够大窗口尾部原样进历史（实测 6,613 token，
   `tailShrunk=false`）；紧窗口自动收窄到线下（`tailShrunk=true`），两种情况主请求都发得出去。

实测（真 run，脚本化模型）：压缩一条 30,062 token 的工具结果 → 摘要 14 token，单轮省 30,048；
成本按实报 usage 记 26,300，剩 3 轮的净收益 `3 × 30,048 − 26,300 = 63,844`（单轮口径 +3,748 也一并记）。

**没做的一项（如实列出）**：审计 P1-4 还要求「先 compact，再做不可逆硬裁剪；只有 compaction 失败时才把工具结果换占位符」。
本次**没有改这个顺序**：现行顺序是「硬裁剪是最廉价、最可靠的兜底网，先兜住再考虑花钱调模型摘要」，
把它倒过来意味着在可能完全不需要摘要的场景先付一次 LLM 调用 —— 这会削弱现有的故障恢复链。
要改需要单独一轮、并配「压缩失败 → 仍然硬裁剪」的完整回归。

## 8.5 阶段 B / P0-3：把意图模型从默认热路径移到歧义 / 高风险边界（同日）

审计的问题：一份 1,258-token 的分类 prompt 同时做 intent / risk / authorization，而画布路由大多可由
画布是否为空与关键词确定、文件写/shell/网络的风险已有 descriptor + shell guard + 审批层 ——
**模型分类唯一不可替代的价值是处理歧义**（以及外部副作用动作的授权缺口）。

### 三处口径变化

| 位置 | 旧 | 新（默认） | 效果 |
|---|---|---|---|
| `agent.intent_recognition` | `auto`（画布为空就分类） | **`ambiguous`**（确定性路由判不出来才分类） | 普通代码 run（"读 a.txt"、"把 buildSystemPrompt 改一下"）**0 次**分类调用；只有"这个怎么弄"这类无信号输入才花一次 |
| `agent.intent_action_review` | `risky`（每个写类动作都问） | **`authorization-gap`**（外部副作用 + 静态层会放行才问） | 本地写（write_file / edit_file / workbench_edit / save_project …）**不再问模型**；`execute_shell` 这类外部动作照旧问 |
| 复核触发范围 | `workspace.write`/`project.save`/`shell.execute` | 加 `ui.interact` | 界面动作也是外部副作用（与 `intent.EXTERNAL_CAPABILITIES` 同口径）；它自带强制确认 → 不会多花调用 |

### 确定性路由（新 `electron/taskRouter.cjs`）

`routeTask({prompt, canvas, canvasSummary})` → `{task, ambiguous, profiles, reason}`。
**它是从工具面判定派生的**：canvas / research / orchestration 直接读 `resolveToolProfiles()` 的结论，
所以两个"路由器"不可能给出互相矛盾的答案（同一份知识只写一遍）。`ambiguous` = 没有任何确定性信号
且输入有实质长度 —— 这正是"画布层该不该救回来"真的判不出来的场景。

### 动作级准入（`intent.shouldConsultGuardian`，纯函数）

只有**外部副作用**（capability ∈ shell.execute / network.request / subagent.delegate / ui.interact；
能力说不清时按副作用类别保守处理）**且静态层本来会放行**的动作才问模型。跳过的四种情况：
只读 / 本地效果 / **本来就会问用户** / 规则已拒绝。

有个**第一版写错的地方**值得记下来：判据一度用「有没有免打扰规则命中」当「静态层会不会问」，
但内置工具默认都**不声明** `requiresConfirmation`（实测 `descriptorOf('execute_shell').requiresConfirmation === false`），
所以"没命中规则"≠"用户会被问到"——那种情况下分类收紧恰恰是**唯一**能让它被问一次的东西，
按旧写法会被静默放过（该收紧的不收紧）。现在判据是 `wouldConfirm = 静态层要审批 && 没有免打扰规则命中`。

### 判据 `test:intent-cost-gate`（验收线逐条对应）

- **普通代码 run 的 intent 调用 = 0**（验收线 <0.5 次/run；含糊提问仍会分类一次）；
- 四种动作取舍得端到端覆盖：外部缺口 → 咨询 / 免打扰规则命中（会放行）→ 咨询 / 本地写 → 不咨询 /
  工具自带强制确认 → **不咨询但用户仍被问**（这一条是**安全不变量**：跳过 guardian 后静态层一个字不改）；
- 纯函数层逐条变异 + 兼容档（`auto` / `risky` / `every` / `off` / `never`）不回退；
- `task_route` / `intent_action_review`（含 `consulted` 与 `reason`）都落 run 事件，可回放归因。

### 面板（审计阶段 B 第 4 条）

`agent:metrics` 新增 `auxiliary`：意图识别与结果压缩的**请求数 / 输入 / 输出 / 净节省**
（`costAttribution.summarizeAuxiliary`，账本新增只读的 `records()`）。净节省按 **run 取最后一次累计值** ——
主请求每轮都带一份累计账，逐轮相加会翻好几倍。

### 没做的（如实列出）

- `agent.intent_model` 默认仍是「跟随主模型」：审计建议配便宜模型，但"哪个模型便宜"是部署方知识，
  这里只提供配置项与观测，不替你选。
- `agent.intent_max_tokens` 仍是 1024：审计的"先试 512 + JSON schema"需要在**真机**上验证
  DeepSeek 的 reasoning 是否稳定关闭（审计自己也写了这条caveat），离线判据无法覆盖。
- Structured Outputs / `response_format` 未接：不同网关对未知字段的处理不一致，接了得配兼容回退，
  属下一轮。

## 8.6 P1-2：动态上下文段落的统一 token 预算（同日）

审计原文：「记忆、RAG、画布状态共用一个 `DynamicContextBudget`，避免各模块都认为自己只占一点。」
此前每段各有各的口径 —— 记忆有 2,000 的池子，而**画布摘要与技能索引完全没有上限**，
于是"每段看起来都不大"加起来把固定输入推得很高，而且没有任何一处能回答「这一轮把多少额度花在了哪一段」。

### 新模块 `electron/dynamicContextBudget.cjs`（纯函数，不产生文本、不读 IO、不认识任何具体段落）

```
allocateContextBudget({totalTokens, sections:[{id, desiredTokens, capTokens?, priority?, minTokens?}]})
  → {totalTokens, used, overcommit, granted:{id:n}, trace:[{id, desired, cap, granted, reason}]}
```

规则（确定性）：① 每段先拿 `minTokens` 保底，**保底优先于总预算**（配置错误宁可超一点也要如实报
`overcommit`，绝不静默把某段饿成 0）；② 剩余额度按 `priority` 补齐到 `min(desired, cap)`；
③ 理由只有四种：`full` / `capped`（自己的 cap 咬住）/ `trimmed`（总量不够）/ `starved`（没分到）。

出厂段落表与取值理由：`canvas`(p1, cap 4000) 是**当前任务的直接输入**，最优先但要兜住大画布；
`memory`(p2, cap 2000，与既有 `agent.memory_budget_tokens` 一致) 缺了还能 `recall`；
`skills`(p3, cap 800) 只需索引；`rag`(p4, cap 1500) 本就按需。总预算出厂 **6000**。

配置：`agent.dynamic_context_tokens`（0 = **关闭**这套预算，各段退回自己的口径）、
`agent.dynamic_context_{canvas,memory,skills,rag}_tokens`。

### 裁剪怎么落地（两个纯函数，在 `agent.cjs`）

- `truncateCanvasSummary(summary, budget)`：能解析成 JSON 数组就**按节点粒度**裁（二分找装得下的最大节点数，
  **保持 JSON 合法**）并留「另有 N 个节点未列出，需要时用 get_workbench_model 读取完整画布」；
  坏 JSON 就字符级裁 + 明确标注（不假装完整）；装得下或预算为 0 → **原样返回**。
- `truncateSkillsIndex(text, budget)`：**按整行**裁（不切半句话）+ 「用 read_skill 按名字读取」。

### 关键口径

1. **不触发时逐字节不变**：每段都 ≤ cap 且合计 ≤ 总量时 `granted === desired` → 不重建、不裁剪。
   实测：同一项目内容，`agent.dynamic_context_tokens=0` 与出厂的 system prompt **逐字节一致**
   （off=5062 on=5062 字符）—— 这是这套东西能安全上线的根基，也是判据里最硬的一条。
2. **完整摘要仍留给分类与工具侧**：注入给**模型**的画布摘要是裁剪后的那一份；意图分类与工具上下文
   仍用完整摘要（它们不是提示词固定税）。理由：分类要判"这是不是画布活"，按裁剪后的残片判会失真。
3. **两类记忆共用一个池子的口径没变**：项目级先用，用户级拿剩余（`memCap - rebuiltProj.tokens`）。
4. 每次分配落 `context_budget` run 事件（每段的 desired/granted/reason）——归因面板的数据来源。

### 判据 `test:dynamic-context-budget`（103 项核心套件）

分配器（全额 / 总量不够 / cap / 保底 + overcommit / 关闭 / 配置解析与夹取）、两个裁剪函数
（画布裁完仍是合法 JSON + 取回提示 + 坏 JSON 不抛错、技能整行裁）、端到端三条：
**负向逐字节比对**、超大画布（事件 `capped` + prompt 里 JSON 仍合法 + 总长 34,471 → 14,977 字符）、
总预算 900（画布先拿满 900、记忆被饿到 0，优先级真的在起作用）。

### 没做的（如实列出）

- **RAG 段只占位不裁**：本 harness 的 RAG 是按需工具（`search_project`），不常驻注入提示词，
  所以 `rag` 段的 cap 目前没有消费者；等真加常驻检索片段时直接接这个分配器即可。
- 未做真机 A/B 验证（要凭据，路径 `test:eval:model`）。

## 9. 安全边界（为什么裁剪不会削弱门禁）

- 暴露面**只影响「模型看不看得见」**：`registry.execute()` 的四道门（角色/能力门、网络门、审批门、
  资源租约门）与角色白名单判据都不读暴露面 —— 未暴露的工具照样会被拒绝成
  `PERMISSION_DENIED` / 未知工具。
- 定面在**意图识别之后**（`intentPolicy.routeHint` 是画布判定的一路信号），与提示词层同源；
  判定是纯函数，无模型调用、无 IO。
- 裁剪整体**fail-open**：`discover_tools` 若被 `tools.allowed/deny` 挡掉（用户显式白/黑名单），
  则**放弃裁剪**回旧的全量面并落 `tool_face{applied:false, reason:'no-discover-tool'}` ——
  没有取回入口就裁剪，等于悄悄削减用户允许的能力。
- 每次定面落 `tool_face` run 事件：`{applied, profiles, reason, exposed, hidden, chars, hash, tokens}`，
  `hash` 是同一份面的稳定指纹（后续 P2-2 的成本归因与 P1-1 的前缀稳定性都以它为基础）。
