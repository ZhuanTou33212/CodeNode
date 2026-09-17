# 上下文超窗的两道闸门：预检 + 供应商报错后的自救（2026-09-17）

> 上一轮把「聊一半断掉」的第 5 类根因（长会话超窗）交给**上下文压缩**（照 Codex CLI 的做法，
> 见 `docs/context-compaction-codex-parity-2026-09-17.md`）。压缩是**概率性**的防线：
> 它按「窗口 × 0.9」提前动手，但有两种现实情况它管不了 —— 本文就是这两条的收尾。

## 0. 压缩管不了的两种情况

| 情况 | 为什么压缩管不了 | 以前的表现 |
|---|---|---|
| **A. 剩下的东西本身就超窗** | 压缩后历史 = 保留的人的话 + 摘要；当**人自己**粘了一大段（或 keep_user_* 调得很大），剩下的仍然超 | 请求发出去被 400 拒 → 报错中断 |
| **B. 模型窗口值填得比供应商实际大** | 触发线 = 声明窗口 × 0.9。标称 1M、实际 64k 时，压缩要等到 900k 才动手 —— 早已被拒 | 同上，且**看起来像「压缩失效」** |

## 1. 三道处置（按发生顺序）

### ① 预检：输入本身就超窗 → 不发，给出出路

```js
if (windowKnown && estimate > compactionWindow) → stopReason='context_overflow' + 中文出路建议
```

- `estimate` = `compaction.estimateTokens(messages, tools)`（中文 0.7/字、其余 1/4，实测偏差 1.5%）。
- **只在窗口已知时才拦**（`windowKnown` = 模型管理声明过 / `agent.compact.context_window` 配过 /
  被供应商真拒过）。只有兜底值（`fallback_window`）时**不拦** —— 兜底值是猜的，拿它拒发会误伤大窗口模型；
  宁可发出去让供应商说真话。
- 文案给出四条可执行出路：开新会话 / 调小 `keep_user_*` / 修模型窗口值 / 换大窗口模型。
- 增量事件 `context_overflow{phase:'preflight', tokens, window}` + run 事件 `context_overflow` + toast。

### ② 输出预算被挤掉 → 缩小 `max_tokens` 继续发（不是拒发）

```js
if (estimate + maxTokens > window) → maxTokens = max(1024, window - estimate - 64)
```

拒发是**过度反应**：输入装得下、只是这次回答不能那么长。缩小后如实上报（`max_tokens_capped`
增量 + run 事件 + toast「本轮输出上限临时从 X 降为 Y」），用户看到的是「回答短了点」，而不是报错。

> 实现注意（踩过一次）：流式请求体是 `chatBody(cfg, …)` 生成的，循环里那个 `payload` 只是给
> 预算/追踪看的影子对象 —— 收缩后的上限必须**进 cfg**（`{...cfg, maxTokens: turnMaxTokens}`），
> 否则用例能过、线上仍在用原值。这一点由 `[输出预算] 缩小后的请求体真的用了新的 max_tokens` 锁住。

### ③ 供应商真报超窗 → 降级窗口 + 压一次 + 重发（自救）

```
400 (context overflow)
  ├─ classifyContextOverflow：只认「HTTP 4xx + 上下文/长度措辞」
  ├─ noteContextOverflow：该模型保守窗口下限 := min(历史值, 估算 × 0.9)（进程内，不写用户配置）
  ├─ runCompactionStep(force)，触发来源标 provider-rejected
  └─ 用压缩后的历史重发同一请求
```

- **只救一次**（`agent.compact.overflow_recoveries`，出厂 1）：压完还超说明剩下的东西本身超窗，
  硬重试只会烧钱 → 如实失败，并**保留供应商原文**。
- 窗口降级取**历史最小值**（越被拒越保守），按 `apiBase|model` 隔离：别的模型不受影响。
- 只用内存、**不写 models.json**：自动改用户配置比一轮报错更危险；toast 会提示去改真实值。
- 增量事件 `context_overflow{phase:'recovering', tokens, window, providerMessage}`（用户能看到
  「为什么这一轮慢了一拍」）+ run 事件 `context_overflow_recovering` / `context_overflow_retry`。

## 2. 与压缩 / 硬裁剪的关系（三层，别混）

| 层 | 模块 | 触发 | 手段 | 角色 |
|---|---|---|---|---|
| 语义压缩 | `electron/compaction.cjs` | 窗口 × 0.9（或被拒过后的下限） | 交接摘要替换助手长文/工具结果 | **质量优先**，主力 |
| 硬裁剪 | `electron/contextBudget.cjs` | 每次请求前，超字符预算 | 旧工具结果换占位符 | 兜底（压不动时保证发得出去） |
| 超窗闸门 | 本文（`electron/agent.cjs`） | 输入超窗 / 供应商 400 | 预检拒发 + 输出收缩 + 自救 | **收尾**，把「必然的报错」变成「可理解的处置」 |

## 3. 判据（`scripts/context-overflow-test.cjs`，进 CORE，9 段 24 断言）

1. **预检**：输入超窗 → `calls=0`（一次请求都不发）、`stopReason=context_overflow`、文案含出路、
   增量带 tokens/window。
2. **不误伤**：只有兜底窗口（猜的）→ 照常发请求。
3. **输出收缩**：挤压时缩小 `max_tokens` 且**请求体里真的是新值**。
4. **自救**：400 → 记窗口下限 + 压缩（trigger=`provider-rejected`）+ 重发成功（3 次请求：400/摘要/重发），
   重发带的是 `<compaction>` 信封历史，`overflowRecoveries=1`。
5. **只救一次**：重发仍超 → 不再压不再试（`calls=3`），错误保留供应商原文。
6. **非超窗 400**（invalid tool schema）→ **不**进自救、不留假的窗口降级、错误原样冒。
7. **识别器**：DeepSeek 真超窗文案 / `context_length_exceeded` / 中文「上下文长度超出上限」命中；
   无上下文措辞的 400、HTTP 500、空错误不命中。
8. **窗口账本**：取历史最小值、按模型隔离。
9. **联动**：被拒后压缩线立刻降到 `估算 × 0.9`（不用等声明值）。

变异校验（`out/mutation-check.cjs` + `out/mutation-spec-v2.json`）：预检改恒假 / 输出不收 / 自救删掉 /
识别器恒真 / 压缩不 force → 各自红在预期断言上。

## 4. 真机验证（2026-09-17，真实 DeepSeek，`out/probe-overflow-real.cjs`）

三次逼近，前两次都**没**超窗 —— 这些「没超」也是结论的一部分：

| 尝试 | 输入（真实 token） | `max_tokens` | 结果 |
|---|---|---|---|
| 1 | 209,074 | 393,216 | **被接受**（回顾：再早一次 357,574 输入 + 4k 输出也被接受） |
| 2 | 748,074 | 900,000 | 400：`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]` —— **不是**超窗，识别器正确地**没有**把它当超窗（真实的反例） |
| 3 | 748,074 | 393,216 | **400 超窗** ✓（见下） |

第 3 次的真实报错与完整自救链路：

```
HTTP 400: {"error":{"message":"This model's maximum context length is 1048576 tokens.
  However, you requested 1141290 tokens (748074 in the messages, 393216 in the completion).
  Please reduce the length of the messages or completion.", ...}}
  → 识别为超窗；保守窗口下限 := 655,595 × 0.9 = 590,035（进程内）
  → 强制语义压缩：655,595 → 1,526 tokens（trigger=provider-rejected，保留人的轮次）
  → 重发：真实用量 prompt_tokens=1,724、completion=46 → 状态 COMPLETED、error=null、自救次数=1
```

顺带把这条规则**实测钉死**：该供应商的约束是「**输入 + max_tokens ≤ 1,048,576**」
（748,074 + 393,216 = 1,141,290 > 1,048,576 才被拒；而 209,074 + 393,216 被接受）——
这正是 §1-② 「输出预留也要一起收缩」那条防御的现实依据；模型管理里填的 1M 窗口也与实测一致。

