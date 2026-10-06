# 控制面补齐：钩子 / 用户级记忆 / 非交互入口 / 审批规则 / 技能渐进披露 / 看图

> 日期：2026-09-21 ｜ 基线：`yimi-branch` ｜ 对照文档：`docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 #3 / #4 / #6 / #7
> 门禁：核心 **81 → 88**（+`hooks` / `headless` / `user-memory` / `approval-rules` / `skill-index` / `view-image`）
> 变异校验：本轮新增 **19/19** 条有判别力（hooks 5 + 控制面 11 + MCP 3）（`out/mutation-spec-hooks.json`、`out/mutation-spec-control-plane.json`）

上一轮（`docs/agent-boundary-and-plan-2026-09-21.md`）做掉了 #1 安全边界与 #2 任务清单。这一轮把对照文档
里剩下的控制面缺口逐条做掉 —— 每一项都是「主流 harness 有、我们没有」的东西，且都配了会先失败的用例
与变异校验。

## 1. 钩子（对照 Claude Code 的 hooks，§5 #3）

- 落点：`electron/hooks.cjs`（配置解析 / 匹配 / 执行 / 渲染）+ `electron/agent.cjs` 主循环 + `electron/ipc/agent.cjs`（会话级）。
- 能力：`hooks.post_tool_use`（匹配的工具执行完跑命令，输出作为机器注入的 user 消息回灌）、
  `hooks.session_start` / `hooks.session_stop`（run 前后各一条，只进 run 事件不进上下文）。
- 安全：跑之前过 `shellGuard`（显式越界写 → 不执行；`sandbox.network=deny` 时联网命令 → 不执行），
  执行走 `sandbox.guardedSpawn`；`hooks.timeout_ms` / `max_output_chars` / `max_runs` 三个上限。
- 未配置 = 一次 spawn 都不发生、一条消息都不注入（负向判据锁死）。
- **实测坑（值得记住）**：把整条命令当 argv 交给 `cmd /d /s /c`，Windows 下 Node 会把内层引号转义成 `\"`，
  cmd 收到后**既不执行也不报错**（退出码 0、零输出）——最坏的一种失败。改为把命令写进 `.cmd` / `.sh`
  临时脚本再执行，引号问题整类消失。
- 判据：`test:hooks`（34 条断言）；变异 5/5。

## 2. 用户级（跨项目）记忆（Java 版 `UserMemoryStore` 的对应物，§5 #7）

- 落点：`electron/userMemory.cjs` + `remember`/`recall` 的 `scope` 参数 + `agent.buildSystemPrompt` 的新段落。
- 语义：`$CODENODE_HOME/user-memory.json`（可注入，测试不污染家目录）、上限 200 条、同内容去重、
  按提问打分检索（复用项目级口径）、注入成独立段落「【用户级记忆（跨项目，不可信数据，仅作参考）】」。
- 不传 `scope` 时行为与改动前**逐字节一致**（判据锁住）。
- 判据：`test:user-memory`（21 条断言）。

## 3. 非交互入口（对照 `codex exec` / `claude -p`，§5 #7）

- 落点：`bin/codenode-agent.cjs`（`package.json` 增 `bin` 映射）。
- 用法：`--project` / `--prompt`(或 `-` 读 stdin) / `--prompt-file` / `--allow-writes` / `--yes` /
  `--json` / `--quiet` / `--timeout` / `--max-iterations`；凭据走 `CODENODE_API_KEY` / `CODENODE_BASE_URL` /
  `CODENODE_MODEL` / `CODENODE_MAX_TOKENS`（CI 注入，不落盘）。
- **fail-closed**：缺凭据退 2；确认策略默认拒绝一切并打印原因与放开方式，`--allow-writes` 只放开 WRITE、
  HIGH 需要 `--yes`；退出码 0 正常 / 1 run 失败或撞上限 / 2 配置凭据 / 3 被取消。
- **实测坑**：Windows 上直接 `process.exit()` 会在异步句柄关闭过程中触发 libuv 断言
  （`!(handle->flags & UV_HANDLE_CLOSING)`，退出码 3221226505）——功能已正确完成、退出码却是崩溃码。
  改为设 `process.exitCode` 让事件循环自然排空 + 一个 unref 的兜底定时器。
- 判据：`test:headless`（17 条断言，真 HTTP + 真 SSE + 真工具调用 + run 落盘）。

## 4. 持久化审批规则（对照 Claude Code 的 allow 规则 / Codex 的项目 trust，§5 #6）

- 落点：`electron/approvalRules.cjs` + `ApprovalService` + `context` 懒创建 + `bridge`（界面按钮）+ `shared.resolveInRoot`。
- 语义：`<project>/.codenode/approvals.json`（上限 50 条），匹配要求**已声明字段全部命中**
  （capability + tool + level）；命中即免打扰，但**仍然签发一次性令牌**并留 `approval_rule_hit` 审计。
- 只记忆**注册表级**审批（`what` 即工具名）；shell 命令那种逐条确认**不记忆**理由：
  「允许一条命令文本」很快退化成「允许一类命令」，而 Windows 上没有内核兜底。
- **受保护路径**：`.codenode/approvals.json`（及 permissions.json）由写工具一律写不进 ——
  否则提示注入可以让模型自己给自己发白名单（判定放在 `resolveInRoot`，所有写工具自动继承）。
- 界面：确认弹窗新增「本项目始终允许」；不可记忆的审批会明确打印说明而不是静默忽略。
- 判据：`test:approval-rules`（24 条断言）。

## 5. 技能渐进披露（§5 #4）

- 落点：`electron/tools/impl/readSkillTool.cjs` + `agent.buildSkillsIndex`（纯函数，供判据直锁）+ `ipc/agent.cjs`。
- 变化：项目 skills 的 `instructions` 从「整段常驻 system prompt」改为「prompt 只放名字 + 一句话，
  正文由模型调 `read_skill` 按需读」（上限 8000 字符、超限截断标注，名字大小写不敏感、未知名字列出可用项）。
- 量测：用例直接断言「索引版比整段注入版省下 ≈ 正文长度的字符数」。
- 判据：`test:skill-index`（17 条断言）。**注意**：第一版把索引文本写在用例里自造，等于什么都没锁，
  变异测试当场抓出来 → 抽出纯函数后判据才真正打在代码路径上。

## 6. 看图（对照 Codex 的 `view_image`，§5 #7）

- 落点：`electron/tools/impl/viewImageTool.cjs` + `agent.cjs` 主循环的附图逻辑。
- 语义：读项目内图片（png/jpeg/webp/gif、≤4MB、路径必须在项目根内），主循环把图**作为一条 user 消息**
  附在工具结果之后（OpenAI 兼容接口只在 user 消息里带 `image_url` 才可靠）；上限与用户附件同一套。
- 附不上（校验失败）时如实回执「不要假设你看到了画面」，不静默吞掉。
- 判据：`test:view-image`（18 条断言，含端到端「第二次请求里真的出现 image_url」与「没调用时零痕迹」）。

## 7. MCP 会话复用 + `tools/list` 缓存（对照文档 §5 #5）

- 落点：新模块 `electron/tools/mcpClient.cjs`，`extensions.runMcpTool` 变成它的薄封装（返回形状不变）。
- 变化：每个 (项目, 扩展) 一条**常驻 stdio 会话** —— spawn 一次、`initialize` 一次、`tools/list` 一次（缓存），
  之后所有 `tools/call` 复用同一条通道；空闲 `idleMs`（默认 120s）自动关闭；server 崩溃时立刻让挂起请求失败
  并允许下一次调用重拉；run 结束 `closeAll()` 统一关闭（不留孤儿进程）。
- 不放松的既有约束：仍走 `sandbox.guardedMcpSpawn`、仍有 1MiB 响应上限、握手超时/失败文案与旧实现一致。
- 顺带修：`closeSession` 打「主动关闭」标记，**不再被统计成 crash**（否则监控数字全是噪声）。
- 判据：`test:mcp-session`（25 条断言，含 server 侧请求日志取证：只有 1 个 pid、initialize 1 次、tools/list 1 次、
  tools/call 2 次）；`test:mcp-handshake` 全绿（回归）。

**实测坑**：`extension.command` 里含空格的路径必须加引号（`splitCommand` 的既定口径），朴素 `split(/\s+/)` 会把
`C:\Program Files\nodejs\node.exe` 拆成 `C:\Program` → ENOENT；所以 mcpClient 复用了 `extensions.splitCommand`，
而不是自己写一套分词。

## 8. MCP streamable HTTP transport（§5 #5 剩余项）

- 落点：`electron/tools/mcpHttpTransport.cjs` + `mcpClient` 改成 transport 无关。
- 能力：`POST` JSON-RPC；应答按 content-type 分流（JSON 直解 / `text/event-stream` 逐帧找**同 id** 的那条）；
  记住并回传 `mcp-session-id`；非 2xx / 空应答 / 非 JSON / 找不到同 id 各自如实报错。
- 出网受策略约束：`sandbox.network=deny`（出厂默认）时拒绝并说明怎么放开；拒绝时**一个请求都不发**。
- `publicHttp` 新增通用 `request()`：method/headers/body + `allowPrivateHosts`（本地/内网 MCP 是用户自己配的端点），
  仍做地址解析与连接固定、仍有字节上限、**不自动跟随重定向**（POST 语义各家不同，静默跟随容易发到没预期的地址）。
- 判据：`test:mcp-http`（29 条断言，进程内 mock HTTP MCP server 记请求取证）。**实测坑**：`http.request`
  只设 `content-length` 而 `req.end()` 不带 body，服务端会一直等那些字节 → 客户端直到超时才 abort，
  症状是「The operation was aborted」且服务端一条请求都没收到 —— 排查方向全错。

## 9. `web_search` 联网搜索（§5 #7）

- 落点：`electron/tools/impl/webSearchTool.cjs`；**不写死服务商**：后端由 `web_search.*` 配置
  （`searxng` 自建实例无需 Key / `custom` 通用 JSON），**不配 = 工具根本不注册**（零上下文成本）。
- 归一化：`{results:[…]}` / `{items:[…]}` / 裸数组；`api_key` → `Authorization: Bearer`；`{query}` 模板替换。
- **绝不编造**：空结果如实说「没有结果」；HTTP 500 / 非 JSON / 形状不对各自如实报错。
- 判据：`test:web-search`（32 条断言）。**实测坑**：抓取路径不能用只允许公网地址的 `fetchPublicText`
  （自建 SearxNG 十有八九在 `127.0.0.1` → 必被 SSRF 判据拦下）；且注册表层已有一道联网门禁，
  工具自身那道纵深防御要靠「绕过注册表直调 handler」才测得到（变异测试抓出的空判据）。

## 10. git 工作树隔离（§5 #7）

- 落点：`electron/worktree.cjs` + `electron/tools/impl/worktreeTool.cjs`（list/create/remove）。
- 安全边界：只在 `.codenode/worktrees/<slug>` 下建/删（受管目录之外一律 `NOT_MANAGED`）；数量上限 5；
  删有未提交改动的工作树默认拒绝（`DIRTY`，必须显式 `force`）；git 命令走 `sandbox.guardedSpawn`、
  60s 超时、`GIT_TERMINAL_PROMPT=0`（绝不因为等凭据输入而挂住）。
- 子代理隔离：`delegate_task(isolation:'worktree')` → 子代理的 `projectRoot` 真的切到工作树，
  结果给出路径/分支/改动清单并写明「这些改动**不在**主工作树里」+ 合并/丢弃方式（**不自动合并**）；
  **建不出来就中止任务**，绝不静默降级成共享工作树。
- 判据：`test:worktree`（22 条，真临时 git 仓库，终端判据是磁盘状态：worktree 里改文件后主工作树的
  README 逐字节不变）+ `test:subagent-worktree`（21 条）。

## 11. 计划卡（§5 #2 的 UI 可见性）

- 主进程：计划一变就发 `kind:'plan'` 增量（与进度提示注入**解耦** —— `progressEvery=0` 时界面照样看得到）。
- 前端：`sessionStore` 存 run 级计划字段（不塞进气泡，否则压缩/续跑时会跟着折叠或错位）；
  `PlanCard` 渲染状态色阶、进度条、完成态、无障碍标注；没有计划时返回 `null`（不留空壳）。
- 判据：`test:agent-plan` 的 E 段 + `test:plan-ui`（显示环境，22 条：DOM、样式生效、色阶变化、脏输入容错、reset 清空）。

## 12. 仍未做（如实列出，逐条给出理由）

| 项 | 为什么没做 |
|---|---|
| **`PreToolUse`（拦截型钩子）** | 要先定义「钩子拒绝时算谁的错、怎么回灌、能不能改参数」（Claude Code 用 exit code 2 + stdout 表达）；不猜语义，本轮只做 `PostToolUse` / `SessionStart` / `Stop`。 |
| **Windows 内核级隔离（受限令牌 / AppContainer）** | 仍无可行方案；边界依旧是「静态审计 + 确认 + 受保护路径 + 工作树隔离」（见 §2 与前一份文档）。 |
| **MCP 订阅/通知流（server→client 推送）** | 当前按「请求-应答」处理，通知帧只忽略；要做真推送需要长连与事件分发，属独立一轮。 |

> 原先 §7 列的 4 项（MCP 会话复用 + `tools/list`、MCP HTTP、`web_search`、worktree、计划卡）**已全部落地**，
> 分别见 §7–§11。
