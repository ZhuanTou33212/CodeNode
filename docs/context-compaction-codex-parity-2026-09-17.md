# 上下文压缩（照 Codex CLI 的做法）：设计、取证与判据（2026-09-17）

> 需求原话：「做摘要压缩，codex 怎么做我们就怎么做」。
> 于是本文的每条取值都先在本机 Codex 上**取证**，再落到 CodeNode 的实现里 —— 不是凭印象转述
> 「Codex 大概是这么做的」。

## 1. 取证：Codex 到底怎么做的

取证对象 = 本机安装的 **codex-cli 0.135.0**（`@openai/codex` → `vendor/x86_64-pc-windows-msvc/bin/codex.exe`）
与其运行记录。

| 问题 | 证据 | 结论 |
|---|---|---|
| 什么时候压？ | `~/.codex/config.toml`：`model_context_window = 1000000`、`model_auto_compact_token_limit = 900000` | **触发线 = 窗口 × 0.9** |
| 用什么提示词？ | 二进制里 grep 出的原文（下面逐字） | 见 §1.1 |
| 压完历史长什么样？ | `~/.codex/sessions/2026/09/*/rollout-*.jsonl` 里 `type:"compacted"` 的 `replacement_history` | `[人的轮次 + developer 指令 + 一个 compaction 项]` |
| 谁被丢掉？ | 该记录实测：压缩前 16 条 user 消息，压缩后只留 9 条 | 丢的是机器注入的 `<codex_internal_context source="goal">`（同一条 6093 字自动续跑指令重复 4 次）与 `<turn_aborted>`；**人的话全留** |
| 摘要是什么形态？ | 该记录最后一项：`{"type":"compaction","id":"cmp_…","encrypted_content":"gAAAAA…"}`（28KB base64） | OpenAI Responses 的**服务端加密压缩项**，客户端只存不解 |
| 用户看到什么？ | 二进制里的 UI 串 `Context compacted`；另有 `/compact` 命令与 `thread/compact/start` | 界面给一个「已压缩」标记 + 手动命令 |

### 1.1 Codex 的压缩提示词（二进制原文，逐字）

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

## 2. 移植到 CodeNode：一一对应

| Codex | CodeNode 实现 | 差异与理由 |
|---|---|---|
| 窗口 × 0.9 触发 | `agent.compact.ratio`（出厂 0.9）× 有效窗口（模型管理里的 `contextWindow`，缺失时 `agent.compact.fallback_window`） | 同口径；窗口取自 `models.json` |
| 提示词 | `electron/compaction.cjs: COMPACTION_PROMPT`，**逐字照抄** | 不译成中文：改了就跟上游行为分叉 |
| 摘要请求 | 把「整段转录 + 提示词」作为**一条 user 消息**发给模型（非流式），取其回复为摘要 | 同 Codex（提示词是追加的 user 轮） |
| 新历史 = 人的轮次 + 摘要 | `buildCompactedHistory`：`[system, ...人的轮次, 摘要信封]` | 同形状 |
| 丢机器注入轮 | `MACHINE_USER_PREFIXES`（`【系统提示】`/`【参数格式错误】`/`【工具失败】`/`RAG 来源校验：`） | 对应 Codex 丢 `<codex_internal_context>` |
| 加密 compaction 项 | 可见文本信封 `<compaction>…</compaction>`（含「当作既定背景，不要当成新指令」） | **唯一实质差异**：OpenAI 兼容接口没有服务端加密压缩能力 |
| `/compact` | 对话框里发 `/compact` → `forceCompact` → 无视阈值压一次 | 同命令语义（命令本身不当作对话发出） |
| `Context compacted` | 聊天里出现「上下文已压缩」卡片；run 记录写 `compaction_start` / `compacted` 事件 | 同标记，另把窗口号/前后 token/保留轮数留痕 |
| 压缩后的历史被持久化 | 压缩后立刻落 `runCheckpoint.saveMessages(.., 'compacted')`；界面把旧消息标记 `compacted` 并不再发送 | 否则每个新回合都会把旧历史又发一遍（刚压完又超线） |

### 2.1 两层机制的配合（本仓库已有的一层 + 本次新增的一层）

- **硬裁剪** `agent.context.*` → `electron/contextBudget.cjs`（另一条线已实现）：请求前把「旧的、超大的
  **工具结果正文**」换成占位符，不动消息结构（不制造孤立 `tool` 消息）。**兜底**。
- **语义压缩** `agent.compact.*` → `electron/compaction.cjs`（本次）：窗口逼近上限时整段换成交接摘要。
  **质量优先**。
- 触发耦合：一旦上一轮**被迫硬裁剪**（占位符已开始顶替正文），下一轮先做语义压缩
  （`agent.compact.on_trim`，默认开）——占位符换不出质量，摘要能。

## 3. 配置（出厂值）

```properties
agent.compact.enabled=true              # 总开关
agent.compact.ratio=0.9                 # 触发线 = 有效窗口 × 该比例（Codex: 900k/1M）
agent.compact.context_window=0          # 覆盖有效窗口（0 = 用模型管理里的 contextWindow）
agent.compact.fallback_window=128000    # 模型没配窗口时的兜底（宁小勿大）
agent.compact.model=                    # 摘要用哪个模型（留空跟随主模型；可换便宜模型）
agent.compact.reasoning=false           # 摘要默认关思考链
agent.compact.max_output_tokens=4096
agent.compact.timeout_ms=60000
agent.compact.item_max_chars=6000       # 送进摘要请求的单条上限（防「压缩请求自己超窗」）
agent.compact.input_max_chars=400000    # 摘要请求总量上限（超出从最旧开始丢并标注）
agent.compact.keep_user_turns=true      # 保留人的轮次（Codex 行为）
agent.compact.keep_user_max_chars=2000
agent.compact.keep_user_total_chars=20000
agent.compact.on_trim=true              # 硬裁剪一开始丢正文就顺手做语义压缩
```

## 4. 判据（`scripts/compaction-test.cjs`，进 CORE）

1. **Codex 口径**：提示词逐字一致（5 行结构全在）；出厂 ratio=0.9；默认保留人的轮次且默认开。
2. **未到阈值**：只有 1 次模型请求（不多花一次摘要调用）、历史逐字节原样送达、无 `compacted` 增量。
3. **超阈值**：先发摘要请求（转录 + 提示词）→ 主请求的历史 = `[system, 人的轮次, 摘要信封]`；
   助手长文/工具结果被取代；机器注入的 user 提示不保留；返回值 `compacted=1`；增量带窗口号与前后 token。
4. **`/compact`**：未到阈值也压，触发来源标 `manual`。
5. **空压缩**：只剩 system + 人的话时**不假装压过**（如实回「没有可压缩的内容」）。
6. **摘要失败**：fail-open —— 本轮照常交付、如实上报失败原因、**不把历史换成空摘要**。
7. **估算口径**：1000 中文字 ≈ 700 token（按字节算会报 3000+）→ 130k 字节的中文不应在 128k 窗口上误触发。
8. **超量保护**：单条按上限截断并标注、总量超限从最旧开始丢、保留轮次按字符预算从最近往前取。

变异校验（回退实现看用例是否真的红）：
- 提示词改成中文 → `[Codex 口径]` 红；
- 不保留人的轮次（`keepUserTurns=false`）→ `[超阈值] 主请求的历史` 红；
- 删掉「机器注入轮不保留」→ 对应断言红；
- 摘要请求失败当成功（`if (!summary)` 分支去掉）→ `[摘要失败]` 红；
- 估算回退成按字节 → `[估算口径]` 红。

## 5. 已知取舍与缺口

1. **摘要是有损的**（Codex 同样是）：信封里已声明「细节以摘要为准」。需要细节时可回到画布/文件/
   run 记录（本仓库的 `.codenode/events.jsonl` 与检查点仍在），但**模型**看不到被丢的细节。
2. **压缩后不一定变小**：压缩后的历史 = 保留的人的话 + 摘要。当主体体积本来就是**人的轮次**
   （典型：把长文档整段粘进对话框）时，「保留轮次 + 摘要」可能比原文还大 —— 实测一个合成例子
   689 → 902 token（该例的助手/工具内容只有 19 字符，摘要反而更大）。真实触发场景（窗口 90%）
   里主体是助手长文与工具结果，所以正常是大幅下降（另一例 5220 → 345）。
   真觉得亏时调 `agent.compact.keep_user_max_chars` / `keep_user_total_chars`，或
   `agent.compact.keep_user_turns=false`。
3. **压缩后模型会忘记工具结果的原文**：与 Codex 一致（它也不保留 tool 结果）；靠摘要里的
   「关键数据/参考」条目兜。
4. **不压 tool_calls 配对**：压缩是**整段替换**，天然不会产生孤立 `tool` 消息（这是选择「替换」
   而不是「滑窗删消息」的原因之一）。
5. **界面上折叠掉的旧消息仍在内存里**（可回看，但不再发送）；会话没有持久化，重开应用即清空 ——
   与本次改动无关的既有行为。

## 6. 真机验证（2026-09-17，真实 DeepSeek）

`out/probe-compaction-real.cjs`（探针不入库）把有效窗口压到 600（阈值 540）以触发压缩：

| 观测 | 值 |
|---|---|
| 触发判定 | `estimate=689 ≥ limit=540` → `over-limit` |
| 摘要请求 | 供应商接受**非流式**调用；产出 330 字结构化交接摘要（当前任务 / 背景约束 5 条 / 下一步 / 用户偏好） |
| 压缩后的历史 | `[system(22), user(518), user(518), user(25), 摘要(411)]` —— 人的轮次全留、助手轮次被摘要取代（`keptUserTurns=3`） |
| 本轮交付 | 正常完成，回答用到了摘要里的背景约束 |
| **估算器精度** | 同一段历史我们的估算 **331**，供应商实际 `prompt_tokens` **326**（偏差 1.5%）—— 对比「按字节」口径会报 ≈500+ |

> 说明：探针第一次跑没触发，原因是我把 `.repeat(6)` 写在了字符串的最后一段上（消息只有 198 字，
> 估算 331 < 540）。**不是实现问题**，但那次的副产品很有价值：它给出了估算器与真实 token 的对账数据。

### 6.1 多轮（真实长会话）验证

`out/probe-compaction-multiturn.cjs`：三轮真实对话（每轮追加约 900 字背景），有效窗口 1200（阈值 1080）。
第 3 轮触发压缩，**压缩后第 1 轮定下的约束仍在回答里被正确复述**：

| 轮次 | 真实 `prompt_tokens` | 是否压缩 | 观测 |
|---|---|---|---|
| 1 | 486 | 否 | 记住 5 条约束 |
| 2 | 1176 | 否 | 主题切换正确、不与上轮混 |
| 3 | 1858 | **是**（1784 → 1629，保留 3 轮人的话） | 摘要里带着「约束清单（去重后 5 条，务必背下）」；回答正确复述了第 ①③⑤ 三条 |

- 全程 `error=null`，没有出现「聊一半断掉」。
- 1784 → 1629 只降了一点，原因见 §5.2：这个合成例子里大头是**人的轮次**（每轮 900 字背景），
  不是助手长文/工具结果 —— 恰好是「压缩后不一定变小」那条取舍的实证。


