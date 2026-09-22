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
