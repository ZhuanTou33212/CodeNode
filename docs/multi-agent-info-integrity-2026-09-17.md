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

## 7. 落地顺序（建议）与进度

| 阶段 | 内容 | 判据（能区分实现的） | 进度 |
|---|---|---|---|
| P1 | 子代理结果改 JSON 信封（字段 + snapshot + refs + evidence + lossy） | 缺字段/缺 snapshot 时**拒收**；收下的必须 schema 校验通过 | ✅ **已落地**（见 §8） |
| P2 | 内容寻址引用 + 有损自报（截断点带 originalRef） | 哈希不符拒收；lossy 内容不得作为交付证据 | ✅ **已落地**（见 §9） |
| P3 | 跨子代理资源租约 + expectedRevision 写 | 并发写同一资源 → 一个成功一个冲突（不是双双成功） | ✅ **已落地**（见 §10） |
| P4 | 产物独立复跑核验（files 哈希 + tests 退出码） | 篡改子代理自述的产物 → 核验必须红 | ◐ 哈希核验已落地（§9）；**复跑命令**由 verifier 用既有 `execute_shell` 按角色规程执行 |
| P5 | 确定性合并 + 冲突裁决 | 同一批消息不同到达顺序 → 合并结果逐字节相同；冲突**不得默认取胜者** | ✅ **已落地**（见 §12） |

> 现在能直接复用的：`eventBus` / `runCheckpoint` / `sideEffects`（幂等 + 归因）/ `failures`（错误码）/
> `scheduler`（写独占）/ `approval`（令牌）/ `roles`+`roleSkills`（角色权限与技能）/
> `validateRagGrounding`（只认真实来源的思路）/ `compressionCache`（内容级键）。

## 8. P1 已落地：子代理结果的单一 JSON 信封（2026-09-17）

实现：`electron/subagentEnvelope.cjs`（契约构建/校验/渲染 + 产物哈希）+ `electron/subagents.cjs`
完成路径；用例 `scripts/subagent-envelope-test.cjs`（13 段，进 CORE）。

```jsonc
{
  "v": 1,
  "msgId": "m_<taskId>",
  "from": { "runId": "…", "taskId": "…", "role": "builder" },
  "to": { "taskId": "supervisor", "role": "supervisor" },
  "snapshot": { "source": "canvas", "hash": "sha256:…", "revision": null },
  "kind": "result",                     // result | error
  "payload": { "objective", "status", "summary", "acceptanceJudgement": "manual",
               "toolCallCount", "summaryChars", "stageNodeId?", "totalTimeoutMs?" },
  "refs": [ { "kind": "changed_file", "path": "a/b.txt" } ],
  "evidence": { "files": [ { "path", "exists", "bytes", "sha256" } ],
                "commands": [ { "cmd", "ok" } ], "warnings": [ "…" ] },
  "trust": "derived",                   // verified 只能由独立复跑产物的核验方给
  "lossy": { "isLossy": true, "droppedChars": 19507, "originalRef": "get_subagent_task(taskId=…)" }
}
```

**硬规则（照 §0 的 E 类错因）**：

- 缺必填字段 / 缺 `snapshot.hash` / `kind`、`trust` 取值非法 / result 没有结论 / error 没有原因
  → `validateEnvelope` 报违约 → 工具结果变成 **error（拒收）** + 文本明写「不得作为结论证据」，
  并在 audit 里留 `subagent_envelope_rejected`。**这就是「信任放大」的闸门**。
- `trust` **不自动给 verified**（只给 derived/untrusted）：验收判定保持 `acceptanceJudgement: 'manual'`，
  绝不替主代理下结论。
- 有损必须自报：截断 → `lossy.isLossy/droppedChars/originalRef`（完整原文用 `get_subagent_task` 取）。
- 产物哈希是**真算的**：改文件内容 → 哈希变（用例锁住）；声称改了但文件不存在 → `exists:false`
  + warning，绝不当交付证据；工程外路径不纳入产物。
- `snapshot.hash` = 画布文档的**键序无关** SHA-256：主代理拿当前画布再算一次，就能判断
  「子代理报告之后世界有没有又变过」（C 类版本错位的检测手段）。
  `revision` 暂为 null —— `GraphModel` 目前没有单调版本号计数器，**不拿节点数之类冒充版本号**；
  补真计数器是 P1 的后续小项。

代价：每个子代理结果进主上下文的文本从「字段头 + 正文」变成「一段引导语 + 一个 JSON 对象」，
本仓库实测 1.1KB → 1.7KB（信封字段空则省）。换来的是**可校验、可拒收、可知有损**。

## 9. P2 已落地：接收侧核验（不采信自述的落点）

实现：`electron/subagentEnvelope.cjs` 的 `verifyEnvelope(envelope, {projectRoot, model})`
+ `SubagentManager` 的 `get_subagent_task`（每次读取都重算，返回 `verification`）。
用例：`scripts/multi-agent-integrity-test.cjs` 的 B 段（含端到端拒收）。

**为什么必须在接收侧做**：信封里的 `evidence.files[].sha256` 与 `snapshot.hash` 都是**报告那一刻**测出来的；
报告之后文件可能被改、画布可能被改 —— 只看信封永远看不出来，必须**重算再比**。

判定分三档（不是只有对/错）：

| verdict | 含义 | 处理 |
|---|---|---|
| `valid` | 产物哈希与画布快照都与报告时一致 | 结论仍可信 |
| `stale` | 只有画布变了 | 结论**可能过期**，按最新状态重新核对（不是造假） |
| `invalid` | 有产物对不上（被改 / 该在的不在 / 声称不存在却存在） | **不得作为结论证据**：工具结果 error + `trust: 'untrusted'` + `verificationNote` + audit `subagent_verification_failed` |

细节：哈希口径与写工具（`impl/shared.cjs` 的 `sha256OfText`）**逐字节一致**，用例里有交叉核对断言防漂移；
没有哈希的条目（超大文件）退化成**存在性**比对，不用「都算过」放过去。

## 10. P3 已落地：跨 Agent 资源租约 + 乐观并发写

实现：`electron/tools/leases.cjs`（`LeaseRegistry` + `resourceKeysFor`）+ `registry.execute` 的第 4 道门
+ `write_file`/`edit_file` 的 `expectedSha256`。用例：`multi-agent-integrity-test.cjs` 的 C/D 段。

**租约（单一写者）**：只在写类工具上生效（读不加锁）；申请是**原子**的（多文件批量编辑要么全拿到
要么一个都不占 —— 部分占用正是死锁的成因）；被占用时**不排队等待**，直接返回 `RESOURCE_LOCKED`
（可重试，带「谁在持有、什么角色、多久过期」）。租约持有到**任务结束**或 TTL 到期：
写完就放会让另一个 Agent 基于过期的读去覆盖 —— 那正是「静默互相覆盖」本身。

资源键归一（同一文件的不同写法必须是同一把锁）：`file:<绝对路径 posix 化>`、`resource:canvas`（画布是单一资源）、
`resource:project-save`。

**乐观并发**：`write_file`/`edit_file` 新增可选 `expectedSha256`（新文件用 `"absent"`）——
写入前校验，不匹配则**不写盘**并返回 `CONFLICT_STALE`；成功时回传写入后的 `sha256`，可直接作为
下一个写者的期望值（交接棒）。校验发生在**确认之前**：注定失败的写不该去打扰用户。

**失败码**：`RESOURCE_LOCKED`（category `conflict`，可重试）/ `CONFLICT_STALE`（不可原样重试），
已进 `failures.cjs` 码表 → nudge 会给出「不要用相同调用硬撞」的分类指引。

**配置**：`agent.subagent.leases`（默认开）/ `agent.subagent.lease_ttl_ms`（默认 120000）。

## 11. `GraphModel` 的单调 revision（信封里 snapshot.revision 的真值）

`electron/tools/GraphModel.cjs`：`bumpRevision()` 把计数写进 `doc.root.revision`（跨请求 round-trip ——
`out.document = model.doc` 会带着它回到渲染层，下一轮再传回来接着数），每个 mutator 与 ipc 的
`mutateWorkbench`/`undo`/`redo` 都会 +1。**不拿节点数/时间戳冒充版本号**：节点数相同的两份不同画布必须能区分开。
撤销/重做也要 +1（从快照恢复会带回旧版本号，那样「报告之后世界变过没有」就判不出来了）。

## 12. P5 已落地：确定性合并 + 冲突裁决

实现：`electron/tools/merge.cjs`（纯函数）+ `SubagentManager` 的 `delegate_tasks`（附合并报告）与
新工具 `merge_subagent_results`（可带显式裁决）。用例：`multi-agent-integrity-test.cjs` 的 E 段
（含 6 种到达顺序的排列断言），变异 8/8 有判别力。

**要解决的问题**：多个子代理各自报告「我对世界做了什么」，这些报告**到达顺序不确定**（并行、重试、
取消都可能打乱）。如果合并按到达顺序应用（`for (r of results) apply(r)`），同一批工作两次运行会得到
不同的结果 —— 「谁覆盖谁」尤其危险：先到后到写法不同、结果就不同，而且**谁也说不清到底谁覆盖了谁**。

**两条硬规则**：

1. **合并只依赖贡献项自身**（资源键 / 内容 / 起止时刻 / 来源），不依赖到达顺序。先规范排序
   （`resourceKey, finishedAt, actor, value, kind`）再去重合并 → 同一组贡献项任意顺序进来，`digest`
   **逐字节相同**；同时**幂等**（同一份报告重复到达不影响结果）。
2. **不猜**。内容不同的两个贡献：
   - 有可判定的先后（完成时刻都非空且互不相同）→ `superseded`：明确记录「谁覆盖谁」，**两份值都留痕**
     （`supersedes` 里带被覆盖方的值与时刻），不再是静默覆盖；
   - 无法判定先后（时刻相同或缺失）→ `conflict` + `requiresArbitration`，**绝不默认取胜者**
     （拿字典序/到达顺序决定事实等于编造）。裁决只能来自显式决定 `decisions`，且 `winnerTaskId`
     必须是该资源的候选来源之一，否则 `rejectedDecisions` 记录被拒原因、冲突仍然存在。

**digest 的语义**：只覆盖 `resources`（合并**视图**）。刻意不含 `duplicatesRemoved` /
`rejectedDecisions` —— 那些是输入侧元数据；否则同一份视图只因为多收了一次重复报告就会换指纹，
幂等与「同一批消息 → 同一指纹」都不成立。

**入口**：
- `delegate_tasks` 的返回里带 `merged: {digest, counts, conflicts}`，文本尾部附合并报告
  （全一致时只留一行摘要；有被覆盖/待裁决/裁决被拒才逐条展开 —— 不让干净的一批平白多几百 token）；
  同时落 run 事件 `subagent_merge` 与 delta `subagent_merge`（UI 在**有待裁决冲突**时提示用户，
  其余情况不打扰）。
- `merge_subagent_results({taskIds?, decisions?})`：主代理可随时重放合并；带 `decisions` 时应用裁决。
- 判先后的唯一依据是信封的 `at.startedAt/finishedAt`（合并**看不到**任何到达时间）；信封没有时刻时
  `at` 字段整体不写，合并如实按「判不出先后」处理。
