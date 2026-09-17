# 多 Agent 并行协作：信息完整性设计（2026-09-17）

> 问题：做多 Agent 并行任务时，怎么保证 agent 之间**传信息不出错**？
> 本文给出的是**可落地的机制清单**，每条都标注了本仓库现有的对应物（能用就别新造）。

## 0. 先把"信息出错"拆成五类

| 类别 | 典型表现 | 之所以发生 |
|---|---|---|
| **A 格式/语义漂移** | 消息少字段、字段含义变了、模型自由发挥 | 用自然语言当传输协议 = 没有契约 |
| **B 有损传输** | 摘要丢了关键约束、被截断的原文当完整证据 | 压缩/截断不标注、不可回溯 |
| **C 版本错位** | A 基于旧画布/旧文件做判断，B 已改过 | 消息里没有"基于哪个版本" |
| **D 写冲突** | 两个 agent 同时改同一文件/节点，互相覆盖 | 并行写 + 无租约 + 无版本号 |
| **E 信任放大** | 子代理说"已完成/已通过"，其实没验 | 把自述当事实、缺独立核验 |

**结论先行**：可靠的多 Agent 信息传递 = **结构化信封 + 内容寻址引用 + 单一写者/乐观并发 + 独立核验 + 可重放事件流**。
自然语言只在「需要理解」的地方用，**不能**当传输层。

## 1. 传输层：统一信封（治 A/C）

每一条 agent 间消息都是一个带身份的 JSON 信封，而不是一段自由文本：

```jsonc
{
  "v": 1,
  "msgId": "m_7f3a",
  "from": { "runId": "run-x", "taskId": "t2", "role": "builder" },
  "to":   { "taskId": "t1", "role": "supervisor" },
  "inReplyTo": "m_7e11",            // 因果链：谁在回应谁
  "snapshot": { "revision": 42, "hash": "sha256:9c1f…" },  // 基于哪个世界状态
  "kind": "result|proposal|objection|evidence|error",
  "payload": { … },                  // 结构化，schema 校验
  "refs": [ { "path": "a.txt", "sha256": "…", "range": [10, 42] } ],
  "evidence": { "files": […], "tests": […], "artifacts": […] },
  "trust": "verified|derived|untrusted",
  "lossy": { "isLossy": false }      // 有损传输必须自报
}
```

- **本仓库对应物**：`electron/eventBus.cjs` 已有 `{v,ts,kind,runId,turnId,toolCallId,attemptId}`；
  子代理结果契约（`electron/subagents.cjs` 的 `[子代理结果]` + `data.contract`）是它的雏形。
  升级方向：把 `[子代理结果]` 从"带字段头的文本"换成**单一 JSON 信封**，并把 `snapshot.revision`
  取自画布/文件的实际版本。
- **硬规则**：缺 `snapshot` 的消息**不得**参与合并；`trust !== verified` 的内容**不得**作为结论证据
  （现有 grounding 门 `validateRagGrounding` 的思路可直接复用：只认有真实来源的引用）。

## 2. 数据层：传引用，不传真值（治 B）

- 大块内容（文件正文、画布模型、工具结果）落**内容寻址存储**（`sha256 → blob`），
  消息里只带 `ref{path, sha256, range}`；接收方校验哈希，不符即拒收并要求重取。
- **压缩/摘要必须自报有损**：`lossy:{isLossy:true, dropped:"…", originalRef:"…"}`。
  子代理回灌上限（`agent.subagent.result_max_chars` 8000）、工具结果上限（`agent.data_truncate_cap`
  12 万字符）都是**有损通道** —— 截断点必须留 ref 指向完整原文，且禁止把截断内容当证据。
- **本仓库对应物**：`.codenode/scalars`（本地标量库）、`tools/impl` 里的 `resultStore` 思路、
  `electron/compressionCache.cjs`（内容级缓存键 = 内容哈希，已经是内容寻址的雏形）。

## 3. 写层：单一写者 + 乐观并发（治 D）

1. **资源租约**：写操作前先取租约（`resource-key → holder taskId`）。同一资源（文件 / 画布节点 /
   标量 key）同时只有一个写持有者；读不加锁。现状 `electron/tools/scheduler.cjs` 已经做到
   「本轮含写操作 → 整轮串行」，把它从**单 run 内**推广到**跨子代理**即可。
2. **乐观并发**：写消息必须带 `expectedRevision / baseHash`；不匹配 = 冲突 → 拒绝并回滚，
   绝不"最后写入者赢"。
3. **幂等**：已有 `electron/sideEffects.cjs`（`canonicalArgsText` + actor 归因）——重发/重试
   不会产生第二次副作用；异步派活必须所有写操作都过它（现在是 UNKNOWN 类工具会进 needs_review）。
4. **冲突裁决要确定性**：优先级 > 先到先得 > 人工裁决（可复用 `electron/tools/approval.cjs`
   的令牌机制做"裁决令牌"），**不允许**按"谁先返回"决定合并顺序。

## 4. 验证层：不采信自述（治 E）

- 子代理的返回值里，**结论必须配可核验产物**：`files:[{path,sha256,bytes}]`、
  `tests:[{cmd,exitCode,tail}]`、`artifacts:[...]`。协调者对**产物独立复跑/复读**后才采信
  （本仓库 `verifier` 角色 + 结果契约里的 `acceptanceJudgement:'manual'` 是雏形）。
- 失败走**结构化错误码**（`electron/tools/failures.cjs` 的 FailureCode 表），不要自由文本，
  这样"重试 / 换角色 / 升级人工"才能被机器分派。
- 每个接缝都要有**能区分实现的判据**（本仓库的变异测试经验）：`状态判据 > 自述判据`。

## 5. 顺序层：一切可重放（治 A/C/D 的兜底）

- 统一事件流（`.codenode/events.jsonl`）+ 每步 `tool_intent/tool_commit`（`runCheckpoint`）
  = 「谁、在什么时间、基于哪个状态、做了什么」的完整账本。
- 合并顺序用**确定性排序键**（事件 seq + msgId），不用墙钟/返回顺序。
- 出问题时的第一现场是**回放**（`scripts/event-replay.cjs`），不是问 agent "你刚才做了什么"。

## 6. 反模式（明确别做）

| 反模式 | 为什么危险 | 替代 |
|---|---|---|
| 把自由文本摘要当事实 | 无法校验、无法追溯、模型会自信地错 | JSON 信封 + evidence |
| 整段工具结果回灌上下文 | 有损截断 + token 爆炸，且截断点未知 | 引用 + 哈希 + lossy 标注 |
| 两个 agent 无租约写同一文件 | 静默互相覆盖 | 资源租约 + expectedRevision |
| "最后写入者赢" | 并行下顺序不确定 | 版本号 / 优先级 / 人工裁决 |
| 子代理说"已完成"就信 | 信任放大，错误向下游传播 | 独立复跑产物 |
| 没有 snapshot 就合并信息 | 版本错位，结论混了不同世界状态 | 信封带 revision |

## 7. 落地顺序（建议）

| 阶段 | 内容 | 判据（能区分实现的） |
|---|---|---|
| P1 | 子代理结果改 JSON 信封（字段 + snapshot + refs + evidence + lossy） | 缺字段/缺 snapshot 时**拒收**；收下的必须 schema 校验通过 |
| P2 | 内容寻址引用 + 有损自报（截断点带 originalRef） | 哈希不符拒收；lossy 内容不得作为交付证据 |
| P3 | 跨子代理资源租约 + expectedRevision 写 | 并发写同一资源 → 一个成功一个冲突（不是双双成功） |
| P4 | 产物独立复跑核验（files 哈希 + tests 退出码） | 篡改子代理自述的产物 → 核验必须红 |
| P5 | 确定性合并 + 冲突裁决（approval 令牌） | 同一批消息不同到达顺序 → 合并结果逐字节相同 |

> 现在能直接复用的：`eventBus` / `runCheckpoint` / `sideEffects`（幂等 + 归因）/ `failures`（错误码）/
> `scheduler`（写独占）/ `approval`（令牌）/ `roles`+`roleSkills`（角色权限与技能）/
> `validateRagGrounding`（只认真实来源的思路）/ `compressionCache`（内容级键）。
