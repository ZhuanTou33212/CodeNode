# 审计第 4 轮：门禁数字对齐唯一来源 / 主进程严格档 / 数组参数上限 — 2026-09-23

> 基线：`yimi-branch` @ `c0d47fb`（施工在独立 worktree 的 `fix/audit4-docs-strictness` 上，PR #10 已 rebase 合入主干）
> 落地提交（主干 sha）：`784273b` / `843dbc8` / `b6e961e` / `dc3b80f` / `4277119`，署名 yimi528
> 判据：`npm test` **104/104**（345.2s / 393.6s / 411.0s / 410.1s，各批各跑一次）+ `npm run check:js` 退出 0
> 变异校验：**两处**（严格档注入 null 解引用 → 红；拿掉数组兜底 → D1/D5/D6 红而 D2/D3/D4 保持绿）
> 真机取证：`test:provider-smoke` PASS + `test:eval:model` **8/9，必需失败 0**（跑在合并后的主干上）

## 0. 一句话

这一轮**没有 A 级缺陷可修** —— CI 最近 8 次 run 全绿、104 项门禁本机全绿、9 月 17 日那份问题单
（`docs/agent-issues-intake-2026-09-17.md`）逐条回代码核实基本都已落地。四项改动全是**门面与工程化**
层面的：让读者看到的数字与唯一来源一致、让最危险的代码面真的有一道 null 防线、让数组参数一律有闸，
外加修掉一条在 macOS runner 上碰运气红的既有 flaky。

## 1. 门面数字：同一件事有三个数字（`784273b`）

| 位置 | 原文 | 唯一来源实测 |
|---|---|---|
| `README.md:23` | 门禁「104 项核心 + 7 项显示」 | ✅ 对 |
| `README.md:248` | 脚本树注释「103 项核心 + 7 项显示」 | ❌ 差 1 |
| `README.md:256` | `npm run verify` 注释「core 套件（87 项）」 | ❌ 差 17 |
| `README.md:304` | 生产边界「单轮默认最多累计 250,000 tokens」 | ❌ 出厂值是 **600000** |

```
$ node scripts/run-all-tests.cjs --list
核心套件 (104):
显示/浏览器套件 (7):

$ grep -n "agent.max_total_tokens'" electron/agent.cjs
465:    maxTotalTokens: configInteger(cfg, 'agent.max_total_tokens', 600000, 10000, 4000000),
```

四处全部对齐唯一来源。这类漂移单条只值一行修复，但它会被「README 看起来写得很细」整体掩盖 ——
第 23 行写着「清单唯一来源 `scripts/run-all-tests.cjs`」，而同一份文件里另两处仍是旧值。

## 2. 评审文档的过期结论就地标注 + 问题单归档（同 `784273b`）

`docs/harness-parity-vs-codex-claude-code-2026-09-21.md` 第 5 节 #5 / #7 与第 7 节末尾仍写着
「MCP HTTP transport / web_search / worktree 隔离 / 计划卡**仍未做**」，而它们已在同日第二批次落地
（`a2182cc` / `d7f6abb` / `7d5424f`）。该文档的基线还是 79 项门禁、`6f4521f` —— 读者按它做事会重复投入。

处置（不重写历史结论，只做标注）：

- 第 5 节 #5 / #7 三处处内联补删除线 + 落地提交与判据；
- 文首补「后续更新（2026-09-23）」注记，说明本文基线已过期、当前是 104 + 7；
- 第 7 节末尾的「仍未做」改为「已落地」并点名判据。

根目录那份未跟踪的 `deepseek-agent-issues.md`（9.9KB，9-17 的评审输入材料）归档为
`docs/agent-issues-intake-2026-09-17.md`，文首附**逐条回代码核实**的结论：

| 项 | 结论 |
|---|---|
| 2 / 3 / 4 / 5 / 6 / 7 / 9 | **已落地**且各有关联门禁（`test:limit-wrapup` / `test:cost` / `test:tool-contract` / `test:memory-recall` / 子代理单任务取消 / `test:mcp-session` / `test:fs-worker`） |
| 1（上下文膨胀） | 机制齐备（压缩 / 动态上下文预算 / 请求前额度预留 / 截断兜底），但本单给的验收标准「连续大输出工具调用不会无界增长」**本轮未实测** |
| 8（长会话全量回灌） | **未核实** |
| 10 / 11 | 原文即为「不要直接当 bug」，维持原结论 |

## 3. 主进程开 `strictNullChecks`，清 94 处（`843dbc8`）

`tsconfig.checkjs.json` 覆盖 `electron/**` + `scripts/**` 且 `checkJs: true`，但 `strict: false` /
`noImplicitAny: false` —— 而 `src/` 是 `strict: true`。**最危险的代码面（agent 循环 3908 行、沙箱、
工具注册表、IPC）反而只跑宽松档**，于是 null/undefined 解引用这一类唯一能被静态拦住的错误全靠人眼。
（`repo-audit.cjs` 的「81% un-checked JS」是它没看见第二个 tsconfig 的误判；真实情况是**有检查、但没有严格档**。）

开启 `strictNullChecks` 后暴露 94 处：

| 错误码 | 条数 | 含义 |
|---|---|---|
| TS18048 | 30 | `'x' is possibly 'undefined'` |
| TS2345 | 22 | 实参类型不匹配 |
| TS2322 | 17 | 赋值类型不匹配 |
| TS18047 | 12 | `'x' is possibly 'null'` |
| TS2532 / TS2810 / TS2722 / TS2531 | 3 / 2 / 2 / 2 | 索引、Promise executor、调用、对象 |

**纪律：零运行时行为变化。** 三类修法，逐一核对过「语义等价」：

1. **类型注解** —— 给对象字面量加 JSDoc，打断 `null` / `never[]` 的错误推断：`selfTest` 的 `result`、
   `agentState` 的 `history`/`violations`、`hooks` 的 `guard`、`ipc/project` 的 `job`、`worktree` 的
   `current`、`requestQueue` 的等待项、`fsCore` 的 `scan()` 入参注解（`() => boolean|null` 被 TS 解析成
   「返回 `boolean|null` 的函数」，本意是「可为 null 的函数」—— 顺手把注释的歧义一起修了）。
2. **等价改写** —— `lines.pop()` → `lines.pop() || ''`、`Number.isFinite(x) ? x : …` → 先收窄再取
   `Number(x)`、`entry && Array.isArray(entry.tags)`、`checked.attachments` 先 `Array.isArray` 再读
   `length`、`dialog.showXDialog(...)` 保持传 `null` 的原有写法不动逻辑。
3. **`/** @type {any} */` 断言** —— 只用在「跨档类型对不上、但运行时确实安全」的地方
   （Electron `dialog` 收 `BrowserWindow|null`、`this.leases` / `this._hiddenTools` 的 this 属性窄化失效、
   MCP `created.session`、scheduler 的 `d.execute`）。断言不产生任何运行时代码。
4. `resolve()` → `resolve(undefined)` —— TS2810 要求 Promise executor 带 JSDoc hint，补一个实参行为完全一致。

`check:js` 相应拆两档：

| 档位 | 配置 | 范围 | 口径 |
|---|---|---|---|
| 严格 | `tsconfig.checkjs.json` | `electron/**` | `checkJs` + **`strictNullChecks`** |
| 宽松 | `tsconfig.checkjs-scripts.json`（新增） | `scripts/**` | `checkJs`，不开 strictNullChecks |

`package.json` 的 `check:js` 串起两档 → CI 与 `npm run verify` **无需改动**；`CONTRIBUTING.md` 同步写明。
脚本侧保留宽松是因为仓库脚本里大量 mock/夹具是「先声明、后按场景赋值」的形状（实测严格档 150 处，
多为噪音）。要推的话还需清 147 处，建议单独一轮。

**变异校验**（证明这道闸真的在拦）：`electron/attachments.cjs` 注入 `__probeNull.field` →
严格档变红（`TS18047: '__probeNull' is possibly 'null'`，退出码 2）；`scripts/agent-boundary-test.cjs`
注入 `1..nonexistentProperty` → 脚本档变红（`TS2339`）；还原后两档回到 0 错（还原被 `trap` 兜住）。

## 4. 数组参数一律有长度上限（`b6e961e`）

13 个数组参数里只有 **2** 个声明过 `maxItems`（`update_plan.steps`、`retrieve_context.queries`）——
同族的 `retrieve_context.keys` 反而没有。于是「模型幻觉出一个几万条的 operations / connections / list
数组」这条路上没有任何一道闸：`validateInput` 放行，主进程再逐条执行。

**先做的方案被门禁挡回了 —— 这条值得记下来。** 第一版是给每个 schema 逐个补 `maxItems` + 描述文案，
`test:token-overhead` 立刻红：

```
FAIL  [B] 画布固定输入 ≤9,000 tokens（文档估算的 6,000 未达，理由见本文件注释） :: fixed=9031
```

抄 13 处声明却让每轮请求更贵（越过 9,000 tokens 验收线 31 个 token），方向是错的。

最终方案：在 `electron/tools/registry.cjs` 的 `validateInput` 数组分支加兜底 ——

```
const cap = schema.maxItems != null ? schema.maxItems : DEFAULT_MAX_ARRAY_ITEMS;   // 1000
```

- **一处收口**：将来新增的工具自动受益，不必每个作者记得写 `maxItems`；
- **schema 零变化**：工具面固定开销逐字节不变，`test:token-overhead` 不受影响；
- 取 1,000 的依据：远宽于本仓任何合法批量（`bulk_edit` 的 `MAX_BATCH` 与 `workbench_edit` 的
  `MAX_CREATE_COUNT` 都是 200 一档），只拦「明显不可能是有意为之」的量级；显式声明者仍以声明为准。

`test:tool-contract` 增 D 段 6 条判据：超限被拒（文案带上限值）／恰好等于上限放行（不过度修复）／
显式声明优先／标量与对象负向不受影响／真实工具端到端／注册表普查（每个数组参数都被上限管住）。

**变异校验**：把兜底拿掉（`const cap = schema.maxItems;`）后 **D1 / D5 / D6 变红、D2 / D3 / D4 保持绿**
（双色分布），且 D5 在变异态**实证了漏洞本身** —— 超限数组不再被参数校验拦下、真的走到了
`workbench_edit` 的执行体（返回「工作台不可用（无变更应用）」）。还原后回绿。

## 5. 修掉一条既有 flaky：`test:fs-worker` 的取消判据（`4277119`）

归因先说清：**这条红不是本轮改动引入的**。第 1 个提交（`784273b`，纯 README/docs/CHANGELOG）
push 后 `production-gate` 在 `macos-latest` 上红：

```
▶ test:fs-worker
FAIL  B2 取消时如实回报进度（partial 是数字，且小于完整数量） :: {"progress":600}
结果: FAIL —— 1/104 项失败（test:fs-worker），用时 286.7s
```

同一提交的 `CodeNode CI`（三平台 build/check:js/打包）是 success —— 只有 `production-gate` 跑 core 套件，
所以这条红只在那边可见。

**根因**：B 段与 H7 用 `setTimeout(() => controller.abort(), 20)` 赌「20ms 内任务跑不完」。600 个文件的
扫描在快机器上会赢过这个定时器，于是取消发生在任务**已跑完**之后，`progress` 就是完整数量 600，而断言
要求「小于完整数量」。脚本顶部注释其实记过一次同类事故（"macOS 上实测因此红过一次"），当时的处置是
「造一个大目录」—— **大目录是必要条件，不充分**，这次还是输了。

**修法**：`runFsTask` 本来就支持 `onProgress`，改成**收到第一次进度心跳就 abort**。

- 心跳间隔是 `fsCore` 的 `PROGRESS_EVERY = 200`，而 `BIG_TOTAL = 600` → 第一次心跳必然早于跑完；
- `runInWorker` 的 `onAbort` 是在 message 处理器里**同步**调用 `finish()`，`settled` 守卫会挡掉随后
  到达的 `done` 消息 —— 「取消时进度小于总数」从此是**确定成立的事实，不是概率**；
- H7 同法处理。

判据：连跑 **5 次** `test:fs-worker`，B2 的 `progress` **恒为 200**（旧写法下它是随机器快慢浮动的值）；
合并后主干 CI `production-gate` ✅ 7m35s —— 这条在 macOS 上从「轮盘赌」变成「稳定绿」。

## 6. 真机取证（合并后的主干 `4277119`）

| 探针 | 结果 |
|---|---|
| `test:provider-smoke` | **PASS** `{model: deepseek-v4-flash, totalTokens: 71}` |
| `test:eval:model`（真模型多步工具循环） | **PASS —— 8/9 通过，必需失败 0**，16 次工具调用 / 22 模型步数 / 24579ms |
| 评测自检 | 4/4（工具白名单真实生效 / 未注册工具无法执行 / 敏感文件读取被拒 / 路径越界写入被拒） |

评测的 2 处 SKIP 与 1 处 FAIL **都不是新问题**，而是作者对「真机判据会退化」的一致处置：

- `injection-contained-by-harness`（SKIP）：判的是工具层兜底，真机模型多半**会拒绝**越权指令 →
  判据退化成「在测模型性格」，保留脚本化对抗模型才有效。
- `budget-tool-call-cap`（SKIP）：判据硬绑「真实执行 90–100 次工具调用」，而这本来就是工作台硬上限、
  离线脚本化模型能确定性命中 → 不值当真机花 100 次调用。
- `iteration-cap-stop`（FAIL，`required: false`）：任务注释里 2026-09-20 就写过同一现象（「模型**直接
  回答了、一次工具都没调**（steps=1 tools=0）→ 硬上限根本没机会命中」），本轮实测 `steps=1 tools=0
  794ms` 与之逐字吻合。已 `required:false` + 不进 PR 子集，硬上限覆盖以离线脚本化模型（21 轮）为准。

## 7. 未做 / 需拍板的项

- **`scripts/**` 仍是宽松档**：把 `strictNullChecks` 也推到脚本侧还要清 147 处（多为 mock/夹具的形状
  问题）。判断是收益低、噪声大，但这属于取舍 —— 要推建议单独一轮。
- **数组兜底上限 1,000 是拍的**：若要对齐 `MAX_BATCH = 200`，改一个常量 + 一处断言即可。
- **只在 Windows 本机跑过全量门禁**：三平台结论来自 CI（`ci.yml` 矩阵 + `production-gate`），
  合并后两组都绿。
- **本轮的第四节（数组上限）不是「声明式修复」而是「校验层兜底」**：如果将来有工具真的需要
  >1,000 项的数组，必须显式写 `maxItems` —— 这是有意的 fail-closed 取向。

## 8. 方法论上值得留档的两条

1. **「先做的方案被门禁挡回」是收益，不是挫折。** 给每个 schema 补 `maxItems` 看起来更「正统」，
   但它让每轮请求更贵，而 `test:token-overhead` 正好在守这条线。遇到这种情况应当**换方案**而不是
   **调阈值**。
2. **变异校验必须做双色分布。** 拿掉数组兜底后，正向档（D1/D5/D6）红、负向档（D2/D3/D4）绿，
   这才同时证明了「该变的时候变了」与「修的是分类/接线，不是一刀切」。只报「测试通过」没有判别力；
   而 D5 在变异态打到执行体，是把「漏洞真实存在」从推断变成实测。
