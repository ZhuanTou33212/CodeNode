# 安全边界收口 + 任务清单（`update_plan`）落地记录

> 日期：2026-09-21 ｜ 基线：`yimi-branch` @ `6f4521f` ｜ 对照文档：`docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 #1 / #2
> 门禁：核心套件 **79 → 81**（新增 `test:shell-boundary` / `test:agent-plan`），变异校验 **8/8** 条有判别力。

## 1. 为什么做这两项

上一轮逐轴对照后的结论是：CodeNode 在可靠性/可观测/评测三层已经不落后，但**控制面与扩展面**明显少于
Codex CLI / Claude Code，其中两条最值得先做：

| 项 | 对照物 | 问题形状 |
|---|---|---|
| #1 安全边界 | Codex `sandbox_mode=workspace-write`（默认无网络）+ `approval_policy` | Windows 后端不隔离文件系统/网络，唯一防线是静态审计 + 确认；而实测**两条默认放行**：联网命令（`network=inherit` 出厂）与「写目标判不出来」（`best-effort` 下静默执行） |
| #2 任务清单 | Codex `update_plan` / Claude Code `TodoWrite` | 模型没有地方写下「分几步、现在在哪一步」，长任务只剩「撞 `max_tool_iterations`」或「漂到别的目标」 |

两项都在 `docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 里排在前两位（收益/成本比最高）。

## 2. #1 安全边界收口（三条）

### 2.1 出厂断网（`sandbox.network` 默认 `inherit` → `deny`）

- 落点：`electron/agent.cjs` 的 `parseSandboxConfig`、`electron/sandbox.cjs` 的 `resolvePolicy`（**两处必须同源**，用例锁的是出厂值）。
- 行为：出厂口径下疑似联网的命令**直接拒绝**（`PERMISSION_DENIED`），**不弹确认、不试连**；拒绝文案给出放行键
  `sandbox.network=inherit`。显式 `inherit` 时联网命令走一次 HIGH 确认（不是静默放行）。
- 平台差异（如实写在文案与注释里）：Linux `bwrap --unshare-net` / macOS `sandbox-exec (deny network*)` 是**真的断网**；
  Windows 只做**命令级拒绝**（无内核方案）。
- 对照：Codex 的 `workspace-write` 默认同样不给网络（`~/.codex/config.toml` 实测 `sandbox_mode="workspace-write"`）。

### 2.2 「写目标判不出来」不再静默放行

- 落点：`electron/tools/impl/executeShellTool.cjs`（`guard.unresolvedWrites` 的新处置）。
- 之前：`outsideWrites`（显式越界）任何模式都硬拒；而 `unresolvedWrites`（`> $OUT`、`writeFileSync(p)` 这类
  变量/通配写目标）**只在 `strict` 模式拒**，出厂 `best-effort` 静默执行 —— 等于「把路径放进变量」即可绕过路径边界，
  而 Windows 没有内核级兜底（2026-09-15 已复现过越界写真能成功）。
- 现在：任何模式都要求确认（HIGH），确认文案写明「写目标含变量或通配（…），当前平台没有内核级文件系统隔离」；
  用户拒绝 → `APPROVAL_DENIED`；`strict` 仍是硬拒。

### 2.3 联网判定与白名单/高危判据共用归一化（本轮由 2.1 暴露）

- 落点：`electron/tools/shellGuard.cjs` 的 `detectNetwork`（此前 `base = tokens[0].replace(/\.(exe|cmd|bat)$/,'')`）。
- 症状：`nuget restore` 被判为联网命令，而 `C:/tools/nuget.exe restore` 一点都不命中 —— 同一件事两种判定。
  出厂 deny 下前者「直接拒」，后者却「弹一次确认就走」= 换个写法绕过断网策略。
- 修法：与 `executeShellTool.normalizeProgram` 同口径 —— 先去掉引号、扩展名，再取 basename（`C:/tools/nuget.exe` → `nuget`）。

## 3. #2 任务清单 `update_plan`

- 新模块 `electron/plan.cjs`（唯一实现来源）：`normalizePlan` / `summarizePlan` / `renderPlan` / `readPlan` / `writePlan`
  + 常量 `MAX_PLAN_ITEMS=20` / `MAX_STEP_CHARS=200` / `PLAN_STATUSES`。
- 新工具 `electron/tools/impl/updatePlanTool.cjs`（`registry.registerDescriptor` 显式契约）：
  - `readOnly:false` / `mutatesWorkspace:false`（不改文件与画布 → **只读上下文里也不该被拦**，也不进只读角色白名单：
    计划是主代理的职责）/ `cachePolicy:{mode:'none'}`（两次同参调用必须真的执行两次）/ `requiresConfirmation:false`。
  - 校验：非数组、空数组、> 20 项、`step` 空/超长、`status` 非法 → `ARG_SCHEMA`；
    **同一时刻最多一项 `in_progress`** → `ARG_SEMANTIC`（允许多项等于「同时在干三件事」，计划会退化成愿望清单）。
- 回灌路径（关键）：计划**搭进度提示那条注入消息**一起回灌 —— 那条消息「同一时刻只保留一条、原地替换」，
  单独注入会被下一轮替换掉（同类失效这个仓库踩过）。触发条件是「到进度节奏」**或**「计划刚变过」，
  后者保证模型写完计划的下一轮就看得见（不必等满 `agent.progress_every=3`）。
- 持久化：run 事件 `plan_updated`（进 `.codenode/runs/<runId>.jsonl`，S8 桥接到 `.codenode/events.jsonl`，
  界面「工作流运行」回放时间线可见）+ `.codenode/runs/<runId>.plan.json`（原子写，跨进程/续跑可读，
  与子代理任务视图同一口径）。
- 主循环读取口径：`agent.readRunPlan(projectRoot, cfg)`（读不到 → `null`，按「没有计划」处理，不抛）。

## 4. 判据与证据

| 项 | 用例 | 断言数 | 变异校验 |
|---|---|---|---|
| #1 | `test:shell-boundary`（`scripts/shell-boundary-test.cjs`） | 38 | 4/4 有判别力 |
| #2 | `test:agent-plan`（`scripts/agent-plan-test.cjs`） | 49 | 4/4 有判别力 |

- 真实输出：`npm test` → `PASS —— 81/81 项通过，用时 312.4s`；`npm run check:js` 退出 0；`npm run build` 退出 0。
- 变异校验（`out/mutation-spec-boundary-plan.json`，8 条）：出厂值退回 `inherit`（两处各一条）、
  未解析写目标回到静默放行、`detectNetwork` 不剥目录、主循环不注入计划、去掉「最多一个 in_progress」、
  不落盘/不写事件、把 `update_plan` 声明成改工作区 —— 每条都让对应用例**非零退出且红在预期断言上**，
  结束后文件 sha256 与改前一致。
- 负向判据（防过度修复）：明文写目标落在项目内不额外要求确认；`git status` 这类只读命令不受影响；
  显式越界写仍硬拒且不落盘；没写过计划时提示里不出现「计划」段、也不凭空造出 plan 文件；
  `sandbox.network=inherit` 仍是可配置的（不是写死）。

## 5. 出厂口径变更带来的两处既有用例调整（都是"测试依赖了旧默认值"，不是产品回归）

| 用例 | 原写法 | 现在 | 原因 |
|---|---|---|---|
| `scripts/tool-descriptor-test.cjs` D3 | `resolvePolicy({mode:'off'})` 当「网络没被切断」 | 显式 `network:'inherit'` | D3 的语义是「网络没被切时不一刀切」；出厂改 deny 后「不写 network」不再等于不切网 |
| `scripts/shell-hardening-test.cjs` #8 | 同上（裸写法 vs 路径限定写法都要弹确认） | 显式 `network:'inherit'` | 该节考察的是「sensitive 判据与白名单共用归一化」；出厂 deny 会让 `nuget restore` 先被断网策略拒，测的就不是敏感判定了 |

另外 `scripts/prompt-layers-test.cjs` 的**每轮固定开销上界**随新增工具抬高（16,000 → 17,000 字符、
合计 18,000 → 19,000），并在断言文案里注明「为什么抬高（新增 `update_plan`，24 → 25 个工具）」——
上界是棘轮而不是橡皮筋：再抬必须给出理由。

## 6. 仍未做（如实列出，不打包成"已完成"）

1. **界面上的计划卡**：计划目前通过 ① 工具结果 ② 进度提示 ③ run 事件回放时间线 三处可见；
   对话区还没有一张独立的「计划」卡（需要新增 delta kind + 前端渲染，属独立一轮）。
2. **Windows 上的强制隔离**：仍无受限令牌 / AppContainer 方案，边界依旧是「静态审计 + 确认」；
   `strict` 模式在 Windows 上会因 `require_filesystem` 而拒绝执行，属**如实拒绝**而非已隔离。
3. **`unresolvedWrites` 的语义上限**：现在把「判不出来」交给用户确认，人点得快就等于放行；
   要真正收口得靠 ②。
4. **计划与子代理**：子代理角色白名单里没有 `update_plan`（有意），所以子代理内部没有清单 ——
   若将来要给 `builder` 加，需要同时决定「子代理计划是否合并进主计划」。
