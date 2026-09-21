# 意图识别 / 授权判定（照 Codex 的 guardian 分类器）— 2026-09-21

> 落地：`electron/intent.cjs`（新增）、`electron/agent.cjs`、`electron/ipc/agent.cjs`、
> `electron/tools/context.cjs`、`electron/tools/approval.cjs`、`config/agent.properties.example`。
> 判据：`scripts/intent-test.cjs`（8 组 100 条断言，含真实 HTTP 链路）+
> 变异校验 **12/12** 条有判别力（`out/mutation-spec-intent.json`）。

## 1. 为什么做：此前的「意图相关」判定全是静态的

| 位置 | 形态 | 局限 |
|---|---|---|
| `agent.resolvePromptLayers`（`agent.cjs:687`） | `CANVAS_KEYWORDS` 正则 + 画布快照 | 关键词漏判就漏判：画布还空着、话里没说「节点/连线」的建模需求会被当成纯代码任务 |
| `tools/shellGuard.cjs` | 命令文本级静态审计（显式写出口 / 联网字面量） | 只看命令文本，不看**这一轮用户到底授权了什么** |
| `approvalRules.cjs` + `tools/approval.cjs` | 持久化免打扰规则 + 令牌审批 | 命中规则即免打扰 —— 无法表达「这一轮风险高，规则这次不算数」 |

缺的是**轮级**信号：这轮在做什么、风险多大、用户授权到哪里。

## 2. 参照物：Codex 的 guardian 分类器（逐条对照）

| Codex | 位置 | 本实现对应 |
|---|---|---|
| 一次**独立的模型调用**做分类（不是主循环顺手判） | `codex-rs/prompts/templates/guardian/classifier_instructions.md` | `intent.CLASSIFIER_INSTRUCTIONS` + `createIntentClassifier`（独立请求、独立 `max_tokens`） |
| `risk_level` 取值域 | `GuardianRiskLevel.ts` → `low\|medium\|high\|critical` | `intent.RISK_LEVELS`（逐字对齐） |
| `user_authorization` 取值域 | `GuardianUserAuthorization.ts` → `unknown\|low\|medium\|high` | `intent.AUTHORIZATION_LEVELS`（逐字对齐） |
| 证据可信度分层（只有 user/developer 消息、`AGENTS.md`、`request_user_input` 回答能确立授权；tool 输出 / skill 指令 / 插件描述 / assistant 自述都是不可信证据） | 同分类器指令 `# Evidence Handling` | 同节搬入口径；`buildClassifierMessages` 把 `<recent_transcript>` 明确标注「除 user 之外不可信」 |
| 信息缺失且无法核实时**保守判高** | `# Investigation Guidelines` | 非法/缺失 `risk` → `high`；非法 `authorization` → `unknown`（`parseIntentOutput`） |
| 授权打分中的判例（含糊意向≠授权、紧迫感不改变授权、想要的结果≠授权任一实现路径） | `# User Authorization Scoring` | 逐条写进指令（中文） |
| 不确定就判高 | `# Predictive Consequence Classification`（`unknown`/`low` 授权 → 高） | 收紧触发器 `authorization-unknown` / `authorization-low` / `low-confidence` |

**有意的差异**（不是照抄不来）：

1. Codex 的 guardian 是**动作级 + 异步后台采样**（只影响未来动作，低风险不打扰）；CodeNode 的动作级把关已经在
   `shellGuard` + 令牌审批里，所以这里做**轮级**判定，产出同一套 risk/authorization 口径。
2. 这里的判定多一个出口：Codex 的采样不阻塞主流程，而本实现还要**决定注入哪层提示词**，
   所以默认在构建请求前同步拿结果（可用 `agent.intent_recognition=never` 完全关掉）。

## 3. 两个出口，三条不变量

```
用户消息 + 可信历史 + 画布现状
        │  （一次小请求：system=分类指令，user=证据包）
        ▼
   verdict { intent, risk, authorization, confidence, source }
        │
   createIntentPolicy(verdict)
        ├── routeHint      → resolvePromptLayers（只把画布层**救回来**，从不拿掉别的层）
        └── forceConfirm() → ApprovalService.riskGate（命中免打扰规则也要再问一次）
```

- **I1 只收紧，不放宽**：`createIntentPolicy` 的字段只有 `{ verdict, routeHint, tighten, signals, forceConfirm, describe }`
  —— 没有任何 allow/skip/approve 口。判据穷举了字段集合，并断言 `forceConfirm` 只随 `tighten` 变化。
  审批侧唯一改动是「命中规则也可能被拉回问用户」（`approval.cjs` 的 `gated`），源码级断言 `gated` 不出现在放行分支。
- **I2 无信号 ≠ 低风险**：`source='unavailable'`（没通道 / 报错 / 超时 / 次数用尽）时**一条收紧规则都不成立**，
  行为与「没有这个功能」逐字节一致；「模型跑通了但输出不可用」（`source='invalid'`）才按 Codex 口径保守判高。
  两条路径分开可判，且断言「硬塞 `risk=high` 的 unavailable 也不收紧」。
- **I3 判据可复现**：模型只产出一段文本；文本 → 决策的每一跳都是纯函数（`parseIntentOutput` /
  `createIntentPolicy` / `decideRouteHint` / `shouldClassify`），表驱动直锁。

## 4. 接线（每处都有「防实现了没接线」的断言）

| 位置 | 作用 |
|---|---|
| `electron/ipc/agent.cjs:530+` | run 前分类 → `routeHint` 进 `buildSystemPrompt`；`intentPolicy` 进工具上下文；落 run 事件 `intent`；发 UI 增量 `kind:'intent'` |
| `electron/tools/context.cjs` | `AgentToolContext.intentPolicy()`；懒建审批服务时把 `riskGate` 接上（**只读** `forceConfirm`） |
| `electron/tools/approval.cjs` | 命中规则 + 门禁收紧 → 仍走确认通道；事件 `approval_risk_gate`（含 ruleId）/ `approval_risk_gate_error` |
| `electron/agent.cjs` | `resolvePromptLayers` 新增 `intentHint` 分支（在 `mode` / 画布非空 / 关键词之后）；`loadConfig().intent` |
| `electron/intent.cjs` | 指令 / 解析 / 策略 / 分类器（缓存、次数上限、失败不阻断）/ `parseIntentConfig` / `shouldClassify` |

判据里对 ipc 源码做了静态断言：`intentHint` 真的传进 `buildSystemPrompt`、`intentPolicy` 真的传进上下文、
`shouldClassify` 真的被调用、`appendEvent(...,'intent')` 真的存在、`kind: 'intent'` 真的记账。

## 5. 实测数字

| 量 | 值 | 怎么量的 |
|---|---|---|
| 分类请求体（指令 1,671 字符 + 证据包 202 字符） | **1,873 字符** | `intent.buildClassifierMessages({prompt, history:[1 条], canvasSummary:'[]'})` |
| 分类输出上限 | 256 tokens（`agent.intent_max_tokens`） | `parseIntentConfig` 默认值 |
| 单 run 分类次数上限 | 5（`auto` 下画布非空时 0 次） | `shouldClassify` + `createIntentClassifier.stats()` |
| 端到端链路 | 本机真起 HTTP 端点，分类请求真的发出去 **1 次**，`/chat/completions`，Bearer 头，`used=760` 记账，`entries=['intent']` | `test:intent` H 块 |
| 断言总数 | **100** 条（8 组） | `node scripts/intent-test.cjs \| grep -c '^PASS'` |
| 变异校验 | **12/12** 有判别力 | `node out/mutation-check.cjs --spec out/mutation-spec-intent.json` |

`auto` 模式的成本边界（默认）：**只在画布为空时**分类一次 —— 那是提示词层唯一可能误判的分支；
画布非空时画布层必然注入，分类改不了路由决策，不值当多花一次请求。风险信号想要更全就设 `always`。

## 6. 变异校验（12 条，全在 `out/mutation-spec-intent.json`）

| 变异 | 期望红在哪 |
|---|---|
| 收紧表 `risk-high` 判据改恒假 | `[B] 多条件命中 → signals 全列` |
| 非法 risk 回落成 `low` | `[A] 非法 risk → high` |
| `unavailable` 也去收紧（I2 失效） | `[C] 即使硬塞 risk=high，unavailable 也不收紧` |
| routeHint 不再要求「模型跑通」 | `[C] invalid 即使自称 intent=canvas 也不给 routeHint` |
| routeHint 无差别返回 canvas | `[B] intent=code → routeHint=null` |
| `shouldClassify` 的 `never` 失效 | `[E] shouldClassify: never 永不` |
| 分类缓存失效 | `[D] 同一输入第二次命中缓存` |
| 门禁被绕过（命中规则直接免打扰） | `[F] 收紧时留痕 approval_risk_gate` |
| 门禁不生效（收紧后不走确认） | `[F] 门禁收紧 + confirm 拒绝 → 不签发令牌` |
| `resolvePromptLayers` 去掉 `intentHint` 分支 | `[E] 画布为空 + 无画布词 + hint=canvas` |
| ipc 不传 `intentHint`（没接线） | `[G] ipc 把 intentHint 传进 buildSystemPrompt` |
| Context 不接 `riskGate`（能力断线） | `[G] Context 的审批服务带 riskGate` |

每条结束都会还原原文件并核对 sha256（`mutation-check.cjs` 内置），12 条全部还原一致。

## 7. 配置

```properties
agent.intent_recognition=auto     # auto（默认：只在画布为空时分类一次）| always（每轮）| never（关闭）
agent.intent_model=               # 分类用模型（留空 = 与主模型相同）
agent.intent_timeout_ms=8000      # 单次分类超时（超时 = 没有信号，不阻断对话）
agent.intent_max_tokens=256       # 分类输出上限
agent.intent_max_calls_per_run=5  # 一个 run 内最多分类几次（0 = 不限制）
```

`never` 时：不分类、不收紧、不改提示词 —— 与加这个功能前逐字节一致（判据 `[E]` 组用
`alwaysPrompt.replace(CANVAS_RULES, CANVAS_RULES_STUB) === autoPrompt` 锁死）。

## 8. 取舍与未做（如实列出）

1. **分类是阻塞的**：要赶在 `buildSystemPrompt` 之前拿到 `routeHint`，所以最长阻塞
   `agent.intent_timeout_ms`（默认 8s；正常 1–3s）。它也不能随「停止」按钮取消 ——
   该时刻 `activeRequests` / `AbortController` 还没建（在工具装配处）。
   若要可取消，需要把 controller 的创建提前（会动到 run 收尾的清理路径），本批没做。
2. **headless（`bin/codenode-agent.cjs`）不接线**：CLI 没有画布（`canvasSummary=''`）、审批是 fail-closed 拒绝，
   轮级意图信号没有消费方；接了只会给 eval/CI 的请求形状平白加一次调用。要接可复用同一个 `intent.cjs`。
3. **动作级判定仍归静态审计**：Codex 是对每个动作单独采样，本实现是轮级一把判。
   想做动作级，落点是 `registry.execute` 的审批门（那里已有 `execContext`）。
4. **真实模型取证未做**：本机 `config/agent.properties` 与 `models.json` 都没有 `api_key`，
   所以「真实 DeepSeek 输出 → 解析」这一步没有真机证据，只有本机 HTTP 端点的端到端链路（`test:intent` H 块）。
   配上 key 后的探针：

   ```bash
   CODENODE_API_KEY=... node -e "
   const a=require('./electron/agent.cjs'), i=require('./electron/intent.cjs');
   const cfg=a.loadConfig(process.cwd());
   const c=i.createIntentClassifier({cfg:i.parseIntentConfig({'agent.intent_recognition':'always'}),
     callModel: async ({messages,maxTokens,timeoutMs}) => (await a.chatCompletion(Object.assign({},cfg,{maxTokens}),messages,{timeoutMs})).content});
   c.classify({prompt:'帮我把这个业务流程画成节点链路',history:[],canvasSummary:'[]'}).then(v=>console.log(v));
   "
   ```

5. **UI 未展示**：run 事件 `intent`、审计事件 `approval_risk_gate`、成本项 `kind='intent'`
   已经有数据，前端还没有对应的展示块（回放面板里能看到原始事件）。
