# Agent 工具调用架构审查与重构方案（2026-09-15）

- **基线**：`cf495cb`（`0_2`），审查时工作区另有在途改动 7 个文件（Milvus 一致性 / RAG 文档，均不涉及本审查引用的行）。
- **方法**：静态通读 + 机械扫描（遍历 24 个 `electron/tools/impl/*.cjs` 的注册项、confirm 调用、timeout/signal 使用、schema 声明）。
- **声明**：本次审查未收到任何"截图架构说明"附件，以下结论**全部来自仓库真实代码**，不与任何口头/截图描述做假定对齐。
- **结论摘要**：骨架（参数校验、只读白名单缓存保活、副作用幂等账本、断点续跑、执行隔离、请求预算预留）已明显强于同类 harness；问题集中在**契约缺失**（工具无 descriptor、错误只有 `ok/text/data`）与**若干已定位的具体缺陷**（`tool_call_id` 三处生成不一致、幂等键未规范化、无 per-tool 超时、无状态机、并行/取消/可观测性缺位）。**不需要重写**，按分阶段方案收敛即可。

---

## 1. 当前代码与"标准架构描述"的差异

| 描述中的能力 | 实际情况（代码） |
|---|---|
| Registry 注册工具 → OpenAI Schema | ✅ 有，但 spec 只有 `{name, description, inputSchema}`（`registry.cjs:66`）——**没有** version / readOnly / idempotent / cachePolicy / timeoutMs / capability |
| 参数校验 | ✅ 类型 / enum / min-max / maxLength / minItems / maxItems（`registry.cjs:20`）；❌ **不校验未知字段、无 `additionalProperties`**：实测 **0/24 个工具**声明 `additionalProperties:false`，仅 `retrieve_context` 声明了 `maxItems` |
| 角色工具白名单 | ✅ `ROLE_TOOLS` 五角色（`toolkit.cjs:14`），但白名单是硬编码角色→工具名表；主 run 不做角色过滤 |
| 确认机制 | ⚠️ 仅 **6/24** 工具调用 `context.confirm`：`write_file`/`edit_file`/`write_analysis_md`/`remember`(WRITE)、`bulk_edit`/`execute_shell`(HIGH)。`workbench_edit`、`create_nodes`、`workbench_connect`、`save_project`、`ui_control` **无确认** |
| 缓存 | ⚠️ 实为**每轮内存 Map**（`agent.cjs:933`），键 = 工具名 + `canonicalArgs`（排序 JSON）；不落盘 → 天然无跨项目/跨用户泄漏，但**无版本 / 工作区版本 / 身份 / 权限范围维度** |
| 幂等保护 | ⚠️ 名字清单式分类（`sideEffects.cjs: classify`）+ 文件账本；幂等键 `sha256(scopeRunId + tool + JSON.stringify(args))` **未做键序规范化**（与缓存键口径不一致） |
| 沙箱 | ✅ 仅对**子进程**生效（shell / 扩展 / hook / MCP 走 `sandbox.guardedSpawn`；写根 = projectRoot + tmp + userData）；进程内文件工具（`read_file`/`write_file`）靠 `resolveInRoot` 校验，**不经沙箱** |
| 调用次数限制 | ✅ 硬编码常量 `MAX_TOOL_ITERATIONS=12` / `MAX_TOTAL_TOOL_CALLS=100` / `DATA_TRUNCATE_CAP=120000`（`agent.cjs:595-597`）——**不可配置** |
| 子代理 | ✅ `subagents.cjs`，子注册表按角色裁剪；但**共享父 `cfg` 与 `cfg.requestBudget`**、无独立预算、无结果合并契约，深度靠"子注册表不复注册 delegate_*"隐式 = 1 |
| 状态 | ❌ **无状态机**：`runStore` 只有字符串 `running/completed/error/cancelled/interrupted/superseded`；`LIMIT_REACHED` 被折叠成 `error`（`agent.cjs:974-982` → `ipc/agent.cjs` `finishRun`） |
| RAG Grounding | ⚠️ 已改为按 `path + 行区间` 判定（`agent.cjs:835`），但**只发独立 `{kind:'grounding'}` 事件**，不拦截、不构成交付门槛 |
| 流式解析 | ❌ 内联在 `chatCompletionStreamInternal`（`agent.cjs:541-560`）做字符串累加；全仓 **0 处引用 `finish_reason`** |
| 事件模型 | ⚠️ 5 套并行日志（`runs/*.jsonl`、`tools_trace.jsonl`、`checkpoints.jsonl`、`side-effects.json`、`audit.jsonl`）；`tools_trace` 条目**无 runId/turnId/toolCallId**（仅 `iter/name`） |

---

## 2. 问题清单

### P0 —— 安全 / 数据破坏 / 重复副作用 / 状态不可恢复

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | **`tool_call_id` 三处生成不一致** | `agent.cjs:992`（assistant 里 `id: tc.id \|\| 'call_'+iter+'_'+随机`）、`:1012`（`callId = tc.id \|\| 'call_'+iter+'_'+totalToolCalls`）、`:1125`（`tool_call_id: tc.id \|\| ''`） | 供应商不返回 `tc.id` 时，assistant 声明的 id 与 tool 消息的 `tool_call_id=''` 不匹配 → 下一轮请求 400（对话直接崩）；检查点里的 callId 又是第三个值，无法对齐 |
| P0-2 | **幂等键未规范化 → 续跑可能重复副作用** | `sideEffects.cjs: idempotencyKey(... JSON.stringify(args))`；对比 `agent.cjs:715 canonicalArgs`（排序）只用于缓存 | 同一写操作以不同键序/等价写法重发（`{"a":1,"b":2}` vs `{"b":2,"a":1}`）→ 幂等键不同 → 中断续跑**不被跳过**，重复写文件 / 重复画布变更 |
| P0-3 | **破坏性工具无确认** | `save_project`（覆盖 `workflow.cnode`，`ipc/agent.cjs: saveDoc`）、`workbench_edit`、`create_nodes`、`workbench_connect`、`ui_control` 均未调 `confirm` | 画布/工程文件可被模型静默覆盖；`atomicWriteFile` 只保证原子性，无备份、无确认 |
| P0-4 | **`save_project` 路径来自渲染层且无边界校验** | `ipc/agent.cjs` 解构 `projectFile` 直接 `path.resolve` 写入，未过 `resolveInRoot`（对比 `tools/impl/shared.cjs`） | 写入目标可越出项目根；与 `write_file` 的路径约束口径不一致 |
| P0-5 | **无 per-tool 超时 / 同步工具不可取消** | `registry.execute` 无 timeout 包装（`registry.cjs:83`）；`runAgentChat` 只在**工具之间**检查 `signal.aborted`（`:1000/:1062`） | 大 PDF `read_file`、大目录 `scan_project`、RAG 建索引、同步 `fs` 期间点"停止"无效，界面卡在 stopping 直到工具返回 |
| **P0-6** | **沙箱子进程继承了 broker 的 stdin → 任何读 stdin 的命令永久挂死（已复现，已修）** | `sandbox/winjob.cs` 用 `RedirectStandardInput = false` 启动目标命令，子进程因此继承 broker 的 stdin——那是 node 侧存活探测用的长生命管道（永不写入、也不关闭）。实测 `git --version` / `cmd /c git --version` 在 `windows-job` 后端下**零输出挂满 60s 只能超时强杀**，而 `node --version` / `where git` 正常（250ms）。即：Windows 上默认沙箱开启时 **git 全部不可用** | 代码类任务（看历史、跑测试、提交）全线瘫掉；每次命令白烧一个超时周期；配合 P0-7 还被当成「成功」 |
| **P0-7** | **超时被当成成功（已复现，已修）** | `executeShellTool` 前台超时分支返回 `AgentToolResult.ok('退出码 -1（超时强杀）…', { timedOut: true })`；`poll_job` 后台 `status==='timeout'` 也走成功分支 | 模型把「被强杀的 git/构建」当成已完成，据此继续推进并给出结论——判据不落终态的典型（正是 P0-6 的放大镜） |
| **P0-8** | **保存失败被当成成功（已复现，已修）** | `AgentToolContext.saveProject()` 吞掉异常返回 `null`，而 `save_project` 工具无论拿到什么都返回 `ok('已保存当前工程到 磁盘')` | 工程实际没落盘，模型却以为已保存 → 后续步骤基于不存在的产物推进 |
| **P0-9** | **幂等账本状态可被降级（已复现，已修）** | `SideEffectLedger.begin()` 无条件把记录置回 `pending`，而去重路径不会再调用 `commit()` → 一次正常的同参去重之后，已提交的写操作在 `review()`/`planResume` 里变成「未提交」 | 续跑判定丢失「这条写已完成」，只能整轮人工复核（功能退化，方向安全但代价高） |

### P1 —— 稳定性 / 重试 / 并发 / 超时 / 缓存

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | 无正式状态机；`LIMIT_REACHED` 语义丢失（记成 `error`）；无 `WAITING_TOOL`/`WAITING_USER` | `agent.cjs:1184-1187` → `ipc/agent.cjs: finishRun(... result.error ? 'error' : ...)` |
| P1-2 | 流式累加器脆弱：`acc.name += ` 遇重复 name 分片会拼成 `read_fileread_file`；args 重复分片 → 非法 JSON；不读 `finish_reason`（`length` 截断的半截 tool_calls 会被当正常调用执行） | `agent.cjs:541-560`；`grep finish_reason` = 0 命中 |
| P1-3 | 失败处理只有一条固定 "nudge" user 消息，**无次数上限、无错误分类** | `agent.cjs:1150-1159` |
| P1-4 | 错误语义单一：`AgentToolResult(ok, text, data)`，无 `failureCode/retryable/userActionRequired`；少量 code 靠 `data.code` 临时塞 | `tools/result.cjs`；`registry.cjs:91` |
| P1-5 | 同轮多 tool call **串行** for-of；只读工具不并行，无并发上限概念 | `agent.cjs:999` |
| P1-6 | 工具层**无重试策略**（只有 LLM 层指数退避）；未知工具/重复失败调用无计数，靠 12 轮上限兜底 | `agent.cjs:502/508`；`registry.cjs:88` |
| P1-7 | 续跑消息可能产生**孤立 tool 消息**：`saveMessages` 逐条截断（24 条 / 每条约 6000 字符），不保证 assistant(`tool_calls`) 与其 tool 响应对 | `runCheckpoint.cjs: saveMessages / buildResumeMessages` |
| P1-8 | 子代理无独立预算/无分账/无结果合并契约；`readOnly` 只靠 3 个角色名集合 | `subagents.cjs: delegate/childContext`；`agent.cjs:926` |
| P1-9 | 副作用分类清单已与真实注册表漂移：`memory_save`/`run_project`/`delegate_subagent`/`run_workflow`/`apply_patch`/`rename_file` 全不存在，实际 `remember`/`delegate_task` 落到默认 `unknown`（默认保守、方向正确，但清单漂移静默失效无守卫） | `sideEffects.cjs: READ_TOOLS/WRITE_TOOLS/UNKNOWN_TOOLS` vs `toolkit.cjs: BUILTINS` + `subagents.cjs: register` |
| P1-10 | 幂等/检查点账本**每次工具调用同步重写整个文件**（只读工具也登记 intent）→ O(n²) 写放大 | `sideEffects.cjs: begin → _persist`；`agent.cjs:1016` |
| P1-11 | 压缩有硬上限 8 次，超限后超大结果**原样进上下文**；截断 cap 只作用于 `[data]` 附加段（`result.text` 无上限） | `agent.cjs: parseCompressionConfig(maxCalls=8)`、`:673 buildToolContent` |
| P1-12 | Grounding 只旁路上报，不构成交付门槛（标 `invalid`/`missing` 的回答可直接交付） | `agent.cjs:1189-1194` |

### P2 —— 可维护性 / 可观测性 / 扩展性

| # | 问题 |
|---|---|
| P2-1 | 工具契约无 descriptor：无法声明式驱动缓存、并行、确认、审计（全靠硬编码 Set + 角色表） |
| P2-2 | `AgentToolContext` 20 个注入依赖一锅端，工具默认获得全部能力（`mutateWorkbench`/`saveProject`/`ui`/`scalars` 均可被任意工具调用）；`fork()` 把全部能力原样复制给子代理 |
| P2-3 | 事件模型不统一，`tools_trace.jsonl` 无 runId/turnId/toolCallId → 无法按 run 回放 |
| P2-4 | 预算维度不全：只有 token（`RequestBudget` 预留/结算 + 累计上限）与硬编码轮数/调用数；无总时长、单工具耗时、并发、子代理、结果大小预算 |
| P2-5 | 权限是 `LOW/WRITE/HIGH` 级别 + 工具名白名单，**不是 capability**；审批无令牌/有效期/scope 绑定；`CODENODE_TEST=1` 时 `confirm` 无条件 `true`（`bridge.cjs`） |
| P2-6 | 扩展/MCP 工具无治理声明（`extensions.cjs` 统一 spawn，未声明 readOnly/缓存策略），无法与内置工具区分可信度 |
| P2-7 | 常量不可配（12 / 100 / 120000）；`agent.max_total_tokens` 默认 60 万与 `agent.cjs:977` 的兜底 25 万并存，语义易混 |

### 做得好、别改坏（重构必须保住）

- 只读白名单缓存保活（非纯只读一律 `clear()`，含失败与未注册工具）；
- 账本 `unknown` 默认保守 + `planResume` 的 `review` 门槛（不盲目重放未知副作用）；
- `safeEnvironment` 环境变量白名单（不透传父进程密钥）；
- 沙箱策略对象注入（不是 `() => policy`）+ `strict` fail-closed；
- 取消链真正落到进程树（shell/fetch/扩展/MCP 均响应 `signal`；`bridge` 在 abort 时取消 pending 确认）；
- `RequestBudget` 预留/结算 + 图片 token 折算（未把 base64 当 token）；
- 失败结果不入缓存 + malformed 参数检测；
- 引用校验按 `path + 行区间` 判定，且提示走独立通道、不污染交付正文。

---

## 3. 推荐的新架构分层

```
┌───────────────────────────────────────────────────────────────────────┐
│ L4  Observability    EventBus → events.jsonl（唯一事件流，带 runId /   │
│                      turnId / toolCallId / attemptId）+ Replay 视图    │
├───────────────────────────────────────────────────────────────────────┤
│ L3  Orchestration    AgentStateMachine(RUNNING / WAITING_TOOL /        │
│                      WAITING_USER / COMPLETED / FAILED / CANCELLED /   │
│                      LIMIT_REACHED)                                    │
│                      ToolScheduler(依赖·冲突分析 → 串行|并行+并发上限)  │
│                      BudgetManager(迭代/调用/时长/token/并发/子代理)     │
│                      StreamAccumulator(纯函数: 分片 → tool_calls)       │
├───────────────────────────────────────────────────────────────────────┤
│ L2  Governance       CapabilityPolicy(能力 → 默认拒绝 + 路径白名单)     │
│                      ApprovalService(令牌/scope/有效期/审计)            │
│                      SideEffectGuard(prepared→running→committed→       │
│                      failed→unknown，持久化)                            │
│                      CacheLayer(版本化键) / Compressor / GroundingGate  │
│                      / Sandbox                                          │
├───────────────────────────────────────────────────────────────────────┤
│ L1  Tool Layer       ToolRegistry（ToolDescriptor 驱动 execute）        │
│                      ExecutionContext / TraceContext / CancelContext   │
├───────────────────────────────────────────────────────────────────────┤
│ L0  Capabilities     ProjectService(fs/画布) / AuditService /           │
│                      UiService / CheckpointService（纯适配层）           │
└───────────────────────────────────────────────────────────────────────┘
```

原则：**能力由 descriptor 声明 → 由 L2 策略裁决 → 由 scheduler 执行 → 由 EventBus 记录**；工具只拿 `ExecutionContext`（含 scoped 的 `project/approval/audit/ui/checkpoint/cancel/trace` facade）。

---

## 4. 核心接口草案

```ts
/** 工具契约：注册的唯一入口（旧 register 保留为适配层） */
interface ToolDescriptor<I = any, O = any> {
  name: string; version: string; description: string;
  inputSchema: JSONSchema;                  // 强制 additionalProperties:false
  outputSchema?: JSONSchema;                // data 的结构化契据
  readOnly: boolean; idempotent: boolean; mutatesWorkspace: boolean;
  requiresConfirmation: false | 'WRITE' | 'HIGH';
  requiredCapability: Capability;
  timeoutMs: number;                        // 未声明时取注册表兜底（新增 default_timeout_ms）
  cachePolicy: { mode: 'none' | 'ttl' | 'run'; ttlMs?: number; invalidatedBy?: string[] };
  retryPolicy: { maxAttempts: number; backoff: 'none' | 'exponential'; retryOn: FailureCode[] };
  concurrencyPolicy: { parallelSafe: boolean; mutexKey?: (a: I) => string };
  roleAllowlist: Role[];                    // 取代 ROLE_TOOLS 硬编码
}

type Capability =
  | 'workspace.read' | 'workspace.write' | 'project.save'
  | 'shell.execute' | 'network.request' | 'ui.interact' | 'subagent.delegate';

/** 结构化结果：判别联合，取代 ok/text/data */
type ToolResult<O = any> =
  | { kind: 'success'; text: string; data: O; effects?: EffectReceipt }
  | { kind: 'partial'; text: string; data: O;
      failed: Array<{ unit: string; failure: ToolFailure }> }
  | { kind: 'failure'; failure: ToolFailure };

type FailureCode =
  | 'ARG_INVALID_JSON' | 'ARG_SCHEMA' | 'ARG_SEMANTIC'   // 参数：可让模型修（限次）
  | 'PERMISSION_DENIED' | 'APPROVAL_REQUIRED'            // 权限：需用户或终止
  | 'CANCELLED' | 'TIMEOUT'
  | 'RETRYABLE_FAILURE' | 'FATAL_FAILURE'
  | 'EFFECT_UNKNOWN'                                     // 副作用未知 → 禁止自动重试
  | 'SYSTEM_ERROR';                                      // 程序异常（带 stack）

interface ToolFailure {
  code: FailureCode; message: string; field?: string; detail?: any;
  retryable: boolean; userActionRequired: boolean;
  stack?: string;                                        // SYSTEM_ERROR 必带
  attemptId: string; toolCallId: string;
}

interface EffectReceipt {                                // 副作用提交状态
  phase: 'prepared' | 'running' | 'committed' | 'failed' | 'unknown';
  idemKey: string; committedAt?: string; resultDigest?: string;
}

/** 工具执行期唯一可见的能力面 */
interface ExecutionContext {
  readonly runId: string; readonly turnId: string; readonly toolCallId: string;
  readonly attemptId: string; readonly role: Role; readonly signal: AbortSignal;
  readonly project: ProjectService;      // readFile / resolveInRoot / …
  readonly approval: ApprovalService;    // 取代 context.confirm
  readonly audit: AuditService;          // audit({event, data})，自动补 runId/turnId
  readonly ui: UiInteractionService;     // ask / ui（受限）
  readonly checkpoint: CheckpointService;
  readonly cache: CacheLayer;            // 键含 version / workspaceVersion / identity / caps
}

interface ApprovalService {
  /** 申请审批：返回令牌（含 scope/expiry、绑定 toolCallId）；不可用时抛 APPROVAL_REQUIRED */
  request(req: { capability: Capability; level: 'WRITE' | 'HIGH';
                 what: string; detail: string; scope: string[] }): Promise<ApprovalToken>;
  /** 校验令牌是否仍有效且覆盖本次调用（服务端签发，模型无法自填） */
  verify(token: ApprovalToken, req: { capability: Capability; scope: string[] }): boolean;
}
interface ApprovalToken {
  id: string; capability: Capability; scope: string[];
  issuedAt: string; expiresAt: string; toolCallId: string;
}
```

---

## 5. 状态机与工具执行时序

| 状态 | 进入条件 | 退出条件 | 可恢复性 | 必须持久化 |
|---|---|---|---|---|
| `RUNNING` | `run_start` 写入成功且未产生 tool_calls | 收到 tool_calls → `WAITING_TOOL`；纯文本回答 → `COMPLETED`；异常 → `FAILED`；abort → `CANCELLED` | — | prompt / model / nodeId / sandbox |
| `WAITING_TOOL` | 本轮 assistant 消息含 tool_calls | 全部调用结算 → `RUNNING` | ✅ 可按 toolCallId 跳过已 committed 的写 | 每 call 的 `intent(prepared)` |
| `WAITING_USER` | 审批或提问已发出 | 用户应答 → `WAITING_TOOL`；超时/拒绝 → `FAILED(PERMISSION_DENIED)` | ✅（审批可恢复；**不重复发起副作用**） | 审批请求 id + 目标 toolCallId |
| `COMPLETED` | 模型给出无 tool_calls 的最终文本 | — | 无需恢复 | content + grounding + usage |
| `FAILED` | 系统错误 / 不可重试失败 / 审批被拒 | 人工重试 → 新 run（旧 run `superseded`） | 部分（仅只读可自动续） | `failure.code/message/stack` |
| `CANCELLED` | 用户 abort | 续跑需人工复核 | ✅（必须 review） | 已 abort 的工具 id 列表 |
| `LIMIT_REACHED` | 迭代 / 调用数 / 时长 / token 任一触顶（**独立状态，不再折叠成 error**） | 用户续跑（预算重置） | ✅（只读阶段可 auto） | 触发维度 + 已用值 |

```
model → delta.tool_calls → StreamAccumulator.finish()
   ↓ 依赖/冲突分析（readOnly 且无共享 mutexKey → 并行；否则串行；并发 ≤ N）
ToolScheduler
   ├─ CapabilityPolicy.check(capability, path/scope)  ── deny → FAILED(PERMISSION_DENIED)
   ├─ ApprovalService.request/verify（requiresConfirmation） ──→ WAITING_USER
   ├─ SideEffectGuard.begin → prepared
   ├─ withTimeout(desc.timeoutMs, signal) → execute
   ├─ commit / fail → committed | failed；结果未知 → unknown（禁止自动重试）
   └─ CacheLayer.put / invalidate(desc.cachePolicy)
   ↓ 每个动作 → EventBus.emit({runId,turnId,toolCallId,attemptId,ts,…})
messages += tool 结果（tool_call_id 统一取自 Scheduler 分配的 callId）
```

---

## 6. 分阶段迁移方案（每步可独立上线，不破坏现有测试）

| 阶段 | 内容 | 兼容策略 | 验收 |
|---|---|---|---|
| **S0（先修 bug，1 提交）** | ① 统一 callId：assistant / tool 消息 / 检查点共用一个生成点（`agent.cjs:992 / 1012 / 1125`）；② 幂等键改用 `canonicalArgs` 同款规范化；③ `save_project` 走 `resolveInRoot` | 纯修复，无接口变化 | 新增 `test:tool-call-id`（造无 `id` 的 SSE 片段）+ 复用 `test:resume` |
| **S1** | 抽出 `streamAccumulator.cjs`（纯函数：chunks → `{toolCalls, finishReason, anomalies}`），替换内联累加；处理重复 name/args 分片、index 漂移、`finish_reason` | 先以"与旧行为等价"单测跑通，再切调用点 | 新增 `test:stream-accumulator`（12 个畸形 chunk 用例） |
| **S2** | `AgentStateMachine` + `run_state` 事件；`LIMIT_REACHED` 独立 | runStore 只加字段，旧读取路径不变 | `test:agent-state` |
| **S3** | descriptor 适配层：`registry.registerDescriptor({...})`，旧 `register()` 内部合成默认 descriptor（readOnly 由现有 CACHEABLE 白名单反推，**未知 = write，fail-closed**） | 24 个工具可逐个迁移 | `test:tool-descriptor` |
| **S4** | `ExecutionContext` 拆面：新增 `context.exec()/approval/audit/project/ui/checkpoint/cancel/trace`，旧方法保留为 deprecated 转发；新工具只用新面 | 双轨并存 | `test:context-capability`（工具拿不到越权面） |
| **S5** | 结构化 `ToolResult` + `FailureCode`；nudge 改为分类化 + 次数上限（每 toolCallId ≤ 2 次） | `ok/text/data` 保留为 getter | `test:tool-failure-taxonomy` |
| **S6** | `ToolScheduler`：只读并行（默认并发 2–4，可配）+ `withTimeout` + 取消贯穿；事件带 turnId/toolCallId/attemptId | 默认并行关闭，行为等价 | `test:scheduler-parallel` + 取消挂钟断言 |
| **S7** | capability 权限模型 + `ApprovalService` 令牌（scope/expiry/绑定 toolCallId）；`save_project`/`workbench_edit`/`create_nodes`/`ui_control` 补审批 | 旧 `confirm` 变薄封装 | `test:approval-token`（模型自填 confirmed 无效） |
| **S8** | EventBus 统一 `events.jsonl` + 回放 CLI（旧 5 套日志保留只读） | 双写一个版本周期 | `test:event-replay` |
| **S9** | 子代理：独立预算 / 深度上限 / 结果合并契约 / 只读范围显式化 | `delegate_task` 签名不变 | `test:subagent-isolation` |
| **S10** | Grounding 门 `mode=warn|enforce`（默认 warn） | 默认行为不变 | `test:grounding-gate` |

---

## 7. 必须补的测试

**单元**
- `streamAccumulator`：12 类畸形分片（重复 name、重复 args、index 漂移、超大文本、含换行/转义、裸 `[DONE]`、无最终换行、`finish_reason=length`）。
- `canonicalArgs / idempotencyKey`：键序不同、等价写法 → 同一键。
- `validateInput`：未知字段拒绝 + `additionalProperties:false` + `items` 元素类型/上下限。
- `CapabilityPolicy`：默认拒绝 / 路径白名单 / 越界 / 符号链接。
- `ApprovalService`：过期、错 scope、错 toolCallId 全部拒绝。
- `ToolScheduler`：同文件写互斥、只读并行、并发上限。
- `BudgetManager`：各维度触顶 → `LIMIT_REACHED`。

**集成**（沿用 `agent-harness-evaluation` 技术 8 的脚本化 fetch 五件套）
1. 无 `id` 的 tool_calls → 请求不被 400；
2. `finish_reason=length` 半截 args → 判 `ARG_INVALID_JSON` 且**不执行**；
3. 同参重复写两次 → 第二次幂等跳过；
4. 中断在 commit 前 / 后两条续跑路径；
5. 24+ 条消息续跑 → 无孤立 tool 消息；
6. 触顶 → `LIMIT_REACHED` 而非 `FAILED`。

**故障注入**：工具挂起 30s（验证 `timeoutMs` 与取消）、fetch 500/429（退避收敛，`maxAttempts=1` 保证确定性）、账本文件损坏（拒绝伪造去重）、检查点损坏、扩展/MCP 子进程不退出、磁盘写失败（`atomicWriteFile` 回落）。

**安全**：路径越界写/读（`..`、绝对路径、符号链接）、敏感文件读拒、`safeEnvironment` 不泄漏 `*_KEY/TOKEN`、工作区快照精确集合断言（注入样本要求写 `pwned.txt` 必须为 0）、审批令牌伪造、`CODENODE_TEST=1` 下确认仍受 capability 约束（**当前是缺口**）。

**门禁**：全部进 `scripts/run-all-tests.cjs` 的 `CORE` + `package.json` 的 `test:*`；每个修复配一次**变异测试**（回退旧行为 → 必须在预期断言上红）。

---

## 8. 需要先验证才能下结论（推理项，尚未复现）

| # | 待验证假设 | 验证方法 |
|---|---|---|
| 1 | `tc.id` 缺失是否真发生（若所有目标供应商都返回 id，P0-1 降级为"潜在"） | 造无 `id` 的 SSE chunk 走 `runAgentChat`，看第二轮请求是否被拒 |
| 2 | 供应商是否真会重复发 `function.name` 分片（决定 P1-2 的实际严重度） | 录一次真实流（或假 SSE）看 `acc.name` 累加结果 |
| 3 | 缓存命中时 `cached.content` 初值 `''` 是否导致 repeated 文案重复拼接 | 单测打印命中的 tool 消息文本 |
| 4 | 续跑消息是否真会产生孤立 tool 消息（取决于截断落点） | 构造 24 条以上消息的 run 复现 |
| 5 | 子代理 `builder` 写文件时是否真的弹确认到用户（走父 bridge） | 跑一次带 builder 的委派 |
| 6 | `save_project` 的 `projectFile` 在渲染层是否已有校验 | 读 renderer 侧调用点（本轮未读 `src/`） |
| 7 | 幂等/检查点账本同步重写的实测开销（n=100） | 计时探针 |
| 8 | 压缩 8 次上限之后的上下文体积曲线 | 探针记账 `body.messages` 字符数 |
| 9 | **`execute_shell` 白名单实际接近"任意命令"**：`ALLOWED` 含 `cmd`/`powershell`/`npx`/`node`，只剩沙箱 writeRoots 兜底 | ✅ **已复现（2026-09-15）**：`cmd /c echo PWNED > <项目外路径>` 与 `node -e "writeFileSync(<项目外路径>)"` 均在 `best-effort` 下**写成功**；策略自述为「后端=windows-job，已隔离:lifetime/processCount/memory/cpu，**未隔离:filesystem/network**，可写根=2 个」——即 writeRoots 在 Windows 后端根本不被执行（它只对 Linux bwrap / macOS sandbox-exec 生效）。两条命令都触发了 HIGH 确认，但确认文案只说「执行命令」，用户无法从文案判断它会越界写盘 → 需要在能力模型里给 `shell.execute` 加路径/网络约束，而不是靠用户点确认 |
| 10 | `CODENODE_TEST` 是否在 CI / 打包环境被设置（设置即审批被整体绕过） | `grep -rn CODENODE_TEST .github scripts electron`（本轮未逐处核对打包脚本） |

### §8 逐条验证结论（2026-09-16）

10 条推理项里：**7 条已闭环（含 2 条在 S12 阶段已修）、1 条挖出真问题并已修（#3）、1 条仍是静态结论（#6）、1 条仍未取得可靠结论（#8）**。

| # | 假设 | 验证结论（2026-09-16） |
|---|---|---|
| 1 | `tc.id` 缺失是否真发生 | ✅ **已复现并有防护**：`tool-call-id-test` 用 `omitId` 造出「供应商完全不给 id」，`assignCallIds` 按下标补齐后才发请求；`context-capability-test` 也用同一手法覆盖 |
| 2 | 供应商是否真会重复发 `function.name` 分片 | ✅ **已复现并已处理**：`stream-accumulator-test` 的 `duplicate-name-chunk` / 前缀累积分支证明分片会累加，累加器**取更完整的那一份**并记 anomaly，不会把名字拼成 `read_fileread_file` |
| 3 | 缓存命中时 `cached.content` 初值 `''` 是否导致 repeated 文案重复拼接 | ⚠️ **挖出真问题，已修**：命中文案本身没有"重复拼接"，但命中路径拿到的 `content` 是空串，于是退化成**裸 `result.text`** —— 既丢了「请勿重复调用」提示（模型会继续空转重试），也丢了首次那条的 `[data]` 段（信息缩水）。已修：命中路径统一补提示前缀 + 正文取自缓存（没有则重建），两条断言 + 变异锁住 |
| 4 | 续跑是否产生孤立 `tool` 消息 | ❌ **未复现**：探针构造 12 组「assistant.tool_calls + tool」历史再裁剪，发出的 27 条消息里孤立 tool 消息 = **0**（每条 tool 都能对上声明） |
| 5 | 子代理 `builder` 写文件是否弹确认到用户 | ✅ **会弹，且走父 bridge**：探针让 builder 调 `workbench_edit`，父 `confirm` 收到 `{level:'WRITE', what:'workbench_edit'}`；批准后子代理**真的改到了画布**（节点 0 → 1）。不需审批的工具（`read_file`/`write_file`）照旧不弹 |
| 6 | `save_project` 的 `projectFile` 在渲染层是否有校验 | 📄 **静态结论：渲染层没有，也不需要**：`projectFile` 只用于显示文件名（`ProjectPanel`）与传参（`WorkbenchDock`/`chatStore`/`projectActions`）；越界保护在主进程（`save_project` 的 `resolveInRoot`，由 `save-project-boundary-test` 锁定） |
| 7 | 幂等/检查点账本同步重写的开销（n=100） | ✅ **实测可接受**：100 次 `begin`+`commit` = **252.5ms**（2.52ms/次，账本 38KB）。每次是**整份 JSON 同步重写**（O(n)），n=100 无感；线性增长，日级 n=1000 时约 25ms/次，将来可改增量 append |
| 8 | 压缩 8 次上限之后的上下文体积曲线 | ⚠️ **仍未取得可靠结论**：探针里压缩请求与主循环共用同一份脚本化模型队列，无法干净隔离（曲线被工具结果本身撑大）。`test:compression-batch` 已覆盖压缩正确性，但「上限之后体积是否失控」需要专门用例（把压缩请求单独打桩） |
| 9 | `execute_shell` 白名单接近「任意命令」 | ✅ 已复现并已修（S12：越界写/网络约束；测试模式不再放行破坏性确认） |
| 10 | `CODENODE_TEST` 是否在 CI/打包被设置 | ✅ 已覆盖：`test-mode-capability-test` D 段静态守卫（仓库里没有任何脚本/CI 赋值 `CODENODE_TEST`）+ 测试模式下能力门照旧拒绝 |

**#3 的修复细节**（唯一因本轮验证而改的产品代码）：

- 新增 `REPEAT_NOTICE` 常量：首次构建与缓存命中两条路径**共用同一份提示文案**（此前只有首次路径会加，命中路径直接复用空 content）。
- 命中路径：正文从缓存取（被压缩过则是压缩摘要），缓存里没有正文就用 `buildToolContent` 重建 —— 保证「命中时的 tool 消息」与首次**信息量一致**。
- 首次构建后把正文回填进缓存条目（性能路径：命中时不必重复拼接大文本）。
- 回归断言（`agent-cache-invalidation-test` 场景 1）：命中那条 tool 消息必须①带「请勿重复调用」提示 ②与首次一样带 `[data]` 段。变异：只破坏提示路径 → 1 条 FAIL；提示 + 正文两条路径**同时**破坏 → `[data]` 断言 FAIL（单条破坏时不红，因为回填与重建互为冗余、行为等价 —— 这是有意的双保险，不是判据缺失）。

---

---

## 9. S0 实施记录（2026-09-15）

按本文第 6 节的分阶段方案先做 S0（纯修复、零接口变化），每一条都**先写会红的回归用例**，并用变异测试证明用例不是空转。

| 修复项 | 改动文件 | 回归用例 | 变异测试（把修复点改回旧行为） |
|---|---|---|---|
| 幂等键规范化（键序无关，与缓存键同口径） | `electron/sideEffects.cjs` | `scripts/side-effect-idempotency-test.cjs`（进 CORE） | 回退成 `JSON.stringify(args)` → 3 项 FAIL（键序/去重/skip 原因） |
| 幂等账本 `committed` 不再被 `begin()` 降级 | `electron/sideEffects.cjs` | 同上 | — |
| `save_project` 路径边界（`resolveInRoot`） | `electron/ipc/agent.cjs` | `scripts/save-project-boundary-test.cjs`（进 CORE） | — |
| 保存失败不再谎报成功 | `electron/tools/context.cjs`、`impl/saveProjectTool.cjs` | 同上 | — |
| 前台/后台超时不再 `ok=true` | `electron/tools/impl/executeShellTool.cjs` | `scripts/shell-timeout-result-test.cjs`（进 CORE） | — |
| 沙箱子进程 stdin 立即 EOF（修 `git` 挂死） | `electron/sandbox/winjob.cs` | `scripts/sandbox-stdin-eof-test.cjs`（进 CORE） | 回退成 `RedirectStandardInput = false` → 15.1s 挂死 FAIL |
| `tool_call_id` 三处统一（P0-1） | `electron/agent.cjs` | `scripts/tool-call-id-test.cjs`（进 CORE） | 回退成 `tool_call_id: tc.id \|\| ''` → 4 项 FAIL（空 tool_call_id / 配对不符） |

**验证证据**（全部为本机实测输出）：

- `npm run verify`（= `npm run build` + `npm run check:js` + `npm test`）→ **33/33 PASS，188.8s**，基线提交 `fa7c862`（评测报告文件名内嵌该 sha：`docs/eval-reports/agent-eval-fa7c862-offline-*.json`）。
- 新增 5 条用例已进 `scripts/run-all-tests.cjs` 的 `CORE` 与 `package.json`，随 `npm test` 一起跑：`test:tool-call-id` / `test:side-effect-idem` / `test:save-project` / `test:shell-timeout` / `test:sandbox-stdin`。
- 变异测试：`mutation-check.cjs --spec <3 条>` → **3/3 条证明有判别力**，且每条结束后自动还原并核对 sha256 一致。
- 实测前后对比：`git --version` 在 `windows-job` 后端下 **25052ms 超时零输出 → 273ms 正常返回**；`execute_shell` 超时 **`ok=true` → `ok=false` + `code=TIMEOUT` + `data.timedOut=true`**。

**协作注意**：`electron/agent.cjs` 的 `tool_call_id` 统一改动被并行会话的提交 `10b70e5`（主题是 Milvus 生产参数档）一并卷走——内容正确但提交信息未覆盖该改动；按「不重写已推送历史」原则只在此记录，未做任何 amend/force push。另一条线在同一文件上还改过 `parseRagConfig`，两者已确认互不冲突。

### S1 实施记录（流式解析抽出 + 截断安全，2026-09-15）

| 内容 | 文件 |
|---|---|
| 新增纯函数累加器：`createAccumulator` / `applySseText` / `consumeLine` / `finalize` / `isJsonComplete`（不碰网络与全局，坏数据只记 anomaly，不抛异常） | `electron/streamAccumulator.cjs` |
| 主循环改用累加器（事件转发语义保持不变）；`finish_reason=length` 的三条安全行为；trace 记录 `finishReason` | `electron/agent.cjs` |
| 用例（进 CORE，门禁 33 → 35） | `scripts/stream-accumulator-test.cjs`（22 断言 / 14 类分片形态）、`scripts/truncation-safety-test.cjs`（12 断言） |

累加器覆盖的分片形态：重复下发整段 name·args、前缀累积、补完式累积、参数整段重发（拼接后非法 → 替换而非拼接）、多调用交错、`index` 缺失/漂移、`index` 被复用给另一个调用（拆槽，避免 id/参数串味）、id 分片与重复、`finish_reason` 变化、usage、坏数据行、流内联 `error`、末尾无换行残行。每个工具调用额外给出 `argsValid`（参数是否已构成完整 JSON）。

`finish_reason=length` 的三条安全行为：① 参数不是完整 JSON → **拒绝执行**（`code=ARG_INVALID_JSON`，附 `finishReason` / `argsLength`）并把错误回灌给模型重写参数，而不是拿 `{}` 去调用工具；② 回答被截断且没有工具调用 → 把已输出部分作为 assistant 消息带回并补问（最多 2 次）；③ 补问用尽仍截断 → 返回 `stopReason='length_truncated'`，不把半截回答伪装成完整答案。

**验证证据**：`npm run verify`（build + check:js + test）= **35/35 PASS，189.6s**；变异测试 **2/2 有判别力** —— 把 `malformed` 判定回退后，spy 工具被**空参执行 1 次**（正是 P1-2 的危害，4 项 FAIL；用例的 spy schema 故意不写 `required`，避免被 registry 的必填校验挡住而误绿），把重复 name 处理回退后 `name` 拼成 `read_fileread_file`。

### S2 实施记录（运行状态机，2026-09-15）

| 内容 | 文件 |
|---|---|
| 新增纯函数状态机：7 状态 + 显式迁移表（非法迁移拒绝并记 violation）+ 状态语义表（`label`/`terminal`/`recoverable`/`persists`）+ `classifyOutcome`/`toRunStatus` | `electron/agentState.cjs` |
| 主循环驱动状态机并逐次上报 `onDelta({kind:'state'})`；返回值带终态 `state`/`stateHistory` | `electron/agent.cjs` |
| 状态上报钩子（`setStateNotifier`/`notifyState`）：`confirm()`/`askUser()` 真正等用户时上报 `WAITING_USER`，应答后回 `WAITING_TOOL` | `electron/tools/context.cjs` |
| 迁移落成 run 事件 `run_state`（带 `previous`/`reason`）；`finishRun` 增加 `state`/`stopReason`（`status` 取值不变） | `electron/ipc/agent.cjs` |
| `summarizeRun` 新增附加字段 `state`（`finish.state` → 最近 `run_state` → `RUNNING`），`status` 不变 | `electron/runStore.cjs` |
| 用例（进 CORE，门禁 35 → 36） | `scripts/agent-state-test.cjs`（34 断言） |

状态与终态映射：abort → `CANCELLED`；迭代/调用触顶 → `LIMIT_REACHED`；异常 → `FAILED`；正常结束 → `COMPLETED`。`toRunStatus` 保持既有 `status` 取值（`LIMIT_REACHED` 仍写 `error`，靠 `state` 字段区分），因此 UI 与续跑判定（只按 `status === 'interrupted'` 过滤）不受影响。

**验证证据**：`npm run verify` = **36/36 PASS，189.7s**。用例 B 段走**真实 IPC 链路**（假 `ipcMain`/`sender` + `require('electron')` 桩，直接调 `agent:chat` handler），判据取自真实 run JSONL：

| 场景 | 断言到的状态序列 / 终态 |
|---|---|
| 正常一轮工具 + 回答 | `RUNNING → WAITING_TOOL → RUNNING → COMPLETED`，`summarizeRun().state === 'COMPLETED'` |
| `write_file`（触发 WRITE 确认） | `RUNNING → WAITING_TOOL → WAITING_USER → WAITING_TOOL → RUNNING → COMPLETED`，且确认请求真的到达渲染进程、文件真实落盘 |
| 模型无限重复同一工具调用 | `LIMIT_REACHED`（`status` 仍为 `error`，`run_finish.stopReason=iteration_limit`） |
| 运行中调用 `agent:stop` | `CANCELLED` + `status='cancelled'`，且不把工具结果误报成最终答复 |
| 模型请求 HTTP 500 | `FAILED` + `status='error'` |

变异测试 **3/3 有判别力**：不再上报 `WAITING_USER` → B2 红；`run_state` 丢 `state` → B1.2/B2 红；迁移表去掉 `WAITING_TOOL → WAITING_USER` → A4/A5 红（且 confirm 路径优雅降级：状态停在 `WAITING_TOOL`，不崩）。

### S3 实施记录（工具契约 ToolDescriptor，2026-09-15）

| 内容 | 文件 |
|---|---|
| 新增契约定义 + 适配层：15 字段契约、`normalizeDescriptor`（缺省一律保守）、`descriptorForLegacy`、`describeDescriptor`；只读/缓存/变更/能力/自管超时名单**收敛为唯一来源** | `electron/tools/descriptor.cjs` |
| 注册表按契约执行：`registerDescriptor`/`descriptorOf`/`listDescriptors`/`describeAll`/`setDefaultTimeoutMs` + 三道 fail-closed 门（只读守卫 / 网络能力 / 确认门）+ 契约超时 | `electron/tools/registry.cjs` |
| `save_project` 迁到显式契约（本阶段唯一行为变化）：覆盖工程文件属破坏性写 → `requiresConfirmation='WRITE'`，不批准就一个字节都不写 | `electron/tools/impl/saveProjectTool.cjs` |
| 三份名单改为引用同一对象；`agent:tools` 顺带返回契约摘要（UI/审计可读） | `electron/agent.cjs`、`electron/ipc/agent.cjs` |
| 用例（进 CORE，门禁 36 → 37） | `scripts/tool-descriptor-test.cjs`（40 断言） |

**三道门与超时的实现要点**：

- **只读守卫**：只读上下文（只读角色子代理）拒绝 `mutatesWorkspace` 的工具，**但角色白名单明确授予的除外** —— 实测若一刀切，`verifier` 角色会失去 `execute_shell`（跑测试）这一核心能力，属过度修复。
- **网络能力**：声明 `network.request` 的工具在 `sandbox.network=deny` 时**直接拒绝、不试连**（此前只有 Linux/macOS 的子进程包装层管网络）。
- **确认门**：只对**显式声明** `requiresConfirmation` 的工具生效（旧 `register()` 合成的契约不触发）→ 避免一次性给所有工具加弹窗导致行为突变。
- **契约超时**：未声明用注册表兜底（默认 120s），显式 `0` = 不限时（`execute_shell`/`poll_job`/`delegate_*`/`retrieve_context`/`scan_project` 等自管超时或合法长任务）。超时只终止「等待」——**同步阻塞操作（大目录扫描、同步 fs 计算）无法被 JS 单线程打断**，真正可中断需要把这类工具挪到 worker/子进程（后续阶段）。
- 顺带修掉一个被新用例当场抓出的真 bug：`normalizeDescriptor` 里 `toPositiveInt(null)` 经 `Number(null)=0` 落到 `0`，而 `0` 表示「显式不限时」→ 所有旧接口工具的兜底超时会被静默关掉（表现为超时用例挂死）。已改为 `null/undefined/''` 一律视为未声明。

**验证证据**：`npm run verify` = **37/37 PASS，188.5s**。契约/名单一致性、只读守卫（含角色授予例外与「名单缺失 → fail-closed」）、网络门、契约超时（含 `timeoutMs=0` 不被兜底拦截）、确认门（无通道 → `APPROVAL_REQUIRED`；拒绝 → `APPROVAL_DENIED` 且副作用计数 0；批准 → 执行；旧接口写工具不被拦）全部有终态断言。

变异测试 **4/4 有判别力**：`readOnly` 改 fail-open → A1/A2 红；只读守卫关掉 → C1/C2b/C4b 红；确认门关掉 → F1/F3/F4/F5 红；`save_project` 去掉 `WRITE` 声明 → B6/F1/F3/F4/F5 红。

### S4 实施记录（工具最小能力面 ExecutionContext，2026-09-15）

| 内容 | 文件 |
|---|---|
| 新增按契约组装的最小能力面：`exec`（四个 id + 角色 + 能力集）+ `project`/`approval`/`audit`/`ui`/`checkpoint`/`cancel`/`trace` 七面 + 能力蕴含关系 | `electron/tools/executionContext.cjs` |
| `registry.execute(name, args, ctx, callInfo)` 改为给工具传能力面；`callInfo`（`turnId`/`toolCallId`/`attemptId`）由主循环传入 | `electron/tools/registry.cjs`、`electron/agent.cjs` |
| 能力面按真实用法校准：标量索引（派生数据）归读面；`scan_project` 因 `applyToWorkbench` 归 `workspace.write` | `electron/tools/descriptor.cjs` |
| 用例（进 CORE，门禁 37 → 38） | `scripts/context-capability-test.cjs`（25 断言） |

**关键设计取舍**：

- **越权即拒绝且可观测**：没授予的能力不是「能调但没人管」，而是返回安全默认值（`false`/`null`/`[]`）并写一条 `capability-denied` 审计（带 `tool`/`method`/能力/所需能力）—— fail-closed，同时旧工具不会因缺能力直接崩。
- **双轨并存**：旧方法名（`projectRoot()`/`confirm()`/`mutateWorkbench()`/`saveProject()` …）保留为 deprecated 转发，24 个既有工具不改一行仍能跑（用例 B4/B5 用真实 `read_file` 与 `workbench_edit` 锁住）。`audit`/`checkpoint`/`ui` 三个名字在新旧两套里重名，做成**可调用对象**：`ctx.audit('文本')`（旧）与 `ctx.audit.log({...})`（新）同时可用（新面会显式序列化对象 —— 底层 `auditLog` 是 `String(entry)`，直接传对象会落成 `[object Object]`）。
- **能力蕴含**：写蕴含读、`project.save` 蕴含写、`shell.execute` 蕴含写；读是能力下限，不构成提权。刻意的宽松两处：标量索引属派生数据 → 读面即可用（`get_workbench_model` 读画布时顺手同步索引靠这条）；`saveProject` 旧面对写工具放行（`write_analysis_md` 等既有行为不收紧），严格的新面 `project.save()` 只认 `project.save` 能力。
- **顺手修掉的接线 bug**：网络能力门必须从**底层上下文**读策略，不能走工具的能力面 —— `sandbox` 属 `shell.execute` 能力，对 `network.request` 工具是被闸住的，读到的会是 `null`，网络门就静默失效（被 `test:tool-descriptor` 的 D1 当场红出来）。

**验证证据**：`npm run verify` = **38/38 PASS，201.6s**。用例 A 段（能力面组装/越权拒绝/审计留痕/拒绝时底层零调用/套娃解包/可调用对象）、B 段（注册表集成 + 真实工具回归）、C 段（主循环端到端：`exec.toolCallId` 与 assistant 声明的 id 一致、`attemptId`/`runId` 可用）全部有终态断言。

变异测试 **3/3 有判别力**：能力门改 fail-open → A5/A6/A7/A10/B3 红；注册表不组装能力面 → B 段红；`attemptId` 置空 → A1/C2 红。

**仍未处理（S4 之后）**：P0-3 的其余工具（`workbench_edit`/`create_nodes`/`workbench_connect`/`ui_control` 仍无确认，留到 S7 与审批令牌一起做）、P0-5 的同步工具可取消（需 worker/子进程化）、P1 其余条目、P2 全部、以及已复现但需能力模型才能根治的 `execute_shell` 越界写（见第 8 节第 9 项）。下一步建议 S5：结构化 `ToolResult` + `FailureCode` 分类（参数/权限/取消/超时/可重试/不可重试/部分成功/副作用提交状态），把「一条模糊的 nudge user 消息」换成按错误类别分派的重试与提示策略。

---

### S9 实施记录（子代理收口：角色契约 / 独立预算 / 总时长 / 结果契约；附压缩成本，2026-09-16）

**起因**：第 6 节把子代理排在 S9（独立预算 / 深度上限 / 结果合并契约 / 只读范围显式化），但 S0–S4 之后它仍是唯一**没有隔离用例**的子系统。动手前读 `subagents.cjs` / `toolkit.cjs` / `registry.cjs` / `sideEffects.cjs` / `requestBudget.cjs`，并在仓库外跑了一次探针（打印角色目录、子注册表、白名单豁免面），确认 10 处问题；同时用户反馈「工具调用里那一次子代理压缩**缓存命中率非常低**」，一并处理。

| # | 修复前（代码级实测） | 修复 | 文件 |
|---|---|---|---|
| 1 | **只读角色会谎报**：`explorer` 白名单含 `scan_project`（契约 `mutatesWorkspace=true`），只读门被「白名单里有这个名字」豁免；`scanProjectTool` 里 `mutateWorkbench` 在只读上下文返回 `false`，仍写 `data.appliedToWorkbench=true` 并回报「已写入工作台」（`void applied`） | 只读门判据改为**角色契约显式授予的能力**；`scan_project` 按真实结果记录，未写入时返回 `ok=false` + `code=WORKBENCH_WRITE_DENIED` + 说明「勿原样重试」 | `tools/registry.cjs`、`tools/roles.cjs`、`tools/impl/scanProjectTool.cjs` |
| 2 | **角色语义三处漂移**：`ROLE_TOOLS` 5 个角色（含 `canvas`）、`READ_ONLY_ROLES` 3 个、`ROLE_PROMPTS` 4 个；`delegate_task` 的 enum 把 `canvas` 暴露给模型，而 canvas 子代理**没有角色提示**（`filter(Boolean)` 静默丢掉 undefined）却能 `save_project` / `ui_control` | 新增 `electron/tools/roles.cjs` 作为**唯一来源**（工具白名单 / 是否只读 / 授予的能力 / 角色提示），`toolkit.filterByRole` 与 `subagents.cjs` 都从它取；canvas 补齐提示 | `tools/roles.cjs`（新）、`tools/toolkit.cjs`、`subagents.cjs` |
| 3 | **子代理共用父预算**：`cfg: this.cfg` → 同一 `RequestBudget`。一个子代理把额度刷穿，父 run 与其他子代理被同一个 `BUDGET_EXCEEDED` 一起挡死，且看不到是谁花的 | `RequestBudget` 支持**父子链** + `createSubagentBudget`：每个子代理独立配额（`agent.subagent.max_total_tokens`，`0` = 沿用旧行为），真实用量按实际值记回父账（父总量依然守恒，不绕过） | `requestBudget.cjs`、`subagents.cjs` |
| 4 | **幂等账本没有归因**：父子代理与多个子代理共用同一幂等域（`sha256(scopeRunId+tool+args)`）却没有任何 actor，去重时回灌「该写操作在上一次中断前已成功提交」——与实际不符 | `begin(tool,args,actor)` 记录 `actor`/`actors`/`committedBy`；去重文案改为「提交者 X，请求方 Y」并由**账本**给出（主循环不再自己编）；检查点 `tool_intent`/`tool_commit` 带 actor；`review()` 输出归因字段 | `sideEffects.cjs`、`tools/context.cjs`、`agent.cjs` |
| 5 | **`timeoutSeconds` 被当成「单轮超时」**：它直接进 `runAgentChat` 的 `timeoutMs`（单轮，默认 180s），最多 12 轮 → 子代理可跑约 36 分钟；没有任务总时长概念 | 语义修正为**任务总时长**（默认 600s，钳制 [10s, 1h]）：组合信号（父 signal + 定时器）+ 单轮上限 180s；超时/取消分别落 `blocked` 并写明原因 | `subagents.cjs` |
| 6 | **结果无合并契约**：`'子代理任务 X 已完成：' + summary` 原样进主上下文（2 万字符也全灌）；失败一律 `AgentToolResult.error` → 主循环注入「失败请重试」→ 主代理**重复委派**同一任务（12 次上限里失败也计数） | 固定字段头（`[子代理结果] taskId/role/status/工具调用/变更文件`）+ 结构化 `contract`（`toolCalls` / `changedFiles` / `usage` / `stageWarning` / `acceptanceJudgement=manual`）+ 按 `agent.subagent.result_max_chars` 截断并指向 `get_subagent_task`；失败文案显式劝退原样重试 | `subagents.cjs` |
| 7 | **stage 回写静默失败**：不校验节点存在/类型，也不看 `workbench_edit` 返回值 → 画布上子代理痕迹可静默消失 | 回写前校验节点存在与 `type==='stage'`，失败写 `task.stageWarning` + 审计事件（`subagent_stage_missing` / `_type_mismatch` / `_update_failed`） | `subagents.cjs` |
| 8 | **深度限制是隐式的**、run 记录里看不到子代理 | 子注册表不含 `delegate_*` 由角色契约保证（白名单里没有）并有用例钉住；子代理状态落 run 事件 `subagent_state`（此前 run 记录里完全没有子代理痕迹） | `tools/roles.cjs`、`ipc/agent.cjs` |
| 9 | **压缩调用成本不可测、命中率天然极低**（用户反馈）：请求形状是「固定 system + 变化的原文」，前缀缓存只能命中前几百 token；`costLedger.tokenParts` 还丢掉了服务端返回的缓存命中字段，命中率**无法测量** | ① 内容级缓存 `compressionCache.cjs`（`key=sha256(工具名+预算+原文)`，LRU 200 条/2MB，落 `.codenode/metrics/compression-cache.json`，**跨 run 复用**）；② system 提示改为常量、预算移到 user 段（前缀稳定）；③ 可配压缩专用模型 + **默认关思考链**；④ 工具记录标注 `compressionCache=hit/miss` | `compressionCache.cjs`（新）、`agent.cjs` |
| 10 | 角色能力与预算、压缩模型等新旋钮没有配置入口 | `agent.subagent.*`（配额 / 总时长 / 结果上限 / 批次上限）与 `agent.compression.model|reasoning|cache|max_output_tokens|timeout_ms` 全部可配，`config/agent.properties` 附说明 | `agent.cjs`、`config/agent.properties` |

**关键设计取舍**：

- **只读门从「白名单豁免」改为「角色能力授予」**：白名单只说「这个角色能用这个工具」，能力集才说「这个角色被允许产生这类副作用」。`verifier` 的 `execute_shell` 由 `shell.execute` 显式授予（跑测试是它的核心能力，不能误伤）；`explorer` 的白名单里虽有 `scan_project`，但契约没授予写能力 → 它只能以只读方式用，写那一步由 `context.mutateWorkbench` 在只读上下文返回 `false` 兜底，并且**工具必须如实上报**。
- **幂等域刻意保持「共享」**：子代理与父代理仍写同一本账（续跑时「已提交就跳过」的语义必须跨角色成立，否则子代理的写会重复执行）。修的是**归因**而不是隔离：每次登记带 actor，去重文案说清谁提交、谁在重复。
- **独立预算用父子链而不是另起一本账**：子代理超额只拒绝它自己；父 run 的 `agent.max_total_tokens` 依然是硬上限（子预算是它的子集，不能绕过）。
- **结果契约只报事实**：`changedFiles` 从工具调用参数里解析（解析不出就跳过），`acceptanceJudgement` 固定为 `manual` —— 验收是否达成不自动判定，避免「编造结论」。
- **压缩那块**：`system` 恒定 + 内容级缓存解决「同一份内容重复付 prefill」，但**没有**假装解决前缀命中率本身 —— 真正能把命中率拉上去的是「把同一轮多个超大结果合并成一次压缩请求」，本轮未做（见下）。

**验证证据**：`npm run verify` = **39/39 PASS，196.8s**（CORE 38 → 39）。新增 `scripts/subagent-isolation-test.cjs` 进 CORE，A–J 共 11 段断言：角色契约一致性（含 canvas 提示与 enum 对齐、白名单/能力集与契约逐项相等）、只读门双向（白名单+无能力 → 拒；能力授予 → 放行）、`scan_project` 只读不谎报 + 有权限时确实写入、预算父子链（子超额只拒自己、父总量守恒）、总时长钳制、结果契约（字段头/截断/变更文件/`acceptanceJudgement`）、stage 警告、失败劝退、幂等归因（含 `context → guard` 传递）、压缩缓存（键稳定/命中统计/LRU/落盘复用）、配置默认值。

变异测试 **4/4 有判别力**（临时改回旧行为 → 新用例变红在预期行 → 自动还原并核对 sha256，基线绿）：只读门退回白名单豁免 → 红在 B 段（行 77）；`scan_project` 不检查是否真写入 → 红在 C 段（行 85）；`context` 不传 actor → 红在 H2（行 239）；子代理结果不截断 → 红在 F 段（行 178）。

**仍未处理（S9 之后）**：① 压缩请求的**批量合并** —— **S11 已完成，见下节**（原记作 S10，与表格 S10 撞号已更正）；② `costLedger` 只新增了缓存命中字段的**记录能力**（`promptCachedTokens`），费用单价未按命中/未命中区分——没配价格就不编造；③ 子代理 UI（`src/` 仍无子代理呈现，只落到 run 事件与 stage 节点摘要）；④ 单子代理取消（当前只能随父 signal 整体停）；⑤ S4 起就挂着的 `execute_shell` 越界写（需 S7 能力模型）。下一步建议仍是 S5：结构化 `ToolResult` + `FailureCode` 分类。


### S11 实施记录（压缩请求批量合并，2026-09-16）

> 编号说明：本节在实施提交里曾记作「S10」，与第 6 节迁移表中的 **S10（Grounding 门）** 撞号 —— 此处更正为 **S11**，避免与尚未实施的 Grounding 门混淆。

**动因**：S9 结尾留下「压缩命中率的根因未解决」——压缩请求的形状是「固定 system + 变化的原文」，服务端前缀缓存只能命中前缀，所以单次压缩几乎必然全量 miss（用户反馈的正是这一点）。本轮把**同一轮工具循环里的多份大结果合并成一次压缩请求**：system 前缀与请求固定开销（连接、重试、输出模板）只付一次，N 次小请求变成一次大请求；再加上 S9 的内容级缓存，同内容直接 0 请求。

| 内容 | 文件 |
|---|---|
| 批量压缩入口 `compressToolBatch`：先吃内容级缓存 → 未命中项合并成一次请求 → 按段归位 → 缺失项逐条兜底 | `electron/agent.cjs` |
| 分段协议：批量请求要求模型逐份输出 `<!-- summary i=N -->`；`parseCompressionBatchOutput` 解析（乱序可、缺段记 `missing`、无标记一律视为缺失并退回单条） | `electron/agent.cjs` |
| 切分 `chunkCompressionItems`：按条数（`agent.compression.batch_max_items`，默认 4）与累计字符（`max_input_chars`）双约束分批 | `electron/agent.cjs` |
| 主循环改为「先登记、轮末结算」：tool 消息先按原文进上下文，轮末批量压缩后**改写**对应 tool 消息内容（消息顺序不变） | `electron/agent.cjs` |
| 配置 `agent.compression.batch`（默认开）/ `batch_max_items` | `electron/agent.cjs`、`config/agent.properties` |
| 用例（进 CORE，门禁 39 → 40） | `scripts/compression-batch-test.cjs`（7 段断言） |

**关键设计取舍**：

- **只对 ≥2 份未命中项才批量**：单份仍走单条路径，不给单份套批量格式要求（少一层格式风险）。
- **质量兜底优先于省 token**：某一段没解析出来 → 该条退回单条压缩；整批失败 → 降级为截断。宁可多花一次调用，也不把「多份结果混成一锅」的摘要塞进上下文。
- **`max_calls` 仍按调用次数计**：一批 = 一次调用；登记时用「已用调用数 + 本轮已登记数」预判，避免一轮内无上限登记。
- **消息顺序不变**：压缩发生在轮末、通过改写已入上下文的 tool 消息完成，`assistant(tool_calls) → tool` 的配对与断点续跑快照结构都不受影响（这也是不采用「先压缩再入上下文」的原因）。
- 收益口径：N 份结果合并后，system 前缀从 N 份降为 1 份、请求数从 N 降为 1（内容级缓存命中时进一步降为 0）；输出 token 与单条合计相当。

**验证证据**：`npm run verify` = **40/40 PASS，201.7s**（CORE 39 → 40）。新用例覆盖分段解析（缺段/乱序/无标记）、切分（条数与字符双约束）、多份合并成一次请求并按序号归位、同内容缓存命中 0 请求、缺段兜底、整体失败降级、单份不套批量格式。变异测试 **3/3 有判别力**：批量开关失效（退回逐个压缩）→ 红在 C 段（行 69）；不给每段归位 → 红在 C 段（行 71）；缺段不兜底 → 红在 E 段（行 92）。

**仍未处理**：① 每段摘要的**尺寸二次校验**（模型可能超出单段预算，目前只在主上下文侧按 `DATA_TRUNCATE_CAP` 兜底）；② `costLedger` 按命中/未命中区分单价（需价格口径，未配就不编造）；③ 子代理 UI、单子代理取消（同 S9）。


### S5 实施记录（结构化 ToolResult + FailureCode 分类，2026-09-16）

**动因（审查 P1-4）**：`AgentToolResult(ok, text, data)` 只有布尔结果，失败语义靠各工具自己在 `data.code` 里临时塞；主循环拿到失败只能回灌同一句「上述工具调用失败…请修正参数后重试」——于是「参数写错了」「用户拒绝了」「超时了」「副作用结果未知」被同一句话打发：该重试的不敢重试、不该重试的反复重试（子代理重复委派、被拒写的重试都是这么来的）。

| 内容 | 文件 |
|---|---|
| **FailureCode 唯一来源**：码表 + 契约（category / retryable / userActionRequired / hint）+ legacy code 显式归一表 + `classifyFailure`（显式 failure > `data.failureCode` > `data.code` > `timedOut`/`cancelled` 结构化信号 > 保守 `FATAL_FAILURE` 且标 `known:false`）+ `planNudges`（同一 toolCallId ≤ 2）+ `buildFailureNudge`（按类别给不同指引） | `electron/tools/failures.cjs`（新） |
| **结构化结果**：`kind`（`success`/`partial`/`failure`）+ `failure` + `failed[]`；新增 `AgentToolResult.failure(code, msg, data)` / `partial(text, data, failed)` | `electron/tools/result.cjs` |
| 注册表门失败显式化：角色无权 → `PERMISSION_DENIED`、未知工具 → `FATAL_FAILURE`（此前只有中文文案，主循环无法分类） | `electron/tools/registry.cjs` |
| 主循环：工具记录带 `callId` + 失败即刻归类；nudge 改为**分类化**并按 toolCallId 限次，被抑制的落 `failure_taxonomy` trace | `electron/agent.cjs` |
| 用例（进 CORE，门禁 41 → 42） | `scripts/tool-failure-taxonomy-test.cjs`（10 段断言） |

**关键设计取舍**：

- **不靠文本猜错误类别**：认不出来的码归 `FATAL_FAILURE` 且标 `known:false`，提示里如实写出 legacy code 并按「不可原样重试」处理 —— 宁可保守，也不假装认识。
- **legacy 归一表只登记真实存在的码**：`WORKBENCH_WRITE_DENIED → PERMISSION_DENIED`、`PATH_OUT_OF_ROOT → ARG_SEMANTIC`、`BUDGET_EXCEEDED → FATAL_FAILURE`（并置 `userActionRequired`）、`SANDBOX_UNAVAILABLE → FATAL_FAILURE`、`INVALID_TOOL_ARGUMENTS → ARG_SCHEMA`；表驱动、可审计，改一处即可影响全局。
- **提示上限抑制的是提示、不是任务**：同一 `toolCallId` 最多灌 2 次，超限只落 trace——循环继续（由 `MAX_TOOL_ITERATIONS` 兜底），但事后能从 trace 看出「模型在原地打转」。
- **兼容优先**：60+ 处既有 `AgentToolResult.error(text, data)` 零改动继续工作；`ok`/`text`/`data` 的字段语义不变（UI、测试、主循环的读取方都不用改）。
- **partial 只报事实**：`ok=true` + `failed[]` + `data.partialFailures`，不把「部分成功」写成「完全成功」。

**验证证据**：`npm run verify` = **42/42 PASS，198.2s**（CORE 41 → 42）。用例分两层 —— 纯契约层（A 码表与契约一一对应防漂移、B legacy 归一、C `classifyFailure` 含结构化信号与未登记保守、D 提示配额、E 分类化文案、F 结构化结果与向后兼容）与**主循环层**（G 权限失败劝退重试、H 参数类指向「修正参数」、I 未登记码如实标注、J 同一 toolCallId 提示上限）；主循环层用脚本化模型跑真实工具循环、断言实际请求体（含「messages 累积 → 按每轮新增统计注入次数」这个坑）。变异测试 **3/3 有判别力**：主循环退回统一文案 → 红在 G 段（行 186）；提示上限失效 → 红在 D 段（行 79）；未登记码假装认识 → 红在 C 段（行 67）。

**仍未处理**：① UI 未消费 `kind`/`failure`（徽标仍是成功/失败两态，未区分「权限拒绝」与「参数错」）；② 多数工具的错误路径仍是自由文本（靠归一表与结构化信号兜底，未逐个补 `code`）；③ 审批令牌与审批细分类留待 S7 的能力模型。


### S6 实施记录（ToolScheduler：只读并行 + withTimeout + 取消贯穿，2026-09-16）

**范围（第 6 节 S6）**：只读并行（默认并发 2–4，可配）+ `withTimeout` + 取消贯穿；事件带 `turnId`/`toolCallId`/`attemptId`；**兼容策略：默认并行关闭，行为等价**。

| 内容 | 文件 |
|---|---|
| `ToolScheduler.prime()`：只**启动**本轮可并行的只读调用（本轮含写操作/需确认 → 整轮串行；malformed → 跳过；受并发上限与调用额度约束），返回 `callId → Promise` 映射；落事件 `scheduler_parallel`（带三个 id） | `electron/tools/scheduler.cjs`（新） |
| `withTimeout(run, ms, { onTimeout })`：到点返回 `code=TIMEOUT`（接 S5 码表）并触发 `onTimeout`（用于 abort 底层执行）；定时器**不能 unref** | 同上 |
| `linkAbort(parent, controller)`：父 signal → 子 controller 的取消贯穿链（含「订阅前父已 abort」的补发） | 同上 |
| 主循环接入：轮开始前 `prime()`，执行处优先 `await` 预启动的 promise（未预启动的按原顺序走 registry） | `electron/agent.cjs` |
| 配置 `agent.tools.parallel`（默认 **false**）/ `agent.tools.parallel_concurrency`（默认 3，钳制 1–8） | `electron/agent.cjs`、`config/agent.properties` |
| 用例（进 CORE，门禁 42 → 43） | `scripts/scheduler-parallel-test.cjs`（9 段） |

**关键设计取舍**：

- **只启动、不等待**：主循环随后仍按原顺序 `await`，因此 record / messages / 幂等账本 / 检查点的顺序与串行执行时**逐字节相同**。这也是不采用「先并行跑完再统一回填」的原因 —— 那会打乱副作用结算时序。
- **写操作独占用「整轮串行」保证**：只要本轮出现任何 `mutatesWorkspace` 或 `requiresConfirmation` 调用，整轮不预启动。逐项判定会漏掉「只读与写并发 → 读到写了一半的状态」，宁可保守。
- **超时值取 descriptor 契约**（与注册表同一值），不在 scheduler 里另设一套；超时同时 abort 底层执行。
- **预启动受调用额度约束**（`MAX_TOTAL_TOOL_CALLS - totalToolCalls`），避免「已执行但被 `capped` 丢弃」的动作。
- **默认关闭**：`enabled=false` 时 `prime()` 直接返回空计划，主循环代码路径与之前完全一致（零风险上线）。

**验证证据**：`npm run verify` = **43/43 PASS，198.6s**（CORE 42 → 43）。用例 9 段：纯函数层（并发归一、`withTimeout` 四种情形、取消贯穿含补发）、计划层（只读轮并行 / 写操作整轮独占 / 需确认不预启动 / 并发上限 / 额度 / malformed）、事件三个 id、主循环层（**挂钟断言**：串行 328ms → 并行 169ms 且并发峰值 2；含写操作时峰值 1；顺序不变 —— tool 消息与 assistant 声明逐一对齐；取消贯穿 —— 父 abort 后传给执行体的 signal 已 `aborted` 且立即返回）。变异测试 **3/3 有判别力**：写独占规则失效 → 红在行 94；并发上限失效 → 红在行 101；取消贯穿断链 → 红在行 65。

**仍未处理**：① mutexKey 级细粒度并行（当前是「只读轮整体并行」，同一文件的两个只读工具仍会并发读 —— 只读无害但可能重复 IO）；② 并行下的流式排序（UI 仍按声明顺序收 delta）；③ 长跑只读工具（`poll_job`）在并行轮里与短只读工具同权，未做优先级区分。


### S7 实施记录（capability 审批：ApprovalService 令牌 + 写工具补审批，2026-09-16）

**动因（审查 P0-3 / 迁移表 S7）**：确认类工具此前只有一句 `context.confirm()` 布尔问答 —— 没有**凭据**概念：「谁批的、批了什么范围、什么时候过期、能不能复用」都无处安放。更要命的是，只要工具参数里塞一个 `confirmed: true`，模型就有机会**自己把审批批了**（`save_project` 的 `requiresConfirmation` 在宽松 schema 下形同虚设）。

| 内容 | 文件 |
|---|---|
| `ApprovalService`：**服务端签发令牌**（`capability` / `scope` / `issuedAt` / `expiresAt` / `toolCallId` / `attemptId`），`verify()` 逐项校验后**立即消费**（单次有效）；`revoke` / `revokeAll` / `pending` / `available` | `electron/tools/approval.cjs`（新） |
| `AgentToolContext.approval()` 懒创建（挂 run 级上下文）；没有 confirm 通道时 `available()===false` | `electron/tools/context.cjs` |
| `ExecutionContext.approval` 面新增 `request / verify / available / revoke / service`（旧 `confirm` / `askUser` 保留，变薄封装） | `electron/tools/executionContext.cjs` |
| 注册表：**剥离模型自填的审批字段**（`confirmed`/`approved`/`approvalToken`…，在参数校验之前剥离并落 trace）；门 3 改为「申请令牌 → 校验令牌」；新增 `declareContract()` 支持渐进补契约；`confirmWrites` 三态开关 | `electron/tools/registry.cjs` |
| 画布写工具补审批：`workbench_edit` / `ui_control` / `create_nodes` 经 `declareContract` 声明 `requiresConfirmation='WRITE'`（`save_project` 早已声明） | `electron/tools/impl/*.cjs` |
| 配置 `tools.confirm_writes`（默认 **true**）/ `agent.approval.ttl_ms`（默认 5 分钟） | `electron/agent.cjs`、`config/agent.properties` |
| 用例（进 CORE，门禁 43 → 44） | `scripts/approval-token-test.cjs`（12 段） |

**关键设计取舍**：

- **令牌只能由服务端签发**：审批字段在参数校验前被剥离（既不生效、也不制造参数错误），trace 里留 `approval_self_fields_stripped` —— 模型自填永远换不来执行。
- **「没有审批通道」≠「用户拒绝」**：前者 `APPROVAL_REQUIRED`（接线/配置问题），后者 `APPROVAL_DENIED`（劝退重试、要人介入）。S5 的分类化提示据此给出不同指引。
- **单次有效 + 绑定 toolCallId/attemptId**：一次批准只够一次调用；重试/续跑不会复用旧批准。
- **令牌不落盘**：重启即失效 —— 宁可让用户再确认一次，也不留长期有效的批准凭据。
- **用 `declareContract()` 而不是重写 descriptor**：三个工具的 schema / executor 结构不动，只在注册末尾补一行声明 —— 与 S3「24 个工具逐个迁移」的路线一致，改动面最小。
- **行为变化（必须知道）**：画布类写操作（`workbench_edit` / `ui_control`）现在执行前需用户批准一次；`tools.confirm_writes=false` 可整体关闭（声明仍在，强制可关）。

**验证证据**：`npm run verify` = **44/44 PASS，191.5s**（CORE 43 → 44）。用例 12 段：服务层（签发/绑定/单次消费、过期、能力与 scope 与调用绑定逐项校验、伪造令牌、无通道、用户拒绝、通道异常、撤销与批量撤销）+ 集成层（声明与真实强制、**模型自填无效**、批准才执行、拒绝不执行、令牌校验失败不执行、每次执行各自获批、配置可关）+ 主循环层（脚本化模型：批准执行；拒绝回灌「未批准」并归到权限类提示）。变异测试 **4/4 有判别力**：不剥离自填字段 → 红在行 144；令牌校验被跳过 → 红在行 182；审批通道判定整块失效 → 红在行 136；令牌不过期 → 红在行 49。

**仍未处理**：① UI 只消费 `confirm`（`ToolDialog`），还没把令牌的 `scope` / 有效期展示给用户（用户看不到自己批了什么范围）；② `scope` 目前是「能力 + 目标」一项，路径级白名单 / 符号链接仍由既有 `resolveInRoot` + sandbox 承担；③ 令牌撤销尚未挂到 run abort 上（`WAITING_USER` 状态机事件已有）。

**顺带修的兼容**：`confirm` 语义从布尔问答升级为令牌后，四个既有用例（`tool-descriptor` / `scalar` / `model` / `cache`）需要显式模拟「用户已批准」（注入 `confirm: async () => true`）；`tool-descriptor` 的 F6 描述也同步更正。

### S12 实施记录（shell 权限边界 + 测试模式边界，2026-09-16）

**动因（§8 第 9 项，已复现未修 + §7 安全清单点名）**：两处「靠用户点确认兜底」的缺口。

| 缺口 | 真实形态 | 修法 |
|---|---|---|
| 越界写无内核兜底 | `ALLOWED` 含 `cmd`/`powershell`/`node`/`npm`/`npx`，Windows 后端不隔离文件系统（`writeRoots` 只对 bwrap / sandbox-exec 生效）→ `cmd /c echo PWNED > <项目外>`、`node -e "writeFileSync(<项目外>)"` 实测写成功；确认文案只说「执行命令」 | 新增 `electron/tools/shellGuard.cjs`：命令文本级静态审计（重定向 / 写选项 / 写动词 / 脚本 API 字面量 / **引号内子命令**），越界写直接 `PATH_OUT_OF_ROOT` 拒绝；只读引用项目外路径不误伤；`cp` 这类「源→目标」动词取最后一个位置参数 |
| 网络只在工具层把关 | 只有 `fetch_url` 过 `network.request` 门，`execute_shell` 里 `git push` / `npm install` / `node -e "fetch(…)"` 不受策略约束 | `sandbox.network=deny` 时，疑似联网的命令（URL / git 子命令 / npm 子命令 / PowerShell 下载型 cmdlet / 脚本网络调用）直接拒绝，不试连 |
| 测试模式是一条后门 | `bridge.confirm` 在 `CODENODE_TEST` 下**无条件** `return true` —— 确认通道是审批令牌的唯一来源，HIGH 级静默放行等于「测试环境 = 后门」 | 只自动批准可回滚的写入；HIGH 默认拒绝（需显式 `CODENODE_TEST_ALLOW_HIGH=1`）并提示一次 |

**关键设计取舍**：越界判定用**策略的 `writeRoots`**（含 projectRoot + `sandbox.allow_write` + tmpdir + userData）而不是「项目根」，这样临时目录里的写不会被误伤（测试与真实脚本都常写 tmp）。静态审计**只认显式写出口**（不模拟命令语义），宁可漏判不误伤。

**验证证据**：`npm run verify` 49/49 PASS。用例 `scripts/shell-guard-test.cjs`（10 段：越界写拒绝 + **磁盘上确实没有那个文件**、相对逃逸、脚本 API 字面量、项目内写仍放行、只读引用不误伤、`network=deny` 三条、`cp` 源在外部不误判、确认文案带审计提示、strict 模式拒绝无法判定的写目标）与 `scripts/test-mode-capability-test.cjs`（A 层 bridge 语义 / B 层越界写·只读上下文·network=deny 三门在 `CODENODE_TEST` 下照旧拒绝 / C 层无审批通道报 `APPROVAL_REQUIRED` / D 层静态守卫：仓库与 CI 里没有任何地方赋值 `process.env.CODENODE_TEST`）。

**未做**：`shellGuard` 是启发式，`bash -c "$(curl …)"` 这类动态构造仍可绕过；真正的根治是 Windows 文件系统级隔离（AppContainer / 管理员 Job Object），本平台暂不可行。

### S8 实施记录（统一事件流与按 run 回放，2026-09-16）

**动因（§3 P2「事件模型不统一」）**：事件散在 `runs/*.jsonl`、`tools_trace.jsonl`、`checkpoints.jsonl`、`side-effects.json`、`audit.jsonl` 五套文件里，`tools_trace.jsonl` 每条只有 `{ts, iter, name…}` —— **没有 runId / turnId / toolCallId**，多轮、多 run、父子代理的记录混在一条流里，无法按 run 回放。

| 内容 | 文件 |
|---|---|
| 统一形状 `{v, ts, kind, runId, turnId, toolCallId, attemptId, …payload}` + `emit / readEvents / replay / formatEvent`；写失败返回 null（旁路，不拖垮工具循环） | `electron/eventBus.cjs`（新） |
| `logToolTrace` **双写**（旧 `tools_trace.jsonl` 保留一个版本周期的兼容读取）；主循环所有事件带身份 | `electron/agent.cjs` |
| `scripts/event-replay.cjs`：`--run / --kinds / --limit / --json`，有事件退出码 0、无匹配退出码 1 | （新） |
| 用例（进 CORE） | `scripts/event-replay-test.cjs`（A 纯函数归一/坏行容忍/过滤、B 真实循环断言 tool 事件带四个 id 且 `toolCallId` 与 assistant 声明一致、C CLI 退出码） |

**第一遍的范围（当日早先）**：只有 `tools_trace` 一条链路双写；`checkpoints.jsonl` / `audit.jsonl` / `side-effects.json` / runs 状态 / 成本 / 告警 都还没挂上事件流。

**补齐（同日第二遍）**：把其余六套日志 + 审批事件全部接进统一流（**旧文件继续写**，遵守「双写一个版本周期」的兼容策略）：

| 来源 | 事件 kind | 接入点 |
|---|---|---|
| `runs/<runId>.jsonl` | `run_state` | `runStore.appendEvent`（延迟 `require` 打破 runStore ↔ eventBus 的循环依赖） |
| `<runId>.checkpoints.jsonl` | `checkpoint` | `runCheckpoint.appendCheckpoint` |
| `<runId>.side-effects.json` | `side_effect` | `SideEffectLedger._persist`（只报条数与最新相位，不把整份账本搬进事件流） |
| `metrics/cost.jsonl` | `cost` | `CostLedger.record`（带 runId / model / tokens / costUsd） |
| `metrics/alerts.jsonl` | `alert` | `AlertDispatcher._persist` |
| `audit.jsonl` | `audit` | `ipc/project.cjs` 的 `auditLog` |
| 审批（S7） | `approval` | `AgentToolContext.approval()` 的 trace（`issued / denied / rejected / consumed`，顶层带 `toolCallId`） |

- 新增 `eventBus.bridge(projectRoot, kind, payload)`：**永不抛**的旁路桥 —— 事件流是旁路，任何失败都必须吞掉，不能拖垮工具循环 / 账本 / 检查点。
- 新增 `eventBus.summarize(events)`：回放摘要（工具调用序列与失败次数、S5 的失败码分布、审批签发/拒绝/消费、成本与 token）——**只统计实际写进事件的字段，不补、不猜**。
- `scripts/event-replay.cjs` 加 `--summary`（文本摘要）与 `--json --summary`（结构化摘要）。
- 用例扩展到 18 段：C4/C5（CLI 摘要）、D×6 + D7/D8（六套来源都进流、成本事件带 runId/token、审批事件带 toolCallId）、E1–E4（摘要统计正确 + 空数据不编造）。变异 **5/5 有判别力**：bridge 整体变 no-op → 8 条 FAIL；run 状态 / 副作用账本 / 审批事件分别断桥 → 各 1–2 条 FAIL；摘要 token 统计失效 → 1 条 FAIL。

**仍未做**：UI 侧没有消费 `events.jsonl`（回放目前仍是 CLI）；`events.jsonl` 自身没有独立的轮转策略（复用 runStore 的字节上限）。

### S8-UI 实施记录（运行回放接进界面，2026-09-16）

**动因**：S8 的记录里写着「UI 侧没有消费 `events.jsonl`（回放目前是 CLI）」—— 用户看得到 Agent 在跑，却看不到「这一轮到底发生了什么」；排查问题时只能去命令行敲 `scripts/event-replay.cjs`。

| 内容 | 文件 |
|---|---|
| `eventBus.replayPayload(projectRoot, {runId, kinds, limit})`：UI/IPC 一次成形的载荷（时间线截断到**最近** limit 条 + 摘要 + 事件文件位置），与 CLI `--json --summary` **同一份数据** | `electron/eventBus.cjs` |
| IPC 通道 `agent:events` + preload `replayEvents` + `global.d.ts` 类型 | `electron/ipc/agent.cjs`、`electron/preload.cjs`、`src/global.d.ts` |
| `src/store/replayStore.ts`：zustand store（loading / error / file / total / runs / events / summary + `load()`） | （新） |
| `src/components/RunReplayPanel.tsx`：挂在「工作流运行」标签内的**摘要条 + 类型芯片 + 时间线**（工具名/ok/耗时、审批相位中文、成本与 token、run 下拉、事件文件路径） | （新） |
| 样式沿用既有 token（三层亮度 + 单一 accent，时间线 hover 用 `--bg-panel-3`） | `src/styles.css` |
| 用例：`test:event-replay` 扩到 **26 段**（新增 F1–F4 载荷契约）；新增 `test:event-replay-ui`（**offscreen Electron 真实渲染** 12 段，进 DISPLAY 组） | `scripts/event-replay-test.cjs`、`scripts/event-replay-ui-test.cjs`（新）、`scripts/run-all-tests.cjs` |

**设计取舍**：

- **不做实时推送**：界面读的是文件里的既成事实（并带「刷新」按钮），不订阅运行中的事件流 —— 避免「界面上显示的事件」与「落盘的内容」两套真相。
- **摘要不编造**：只统计事件里真实存在的字段（与 S5 的分类哲学一致）—— 没配单价的成本事件不会显示成 `$0.0000`。
- **时间线截断、摘要全量**：时间线只回最近 `limit`（默认 200）条，摘要按全量统计并在底部提示「共 N 条」。
- **新 IPC 通道必须显式登记**：`agent:events` 同步进了 `ipc-registry-test` 的通道白名单 —— 该用例的存在就是为了防「模块注册漏接线」。
- 面板复用 `dock-metrics` / `dock-run-toolbar` / `dock-empty` 等既有 class，新增样式只有时间线本身，视觉上与「工作流运行」其它区块同层。

**仍未做**：① 没有「按 kind 过滤」的交互（store 已支持 `kinds`，UI 未暴露）；② 没有「跳到某个事件的调用详情」；③ 面板只读，不能从事件流反向触发续跑。

### P4/P5 实施记录（工具契约闭合与显式化、循环上限可配置，2026-09-16）

- **schema 闭合**：`registry.closeInputSchema()` 在注册时统一补 `additionalProperties: false`（**22/22**，模型侧 `toOpenAiTools()` 与校验侧同一份 schema）；`validateInput` 对闭合 schema 上的未声明字段**当场拒绝**并指出字段名（此前 `maxLines` 拼成 `maxLine` 会静默走默认值 —— 判据消失而不报错）。
- **契约显式化**：`toolkit.declareSemantics()` 构建后把语义固化成 `source: 'explicit'`（字段值逐字不变），`requiresConfirmation` **原样传递** —— 补声明不给写工具凭空加审批（用例 C3/C4 锁住）。
- **顺带修掉的真 bug**：模型自填审批字段的剥离此前只在 `requiresConfirmation` 为真的工具上执行，且 `const traceFn = execContext.trace; typeof traceFn === 'function'` 对**冻结对象**恒假（审计从未落盘）。schema 闭合把这些残留字段变成「未知参数」后，`write_file` 带 `confirmed=true` 直接 `INVALID_TOOL_ARGUMENTS`。现在所有工具、校验前一律剥离，审计走 `trace.note`。
- **上限可配置**：`agent.max_tool_iterations`（12）/ `agent.max_total_tool_calls`（100）/ `agent.data_truncate_cap`（120000），默认值与旧常量逐字一致；`buildToolContent` 现在对**正文本身**也截断（此前只截 `[data]` 附加段，`result.text` 无上限）。
- **新增门禁**：`scripts/tool-contract-closure-test.cjs`（22/22 闭合、拼错字段被拒、自填字段仍被剥离、`source` 全为 explicit、语义与名单一致、审批级别未被改变、**impl 目录里没有「文件在却没注册」的静默漂移**——`createNodesTool.cjs` / `workbenchConnectTool.cjs` 作为显式白名单列出）与 `scripts/agent-limits-test.cjs`（默认值不变 + 配小后真实循环按新上限停下且 `stopReason` 为 `iteration_limit`/`tool_limit` 而非 `FAILED` + 正文截断生效）。

### P6/P7 实施记录（grounding 门、同步遍历工具可取消，2026-09-16）

- **来源校验门（原计划 S10）**：`agent.grounding.mode` = `warn`（默认，只上报 —— 行为与之前逐字一致）/ `enforce`（引用不可信不允许直接交付：先让模型按 `groundingRetryPrompt` 订正，最多 `agent.grounding.max_retries`（默认 1）次；仍不达标 → 返回值 `groundingBlocked=true` + 独立 `grounding_blocked` 事件，**不把校验提示拼进交付正文**）。用例 `scripts/grounding-gate-test.cjs`（14 段：配置默认/回落、warn 不拦、enforce 拦下→订正→合格交付、订正用尽→如实标记、`max_retries=0` 直接标记）——其中 `retrieve_context` 用**测试替身**覆盖（离线环境没有嵌入服务，替换成固定返回一份文件型来源，让「检索到了可用来源」这个前提成立）。
- **同步遍历工具可取消**：`impl/shared.cjs` 新增 `isCancelled(context)`；`scan_project`（含 `projectScan` 的遍历与逐文件分类两个循环）、`find_files`、`search_files` 在循环里加检查点，取消时返回 `kind=failure / code=CANCELLED` 并如实说明「结果不完整」（`partial` 计数）。
  **边界（别当成已解决）**：单次同步 fs 调用（一次 `readFileSync` 大文件、一次巨型 `JSON.parse`）**依旧不可打断**，真正的可中断需要把这些工具挪到 worker/子进程 —— 未做。
  用例 `scripts/sync-tool-cancel-test.cjs`：用**计数式 `aborted` getter** 造出「同步循环内部真的发生取消」（`setTimeout` 在同步遍历里排不上队，用它永远测不到），判据是「取消 → `CANCELLED` + `partial < 完整结果`」与「不取消 → 结果完整」（防过度修复）。

---

## 附：本轮机械扫描证据

```
$ node -e '<遍历 electron/tools/impl/*.cjs 汇总 register/confirm/timeout/signal/schema>'
# 24 个工具文件：
#   confirm 调用：bulk_edit(HIGH) edit_file(WRITE) execute_shell(HIGH)
#                 memoryTool(WRITE) write_analysis_md(WRITE) write_file(WRITE)  → 6/24
#   timeout 声明：仅 executeShellTool（后台任务）
#   signal 使用：executeShellTool / fetchUrlTool（其余 22 个不使用）
#   additionalProperties：0/24
#   maxItems：1/24（retrieve_context）
$ grep -rn "finish_reason" electron/ → 0 命中
$ grep -n "Promise.race|timeoutMs" electron/agent.cjs → 仅 LLM 调用与压缩调用，工具执行无包装
```
