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

**仍未处理（下一阶段）**：P0-3（破坏性工具无确认）、P0-5（无 per-tool 超时 / 同步工具不可取消）、P1 与 P2 全部条目、以及已复现但需能力模型才能根治的 `execute_shell` 越界写（见第 8 节第 9 项）。建议下一步做 S1：把流式 tool_call 解析抽成独立可测模块并处理 `finish_reason` 异常。

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
