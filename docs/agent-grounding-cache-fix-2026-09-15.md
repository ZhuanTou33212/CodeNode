# Agent 引用校验 / 结果缓存 / 隔离接线 修复记录

修复日期：2026-09-15
基线：提交 `0608583`（分支 `0_2`），修复开始时工作区干净、`npm test` 26/26 通过。
定位方式：在 **fetch 传输边界注入脚本化模型**驱动真实的 `runAgentChat` 工具循环（模型返回是脚本，工具执行 / 文件系统 / Run 事件 / shell 都是真的），不是静态读代码推结论。

## 1）引用校验把真实引用判成伪造引用（用户可见）

**现象**：`retrieve_context` 返回的是块级来源（如 `docs/session.md#L1-L4`），而模型按系统提示第 9 条的
要求引用精确行区间时（`[docs/session.md#L3-L3]`），或按第 11 条「用 read_file 深读候选文件」后引用实读文件
（`[docs/big.md#L1-L20]`），都会被判为无效引用；提示还被 `content += warning` **拼进交付回答正文**。

复现（修复前）：

```
检索来源 citation = ["docs/session.md#L1-L4","src/session/tokenRefresh.cjs#L1-L9","docs/big.md#L61-L132",…]
grounding.status = invalid | invalid = ["docs/session.md#L3-L3","docs/big.md#L1-L20"]
用户看到的回答尾部：> RAG 来源校验：回答包含未由检索工具返回的引用：… 请勿将这些引用视为有效证据。
```

**根因**：白名单只收集 `retrieve_context` 返回的 citation 字符串，判定是字符串精确相等（`allowed.has(citation)`）。

**修复**（`electron/agent.cjs`）：

- 新增 `parseCitation` / `collectTrustedSources` / `citationTrusted`：可信来源改判「本轮真实读过的内容」——
  `retrieve_context` 的文件来源取 `path + startLine/endLine`，`read_file` 取实际读到的行区间（无行号信息时按整文件，
  例如 PDF 文字层），`search_files` 取命中行，`query_scalars` 取命中 key；路径按正斜杠 / 去 `./` / Windows 大小写归一。
- 判定规则：标量按 key 命中；文件引用要求「本轮读过该路径 + 行区间与读到的范围相交」。
  没读过的路径、读过但行号完全不相交的引用仍然判无效；`binary` 的失败读取不产生可信来源。
- 附带修掉同一处的真 bug：引用正则 `\[([^\]\r\n]+(?:#L\d+-L\d+|scalar:…))\]` 要求前缀至少 1 个字符，
  导致 `[scalar:<key>]` 这条形态**永远匹配不上**（被当成「没有引用」）→ 纯标量证据会被误判成 missing。
- 校验结果改为独立事件上报（`onDelta {kind:'grounding'}`），**不再拼进回答正文**；界面本来就有来源徽标
  （`src/components/side/MessageList.tsx` 的 `rag-grounding` 徽标 + 无效引用 tooltip）。

## 2）只读结果缓存的失效盲区

**现象**：`read_file` 读到内容后，`execute_shell` 跑了脚本/构建改了文件，再 `read_file` 同参数 → 命中旧缓存。

复现（修复前）：

```
B3 read_file ok=true repeated=true → work/a.txt（2 行，text） OLD-CONTENT
B4 磁盘实际内容 = "NEW-CONTENT"
```

**根因**：失效条件写成「工具名在写工具清单 `MUTATION_TOOLS` 里」，而能改文件的不止写入类工具——
`execute_shell`（脚本/构建/格式化）、`poll_job`（正在写盘的后台任务）、`delegate_task`（builder 子代理落盘）、
项目扩展与 MCP 工具（执行外部命令）都不在清单里。列举「谁可能写」永远列不全。

**修复**（`electron/agent.cjs`）：改成按**只读白名单**判定——`if (!CACHEABLE_TOOLS.has(tc.name)) toolResultCache.clear();`，
即只有纯只读工具之间缓存保活，其余任何工具（含执行失败、未注册的工具）执行后一律清空。
`MUTATION_TOOLS` 保留为语义清单（注释说明）。

## 3）执行隔离策略经 context 注入时被当成函数（静默降级）

**现象**：`electron/ipc/agent.cjs` 把策略写成 `sandbox: () => sandboxPolicy`，而 `AgentToolContext.sandbox()`
把注入值原样返回 → `sandbox.currentPolicy(context)` 拿到的是**函数**：`policy.mode`、`policy.capabilities`
全为 `undefined` → `guardedSpawn` / `wrapCommand` 判定为「无后端」→ Windows 上 Job Object 的进程数 / 内存 / CPU
限额不生效，macOS/Linux 直接退化成无隔离的原生 spawn；`strict` 模式的 fail-closed 检查（`policy.unsatisfied`）
也被一起绕过。`sandbox-test` 此前都显式传 `policy` 对象，所以测试全绿而应用路径一直没隔离。

**修复**：

- `electron/ipc/agent.cjs`：改为传策略对象本身（并留注释说明为什么不能传函数）。
- `electron/tools/context.cjs`：`sandbox()` 兼容 getter 形式（注入值为函数时取其返回值），避免后续调用点
  再踩同一个坑；返回非对象时不再被当作有效策略。

## 回归用例（都进 core 套件）

| 用例 | 覆盖 |
| --- | --- |
| `scripts/agent-cache-invalidation-test.cjs`（新增，`npm run test:agent-cache`） | shell 改文件后必须失效 / 写工具路径仍失效 / 未注册工具失败后也失效 / 纯只读之间仍复用 / 不同参数不共享键 |
| `scripts/rag-grounding-test.cjs`（扩 10 组断言） | 块内子区间有效 / read_file 实读区间有效 / 行号越界无效 / search_files 命中行 / scalar 命中与伪造 / `source:` 前缀 / `./` 归一 / 分段读取 / PDF 整文件 / binary 不产生来源 |
| `scripts/sandbox-test.cjs`（新增第 10 节） | 策略对象与 getter 两种注入都解析为策略对象、保留 backend 声明、strict 经 context 注入仍 fail-closed |

**变异测试（证明判据有判别力）**：

- 把缓存失效改回 `MUTATION_TOOLS` → `agent-cache-invalidation-test` 3 项 FAIL、exit 1（`repeated=true` 且读到 `OLD-CONTENT`）。
- 把引用校验改回精确串白名单 → `rag-grounding-test` 在子区间断言处 `'invalid' !== 'valid'`、exit 1。
- 两次都原样还原（sha256 与原始一致）。

## 验证

`npm run verify`（build + check:js + `npm test` 27 项 core，含 11/11 离线评测）全绿；
报告见 `docs/eval-reports/`。
