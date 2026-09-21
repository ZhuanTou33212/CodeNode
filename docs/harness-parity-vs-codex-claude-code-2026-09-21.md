# CodeNode harness 与 Codex CLI / Claude Code 的逐轴对照

> 日期：2026-09-21 ｜ 被我方基线：`yimi-branch` @ `6f4521f`（工作区干净，`npm test` 79/79 全绿，321.8s）
> 对照基线：本机 `codex-cli 0.135.0` 与 `Claude Code 2.1.153`
> 结论口径：**本文只写可复跑的取证结果**，不写印象。第 6 节列明哪些结论证据不足。

## 0. 一句话结论

CodeNode 在**可靠性、可观测性、评测**三层已经超过两家公开水位（真机评测挂 PR、统一事件流与回放、审批令牌、
超窗三道闸门都是两家没有的）；真正落后的是**两个面**：

1. **控制面 / 扩展面的缺失** —— 没有 todo/规划工具、没有 plan 模式、没有 hooks、没有命令与技能的按需加载、
   没有用户级记忆与可持久化的审批规则。CodeNode 目前更像一个「跑得稳的执行器」，而不是「用户可驯服的 coding agent」。
2. **主力平台（Windows）上安全边界是"声明式"而非"强制式"** —— 内核隔离只在 Linux/macOS 存在；Windows 上的
   边界是工具层路径校验 + 静态审计 + 一次确认，且默认口径下只拦**显式写路径**。这是唯一可能造成数据损失的口子。

## 1. 取证方法与基线（全部可复跑）

| 对象 | 取值 | 怎么复跑 |
|---|---|---|
| 我方代码基线 | `yimi-branch` @ `6f4521f`，工作区干净（唯一未跟踪文件是根目录任务单 `deepseek-agent-issues.md`） | `git log --oneline -1`、`git status -s` |
| 我方门禁 | **79 核心 + 5 显示**，`npm test` = 79/79 PASS，321.8s | `node scripts/run-all-tests.cjs --list`、`npm test` |
| 我方 CI | `CodeNode CI` 与 `production-gate` 两 workflow 在 `6f4521f` 上均 success | `gh run list --branch yimi-branch --limit 6` |
| Codex | `codex-cli 0.135.0`，二进制 `…/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`（242,541,872 B） | `codex --version` |
| Codex 配置面 | `~/.codex/config.toml`：`sandbox_mode="workspace-write"`、`[windows] sandbox="elevated"`、`approval_policy="on-request"`、`model_auto_compact_token_limit=900000`、`notify=[…,"turn-ended"]`、`[projects.'e:\codenode'] trust_level="trusted"` | `cat ~/.codex/config.toml` |
| Claude Code | `2.1.153`，二进制 `~/.local/bin/claude`（235,564,192 B） | `claude --version` |
| Claude Code 状态面 | `~/.claude/{todos/,plugins/marketplaces,ide/,sessions/,backups/}`、`settings.json` | `ls ~/.claude` |

**上游能力的取证方式**：对二进制做特征标识符统计 ——

```bash
grep -aoE '<备选串>' <bin> | sort | uniq -c | sort -rn
```

命中的含义是「该能力标识符在该版本二进制里出现过」，属**能力存在性**证据，不等于行为等价（见第 6 节）。
结果（本机实测）：

```
codex-cli 0.135.0 : apply_patch 92 · web_search 42 · AGENTS.md 38 · streamable_http 27 · update_plan 26 ·
                    unified_exec 25 · shell_command 15 · view_image 11 · sandbox_mode 11 ·
                    approval_policy 11 · danger-full-access 9 · codex exec 7 · codex resume 6
Claude Code 2.1.153: PostToolUse 154 · bypassPermissions 137 · WebFetch 105 · PreToolUse 103 · acceptEdits 94 ·
                    SessionStart 84 · UserPromptSubmit 48 · WebSearch 42 · SlashCommand 39 · AskUserQuestion 34 ·
                    TaskCreate 32 · ExitPlanMode 27 · EnterWorktree 25 · SkillTool 16 · NotebookEdit 15 ·
                    BashOutput 14 · EnterPlanMode 14 · TodoWrite 12 · KillShell 8
```

**我方能力的取证方式**：`grep -rn` 落点 + 两个探针（`out/probe-fixed-overhead.cjs` 只读量测固定开销；
`npm test` 里 79 个核心套件）。文中每条 `file:line` 均可直接复核。

## 2. 逐轴对照表

图例：✅ 有且完整 ｜ ⚠️ 有但形态不同 / 弱 ｜ ❌ 无

| 能力轴 | CodeNode（落点） | Codex CLI 0.135 | Claude Code 2.1.153 |
|---|---|---|---|
| 工具循环 / 多轮调用 | ✅ `electron/agent.cjs` `runAgentChat`；上限可配（`agent.max_tool_iterations` / `max_total_tool_calls`） | ✅ | ✅ |
| 上下文自动压缩 | ✅ 照 Codex 实现：阈值 = 窗口 × 0.9、逐字提示词、真机估算 331 vs 供应商 `prompt_tokens` 326（偏差 1.5%）；`electron/compaction.cjs` | ✅ `compact` | ✅ auto-compact + `/compact` |
| 硬裁剪 / 超窗自救 | ✅ 三层：`contextBudget.cjs` 占位符硬裁剪 + 预检拒发 + 供应商 400 → 降级窗口→压缩→重发一次（`context-overflow-guard-2026-09-17.md`） | 部分 | 部分 |
| 任务清单 / 规划工具 | ❌ 无。`update_plan`/`TodoWrite` 全仓 **0 命中**；只有机器注入的进度条 `agent.cjs:875 buildProgressNote`（轮次/调用数/改动文件 + "复述目标·已完成·下一步"三问） | ✅ `update_plan` | ✅ `TodoWrite` + `TaskCreate`，任务落盘 `~/.claude/todos/` |
| Plan 模式（先只读调研再落地） | ❌ 无 `planMode` 相关实现 | 用 `approval_policy` 表达 | ✅ `EnterPlanMode`/`ExitPlanMode` |
| 审批 / 人在回路 | ✅ 服务端签发令牌、单次有效、校验前剥离模型自填字段（`electron/tools/approval.cjs`） | ✅ `approval_policy="on-request"` | ✅ 三种 permission mode |
| 审批规则持久化 / 项目信任 | ❌ 令牌**仅内存、重启失效**（`approval.cjs:61`）；全仓 `alwaysAllow`/`记住选择`/`不再询问` 0 命中 | ✅ `[projects.*] trust_level` | ✅ allow/deny 规则（用户级 + 项目级 settings） |
| 权限模式可切换 | ⚠️ 只有布尔开关 `tools.confirm_writes`（默认 true） | ✅ on-request / 其他档 | ✅ default / `acceptEdits` / `bypassPermissions` |
| 沙箱：进程/资源 | ✅ Windows Job Object（lifetime/process/memory/cpu，`electron/sandbox.cjs:159`） | ✅ `[windows] sandbox="elevated"` | ✅ |
| 沙箱：文件系统 | ❌ Windows 无（`sandbox.cjs:151,159` `filesystem:false`）；✅ Linux bwrap / macOS sandbox-exec 有 | ✅ `workspace-write` | ✅ sandbox 运行时 |
| 沙箱：网络 | ❌ Windows 无；`sandbox.network` 默认 `inherit`（`agent.cjs:345`） | ✅ 沙箱内可断网 | ✅ |
| shell 越界写防护 | ⚠️ 静态审计：显式路径越界 → 硬拒 `PATH_OUT_OF_ROOT`；**写目标含变量/通配只在 `sandbox.mode=strict` 才拒**（`impl/executeShellTool.cjs:361-375`），默认 `best-effort` | 内核强制 | 内核/运行时强制 |
| shell 命令面 | ⚠️ 白名单含 `cmd/powershell/node/python/npm/npx`（≈任意代码），`SENSITIVE_PROGRAMS` 让它们一律需 HIGH 确认（`executeShellTool.cjs:13-41`） | 沙箱 + 审批 | 沙箱 + 审批 |
| 后台任务 | ✅ `execute_shell async` + `poll_job` | ✅ `unified_exec` | ✅ `BashOutput`/`KillShell` |
| 钩子 / 扩展点 | ❌ 无（`grep -i hook` 只命中 `alertWebhook` 与 React hooks） | `notify=[…,"turn-ended"]` | ✅ `PreToolUse`/`PostToolUse`/`SessionStart`/`UserPromptSubmit` |
| 斜杠命令 | ⚠️ 唯一硬编码 `/compact`（`src/store/chatStore.ts:191`），无命令体系 | 自定义 prompts | ✅ `SlashCommand`（`.claude/commands/*.md`） |
| 技能加载方式 | ⚠️ **静态注入**：`ipc/agent.cjs:453-457` 读 `extensions.json` kind=skills，拼进 system prompt | AGENTS.md | ✅ `SkillTool`（模型按需读 SKILL.md，渐进披露） |
| 项目指令文件 | ⚠️ 有等价物但不是生态约定：`config/soul.md` + `.codenode/memory.json`；**无 AGENTS.md/CLAUDE.md 兼容、无目录层级继承** | ✅ AGENTS.md | ✅ CLAUDE.md（用户级→项目级→子目录） |
| 记忆：项目级 | ✅ `.codenode/memory.json`，按提问打分检索（key×6/tags×4/content×2） | — | ✅ |
| 记忆：跨项目用户级 | ❌ 无（`grep userMemory\|user-memory` 0 命中） | 有全局态 | ✅ |
| 子代理 | ✅ `delegate_task(s)` 5 角色 + 独立预算 + JSON 信封 + 任务视图落盘（`test:subagent-isolation`/`subagent-view`） | ❌ 无 | ✅ `Task` + `.claude/agents/*.md` 自定义 |
| 子代理角色可扩展 | ❌ 写死 5 个（`electron/tools/roles.cjs`：explorer/builder/verifier/reviewer/canvas），无磁盘定义 | — | ✅ 磁盘定义 |
| worktree / 并行隔离 | ❌ 无（`grep worktree` 只命中 skip-worktree 注释） | ❌ | ✅ `EnterWorktree` |
| 读后写约束 | ❌ 未强制（有 `expectedSha256` 乐观并发，是加分项） | apply_patch 全量替换语义 | ✅ Edit 前必须 Read |
| 代码搜索实现 | ⚠️ 自研 JS 正则扫描（`electron/tools/fsCore.cjs:380`，跑在 worker、可取消、跳过 `node_modules/.git/dist/out` 等），非 ripgrep | 自有 | ✅ ripgrep（Grep/Glob） |
| 联网检索 | ⚠️ 只有 `fetch_url`（读单页），**无 web_search** | ✅ `web_search` | ✅ `WebSearch` + `WebFetch` |
| 让模型"看图" | ❌ 用户可发图（`electron/attachments.cjs` 多模态 + 4MB/张、6 张/条校验），但模型**不能主动读磁盘图片/截图** | ✅ `view_image` | 支持图片输入 |
| MCP | ⚠️ **仅 stdio，每次调用 spawn**（`electron/tools/extensions.cjs:127`）；无 `tools/list`/resources/prompts、无 HTTP/SSE、无 OAuth | ✅ `streamable_http` | ✅ 多 transport + OAuth |
| 非交互 / 脚本化入口 | ❌ `package.json` 无 `bin`、`main=electron/main.cjs` —— 没有 `codex exec` / `claude -p` 式入口（评测脚本是直接 require harness，属测试基建） | ✅ `codex exec` / `codex resume` | ✅ `claude -p` / `--resume` |
| 运行中控制（插话） | ✅ Run 级插话 `steerQueue.cjs` + `agent:steer` | ❌ | 部分 |
| 文件改动回滚 | ✅ Run 级回滚 `runRollback.cjs`（写前像按路径存） | 部分（git 兜底） | ✅ `/rewind` 检查点 |
| 崩溃恢复 / 续跑 | ✅ `runStore` + `recoverInterrupted` + 幂等账本 + 检查点（`test:resume`） | ✅ `codex resume` | ✅ `--resume` |
| 每轮固定开销 | ⚠️ **≈7,881 tokens/轮**（详见第 4 节） | 工具面仅 ~6 个 | 工具多，但技能/命令按需加载 |
| 评测 / 门禁 | ✅ 79 核心 + 5 显示门禁、变异校验、**真机子集挂 PR**（`--subset=pr`，判据只看世界状态 + `eval-limits.cjs` 护栏） | 不公开 | 不公开 |

## 3. CodeNode 明确领先的三条（对照时要一起说）

1. **真机评测挂到 PR 门禁**：`scripts/agent-eval.cjs --subset=pr` 只跑 3 个「判据只看世界状态」的任务
   （文件字节 / 工具返回 / Run 事件 / 退出码 / 供应商 usage），CI 侧 `model-eval-pr` job 在 `has_key == 'true'` 时执行，
   无凭据时 fail-closed；`scripts/lib/eval-limits.cjs` 只许放宽白名单内的 `steps-at-most` 且幅度 ≤2×。
   两家 CLI 都没有公开可复跑的评测门禁。
2. **统一事件流 + 回放**：`.codenode/events.jsonl` 七条链路双写（tool / run_state / checkpoint / side_effect /
   cost / alert / audit + approval），CLI `scripts/event-replay.cjs` 与界面 `RunReplayPanel` 共用同一份数据。
3. **审批令牌不可伪造**：服务端签发、绑定 `capability`/`scope`/`toolCallId`/`attemptId`、单次有效，
   且注册表在**参数校验之前**剥离模型自填的 `confirmed`/`approved`/`approvalToken`。
   对照：ToolUse 类 harness 常见的「模型自己批准自己」在这里被结构性堵死。

另外两条值得记的加分项：`expectedSha256` 乐观并发写（写前校验哈希，`CONFLICT_STALE` 失败不落盘）、
多模态输入校验（`electron/attachments.cjs`）。

## 4. 每轮固定开销（实测，探针 `out/probe-fixed-overhead.cjs`）

```
已注册工具: 24 个
  get_workbench_model, workbench_edit, scan_project, read_file, write_file, edit_file, find_files,
  search_files, list_directory, execute_shell, poll_job, code_review, ask_user, fetch_url, save_project,
  bulk_edit, analyze_project, ui_control, write_analysis_md, project_info, retrieve_context,
  query_scalars, remember, recall
system prompt 骨架（无画布规则）: 3,172 字符 ≈ 1,592 tokens
system prompt（含画布规则）   : 4,601 字符 ≈ 2,317 tokens
24 个工具 schema              : 15,911 字符 ≈ 5,564 tokens
合计（含画布规则口径）        : 20,512 字符 ≈ 7,881 tokens / 轮
最大单个 schema: workbench_edit 2,870 字符（次: retrieve_context 1,369 / ui_control 973）
```

> 口径更正：旧记录里的「22 个工具 / ≈7,415 tokens」已过期 —— `BUILTINS` 是 22 个**模块**，
> `memoryTool` 注册 `remember`+`recall` 两个工具，另有 `poll_job`，注册表实测 24 个。
> 该探针原本记在 `scripts/probe-fixed-overhead.cjs`，现仓库内无此文件，需要在 `out/`（gitignore）重建。

对照：Codex 的工具面只有 `apply_patch` / `shell_command` / `unified_exec` / `update_plan` / `view_image` / `web_search`
这 6 类，固定开销天然更小。把 24 个工具**全部常驻**下发，等于每轮都付一次「画布 + RAG + 标量 + 记忆」全套税。

## 5. 缺口的级别与最小修法

| # | 级别 | 缺口 | 最小修法 |
|---|---|---|---|
| 1 | **P0** | ~~Windows 上无强制隔离；默认 `sandbox.mode=best-effort` + `network=inherit`，静态审计只拦**显式**越界写（变量/通配要 `strict` 才拦）~~ **已落地 2026-09-21**：出厂 `network=deny` + 未解析写目标任何模式都要确认（`strict` 仍硬拒）；仍无 Windows 内核级隔离 | ① 出厂 `sandbox.network=deny`（或至少对 `curl/wget/ssh/npm install` 类默认需审批）；② `ALLOWED` 收窄成"项目声明的命令清单"，`node -e`/`python -c`/`powershell -c` 一律降级为裸执行需审批；③ 长期：winjob 补受限令牌 / AppContainer |
| 2 | **P1** | ~~模型没有任务清单，长任务靠 12 轮上限 + 收尾兜底~~ **已落地 2026-09-21**：新增 `update_plan`（落 run 事件 + run 级文件 + 搭进度提示回灌） | 加 `update_plan` 形态的 todo 工具（`buildProgressNote` 的注入点直接升级成"计划 + 进度"，同一处替换逻辑已在 `agent.cjs:2289`） |
| 3 | ~~P1~~ | ~~无 hooks~~ **已落地 2026-09-21**（`electron/hooks.cjs`，含 PostToolUse / SessionStart / Stop + 三个上限；`PreToolUse` 仍未做） |
| 4 | ~~P1~~ | ~~技能静态注入~~ **已落地 2026-09-21**（`read_skill` + `agent.buildSkillsIndex`；工具面按任务裁剪**有意不做**——见 S20 的设计取舍记录） |
| 5 | **P2** | MCP 仅 stdio、每次 spawn、无 `tools/list` | 加 streamable HTTP transport + 启动时 `tools/list` 缓存 + 会话复用 |
| 6 | ~~P2~~ | ~~无持久审批规则~~ **已落地 2026-09-21**（`.codenode/approvals.json` + 界面「本项目始终允许」+ 受保护路径；只记忆注册表级审批） |
| 7 | **P2** | **部分落地 2026-09-21**：用户级跨项目记忆 / `view_image` / headless 入口（`bin/codenode-agent.cjs`）已做；**仍未做**：`web_search`（需要搜索后端决策）、worktree 隔离（要设计工作树合并语义） |

## 6. 本文的边界（证据不足或未验证）

- **二进制特征串 ≠ 行为**：第 2 节上游一列证明的是「该版本里存在这些能力标识符」，本文**没有**实测两家 CLI 的
  沙箱在 Windows 上的实际拦截效果，也没有对比两家的提示词质量与压缩保真度。
- **版本敏感**：Codex / Claude Code 迭代很快，本文结论绑定 0.135.0 与 2.1.153；换版本要重新取证。
- **未做的探针**：没有用真机模型跑「缺 todo 工具时长任务偏离程度」的量化对比（需要真 key 与两轮真机评测），
  所以第 5 节第 2 项是**结构性推断**（有落点、无实测数字），不是实测结论。
- **CodeNode 侧的 24 个工具、7,881 tokens/轮是实测**（探针 + `registry.toOpenAiTools()`），可复跑。

## 7. 建议的处理顺序

**落地记录**：`docs/agent-boundary-and-plan-2026-09-21.md`（#1 + #2）+ `docs/agent-control-plane-2026-09-21.md`（#3 / #4 / #6 + #7 的三项；MCP / web_search / worktree / 计划卡仍未做，理由见该文末节）。

1. 第 5 节 #1（安全边界收口）—— 唯一会"丢数据"的口子，且改动集中在 `sandbox.cjs` / `executeShellTool.cjs` / 出厂 properties。
2. #2（todo/plan 工具）—— 成本最低、对长任务可控性收益最大。
3. #3（hooks）—— 一处扩展点换来自动 lint/测试、审计与用户脚本化。
4. #4（固定开销分层）—— 直接省钱、省上下文。
5. #5–#7 顺次补。
