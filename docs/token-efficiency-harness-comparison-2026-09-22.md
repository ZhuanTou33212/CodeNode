# CodeNode Token 效率审计与主流 Coding Agent Harness 对比方案

> 审计日期：2026-09-22  
> 代码基线：`9f5edb9`  
> 范围：主 Agent 请求、工具 schema、工具结果、意图分类、记忆/RAG、压缩、子代理回灌与 prompt cache 形状。  
> 结论口径：本地数字来自当前代码真实装配后的只读探针；外部产品只采用官方文档或官方仓库，不猜闭源系统的精确 token 数。

## 1. 结论先行

CodeNode 现在最主要的问题不是“上下文没有压缩”，而是**进入压缩前，每一轮已经背着过宽的固定工具面和若干重复内容**。

优先级最高的三个浪费点：

1. **33 个工具 schema 每轮全量发送**：纯代码轮固定输入约 **9,619 tokens**，画布轮约 **10,346 tokens**；对一个 6 轮任务，仅固定部分就约 57,714 tokens，尚未计入用户历史、工具结果和模型输出。
2. **工具结果 `text + data` 双份回灌**：`find_files`、`search_files`、`execute_shell` 等会先把结果写入可读文本，又把相同列表/输出放进 `[data] JSON`，高频结果接近重复一遍；随后 LLM 压缩器还要为这份重复输入付费。
3. **意图模型调用在热路径上偏重**：空画布下默认先做一次轮级分类；每个副作用动作还可再分类，默认最多 5 次。当前单次分类输入约 **1,258 tokens**，输出额度为 **1,024 tokens**。

建议目标不是简单删提示词，而是把 harness 改成：

```text
确定性轻路由
  -> 小型常驻核心工具集
  -> 按任务单调追加的工具 profile / tool search
  -> 稳定且可缓存的前缀
  -> 有 token 上限的动态上下文
  -> 单份模型可见工具结果 + 本地完整结果句柄
  -> 只在预计净收益为正时做 LLM 压缩
  -> “旧摘要 + 最近无损操作尾部”的 checkpoint
```

按当前 schema 实测，只做“按任务裁剪工具面”即可把：

| 场景 | 当前固定输入 | 建议 profile 固定输入 | 预计下降 |
|---|---:|---:|---:|
| 纯代码（15 工具） | 9,619 | 5,057 | **47.4%** |
| 画布（7 工具） | 10,346 | 5,380 | **48.0%** |
| 调研（9 工具） | 9,619 | 3,547 | **63.1%** |
| 极简修改（7 工具） | 9,619 | 3,379 | **64.9%** |

这还没有计入工具结果去重、意图调用收敛、记忆预算和缓存命中改善，因此建议把首阶段验收目标定为：**典型 6 轮代码任务总输入 token 至少下降 35%，成功率与安全门禁不回退。**

## 2. 口径：不要把三种“省 token”混在一起

| 指标 | 含义 | Prompt cache 是否减少 |
|---|---|---|
| 上下文输入 token | 模型本轮真正看到的 system、历史、工具 schema、工具结果 | 否；缓存命中内容仍占窗口 |
| 计费成本 | 供应商按未缓存输入、缓存输入、输出分别计价 | 是；缓存输入通常更便宜 |
| 模型调用次数与输出 token | 主 Agent、意图分类、工具压缩、compaction、子代理各自的调用与输出 | 缓存只能部分降低输入成本，不能消除调用和输出 |

本项目的 `electron/costLedger.cjs` 已能记录 DeepSeek 的 `prompt_cache_hit_tokens` 和 OpenAI 的 `prompt_tokens_details.cached_tokens`，这是优势。但当前优化不应只追求缓存命中：33 个工具即使命中缓存，仍会占上下文，并可能稀释工具选择质量。

## 3. 当前基线量测

### 3.1 复跑方法

量测使用生产同一路径：

- `toolkit.buildDefaultRegistryWithConfig(...)`
- `SubagentManager.register(...)`
- `registry.toOpenAiTools()`
- `agent.buildSystemPrompt(...)`
- `compaction.estimateTokens(...)`

该估算器是项目实际用于 compaction 预检的中英文混合估算器。旧实测文档记录同一份历史估算 331、供应商实际 326，偏差约 1.5%；本文数字仍应看作**当前 harness 的工程估算值**，不是供应商账单承诺。

### 3.2 固定输入

| 项目 | 纯代码请求 | 画布请求 |
|---|---:|---:|
| 已暴露工具 | 33 | 33 |
| system prompt 字符数 | 4,801 | 6,236 |
| tool schema JSON 字符数 | 20,674 | 20,674 |
| 估算固定 token/模型轮 | **9,619** | **10,346** |

固定输入随模型轮数重复出现：

| 主模型轮数 | 纯代码固定输入 | 备注 |
|---:|---:|---|
| 1 | 9,619 | 尚未含用户消息与结果 |
| 3 | 28,857 | 小型修改也很容易达到 |
| 6 | 57,714 | 常见多步代码任务 |
| 12 | 115,428 | 当前默认最大工具迭代数 |

当前最大的单工具 schema：

| 工具 | 估算 token |
|---|---:|
| `workbench_edit` | 1,073 |
| `delegate_task` | 557 |
| `retrieve_context` | 528 |
| `execute_shell` | 312 |
| `ui_control` | 297 |
| `bulk_edit` | 277 |
| `query_scalars` | 263 |

直接删 system prompt 里的“工具名称 + 一句话用途”不是首要收益：它和 schema 有重复，但当前量测只约 **641 tokens/轮**。应先裁 schema，再合并说明。

### 3.3 当前暴露的 33 个工具

```text
get_workbench_model, workbench_edit, scan_project, read_file, write_file,
edit_file, find_files, search_files, list_directory, execute_shell, poll_job,
code_review, ask_user, fetch_url, save_project, bulk_edit, analyze_project,
ui_control, write_analysis_md, project_info, retrieve_context, query_scalars,
remember, recall, update_plan, read_skill, view_image, worktree,
delegate_task, get_subagent_task, cancel_subagent_task, delegate_tasks,
merge_subagent_results
```

代码任务通常不需要画布、UI、长期记忆写入、worktree、子代理合并等 schema；画布任务也不需要完整代码审查/文件编辑/子代理管理面。当前把所有能力常驻，相当于每轮都为所有未来可能性缴税。

### 3.4 意图分类的额外成本

当前 `electron/intent.cjs` 的分类请求：

- 当前样例输入约 1,258 tokens；
- `max_tokens=1024`；
- 轮级默认最多 5 次；
- 动作级默认最多再 5 次；
- 空画布的普通代码请求在 `auto` 模式下也会先分类一次；
- `actionReview=risky` 会在副作用工具执行前追加分类。

所以一个“先分类 + 写文件 + 跑命令”的短任务，可能在主模型之外再做 3 次分类，即仅分类输入约 3,774 tokens，另有推理和输出。安全收益是真实的，但当前分类同时承担“画布路由”和“授权风险判断”，导致低风险路由也必须走模型。

### 3.5 动态上下文的未封顶点

项目记忆与用户记忆虽然按相关性排序，但自动注入分别可取 30 条和 20 条；`buildMemoryText` 没有单条字符上限和总 token 上限。更关键的是：**没有关键词命中时，会回退注入最近 N 条记忆**。这会让不相关记忆变成固定税，也会把动态内容放进 system prompt 中部，破坏后续稳定前缀的跨 run 缓存。

## 4. Token 热点与改进建议

### P0-1：主 Agent 工具面分层，增加延迟加载

#### 问题

`electron/agent.cjs` 每轮都调用 `registry.toOpenAiTools()`；`electron/tools/registry.cjs` 会序列化整个当前注册表。子代理已经按角色裁剪工具，但 supervisor 没有任务级裁剪。

#### 建议

保留一个稳定的核心面，再按任务单调追加 profile：

| Profile | 建议工具 |
|---|---|
| core | `read_file`, `search_files`, `list_directory`, `edit_file`, `write_file`, `execute_shell`, `update_plan`, `discover_tools` |
| code | `find_files`, `scan_project`, `project_info`, `poll_job`, `code_review`, `retrieve_context`, `read_skill`, `view_image` |
| canvas | `get_workbench_model`, `workbench_edit`, `query_scalars`, `write_analysis_md`, `ui_control` |
| research | `fetch_url`, `web_search`（启用时）, `retrieve_context`, `recall`, `view_image` |
| orchestration | `delegate_task(s)`, `get/cancel_subagent_task`, `merge_subagent_results`, `worktree` |

设计纪律：

1. profile 首选确定性规则：显式画布状态/关键词、读写目标、用户点选模式；不要先花一次模型调用决定用哪些工具。
2. 引入小型 `discover_tools(query)`，只返回候选工具的名字和一句描述；需要后从下一轮开始追加完整 schema。
3. 一个 run 内工具集只增不减，新增后保持顺序不变，避免频繁改写前缀造成 cache miss。
4. 安全过滤发生在暴露之前；未暴露工具仍保留注册表执行侧拒绝，不能因为 schema 不可见就放松能力门。
5. `toOpenAiTools(names)` 返回值在 run 开始时缓存；当前同一轮里 compaction 估算、preflight 和正式请求会重复构造 JSON，虽不直接增加远端 token，但浪费 CPU 且容易口径漂移。

#### 当前量测下的收益

代码 profile 15 工具：9,619 → 5,057 tokens/轮；6 轮约少 **27,372 输入 tokens**。

#### 涉及文件

- `electron/tools/descriptor.cjs`：增加 `exposure/profile/searchInfo`。
- `electron/tools/registry.cjs`：支持按名字生成 schema、稳定排序、schema hash。
- `electron/tools/toolkit.cjs`：定义 profile，不再只靠全局 allow/deny。
- `electron/ipc/agent.cjs`：run 开始时选择初始 profile。
- `electron/agent.cjs`：缓存 model-visible specs，处理单调追加。

### P0-2：工具结果只向模型投影一次

#### 问题

`buildToolContent()` 先放 `result.text`，再把 `result.data` 序列化成 `[data]`。不少工具的两者语义重复：

- `find_files`：文件列表同时出现在文本和 `data.files`；
- `search_files`：匹配列表同时出现在文本和 `data.matches`；
- `execute_shell`：命令输出同时出现在文本和 `data.output`；
- 子代理 `get_subagent_task`：`JSON.stringify(view)` 后又附加同一个 `view`。

#### 建议

把“内部完整结果”和“模型可见投影”分开：

```js
{
  ok,
  modelContent,   // 唯一进入 LLM 上下文的紧凑内容
  data,           // UI、审计、回放使用，不自动追加给 LLM
  artifactRef,    // 完整结果的本地内容寻址句柄
  outputDigest
}
```

具体规则：

1. 搜索/文件列表只发一种格式，推荐紧凑纯文本并带分页游标。
2. shell 只发退出码、首尾输出和 `artifactRef`；完整输出留在现有 job/output store。
3. 写工具只发状态、路径、变更摘要和 hash，不回灌 UI 用的完整 data。
4. 需要结构化推理的工具只发 JSON，不再同时造一份自然语言镜像。
5. 对模型投影设**按 token 计的硬上限**，不再使用全局 120,000 字符上限。

这项通常比“再调用一个模型压缩重复内容”更便宜、更确定，也不会引入摘要失真。

### P0-3：把意图模型从默认热路径移到歧义/高风险边界

#### 问题

当前一份 1,258-token 分类 prompt 同时做 intent、risk、authorization 三件事。实际上：

- 画布路由大多可由画布是否为空、显式关键词、用户选择模式确定；
- 文件写、shell、网络、删除等风险已有 descriptor、shell guard、approval service；
- 模型分类的主要独特价值，是处理**授权语义歧义**，而不是替代静态风险表。

#### 建议

1. 默认用确定性 `TaskRouter`：`chat/code/canvas/research/ops` 只决定 profile，不决定放行。
2. 动作风险继续由工具 descriptor + 参数静态分析决定。
3. 只有同时满足以下条件时调用 guardian：
   - 动作有外部/不可逆副作用；
   - 静态授权无法判定；
   - 现有审批规则可能免询问，分类结果会真实改变“是否强制确认”。
4. 已经必定弹用户确认的动作，不再先花一次 guardian 调用；分类不会改变结果。
5. 分类使用便宜模型；支持时用 Structured Outputs/JSON schema，避免用长 prompt 重复描述输出格式。
6. 保留现有“只收紧不放宽”和失败 fail-open-to-existing-policy 的安全不变量。

建议新增配置：

```properties
agent.intent_recognition=ambiguous
agent.intent_action_review=authorization-gap
agent.intent_model=<cheap-model>
agent.intent_max_tokens=512
```

DeepSeek 当前实测 256 额度会被 reasoning 吃光，因此不能机械降回 256；应先验证 512 + JSON schema，若供应商不能稳定关闭 reasoning，再维持 1024 但显著减少调用次数。

### P1-1：重排 prompt，稳定内容在前、动态内容在后

#### 问题

当前 system prompt 顺序大致为：固定回复约束 → soul → 画布快照 → 项目记忆 → 用户记忆 → skill 索引 → 工具引导 → 大段固定运行规则。

画布和记忆位于大段固定规则之前；它们每个 run 都可能变化，会让后续稳定规则无法形成同一个长前缀。项目现在会统计 cache hit，但没有主动构造 cache-friendly prefix，也没有稳定的 `prompt_cache_key` 适配层。

#### 建议顺序

```text
固定安全/执行规则
固定核心工具使用约定
稳定 soul / 项目硬约定
工具 schema（稳定顺序）
--- cache boundary ---
任务 profile 的追加说明
skill 名称索引
相关记忆（有总预算）
画布/项目即时状态
用户本轮请求
```

支持供应商时显式传 cache key/breakpoint；不支持时也保持最长公共前缀。注意：这主要降低**计费与延迟**，不减少上下文占用。

### P1-2：给记忆与 RAG 统一 token 预算

建议自动注入改为：

- 项目记忆 top-k 默认 5，用户记忆 top-k 默认 3；
- 单条最多 400 字符；两类合计默认 2,000 tokens；
- 无相关性命中时自动注入为空，不再回退最近 30/20 条；需要时让模型调用 `recall`；
- 按阈值过滤低分项，不只是按数量截断；
- 记忆、RAG、画布状态共用一个 `DynamicContextBudget`，避免各模块都认为自己只占一点。

可保留 UI 中“最近记忆”展示，但不要默认送给模型。

### P1-3：LLM 工具结果压缩改成收益驱动

#### 当前问题

当前阈值约为 2,400 字符、摘要预算 1,500 字符。假设原文 `R=2400`、摘要 `S=1500`，忽略价格差异：

```text
压缩调用成本约 R + S
每个后续主轮节省约 R - S
回本所需后续轮数 > (R + S) / (R - S) = 4.33
```

也就是说，刚过阈值的结果必须在后面再使用 5 轮左右才可能按 token 数回本；短任务里反而更贵。批量压缩减少固定前缀与请求数，但没有改变这个基本式。

#### 建议

1. 先做确定性投影、分页和句柄，只有投影后仍很大才考虑 LLM 摘要。
2. 用 token 而不是字符判断；建议初始阈值至少 8k tokens。
3. 仅在 `预计剩余轮数 × (原文 - 摘要) > 压缩输入 + 摘要输出` 时压缩。
4. 最后一轮、预计只剩一次模型调用时永不压缩。
5. 压缩专用模型必须显式配置为便宜模型；默认跟随主模型不是成本最优。
6. 记录 `netTokensSaved`，若某类工具长期为负，自动转为确定性裁剪策略。

### P1-4：Compaction 改成“旧摘要 + 最近无损操作尾部”

#### 当前优点

CodeNode 已有 90% 触发、手动 `/compact`、provider overflow 后压缩重试、硬裁剪兜底和压缩事件留痕；这一块的故障恢复比很多轻量 harness 完整。

#### 当前不足

1. 新历史是 `[system, 保留的人类轮次, 一个摘要]`，没有保留最近若干完整的 assistant/tool 操作组。
2. 硬裁剪发生后，到下一轮才因 `lastTrimStats` 触发语义压缩；此时摘要看到的可能已经是占位符，而不是原始工具结果。
3. 触发线主要是 `window × ratio`，没有把输入上限、输出预留和安全 buffer 统一进同一个公式。

#### 建议

采用：

```text
[stable system]
[previous structured checkpoint]
[new structured checkpoint for old history]
[最近 8k~15k tokens 的完整操作组]
[pending user/steer]
```

操作组必须原子保留 `assistant tool_call + tool result`，不能在中间切断。触发公式建议对齐“可用输入上限”：

```text
estimated >= min(inputLimit - buffer,
                 contextLimit - max(outputReserve, buffer))
```

先 compact，再做不可逆硬裁剪；只有 compaction 失败时才把工具结果换占位符。供应商支持原生 compaction 时优先使用原生项，其他兼容接口继续走本地可见摘要。

### P2-1：按阶段分配输出与 reasoning 预算

- 主模型“选择工具”的轮次通常不需要 32k 输出；最终交付轮才可能需要较大额度。
- 意图、工具压缩、compaction 等辅助调用默认关闭 reasoning；供应商若无视该设置，应换辅助模型。
- 不建议简单把主模型全局 `max_tokens` 从 32k 降到 8k：项目已有真实证据表明 reasoning 会吃掉正文额度，并触发多次续写，可能更贵。
- 可采用两档：工具阶段 8k~12k，最终阶段 24k~32k；`finish_reason=length` 的续写只在确实有正文时执行。

### P2-2：让成本账本回答“哪一层在烧 token”

现有账本按 `main/intent/compression/compaction/subagent` 分类很好，但还缺主请求内部构成。建议每次请求同时记录：

```text
system_static_tokens
tool_schema_tokens
memory_tokens
rag_tokens
history_user_tokens
history_assistant_tokens
tool_result_tokens
attachment_tokens
cached_tokens / miss_tokens
```

再增加：

- 每种工具的 `resultRawTokens -> modelProjectionTokens`；
- 每次压缩的 `costTokens -> futureSavedTokens`；
- 每个 profile 的 schema hash 与 token；
- cache miss 发生时，记录第一个变化的 prompt 区段。

没有这层归因，后续很容易出现“总 token 降了，但不知道是任务更短还是 harness 真变轻”的假优化。

## 5. 与主流 Harness 的优劣对比

### 5.1 对比表

| 维度 | CodeNode 当前 | Codex | Claude Code | Aider | OpenCode |
|---|---|---|---|---|---|
| 固定工具面 | **弱**：33 schema 全量常驻 | **强**：官方代码已有 deferred exposure、tool search 与 model-visible specs | **强**：MCP 默认只装名字，完整 schema 按需加载 | **强**：工具面窄，核心围绕编辑/运行 | **中上**：agent 可限制权限/工具，仍需配置好 profile |
| 项目上下文 | 混合 RAG + 标量库 + 记忆，能力强但预算分散 | 按需搜索、严格限制注入项大小 | Skills 按需、path-scoped rules、LSP、隔离 subagent | **强项**：图排序 repo map，有显式 token budget | agent/subagent 隔离，工具与 compaction 可配置 |
| 工具结果治理 | 有单条截断、缓存、批量 LLM 压缩，但存在 text/data 重复 | 官方规则要求所有注入项硬上限，>1k 项重点审查 | 文件读取有输出限制，hooks 默认零上下文 | 以文件/差异和 repo map 为核心，链路更窄 | compaction tail 中工具输出限制长度 |
| Prompt cache | 能统计命中；前缀布局未专门优化 | 官方强调增量构建、避免频繁改写导致 miss | 支持 prompt cache，MCP schema 延迟加载 | 显式组织 system/read-only/repo map/editable files 以利缓存 | 依供应商；checkpoint 与 instruction baseline 分离 |
| Compaction | 三层防线、provider overflow 自救强；缺最近无损操作尾部 | 原生/加密 compaction 能力强 | 自动 compact、可调窗口、`/context` 可观测 | 不是其核心优势 | **文档化最完整**：buffer/output reserve、15k tail、一次 overflow 重试、原生/本地策略 |
| 辅助模型调用 | 意图 + 结果压缩 + compaction，热路径偏多 | 核心能力与模型/Responses 深度协同 | Skills/MCP/subagent 以按需为主 | 可用 weak/editor model，整体链路较简 | title/summary/compaction 等隐藏 agent，策略清晰 |
| 成本可观测性 | **强**：按 kind、缓存命中、reasoning、价格记账 | 有 usage/rollout，但项目级自定义账本需另做 | `/context`、`/usage` 可看 | `/tokens` 与缓存设置清晰 | session/compaction 事件较完整 |
| 安全与恢复 | **强**：审批令牌、side-effect ledger、checkpoint、事件回放、超窗恢复 | 强 | 强 | 较轻量，依赖 git 工作流 | 强，agent 权限清晰 |
| 多供应商适配 | **强**：OpenAI Chat Completions 兼容面广、本地摘要可用 | OpenAI/Responses 优先 | Anthropic 优先，可接云平台 | **强** | **强** |

### 5.2 CodeNode 相对优势

1. **预算和成本是 harness 的一等公民**：主调用、意图、压缩、子代理分账，并识别缓存输入与 reasoning。
2. **失败与恢复链完整**：请求前预算、硬裁剪、语义压缩、供应商 400 自救、运行检查点和副作用幂等都已有落点。
3. **本地数据面丰富**：画布标量、RAG、记忆、子代理信封和统一事件流，适合 CodeNode 的可视化工作台，不是普通 CLI 能直接替代的。
4. **供应商无关**：没有原生 compaction 的 OpenAI 兼容供应商仍可工作。

### 5.3 CodeNode 相对劣势

1. **扩展越多，固定税越高**：新增一个工具就永久扩大所有主轮请求；当前已经从旧文档 24 工具增长到 33 工具。
2. **把安全、路由和上下文压缩过多交给额外 LLM 调用**：静态规则能解决的场景仍可能走分类器/压缩器。
3. **动态上下文没有统一预算调度器**：记忆、RAG、画布、工具结果分别限额，但缺一个总分配器。
4. **compaction 的“最近无损尾部”不足**：摘要后精确操作细节容易丢；硬裁剪后再摘要的顺序也不理想。
5. **缓存只观测、少设计**：能看到命中率，但 system 动态区段与工具面还没有按最长稳定前缀设计。

### 5.4 推荐借鉴，而不是照抄

- 借鉴 Codex：deferred tool exposure、tool search、所有 context item 都有硬上限、保持增量和缓存稳定。
- 借鉴 Claude Code：skill 只常驻描述、MCP schema 延迟加载、路径规则按需、子代理隔离上下文、hook 默认不回灌。
- 借鉴 Aider：repo context 必须有显式 token budget，并按代码依赖/相关性排序；缓存前缀是数据结构问题，不是供应商开关问题。
- 借鉴 OpenCode：compaction 同时考虑 input limit、output reserve、buffer，并保留最近操作尾部。
- 保留 CodeNode 自己的优势：统一账本、审批令牌、副作用幂等、画布标量库、多供应商本地 fallback。

## 6. 建议实施顺序

### 阶段 A：先拿确定性收益（1~2 个迭代）

1. `AgentToolResult` 增加 `modelContent`，停止默认拼接全部 `data`。
2. 给 supervisor 上 code/canvas/research/orchestration profile。
3. schema 在 run 内缓存并记录 hash/token。
4. 自动记忆注入改为“有命中才注入”，加 2k token 总预算。

验收：

- 纯代码固定输入 ≤5,500 tokens；
- 画布固定输入 ≤6,000 tokens；
- 搜索、shell 结果重复率 <5%；
- 现有安全/恢复/工具契约测试全绿。

### 阶段 B：减少额外模型调用

1. 确定性 TaskRouter 替代默认轮级 intent 模型。
2. guardian 只处理授权歧义且会改变审批结果的动作。
3. 工具结果压缩增加净收益判据；默认压缩模型与主模型解耦。
4. 为 intent/compression 增加“请求数、输入、输出、净节省”面板。

验收：

- 普通代码 run 的 intent 调用平均 <0.5 次；
- 已经必定审批的动作不再产生 guardian 请求；
- compression 的累计 `netTokensSaved > 0`；
- 风险分类变异测试和审批测试不回退。

### 阶段 C：重构长上下文与缓存

1. 固定 prompt 前缀重排，动态区段后置。
2. `DynamicContextBudget` 统一分配 memory/RAG/canvas/tool tail。
3. compaction 改成 structured checkpoint + lossless operational tail。
4. provider adapter 支持原生 compaction/cache key，保留本地 fallback。

验收：

- 6 轮代码评测总输入 token 相对当前基线下降 ≥35%；
- 同一 run 第 2 轮起缓存命中率显著上升；跨相似 run 的稳定前缀 hash 一致；
- compaction 后最近 tool call/result 配对逐字保留；
- 长任务成功率、引用正确率、恢复率不低于当前基线。

## 7. 必须新增的回归判据

建议新增以下测试，而不是只看单次真实模型账单：

- `scripts/token-overhead-test.cjs`：锁住各 profile 的工具数、schema token 和固定 prompt 上限。
- `scripts/tool-result-projection-test.cjs`：断言 `text/data` 不重复、完整结果仍可由句柄取回。
- `scripts/prompt-prefix-stability-test.cjs`：记忆/画布变化不能改动固定前缀 hash。
- `scripts/intent-cost-gate-test.cjs`：低风险代码任务零分类；歧义高风险任务必须分类。
- `scripts/compression-roi-test.cjs`：预计净收益为负时不得调用压缩模型。
- `scripts/compaction-tail-test.cjs`：最近完整操作组不被摘要或拆断。
- 真机评测同时记录成功终态、总输入/输出、缓存命中、调用数、wall time，防止“少 token 但多失败/多重试”。

## 8. 外部一手资料

- Codex 官方仓库的 context 规则：要求增量构建、避免 cache miss、所有注入项有硬上限、单项不超过 10k tokens：<https://github.com/openai/codex/blob/main/AGENTS.md#model-visible-context>
- Codex 官方工具路由代码：存在 deferred exposure、tool search 与 model-visible specs：<https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs>
- OpenAI 模型指南：稳定内容前置、动态内容后置，并跟踪 cached tokens：<https://developers.openai.com/api/docs/guides/latest-model>
- OpenAI Responses compaction：<https://developers.openai.com/api/docs/guides/compaction>
- Claude Code 官方扩展/上下文成本说明：skills 正文按需、MCP 完整 schema 延迟、subagent 独立上下文、hooks 默认零上下文：<https://code.claude.com/docs/en/features-overview>
- Claude Code tool search 配置：<https://code.claude.com/docs/en/env-vars#environment-variables>
- Claude Code `/context`、`/compact`、`/autocompact`：<https://code.claude.com/docs/en/commands>
- Aider repo map：图排序并受 `--map-tokens` 预算控制，默认约 1k：<https://aider.chat/docs/repomap.html>
- Aider prompt caching 的上下文组织：<https://aider.chat/docs/usage/caching.html>
- OpenCode V2 compaction：输入/输出/buffer 联合阈值、15k recent tail、原生/本地 checkpoint：<https://opencode.ai/v2/docs/compaction>

## 9. 最终建议

如果只做一件事：**先把 supervisor 的 33 工具改成“核心工具 + 任务 profile + 延迟发现”，不要先继续微调 compaction prompt。**

如果做三件事：

1. 工具 schema 分层；
2. 工具结果单份投影；
3. 意图模型只在授权歧义且会改变审批结果时调用。

这三项直接作用于每个短任务和每个模型轮，收益比“到 90% 窗口才触发”的长上下文优化更稳定。完成后再做 cache 前缀和 checkpoint tail，才能得到一个既省 token、又不牺牲 CodeNode 可靠性优势的 harness。
