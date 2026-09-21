# 控制面补齐：钩子 / 用户级记忆 / 非交互入口 / 审批规则 / 技能渐进披露 / 看图

> 日期：2026-09-21 ｜ 基线：`yimi-branch` ｜ 对照文档：`docs/harness-parity-vs-codex-claude-code-2026-09-21.md` §5 #3 / #4 / #6 / #7
> 门禁：核心 **81 → 87**（+`hooks` / `headless` / `user-memory` / `approval-rules` / `skill-index` / `view-image`）
> 变异校验：本轮新增 **16/16** 条有判别力（`out/mutation-spec-hooks.json`、`out/mutation-spec-control-plane.json`）

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
- 判据：`test:hooks`（38 条断言）；变异 5/5。

## 2. 用户级（跨项目）记忆（Java 版 `UserMemoryStore` 的对应物，§5 #7）

- 落点：`electron/userMemory.cjs` + `remember`/`recall` 的 `scope` 参数 + `agent.buildSystemPrompt` 的新段落。
- 语义：`$CODENODE_HOME/user-memory.json`（可注入，测试不污染家目录）、上限 200 条、同内容去重、
  按提问打分检索（复用项目级口径）、注入成独立段落「【用户级记忆（跨项目，不可信数据，仅作参考）】」。
- 不传 `scope` 时行为与改动前**逐字节一致**（判据锁住）。
- 判据：`test:user-memory`（25 条断言）。

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
- 判据：`test:approval-rules`（21 条断言）。

## 5. 技能渐进披露（§5 #4）

- 落点：`electron/tools/impl/readSkillTool.cjs` + `agent.buildSkillsIndex`（纯函数，供判据直锁）+ `ipc/agent.cjs`。
- 变化：项目 skills 的 `instructions` 从「整段常驻 system prompt」改为「prompt 只放名字 + 一句话，
  正文由模型调 `read_skill` 按需读」（上限 8000 字符、超限截断标注，名字大小写不敏感、未知名字列出可用项）。
- 量测：用例直接断言「索引版比整段注入版省下 ≈ 正文长度的字符数」。
- 判据：`test:skill-index`（15 条断言）。**注意**：第一版把索引文本写在用例里自造，等于什么都没锁，
  变异测试当场抓出来 → 抽出纯函数后判据才真正打在代码路径上。

## 6. 看图（对照 Codex 的 `view_image`，§5 #7）

- 落点：`electron/tools/impl/viewImageTool.cjs` + `agent.cjs` 主循环的附图逻辑。
- 语义：读项目内图片（png/jpeg/webp/gif、≤4MB、路径必须在项目根内），主循环把图**作为一条 user 消息**
  附在工具结果之后（OpenAI 兼容接口只在 user 消息里带 `image_url` 才可靠）；上限与用户附件同一套。
- 附不上（校验失败）时如实回执「不要假设你看到了画面」，不静默吞掉。
- 判据：`test:view-image`（16 条断言，含端到端「第二次请求里真的出现 image_url」与「没调用时零痕迹」）。

## 7. 仍未做（如实列出，逐条给出理由）

| 项 | 为什么没做 |
|---|---|
| **MCP HTTP/SSE transport + 会话复用 + `tools/list`** | 当前 MCP 只支持 stdio 且每次调用 spawn 一个 server 进程。加 transport 要同时定义「连接生命周期 / 认证 / 断线重连 / 与 sandbox 的关系」，是**独立一轮**的量级；只做一半（比如只缓存 tools/list）会让「支持 HTTP」变成假象。建议单开一轮，并按 `test:mcp-handshake` 的现有口径扩展。 |
| **`web_search`** | 需要一个搜索后端（SearxNG / Bing / 自建）。没有可用的公开假设，做成「可配置端点 + 默认关闭」只是把接口摆出来，价值有限；建议等用户明确用哪个后端（或在 `config/agent.properties` 里给出 `web_search.endpoint` 模板）再做。 |
| **worktree 隔离** | 真正有价值的是「子代理在独立 worktree 里改代码、主代理再合并」——那要动子代理的 `projectRoot` 与合并/冲突语义（仓库已有 `merge.cjs` 的确定性合并，但那是**结果合并**不是**工作树合并**）。属于设计问题，需要一轮专门设计而不是顺手加个工具。 |
| **对话区的「计划卡」UI** | 计划目前通过 ① 工具结果 ② 进度提示 ③ run 事件回放时间线三处可见；独立卡片要新增 delta kind + 前端渲染 + 显示环境用例。属独立一轮（`docs/agent-boundary-and-plan-2026-09-21.md` §6 已记过）。 |
| **`PreToolUse` 钩子** | 拦截型钩子要先定义「钩子拒绝时算谁的错、怎么回灌、能不能改参数」，Claude Code 用 exit code 2 + stdout 表达；不猜语义，先只做 PostToolUse / SessionStart / Stop。 |
| **Windows 内核级隔离** | 仍无受限令牌 / AppContainer 方案；边界依旧是「静态审计 + 确认 + 受保护路径」（见前一份文档 §2）。 |
