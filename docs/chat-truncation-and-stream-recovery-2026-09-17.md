# 聊天「回答写一半就断」的根因与修法（2026-09-17）

> 现象：用户反馈「codenode 目前还会聊天聊一半断掉」。
> 本文记录**四类根因的真实取证**（不是推测）、各自的修法、判据与仍然存在的缺口。

## 0. 先把「断」分成四类（每一类都有自己的证据）

| # | 现象 | 根因 | 证据（真实运行） |
|---|---|---|---|
| 1 | 回答写到大半被砍断，文字停在半句 | 思考 token 与正文**共用** `max_tokens`，而出厂值是 8192 | 同一份「写 4000 字文档」请求：`max_tokens=1000` → 1000 tokens 全给思考、**正文 0 字**；`max_tokens=8192` → `finish_reason=length`，8196 tokens（思考 5037）+ 正文 5520 字；供应商侧 32768/65536 都接受 |
| 2 | 被截断后模型「越写越水」或直接停 | 补问文案是「请把回复拆短：只给结论」= 让模型主动丢信息；上限写死 2 次 | `scripts/truncation-safety-test.cjs` 锁住的旧行为；真实 DeepSeek 上 8192 档位随机复现 `length` |
| 3 | 慢但一直在输出的长回答被整轮砍掉，报错是英文 `This operation was aborted` | 单轮 180s **墙钟**硬超时、写死不可配；且没有「停滞」概念 | 探针 `out/probe-truncate.cjs`：30s 超时 → 已流出 4154 字的回答被作废，`usage=null`、`iterations=0`、state=FAILED，报错原文英文 |
| 4 | 回答流到一半突然没了（半截内容还在，但进程报错） | 重试只覆盖**建连**阶段；流中途 `reader.read()` 抛错直接冒到主循环 | 探针 `out/probe-stream-break.cjs`：mock 服务吐 3 个分片后杀连接 → **服务端只收到 1 次请求**、错误 `terminated`、18 字半截内容已推给界面 |

另有一处**放大观感的界面缺陷**：`failTurn` 会把已流出的半截正文**替换**成「（调用失败：…）」——
用户看到的是「写了一半的回答凭空消失」，而不是「回答中断了」。

## 1. 修法

### 1.1 输出上限：8192 → 32768（`max_tokens`）

- 代码默认（`electron/agent.cjs: DEFAULT_MAX_TOKENS`）与 `config/agent.properties[.example]` 同步改。
- 关键认知写进注释与配置样例：**思考链计入这笔额度**。开 `reasoning_effort` 时 8k 档位会把
  「一份 4000 字文档」顶到边界，档位不足就等于随机砍半。

### 1.2 截断补救：从「拆短」改成「接着写」

- 补问文案：`请直接从断点接着写：不要重新开头、不要重复已经输出过的内容，也不要为了缩短篇幅丢信息。`
- 补问上限可配：`agent.truncation_nudges`（出厂 4，钳制 0–8；旧行为是写死 2）。
- 用尽仍截断：`stopReason='length_truncated'` + 新发 `truncated` 增量（`continuing:false`），
  界面提示「可回复『继续』让它接着写完」——半截答案不再被当成完整交付。

### 1.3 超时：停滞与总时长分开

| 配置 | 出厂 | 语义 |
|---|---|---|
| `agent.stream_idle_timeout_ms` | 120s | **停滞**：连续这么久没有任何分片才判定卡死；**每来一个分片就重置** |
| `agent.turn_timeout_ms` | 600s | 单轮模型请求（含中断重发）的**总时长**上限；旧行为写死 180s |

报错一律中文化，并如实带上「已收到 N 字 / 已重发 M 次」与底层原因（`code`：
`STREAM_STALLED` / `STREAM_INTERRUPTED` / `TURN_TIMEOUT`）。

### 1.4 流中途断线：丢弃半截、整轮重发

- 新配置 `agent.stream_max_attempts`（出厂 2；0 = 旧行为）。
- 重发前发 `stream_restart` 事件：
  - 主循环**回滚本轮**已累加的 `content`/`reasoning`（不碰此前轮次）；
  - 界面收到 `content_reset` → 清空当前气泡，避免「两遍开头」；
  - `emitTrace({kind:'stream_restart'})` + run 事件 `content_reset` 留痕。
- **用户取消不重发**；**总时长超限不重发**（时间已经用完了）。
- 重发过的输入计进请求预算补偿（`attemptsRef.count = 已重发次数 + 本轮 HTTP 尝试`），
  避免「白烧额度」被系统性少记。

### 1.5 界面

- `failTurn` 保留半截正文 + 追加 `> ⚠️ 本轮中断：<原因>`（原来直接抹掉）。
- `streamDelta` 支持 `content_reset`。
- run 记录（`.codenode/runs/<runId>.jsonl`）新增 `content_reset` / `truncated` 事件与
  `run_finish.streamRestarts` —— 排障时不必再猜「这次为什么重来了一遍」。

## 2. 判据（进 CORE 门禁）

`scripts/stream-recovery-test.cjs`（8 段 / 29 条断言，全部落在可观察终态）：

1. 中途断线 → 服务端收到 2 次请求；交付内容 == 重发的完整回答；半截片段不出现在交付里；
   **界面拼出来的文本 == 交付内容**（`content_reset` 生效）；`streamRestarts === 1`。
2. 连续两次断线 → 第 3 次成功，界面仍与交付一致。
3. 停滞 → 中文「停滞」+「已收到 N 字」；重发次数用尽；半截内容仍在返回值里；停滞先于总时长触发。
4. 慢速流（每 120ms 一片，停滞阈值 400ms）→ **不被误判**为卡死（锁住「有数据就重置」）。
5. 用户取消 → 只 1 次请求、`aborted=true`、界面不收到 `content_reset`。
6. 正常流 → 0 重发 0 复位（防过度修复）。
7. 预算补偿 → 重发的结算量 > 单次对照（去掉补偿即红）。
8. 出厂口径：停滞 120s / 单轮 600s / 重发 2 次 / 补问 4 次 / 配置样例 `max_tokens ≥ 16384`。

`scripts/truncation-safety-test.cjs` 同步改写：补问文案必须是「接着写」且**不得**出现「拆短」；
拼接交付（4 段都在）；`truncationNudges` 配置生效；用尽时 `continuing:false`。

## 3. 当时剩下的第 5 类缺口：现已由「两层」补上（2026-09-17 追记）

> 本节写于四类根因修完时，当时记录的两条缺口**已经修掉**，指向如下 —— 不要把这一节再当成「未修」。

1. **会话历史不做窗口裁剪 → 已有两层防护**：
   - **语义压缩**（质量优先）：`electron/compaction.cjs` + `agent.compact.*` —— 窗口逼近
     `agent.compact.ratio × contextWindow`（出厂 0.9，照 Codex CLI 的
     `model_auto_compact_token_limit/model_context_window`）时，把「助手长文 + 工具结果」整段换成
     一份交接摘要，历史重整为 `[system, ...人的轮次, 摘要]`。设计与取证见
     `docs/context-compaction-codex-parity-2026-09-17.md`。
   - **硬裁剪**（兜底）：`electron/contextBudget.cjs` + `agent.context.*` —— 请求前把「旧的、超大的
     工具结果正文」换成可追溯占位符，不动消息结构（不制造孤立 `tool` 消息）。
   - 两者的触发是互锁的：硬裁剪一开始丢正文，下一轮先做一次语义压缩。
2. **单轮运行内的上下文增长 → 主循环内已有两处闸门**：`agent.context.trim` 在**每次请求前**执行
   （不是只在轮边界），压缩步骤也在每个循环轮次开头；单轮内的工具结果洪峰先被占位符压住、
   轮边界再被摘要吸收。实测 40 次 27KB `read_file`：第 11 次请求的输入 434,743 字符 → 59,605 字符。

**仍然保留的残留风险（如实列出）**：

- 硬裁剪为了保护「最近 N 条」可以**故意超预算**（`hard_keep_recent_messages`），压缩的保留轮次
  （`keep_user_total_chars`，默认 20k 字符）也可能本身就是大头。**当窗口里剩下的东西本身超窗**时，
  请求仍会被供应商以 400 拒掉 —— 这条已在 2026-09-17 的后续提交里收口为「**超窗三道闸门**」：
  ① 预检（只在窗口已知时）输入本身超窗 → 不发出去，`stopReason=context_overflow` + 四条可执行出路；
  ② 输入装得下、只是挤掉输出预算 → 自动收缩本轮 `max_tokens` 继续发；
  ③ 供应商真报超窗 → 记下该模型的保守窗口下限（估算×0.9，进程内）→ 强制压缩一次 → 用压缩后的历史重发
  （只救一次）。真机闭环：`748,074 + 393,216 > 1,048,576` 被真实拒绝 → 降级窗口 590,035 → 压缩到 1,526
  tokens → 重发成功交付。详见 `docs/context-overflow-guard-2026-09-17.md`。
- 同步 `fs` 工具仍不可中断（超时只终止 await），已知。
- 探针脚本留在 `out/`（被 gitignore），不入库；复现命令见本文第 0 节的脚本名。

