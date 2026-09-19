# Agent 增量审查（第三轮）与修复任务单

日期：2026-09-19
审查基线：`062dac8` ｜ 复核基线：`50e9b4b`（分支 `yimi-branch`）
范围：只找既有四份文档**未覆盖**或**只做了一半**的问题 ——
`docs/agent-production-readiness-review.md`、`docs/agent-remediation-progress.md`、
`docs/AGENT_GAP_FIX_2026-09-17.md`、`docs/multi-agent-info-integrity-2026-09-17.md`。
本轮**没有修改任何生产代码**（交付物是本文件）。

取证方式：4 路只读代码审查（主循环与状态机 / 工具执行与安全边界 / 子代理与预算日志 / 前端与交互），
每路均要求给出 `file:line` 证据并如实单列「已检查但未发现问题」；父代理随后**逐行复核**了最严重的 3 条，
并逐条核对「在最新基线上是否仍成立」。

---

> ## 修复状态（2026-09-19 晚回写，**先读这一节再看 §1/§3 的表**）
>
> **#1–#25 已全部实现并配用例**（`electron/` + `src/` 29 文件 +1726/−260；新增 6 个核心套件：
> `test:frontend-incremental`（87 断言）/ `stream-anomaly` / `shell-hardening` / `confirm-payload` /
> `run-store-scale` / `storage-hardening`；20 份变异 spec 在 `out/`，`out/` 被 gitignore）。
> 因此 §1 的「状态」列与 §3 表格里的「未修/成立」是**审查当时（`50e9b4b`）**的描述，**不要当作现状照抄**。
>
> **仍未做的是 §4 的四类结构性问题**（不是单点 bug，需要产品决策）：
> ①真机回归与代码演进脱节（`scripts/agent-eval-tasks.cjs` 仍 6 个 `realModel:false` / 5 个 true；
> 真机 job 只在手动 release 模式跑）②用户对运行中的 Agent 没有控制手段
> （无 steering/排队消息；子代理任务视图仅内存 `Map`、无 UI；无 Run 级文件改动回滚、幂等账本无 before-image）
> ③每轮固定开销 ≈8k tokens 未审计、无按任务分层注入 ④缺「用例输入与生产同形」的门禁。
> 另：`README.md` 徽章仍写 `gates-43 core + 3 display`，实际 **73 核心 + 5 显示**
> （`node scripts/run-all-tests.cjs --list`）。
>
> **两处「待核实」已在本次实施中被反向证实**：#1 的触发链（§6.5 建议的复现已写成用例
> `agent-resume-test.cjs` 场景 3b）与 #2 的孤立 `tool` 消息（`repairToolPairing` +
> `isToolPairingValid` 已落地并有配对合法性断言）。

---

## 0. 基线变更声明（先读这一节）

审查开始于 `062dac8`；复核时 HEAD 已是 `50e9b4b`，期间新增 4 个提交：

| 提交 | 内容 |
| --- | --- |
| `3a8c914` | 多 Agent 信息完整性 **P2 接收侧核验 + P3 资源租约与乐观并发写 + P4 复跑核验地基 + GraphModel 真 revision** |
| `0f7096f` | 上述 P2/P3 落地记录（§9–§11） |
| `e60360e` | **P5 确定性合并 + 冲突裁决 + 信封 at 时间戳** |
| `50e9b4b` | P5 落地记录（§12） |

新增模块 `electron/tools/leases.cjs`（资源租约）、`electron/tools/merge.cjs`（确定性合并）、
用例 `scripts/multi-agent-integrity-test.cjs`。

**两处更正（请以本文为准）**：

1. 本轮之前口头提到的「多 Agent P3/P4/P5 仍未落地」**已过时、作废** —— 上述提交已落地。
2. 本文每条都已在 `50e9b4b` 上复核。**受新提交影响、需要改写的只有 #9 与 #10 两条**
   （`edit_file` / `write_file` 新增了乐观并发参数），其余全部**仍然成立**。判定依据分两类：
   涉及文件在 `062dac8..50e9b4b` 区间内**未被改动**（改动清单：`agent.cjs`、`ipc/agent.cjs`、
   `subagentEnvelope.cjs`、`subagents.cjs`、`GraphModel.cjs`、`failures.cjs`、`editFileTool.cjs`、
   `shared.cjs`、`writeFileTool.cjs`、新增 `leases.cjs`/`merge.cjs`、`registry.cjs`、`roles.cjs`、`toolkit.cjs`、
   `src/store/sessionStore.ts`），或已逐行复读确认逻辑未变。

---

## 1. 结论汇总

| # | 问题 | 严重度 | 状态 | 复核方式 |
| --- | --- | --- | --- | --- |
| 1 | 续跑把「已提交的 unknown 副作用」当可跳过，执行期却会重跑 | **P0** | 成立 | 父代理逐行复核 |
| 2 | 续跑检查点按位置切片且不修配对 → 孤儿 tool 消息 | **P1** | 成立 | 父代理逐行复核 |
| 3 | 一次超窗自救把模型窗口永久锁成估算值，并被预检当硬门槛 | **P1** | 成立 | 父代理逐行复核 |
| 4 | 幂等账本把同 run 内同参数写当已完成跳过，却返回 `ok:true` | **P1** | 成立 | 审查报告（`sideEffects.cjs` 区间内未改） |
| 5 | 子代理被 `max_tokens` 截断仍标 `done` 且产出「契约合规」信封 | **P1** | 成立 | 复读确认 `stopReason` 零命中 |
| 6 | 子代理 token/成本双重记账（`main` 逐轮 + `subagent` 汇总） | **P1** | 成立 | 复读确认两处记账点仍在 |
| 7 | 前端并发竞态：单值 `sending`/`requestId` + 续跑绕过 `busy` 守卫 | **P1** | 成立 | `chatStore.ts` 区间内未改 |
| 8 | 高风险确认判据与白名单不共用归一化结果 | **P1** | 成立（条件受限） | `executeShellTool.cjs` 区间内未改 |
| 9 | `edit_file` TOCTOU：新增可选 `expectedSha256`，但校验在 confirm **之前** | P2 | **部分缓解、未收口** | 父代理读 diff |
| 10 | 确认对话框信息面不足（`write_file` 仍只给字节数） | P2 | 成立（`edit_file` 已改善） | 父代理读当前代码 |
| 11 | 压缩失败降级 = 12 万字符截成 1500 字符，却标 `compressed:true` | P2 | 成立 | 审查报告 |
| 12 | `streamAccumulator.anomalies` 无生产消费者，流内 `error` 被当成功 | P2 | 成立 | 审查报告 |
| 13 | 热路径全量原子落盘，字节数 O(n²) | P2 | 成立 | 审查报告 |
| 14 | 日志追加全量读回整文件；每次 chat 同步扫最多 200 个 run 文件 | P2 | 成立 | 审查报告 |
| 15 | 脱敏缺口：`compression-cache` / `side-effects.error` / `memory.json` 明文 | P2 | 成立 | 审查报告 |
| 16 | `memory.json` 解析失败即静默清空；超 200 条静默淘汰 | P2 | 成立 | 审查报告 |
| 17 | `read_file` 敏感判定用请求路径而非 realpath | P2 | 成立 | 复读确认（`shared.cjs` 仅加哈希函数） |
| 18 | 模型自选 `taskId` 可覆盖已有任务 | P2 | 成立 | 复读确认无 `tasks.has` |
| 19 | `execute_shell` 输出无上限累积 | P2 | 成立 | 审查报告 |
| 20 | POSIX 前台命令停止后残留子孙进程 | P2 | 成立 | 审查报告 |
| 21 | `needsReview.plan` 被丢弃；`truncated`/`stopped` delta 前端无分支 | P2 | 成立 | 审查报告 |
| 22 | 裁剪占位符拿不到工具名（生产 tool 消息无 `name`） | P3 | 成立 | 父代理复读确认 |
| 23 | `bulk_edit.create_files` / `write_analysis_md` 绕过原子替换 | P3 | 成立 | 审查报告 |
| 24 | 并行预启动对父 `AbortSignal` 挂的监听只增不减 | P3 | 成立（默认关闭） | 审查报告 |
| 25 | 前端 `void asyncFn()` 无 catch；关键状态无 live region | P3 | 成立 | 审查报告 |

---

## 2. 优先修复项（逐条）

### #1【P0】续跑把「已提交的 unknown 副作用」当可跳过，执行期却会重跑

**结论**：确认缺陷，且与代码自身明文声明直接矛盾。**父代理逐行复核。**

**现象**：链路上的四次判定互相抵消 ——

- `electron/runCheckpoint.cjs:217-221`：只要该 `idemKey` 在幂等账本里是 `committed`，就先塞进 `skippable` 并
  **`continue`** —— 这一步发生在**判断 `effect` 之前**。
- `electron/sideEffects.cjs` 的 `review()` 先判 `phase === 'committed'` 再判 `effect === 'unknown'`，
  因此**执行成功的 `execute_shell`（`classify` = `unknown`）会落进 `committed` 集合**。
- `electron/runCheckpoint.cjs:224-225`：`unknownFromLedger` 又用 `phase !== 'committed'` 过滤，
  把上面那条 unknown **排除**掉。
- 于是 `unknownSteps` 与 `unknownFromLedger` 同时为空 → `:260-268` 的 review 分支不进入 →
  若其余待办只读，`:278-284` 判定 `mode:'auto'`，文案写「续跑时跳过」。

而执行期 `electron/sideEffects.cjs:180` 的去重条件是 `phase === 'committed' && effect === 'write'` ——
**`unknown` 根本不参与去重**。

**触发条件**：一个 Run 里执行过会成功返回的 `execute_shell`（`git push` / `npm publish` / `curl POST` 等
`classify` = unknown 的命令），Run 中断或触顶后点「续跑」。

**实际影响**：命令会被**真的再执行一次**，而 `planResume` 已告诉用户和模型「该写操作已提交，续跑时跳过」，
模型被文案安抚不会去核对 → **重复的不可逆外部副作用**。这与
`electron/sideEffects.cjs:13`、`electron/runCheckpoint.cjs:16-17` 明文写的
「unknown 永不自动跳过/重放」相反。

**现有保护**：幂等账本对 `effect === 'write'` 的去重是有效的；检查点与恢复入口都在。

**最小修复**：`review()` 改为**按 `effect` 优先分类**（`unknown` 恒进 `unknown`，不看 phase）；
`skippable` 只收 `effect === 'write'`；`unknown` 一律 `requiresReview`，文案改成
「已执行但外部结果不可知，需人工核对」。

**回归测试**：造一个含「成功 `execute_shell` + 只读待办」的中断 Run，断言
① `plan.mode !== 'auto'`、② `requiresReview === true`、③ `unknownEffects` 含该 shell、
④ `skippedByLedger` 不含它。变异：把 `review()` 的判定顺序改回 phase 优先，用例必须红。

---

### #2【P1】续跑检查点按位置切片且不修配对 → 孤儿 `tool` 消息

**结论**：确认缺陷。**父代理逐行复核。**（两条独立审查路各自报出，互相印证。）

**现象**：`electron/runCheckpoint.cjs:95-103` 是**纯按位置**切片：

```js
.filter((m) => m && m.role).slice(-MAX_CHECKPOINT_MESSAGES)   // 24 条
.map((m) => ({ role, content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }))
```

`:292-301` 的 `buildResumeMessages` 又原样拼回 `messages`，`electron/ipc/agent.cjs:363-365`
直接把它当 `runAgentChat` 的报文。切片边界**不保证**落在 `assistant`／`tool` 组边界上，
只要消息数越过 24，就可能切出**前驱 assistant 已被切掉的 `tool` 消息**。

另一条更直接的破坏路径：`electron/agent.cjs:2432` 的 `checkpointMessages(..., 'round_end')`
发生在 `:2435 if (capped) break` **之前** → 「声明了 N 个 `tool_calls`、只回了 k 个」的残缺报文被落盘。

**触发条件**：任何「单轮多个工具调用 + 消息数越过 24」的正常长任务，或跑到
`agent.max_total_tool_calls` 上限的 Run；随后点「续跑」（`LIMIT_REACHED` / `interrupted` 都在列表里）。

**实际影响**：续跑的第一条请求就是非法报文 —— OpenAI 兼容接口对孤立 `tool` 消息会返回 400。
用户看到「Agent 调用失败 + 供应商英文原文」，**无法从界面判断是检查点坏了**，
文档承诺的「点续跑从断点继续」在常见形态下不可用。

**现有保护**：`electron/agent.cjs:1908-1910` 的硬裁剪层**专门声明**「保配对」—— 说明该约束是已知的，
只是**检查点这条路没遵守**。

**为什么一直没被红出来**：`scripts/agent-resume-test.cjs:174-178` 只断言「有 system / 有断点续跑字样」，
**从不校验消息结构合法性**。

**最小修复**：加纯函数 `repairToolPairing(messages)`（在 `saveMessages` 或 `buildResumeMessages` 调用）：
丢弃头部找不到前驱 `assistant` 的 `tool` 消息；对尾部未应答的 `tool_calls`，要么丢弃，
要么补一条写明「上次中断于此，未执行」的 `tool` 消息。

**回归测试**：两组输入断言 + 变异 ——
① 构造 `[system, user, (assistant+7tool)×4]` 走 `slice(-24)`，断言输出**无孤儿 tool 消息**；
② 构造「声明 3 个 `tool_calls` 只回 1 个」的残缺报文，断言修复后配对完整或明确丢弃；
③ 断言修复后的报文能通过「每个 `tool_call_id` 都有前驱 `tool_calls`」的独立校验函数。

---

### #3【P1】一次超窗自救把模型窗口永久锁成估算值，并被预检当硬门槛

**结论**：确认缺陷（机制确证；触发频率待真机确认）。**父代理逐行复核。**

**现象**：

- `electron/agent.cjs:1710`：`compactionWindow = overflowWindow || declaredWindow || …`
- `electron/agent.cjs:1715`：`windowKnown = overflowWindow > 0 || …`
- `electron/agent.cjs:1943-1972`：`windowKnown` 为真且 `estimate > compactionWindow` → **直接拒发**，
  返回 `stopReason:'context_overflow'` 并建议「开一个新会话」。

而 `overflowWindow` 来自 `getContextWindowOverride(cfg)` —— 是**被 400 自救写进去的自有启发式估算**
（`:2049-2050` 用 `compactionLib.estimateTokens(messages)`，**不是供应商报的真实用量**），
取历史最小值、只降不升；`resetContextWindowOverrides` 全仓只有脚本调用，**没有 IPC/UI 出口**。

**对照本仓库自己的真机数据**（`docs/context-overflow-guard-2026-09-17.md §4`）：
真实窗口 1,048,576，锁下来的是 `655,595 × 0.9 = 590,035` —— **真实窗口的 56%**。
而那一次 400 的成因是「输入 **+ max_tokens** 超窗」，与输入本身是否超窗**无关**
（机制②`max_tokens_capped` 本来就是处理这种情况的）。

**触发条件**：任意一次被判为超窗的 400。

**实际影响**：一次与输入无关的 400，会让**这份历史在该进程内再也发不出去**：
预检直接拒发并让用户「开一个新会话」，压缩触发线也永久提前。用户既看不到这个降级，
也没有任何开关能撤销（只能重启应用）。

**现有保护**：只写内存、不写 `models.json`（「自动改用户配置比一轮报错更危险」这个判断是对的）；
按 `apiBase|model` 隔离；只自救一次。

**最小修复**：① 降级值改取**供应商报错原文里解析出的真实 token 数**（如 `X in the messages`），
而不是自己的估算；② 预检**不要**拿这个「由错误推导出来的下限」做拒发，只让它影响压缩触发线
（拒发只认用户声明的窗口或实测接受过的窗口）；③ 给一个 IPC/配置出口能查看与重置该账本，
并在 UI / run 事件里如实显示「本模型窗口已临时下调至 N」。

**回归测试**：模拟一次「输入 + max_tokens 超窗」的 400（供应商文案含真实 token 数），断言
① 记下的窗口来自报错原文而非估算、② 随后同尺寸输入**仍会发请求**（只收缩 `max_tokens`）、
③ 有可查询/重置的出口。变异：把降级值改回估算，用例必须红。

---

### #4【P1】幂等账本把「同 run 内同参数的写」当已完成跳过，却返回 `ok:true`

**结论**：确认缺陷（虚假成功 + 陈旧落盘）。

**现象**：`electron/agent.cjs:2184` 在每个工具调用前调 `beginSideEffect`；账本命中
「同 `runId` + 同工具 + 同参数 + `phase=committed`」就 `skip:true`（`electron/sideEffects.cjs:180`），
主循环随即构造 `AgentToolResult.ok('（幂等去重）…本次不再重复执行')` 并**完全不执行工具**（`:2208-2216`）。
`save_project` 的 `inputSchema` 是 `{properties:{}}`（`impl/saveProjectTool.cjs:17`），
所以第二次调用的参数与第一次**逐字节相同**；它还被 `electron/tools/descriptor.cjs:68` 显式声明为幂等
（`saveProjectTool.cjs:20 idempotent:true`）—— 即「重复执行本就安全」的工具，恰恰是账本拒绝重复的那一类。

同根因第二处：`impl/bulkEditTool.cjs:209-212` 部分失败时仍返回 `ok:true`，
于是这批「有失败项」的写被记成 `committed`，续跑时整批被跳过。

**触发条件**：同一次 run 内对同一工具用相同参数调用两次。典型：「保存工程 → 继续改画布 → 再保存」，
或 `write_file(A,X)` →（shell 改过 A）→ `write_file(A,X)`。

**实际影响**：第二次「保存」没有落盘，磁盘上的 `.cnode` 停留在第一次保存的状态，
而工具返回 `ok:true`，模型据此报告「已保存」。用户拿到的是**陈旧落盘 + 虚假成功**。
`electron/ipc/agent.cjs:458-543` 结束时把 `document` 交回渲染进程，**没有兜底保存**，磁盘不会自动追上。

**现有保护**：幂等账本本身是为「崩溃续跑不重复副作用」设计的，方向正确；写类工具走原子替换。

**最小修复**：把幂等键扩展为 `(runId, tool, args, 前置状态摘要)` —— `write_file`/`edit_file` 取目标文件
内容哈希或 `mtime+size`，`save_project` 取画布 doc 哈希或 dirty 版本号；前置状态变了就视为新操作。
同时把「部分成功」（`data.errors` 非空）降级为 `kind:'partial'` 且**不 commit**。

**回归测试**：真实循环里 `save_project` → 改画布 → `save_project`，断言第二次**真的执行**
（落盘时间戳/内容变化）；反向锁：同一状态连调两次必须只执行一次。变异：把幂等键改回不含状态摘要，用例红。

---

### #5【P1】子代理被 `max_tokens` 截断仍标 `done`，并产出「契约合规」信封

**结论**：确认缺陷 —— 正是 P1 要治的「信任放大」，在子代理这一侧漏了。

**现象**：`electron/agent.cjs:2459-2468, 2505-2516`：`finish_reason=length` 且补问用尽时返回
`{stopReason:'length_truncated'}`，**不设 `error`/`aborted`**。而 `electron/subagents.cjs:329-346`
只看 `timedOut`/`error`/`aborted` → 其余一律 `done`；**`stopReason` 从未被读**
（已复读 `50e9b4b`：`subagents.cjs` 中 `stopReason`/`truncated` **零命中**）。
信封的 `lossy` 仅由 `resultMaxChars` 决定（`electron/subagentEnvelope.cjs:217-225`），
`payload` 里没有 `stopReason`/`finishReason`。

**触发条件**：子代理输出触 `max_tokens` 且 truncation nudge（默认 4）用尽。

**实际影响**：主代理拿到字段齐全、`isLossy:false` 的**半截报告**当证据。
对照：主 Run 路径**反而**透传了 `stopReason`（`electron/ipc/agent.cjs:523`），只有子代理丢失。

**同类未单列**：`delegate_tasks` 用 `AgentToolResult.ok` 汇总（`subagents.cjs:235`），
把 8 个「违约不得采信」的子结果包装成**成功调用**，而单条 `delegate_task` 路径是 `error`（`:404-407`）。

**现有保护**：信封 `validateEnvelope` 对缺字段是 fail-closed 的（这块做得好），
但它校验的是**形状**，不是「内容是否完整」。

**最小修复**：子代理状态映射加 `stopReason` 分支（`length_truncated` → `kind:'error'`）；
把 `stopReason`/`finishReason` 进 `payload`；`delegate_tasks` 只要有任一子结果 `ok === false` 就返回 `error`。

**回归测试**：驱动一个必然被截断的子代理，断言 ① 信封 `kind === 'error'`、
② `payload.stopReason === 'length_truncated'`、③ 主上下文里没有「契约合规」的引导语。
变异：把 `stopReason` 分支删掉，用例必须红。

---

### #6【P1】子代理 token/成本双重记账 → 账本与告警约 2 倍失真

**结论**：确认缺陷（统计精度）。

**现象**：子代理 cfg 继承父 `costLedger`/`costRunId`，子代理每轮 `runAgentChat` 以
`kind:'main'` 记一条（`electron/agent.cjs:2091`），结束后 `electron/subagents.cjs:467`
又用 `result.usage`（逐轮 `mergeUsage` 的**累加值**）记一条 `kind:'subagent'`。
（已复读 `50e9b4b`：两处记账点都还在。）

**触发条件**：任何 `delegate_*` 调用。

**实际影响**：`ledger.summary(runId)` / `today()` / `byKind.main` / `cost.jsonl` 全部约 2 倍，
`run_tokens` / `run_cost` 告警（`electron/alerts.cjs:72-83`）会提前误报。
附带：`mergeUsage` 是浅合并（`agent.cjs:1553-1561`），`prompt_tokens_details` 只留第一轮，
配合 `costLedger.cjs:63` 的 `miss = prompt - cached` 推导，在配了 `cachedIn` 单价时该条会额外高估。

**最小修复**：二者只留一条路径 —— 给子代理传「不再自行记账」的 cfg（`costKind:'subagent'` 按轮记，
或子代理不记账、由外层汇总记一次）；`mergeUsage` 对 `*_details` 做深度累加。

**回归测试**：跑一个含 1 个子代理的 Run，断言 `ledger.summary().total` **等于**主模型 + 子代理的真实
usage 之和（而不是 2 倍）；变异：恢复双路径记账，用例红。

---

### #7【P1】前端并发竞态：单值 `sending`/`requestId` + 续跑按钮绕过 `busy` 守卫

**结论**：确认缺陷。

**现象**：`src/store/chatStore.ts:54` 的 `sending: boolean` 与 `requestId: string | null` 是
**全局唯一**语义；`send()`（`:64` 之后）**没有任何 `if (get().sending) return` 守卫**，
而每个 `send` 的 `finally` **无条件** `set({ sending:false, requestId:null })`（`:222-225`）。

两条真实路径：

- **主路径**：`src/components/WorkbenchDock.tsx:352,369` 的「自动续跑 / 按当前状态重试」直接
  `await sendChat(...)`，**完全绕过**输入框的 `busy = sending || streaming` 守卫
  （`src/components/side/AgentPanel.tsx:132,173`）。若该 Run 命中 `planResume` 的快速失败分支
  （无检查点 / 需复核，`electron/runCheckpoint.cjs:257-267` → `electron/ipc/agent.cjs:218-220`），
  第二个请求会**立刻**返回，它的 `finally` 瞬间把 `sending/requestId` 清掉，而第一个请求还在流式。
- **次路径**：`src/store/sessionStore.ts:393-401` 的 `stopTurn()` 先置 `streaming=false`，
  而 `sending` 要到 `finally` 才清 —— 中间存在「UI 已显示空闲、旧请求尚未收尾」的窗口。

**实际影响**：① `stop()` 只持有最后一个 `requestId`（`chatStore.ts:56-62`），被覆盖后**旧请求的
controller 再也点不到**，停止按钮不生效，旧 Run 继续真实调用工具
（`electron/ipc/agent.cjs:551-555` 查不到 controller 也照样返回 `{ok:true}`，不报错）；
② 两个 `send` 的 delta 都追加到「最后一条 assistant」（`sessionStore.ts:308-312`），在同一气泡里交错；
③ 全局 `requestId` 错配。后端**不是**并发上限所限（默认允许 2 个并发，`ipc/agent.cjs:170-173`）。

**最小修复**：把 `requestId`/`sending` 改成按 id 的集合（`const inflight = new Map<id, AbortController>()`），
`sending` 改为派生值 `inflight.size > 0`；`send()` 开头硬守卫；
`stop()` 明确指定 id（或提供「全部停止」）；`finally` 只删自己那一条；
`RunsPanel` 的续跑按钮同样接上 `busy` 禁用。

**回归测试**：offscreen 断言 —— 在流式中调用「自动续跑」两次，断言
① 不会同时存在两个 in-flight、② 旧请求的 controller 仍可 abort、③ 两条回复不落在同一气泡。

---

### #8【P1】高风险确认判据与白名单不共用归一化结果

**结论**：确认缺陷，但**触发面受限**（见下）。

**现象**：`electron/tools/impl/executeShellTool.cjs` 的白名单校验用**归一化后的 basename**
（`normalized`，`:271-275`），但「是否高危、要不要 HIGH 确认」用的是 `tokens[0]` **原文**
（`isSensitiveCommand`，`:184-189`）。于是同一程序两种写法判定不一致：
`node -e "…"` 触发确认，`/usr/bin/node -e "…"` **不触发**；`gradlew` 也不在名单里
（名单只有 `mvn/mvnw`，`:187`），而 `gradle/gradlew/gradlew.bat/nuget` 都在白名单（`:14`）。

**触发条件**：Linux / macOS（`sandbox.mode=best-effort` 且 bwrap / sandbox-exec 不可用，即文档承认的
降级路径）下，命令写成路径限定形式或改用 gradle 系入口。
**Windows 上不可达**：`.bat`/`.exe` 在 `shell:false` 下无法直接 spawn，经 `cmd` 调用会命中敏感名单。

**实际影响**：在隔离后端缺失时，HIGH 确认是任意代码执行的**唯一**闸门；绕过它等于对
「不可信项目 → 任意代码/越界写」开一条静默通道。
注意这条与「`verifier` 角色 `readOnly:true` 却持有 shell 能力」会互相放大。

**最小修复**：确认判据与白名单**共用同一个归一化结果**（去 `.exe/.cmd/.bat/.ps1` 后缀、小写、取 basename），
并把 `gradle/gradlew/gradlew.bat/nuget/dotnet/pip/pnpm/yarn` 等脚本入口全部纳入；
更稳的方向是反向写法（白名单通过即需确认，只对显式只读子命令豁免）。

**回归测试**：断言「任何白名单命令的路径限定写法与裸写法得到**相同的** sensitive 判定」，
对一组候选命令做表驱动。

---

## 3. P2 / P3 项（表格 + 关键说明）

「现有保护」一列只写与本条直接相关的。

| # | 现象与证据 | 触发条件 | 影响 | 最小修复 | 回归测试 |
| --- | --- | --- | --- | --- | --- |
| 9 | `edit_file`/`write_file` 新增**可选** `expectedSha256`，但校验在 `context.confirm` **之前**（`editFileTool.cjs:70-83` vs `:101`；`writeFileTool.cjs:36-47` vs `:52`），且模型不传就不校验 | 确认框挂着时目标文件被外部改动 | **TOCTOU 窗口未关闭**：确认期间的外部修改仍被静默覆盖；`edit_file` 文案里「替换 N 处」仍是旧快照数字 | 在 confirm **之后、写入之前**再校验一次（或改为内容哈希条件写）；写前重算替换处数 | 在 confirm 与 write 之间改动文件 → 断言写入被拒（`CONFLICT_STALE`）；变异：删掉第二次校验，用例红 |
| 10 | 确认信息面不足：`write_file` detail 仍只有字节数（`writeFileTool.cjs:52`）；`bulk_edit.create_files` 不显示内容（`bulkEditTool.cjs:83-103`）；MCP 分支不给 `command` 与 `args`（`extensions.cjs:199`，非 MCP 分支 `:221` 反而给了） | 任何提示注入诱导写入 | 用户唯一的判断依据来自对话框，而对话框不给内容 → 「确认」退化为无条件放行 | 确认 payload 增加结构化字段：内容 diff / 前 N 行预览（大内容给哈希+行数）、完整路径列表、MCP 的 `command` 与参数 JSON 预览 | 断言 confirm payload 含内容摘要与命令原文 |
| 11 | 压缩失败降级：`catch` 返回 `String(text).slice(0, budget=1500) + '…（子代理压缩失败，已截断）'`（`agent.cjs:1262-1264`），主循环无条件 `record.compressed = true`（`:2371-2374`）。进入压缩前上限是 12 万字符 | 压缩模型 429/超时/额度用尽 | 最坏 **120,000 → 1,500 字符（丢 98.7%）**，模型以为拿到了完整结果；用例把该行为断言成「信息不丢」（`compression-batch-test.cjs:104`） | 失败时**保留原文**（已受 `dataTruncateCap` 约束）；若要截断，用显式标记 +「请用相同参数重新调用」；改掉用例与文档里的说法 | 注入压缩失败 → 断言正文**未被缩短**且带「未压缩（原因 X）」；变异：恢复截断，用例红 |
| 12 | `streamAccumulator.cjs:220-223` 解析了「200 流内联 `error`」并记 anomaly，`:304` 返回；但主循环 `agent.cjs:2081` 之后只读 `usage`/`toolCalls`/`finishReason`，**从不看 `res.anomalies`**（生产代码仅 `:834` 一处出现） | 供应商在 200 流里下发错误对象，或出现 `unparsable-data-line` 等分片异常 | 空回答/半截回答被当 `COMPLETED` 交付，无报错、无 run 事件、无留痕 | 至少 `emitTrace(kind:'stream_anomaly')`；`in-stream-error` 按可重试错误处理；「流内 error 且无内容」判为失败 | 注入流内 error → 断言状态非 `COMPLETED` 且事件流有记录 |
| 13 | `sideEffects._persist()` 把**整本账本** `JSON.stringify` 后 `fsync + rename`（`:142-160`），而 `begin()`/`commit()` **每次都调**（`:188,210,224`）；`beginSideEffect` 对每个工具调用都调（`tools/context.cjs:255-262`，**含只读**）。`compressionCache.cjs:125-133` 每条 `set` 全量重写 | 任何正常多工具 Run（默认上限 100 次）——不需要异常 | 单 Run 累计 n 次 fsync + 全量重写，写出字节数约 **O(n²)**；全在 Electron 主进程同步路径上 → UI/IPC 可感知卡顿，随调用数二次增长 | 只读工具不建账本记录；`_persist` 改脏标记 + 批量落盘（round_end / 退出前强制 flush）；压缩缓存每轮落一次 | 计时探针：100 次工具调用的累计 fsync 时延与写出字节数；断言只读调用**不**触发落盘 |
| 14 | `runStore.appendJsonl` 每次调用都 `readFileSync` 整个文件再判轮转（`:30-31`）；`recoverInterrupted` → `listRuns(200)` 对每个文件整读 + 逐行 `JSON.parse`（`:99-108,135-157`），而 `ipc/agent.cjs:204` **每次 `agent:chat`** 都调，`:120-124` 的 `agent:runs` 再来一遍 | 项目累积过多次 Run（每次对话留一个 run 文件，单文件上限 2MB） | 发消息前同步读解析最多 200 个 JSONL（可达数十 MB）→ 发送时固定卡顿，随使用历史单调变差 | 进程内维护 `Map<path,bytes>` 字节计数（启动 stat 一次）；`recoverInterrupted` 只读首行 `run_start` + 尾行 `run_finish`，已 recover 过则跳过 | 造 200 个 run 文件，断言 `agent:chat` 耗时与读取字节数**不随 run 数线性增长** |
| 15 | 脱敏只覆盖 `runStore.appendJsonl` 与 audit 路径；三处走裸 `atomicWriteFile`：`compressionCache.cjs:86`（工具结果的模型摘要）、`sideEffects.cjs:147`（`record.error`，最长 500 字符原文）、`memory.cjs:23`（`remember` 任意内容） | 任何结果压缩（>2000 字符）、工具失败、或 remember 敏感内容 | `.codenode/metrics/compression-cache.json`（LRU 200 条 / 2MB 长期驻留）、`runs/*.side-effects.json`、`memory.json` 出现明文 Key，而审计视角以为日志已脱敏 | 把 redact 下沉到统一 `atomicWriteJson` 封装，至少给 `compressionCache.value` 与 `sideEffects.error` 加脱敏 | 写入含合成密钥的工具结果 → 断言三个文件里都**不含**原文 |
| 16 | `readMemory` 任何异常都返回 `{entries:[]}`（`memory.cjs:11-17`），而 remember 是「读出 + push + 整体覆盖写」（`memoryTool.cjs:15-17`）；`writeMemory` 固定 `slice(-200)`（`memory.cjs:23`） | `memory.json` 被编辑坏/截断；或记忆超 200 条 | 文件一旦解析失败，**下一次保存把整个记忆库替换成 1 条**；第 201 条起每保存一次静默丢弃最旧约定，无提示无审计 | `readMemory` 区分「文件不存在」与「解析失败」；解析失败**拒绝写入**并保留坏文件报错；上限改显式淘汰 + 审计 | 写坏 `memory.json` → 断言保存被拒且原文件未被覆盖；变异：恢复静默清空，用例红 |
| 17 | `read_file` 用**模型给的 relative** 做 `isSensitivePath`（`readFileTool.cjs:94`），之后才 `resolveInRoot`（只保证 realpath 在根内，`shared.cjs:16-35`）并跟随符号链接读取 | 打开自带相对符号链接的不可信仓库（`notes.md → .env`） | `read_file` 是凭据外发的直接通道：内容回灌进上下文并送到供应商；`fsCore.isSensitivePath` 与 RAG 的同等规则同时失效。遍历类工具**不受影响**（`walkEachFile` 会跳过符号链接） | 判定改为对 **realpath 结果**做（`isSensitivePath(path.relative(realRoot, real))`） | 造 `notes.md → .env` 链接 → 断言读取被拒；变异：改回相对路径判定，用例红 |
| 18 | 模型可自选 `taskId`：`subagents.cjs:369` 无条件 `String(args.taskId \|\| makeTaskId())`，配额用 `this.tasks.size`（`:357`），全文件**无 `tasks.has` 唯一性检查**（已复读 `50e9b4b`） | 模型复用同一 `taskId`（如每轮都写 `"task-1"`） | ① `tasks.size` 恒 1 → `maxTasksPerRun`(12) **永不触发**，单 Run 子代理数量与花费无上界（`maxBatchTasks=8` 只限单批）；② `cancel_subagent_task` 只能查到新任务（`:213`），旧子代理跑到总时长上限且无法取消；③ 旧任务结束时回写覆盖新任务视图 | `taskId` 冲突拒绝或加后缀；配额改用独立的「曾进入 running」计数器 | 连续两批用同一 `taskId` → 断言第二批被拒或自动改名，且配额仍生效 |
| 19 | `execute_shell` 前台把 stdout/stderr **无界**累加（`executeShellTool.cjs:348-353`），到 `close` 才分页；`outputPage` 的 `size` 只限制**返回的那一页**（`:118-130`）。后台 `job.output +=` 同样无界并常驻内存至多 1 小时（`:78-79`）。对照：扩展有 20000 上限、`fetch_url` 有 1MiB 上限 | 高输出命令（`npm test`、大 `git log -p`、死循环 `Write-Output`） | 主进程内存线性增长，可 OOM/无响应并阻塞所有并发 run；分页给人「已限制」的错觉 | 收集侧设硬上限（如 8MiB），超限停止累积并记录丢弃字节数，保留 tail 环形缓冲；后台超限落临时文件 | 跑一个输出 100MiB 的命令 → 断言峰值内存有界且结果标注截断 |
| 20 | POSIX 前台 spawn **不带 `detached`**（`executeShellTool.cjs:338-343`），而 `killProcessTree` 首选 `process.kill(-pid)`（`processTree.cjs:11-16`）→ 非组首进程 `ESRCH` → 落到只 `child.kill()`，**只杀直接子进程**。后台路径有 `detached`（`:62`），所以那条是对的 | Linux/macOS 且隔离后端不可用时，前台执行再 fork 的程序（`npm test` → jest worker）后点停止或超时 | 用户认为已停止，实际构建/测试进程树继续运行、继续写工作区 —— 「停止后仍有残留副作用」，修复只覆盖了后台与扩展路径 | 前台也加 `detached:true`，或兜底枚举子孙进程逐个终止 | 前台起一个 fork 子进程的命令 → 取消后断言**无残留子孙**（`ps` 快照对比） |
| 21 | `needsReview` 分支丢弃 `plan`：后端回传 `{ok:false, needsReview:true, plan}`（`ipc/agent.cjs:218-220`），前端只取布尔（`chatStore.ts:130-134`），类型里连 `plan` 都没有（`global.d.ts:291`）。另：后端发的 `truncated`（`agent.cjs:2116,2461`）与 `stopped`（`:1898,2165,2246,2530`）在前端 `streamDelta` **无任何分支**（`sessionStore.ts:276-338`） | 对含未知副作用的 Run 续跑；或回答撞 `max_tokens` / 用户点停止 | ① 要求用户「人工复核」却不告诉他复核什么（`unknownEffects`/`warning` 被整条丢弃）；② 「正在续写 / 已停止」在流式中不可见，停止操作数秒内像没生效 | 把 `plan` 接进类型与 UI（列出未知副作用 + 警告 + 待办，给「了解风险强制续跑 / 按状态重试」两个出口）；`streamDelta` 加 `truncated`/`stopped` 分支 + 未知 kind 兜底 `console.warn` | 断言 `needsReview` 时界面出现 `unknownEffects` 的工具名；断言 `stopped` delta 后消息状态立即变化 |
| 22 | 主循环 push 的 tool 消息只有 `{role, tool_call_id, content}`（`agent.cjs:2322-2326`，已复读 `50e9b4b` 仍无 `name`），而 `contextBudget.cjs:99,103` 用 `message.name \|\| message.toolName` 取工具名 | 任何触发硬裁剪（默认 25 万字符） | 占位符渲染成「此处原本是**工具**的结果」——「用相同参数重取」这句话里最有用的信息丢了；`context_trim` 事件里也是 `:27489`。用例 fixture 自带 `name`（`context-budget-test.cjs:43`）所以一直绿 | push tool 消息时带上 `name: tc.name`（协议允许），或从同索引之前的调用回查工具名 | 用**生产同形**（不带 `name`）的消息断言占位符含工具名 |
| 23 | `bulk_edit.create_files` 用裸 `fs.writeFileSync`（`bulkEditTool.cjs:200`），`write_analysis_md` 同样（`writeAnalysisMdTool.cjs:76-77`）—— 不备份、不 fsync、不 rename；同目录的 `write_file`/`edit_file` 走 `atomicWriteFile` | 写入过程中崩溃/断电 | 文件被截断成半截且无 `.bak`；与 remediation 文档「Agent 写文件统一原子替换」的表述不一致 | 统一从 `atomicFile.cjs` 写盘（批量可用 staging 目录 + 批量 rename） | 静态门禁：断言不存在绕过 `atomicWriteFile` 的写路径 |
| 24 | `scheduler.cjs:40-58` 的 `linkAbort` 对父 signal `addEventListener('abort', () => controller.abort(), {once:true})` —— 闭包匿名、句柄不留，**无法摘除**；`178-186` 每个预启动的只读调用挂一次，而父 signal 整轮复用 | `tools.parallel=true`（默认 **false**）且单 Run 预启动 >10 次 | Node `MaxListenersExceededWarning` 刷屏掩盖真实告警；内存随 run 内调用数增长（run 结束随 signal 回收，非跨 run 泄漏） | 存句柄并在 `finally` 里 `removeEventListener`，或用 `AbortSignal.any([...])` | 断言预启动 20 次后父 signal 的监听数不增长 |
| 25 | (a) `void autoResume()` / `void retryResume()` 等 `async` 函数**无 catch**（`WorkbenchDock.tsx:348-373,457,460`），而 `retryResume` 内部会主动 `throw`（`:368`）；同类 `void api.stopAgent(rid)`（`chatStore.ts:60`）。(b) 流式正文、「思考中」、`stopped`、失败原因都不在 live region；`ToolDialog` 无 `role="dialog"`/焦点管理 | IPC reject；键盘/读屏用户 | 错误只出现在 devtools，界面「点了没反应」；读屏用户得不到「正在生成/已中断」播报；审批弹窗只能用鼠标 | 封装 `fireAndReport(promise, label)` 统一 catch 并 toast；对话体加 `aria-live`，`ToolDialog` 加 `role="dialog"` + 焦点圈定 + Escape | 让 handler 抛错 → 断言出现用户可见的错误提示 |

---

## 4. 结构性问题（不是单点 bug）

### 4.1 真机验证与代码演进脱节（本轮我认为最值得处理的系统性问题）

1. **真机模式下 11 个任务只执行 5 个**。`scripts/agent-eval-tasks.cjs` 里 6 个任务标了 `realModel: false`，
   跳过理由统一写成「依赖脚本化模型（确定性注入/预算/取消/崩溃）」——
   而跳过的恰好是**最关键**的可靠性路径：长上下文压缩、越界注入兜底、崩溃恢复、token 预算、
   工具调用上限、迭代上限（见 `docs/eval-reports/agent-eval-72342c7-model-20260917-085235.md`）。
   报告汇总里的「成功率 100.0%」分母是「执行任务中」，对外容易被读成 11/11。
2. **这个理由对至少 4 项是过度归因**：长上下文压缩、`budget-token-cap`、`budget-tool-call-cap`、
   `iteration-cap-stop` 在真机下**是可执行的**，只是判据要从「必然触发」改成「触发则必须满足」
   （或把 prompt/阈值调到更必然）。「崩溃恢复」与「注入兜底」确实难做确定性复现，属合理取舍。
3. **真机 job 只在手动 `workflow_dispatch` 的 release 模式跑**（`.github/workflows/production-gate.yml:102-105`），
   默认 push/PR 的 gate 模式**不跑**真实模型。
4. **后果已经发生**：最后一份真机报告停在 `72342c7`；之后有 **6 个提交改了 15 个 `electron/` 文件**
   （`git log --oneline 72342c7..HEAD -- electron/`），全是 Agent 核心行为
   （上下文压缩、超窗闸门、子代理信封）。这些改动的合并**没有经过真机回归**。

### 4.2 用户对运行中的 Agent 几乎没有控制手段

三件事放在一起看才明显：

- **不能中途纠偏**：全仓无 steering / 排队消息机制（`grep steer|interject|queueMessage` 无生产命中），
  长任务方向跑偏只能整停。
- **不能单独停子代理**：`cancel_subagent_task` 是上一轮才加的，而跨 Run 查不到（`tasks` 是内存 Map，
  manager 每 request 新建）；#18 的 `taskId` 覆盖会让它进一步失准。
- **不能回滚本次 Run 的文件改动**：`src/store/projectStore.ts:213` 的 `revertDraft` 只是**编辑器草稿**撤销；
  幂等账本记了「改了什么」（`idemKey`/actor/phase），但**没记「改之前是什么」**（无 before-image），
  也没有任何回滚入口。

### 4.3 每轮固定开销从未被审计

`contextBudget` 明确**保护 system 消息**、只裁工具结果，而固定开销的大头在别处。实测（本机）：

| 项 | 度量 |
| --- | --- |
| `buildSystemPrompt` 固定部分（空画布/无记忆/无技能/无工具引导） | **4,814 字符 ≈ 3.4k tokens** |
| `toOpenAiTools()` 24 个工具的 JSON Schema | **15,602 字符 ≈ 4.5k tokens** |
| 合计 | **≈ 8k tokens/轮** |

提示词里是 **19 条顶层规则 + 8 条子规则**（规则 14 从 a 到 h），其中画布建模规则在纯代码任务中
完全无关却常驻。这不是 bug，但是「注意力稀释 + 固定成本」的来源 —— 值得做一次按任务类型的分层/按需注入。

### 4.4 「用例与生产不同形」让真问题长期是绿的

同一模式至少出现三次：

- `scripts/context-budget-test.cjs:43` 的 fixture **自带 `name`**，生产消息没有（掩盖 #22）。
- `scripts/compression-batch-test.cjs:104` 把「截断」断言成「**信息不丢**」（掩盖 #11）。
- `scripts/agent-resume-test.cjs:174-178` 只断言「有 system / 有断点续跑字样」，不校验结构合法性（掩盖 #2）。

本仓库的**变异测试纪律很强**，但缺一道「用例输入是否与生产同形」的门禁。建议：
对关键用例增加「fixture 形状断言」（用生产构造函数生成输入，而不是手写近似对象）。

---

## 5. 已检查但未发现问题（这些边界确实做对了）

如实记录，避免下一轮重复投入。

- **`publicHttp.cjs` 的 DNS 固定解析是真绑定到已校验 IP**：`readResponse` 用 `lookup` 回调强制返回
  `resolveTarget` 校验过的地址（`:63-66`），并用 `agent:false` 避免连接池复用绕过校验（`:61`）；
  `resolveTarget` 对 `dns.lookup(all:true)` 的**每一个**地址做公网判定（`:49-50`），IPv4 覆盖
  私网/保留/组播/CGNAT/文档段（`:13-18`）；重定向逐跳重走校验（`:119-127`）。
  这不是「注释里说绑定了」，是读码确认的。
- **路径边界**：`resolveInRoot`（`shared.cjs:16-35`）先做 resolve 前缀比较，再对「最长存在前缀」
  做 realpath 并复核；UNC、`C:foo` 盘符相对、`..`、指向根外的 junction/symlink 均被拒。
  所有文件入口都接了它（`write_file/edit_file/read_file/list_directory/search_files/scan_project/
  bulk_edit/write_analysis_md/code_review` + `ipc/agent.cjs:58` 的工程保存）。
- **`envPolicy` 的继承面是真的白名单**：只复制 `SAFE_ENV_KEYS`（`:16`），allowlist 还按名字过滤
  密钥类与 `NODE_/LD_/DYLD_/PYTHONPATH/ELECTRON_/CODENODE_` 前缀（`:19-21`）；
  Windows Job 后端先 `psi.EnvironmentVariables.Clear()` 再只写 spec 里的 env。当前所有调用点传入的
  `extra` 都是内部常量，**没有**模型/扩展配置可控的注入路径。
- **审批链不可被参数伪造**：模型自填的 `confirmed/approved/approvalToken` 在校验前被剥离
  （`registry.cjs:24,272-287`）；无审批通道时返回 `APPROVAL_REQUIRED` 而非放行（`:301-310`）；
  令牌单次消费、带 TTL、绑定 capability/scope；确认通道超时/发送者销毁一律解析为**拒绝**
  （`bridge.cjs:50-71,98-99`）；检查确认→执行之间参数未被改写。
- **`requestQueue` 的排队/取消/公平性与有界拒绝正确**：槽位交接不先减 `active`（`:30-36`）；
  排队者被 abort 时从 `waiting` 摘除并 reject、不占槽（`:16-22`）；`maxWaiting=32` 满时**显式拒绝**，
  不是无界等待。模型并发不会被并行子代理放大（`modelQueue` 是模块级单例，全局并发恒为 4）。
- **预算 `reserve`/`settle` 无竞态且总量有界**：全同步无 `await`；父链预留失败时子层未自增，回滚干净；
  子默认配额 0 = 共享父预算 → 「N 个子代理各拿满配额相乘」不成立。无 usage 时按全额结算（保守而非漏算）。
- **子代理信封是真 fail-closed 且不误伤**：缺 `snapshot.hash`/`payload`/`trust` 即违约；
  `GraphModel.doc` 恒为对象 → 不存在「无画布环境全部拒收」的过判。
- **子代理无法递归委派**：`delegate_*` 只挂主注册表，子注册表由 `BUILTINS` 构建不含它 → 无扇出递归。
- **日志系统的轮转原子性与坏尾行容错**：轮转 = 写临时文件（`wx`）+ rename；坏尾行过滤丢弃且不阻断本次写入；
  `readRun`/`readCheckpoints`/`readEvents` 逐行跳过坏行。
- **`atomicFile.atomicWriteFile` 覆盖语义正确**：临时文件 `wx` + `fsync` + `rename`，异常路径关闭句柄并清理。
  （未做父目录 fsync —— 对缓存/账本这类可重建数据是可接受取舍。）
- **`compressionCache` 有界**：LRU 同时按 `maxEntries`(200) 与 `maxBytes`(2MB) 淘汰并正确扣减 `bytes`；
  文件损坏时保留 `loadError` 供 `stats()` 读出。
- **`contextBudget` 的裁剪自身不破坏协议**：只改写 `role:'tool'` 的 `content`，条数与角色序不动；
  `done` 集合保证第二档不重复计账；压不住时如实报 `overBudget`。
- **`agentState` 迁移表覆盖实际收尾组合**：`tools_settled→RUNNING`、`WAITING_TOOL→LIMIT_REACHED`、
  `→CANCELLED` 均为合法边；非法迁移只记 `violations` 不改状态，不会产生悬挂状态。
- **`ipc/agent.cjs` 的并发上限检查无 TOCTOU**：`:173` 的检查到 `:455` 的 `set` 之间**没有任何 `await`**
  （装配全同步），同一 event loop turn 完成；`finally` 必定删除条目并 `bridge.cleanup()`。
- **前端无注入面**：全仓仅 1 处 `dangerouslySetInnerHTML`（`WorkbenchDock.tsx:210`），值来自
  `highlightCode(draft)`，而它对每个拼接片段都 `escapeHtml`（`:70-86`）；Agent/用户输出全部走 React
  文本子节点。`contextBridge` 只暴露 23 个具名方法，无 `ipcRenderer`/`require`/`fs` 外泄。
- **订阅/定时器无泄漏**：`chatStore` 的 delta 订阅在 `finally` 里 `unsub()`；`WorkbenchDock` 的 20s 轮询与
  `onAgentAlert` 在 cleanup 里清理；`Canvas`/`useContainerAutoFit`/`App` 的监听器都正确回收。
- **记忆检索打分无逻辑错误**：中英分词（英文按词、中文 2-gram）、`key×6/tags×4/content×2`、
  全无命中时显式标注「未按当前问题检索」并退回最近 N 条。

---

## 6. 待核实（不要在只读审查的基础上当成已复现）

1. **#2 的「必然 400」**：结构破坏是读码确证的，但供应商对孤立 `tool` 消息的拒绝行为需真机确认 ——
   建议手写一个 5 行的含孤立 `tool` 消息的请求打一次。
2. **#13/#14 的量级**：fsync 与 run 日志扫描的实际毫秒数需一次真实多工具 Run 的计时探针；
   本文给的是按 Windows `FlushFileBuffers`+rename 常见量级的**区间估计**，不是实测。
3. **#3 的触发频率**：机制（一次性、只降不升、无重置出口）是读码确证的；
   实际撞到「输入 + max_tokens > 窗口」的频率取决于真实用户与模型窗口配置。
4. **#8 的实际可达性**：Windows 侧不可达已确认；Linux/macOS 需要在沙箱降级（无 bwrap/sandbox-exec）
   的实际环境里验证命令确实被放行。
5. **#1 的复现**：建议用一个「成功 `execute_shell` + 只读待办」的中断 Run 走一遍 `planResume`，
   确认 `mode === 'auto'` 且续跑时命令真的再执行（本文的结论链是逐行读码得出的）。

---

## 7. 建议实施顺序

1. **#1**（P0）—— 唯一会重复**不可逆外部副作用**的一条，且与代码明文声明矛盾，改动很小。
2. **#2 / #3** —— 都是「功能承诺在常见形态下失效」，修法都很小（加配对修复函数；降级值取真实 token 数
   并解除预检的硬门槛）。
3. **#4 / #5 / #6 / #7** —— 虚假成功、信任放大、成本失真、前端竞态；每条都需要一个能区分实现的用例。
4. **补真机回归的形状**（§4.1）：把 4 个可执行的 skip 任务改成真机可跑，并把真机 job 挂到 PR（哪怕只跑 3 个便宜任务）。
5. **清掉「记了没人读」的一组**：#12、#21、#22 —— 改动量小，收益是用户能看见原因。
6. **热路径 I/O 与脱敏**：#13、#14、#15、#16。
7. **结构化能力**（§4.2 与 §4.3）：回滚、steering、子代理 UI、提示词分层 —— 需要产品决策，不宜当 bug 修。

> 不建议按「发现了多少条」评估这一轮的产出。上面 25 条里真正会伤到用户的只有前 8 条，
> 其余大部分是「不影响正确性但影响可信度/性能/可维护性」的债。第 5 节列出的那些**确实做对的边界**
> 同样是结论的一部分 —— 尤其是 `publicHttp` 的 IP 绑定、审批链的不可伪造、`resolveInRoot` 的路径边界，
> 这三处的实现质量明显高于同类项目。
