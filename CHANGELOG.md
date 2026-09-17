# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号见 `package.json`（唯一来源）。

## [未发布]

### 新增（子代理角色档案 + 内置技能库 + 自包含 prompt；2026-09-17）

- 子代理的 system 此前只有「你是 CodeNode 的子代理」+ 一句角色提示 + 任务信息 —— 一句抽象职责是**身份**
  不是**技能**：模型拿到「你负责实施最小必要修改」后，仍不知道这类活先看什么、按什么顺序、什么算完成。
  现在 `electron/tools/roles.cjs` 的每个角色是 8 字段档案（身份名 / 负责的工作类型 / 明确不归它管 /
  内置技能 id / 工作方式），`electron/tools/roleSkills.cjs` 提供 15 个内置技能（技能 = 若干条可执行规程，
  5 个角色各挂 3 个），`electron/subagentPrompt.cjs` 把子代理 system 组装成七分区自包含 prompt。
- 其中**可用工具清单取自子代理的真实注册表**（不是手写名单）—— 角色的权限裁剪一变，说明同步变，不可能漂移；
  项目自定义 Skill 也首次对子代理可见（沿用主代理「不可信数据，仅作参考」的标注）；未知技能 id 显式报出，
  配置笔误不再被静默吞掉。
- `delegate_task` / `delegate_tasks` 的描述补上「派活对照表」（角色 + 身份名 + 工作类型），否则主代理会拿
  explorer 去改代码、拿 verifier 去写文件。
- 用例 `scripts/subagent-role-skill-test.cjs`（进 CORE）锁四件事：prompt 里的工具清单 == 该角色真实注册表
  工具集；越权调用被注册表拒绝（不依赖 prompt 自觉）；描述里有身份与工作类型；没有项目 Skill 时不出现空分区。

### 安全（execute_shell 越界写/网络约束，测试模式不再放行破坏性确认；2026-09-16）

- **越界写没有内核兜底**：`execute_shell` 的白名单含 `cmd` / `powershell` / `node` / `npm` / `npx`，而 Windows
  后端（windows-job）**不隔离文件系统**（`writeRoots` 只对 Linux bwrap / macOS sandbox-exec 生效）——
  `cmd /c echo X > <项目外路径>` 与 `node -e "writeFileSync(<项目外>)"` 实测都能写成功。唯一兜底是用户点确认，
  而确认文案只说「执行命令」，用户无法从中看出它会越界写盘。
  新增 `electron/tools/shellGuard.cjs`：命令文本级静态审计（重定向 / 写选项 / 写动词 / 脚本 API 字面量 /
  引号内子命令），越界写**在能力层直接拒绝**（`PATH_OUT_OF_ROOT`，不靠用户点确认）；写目标含变量时
  strict 模式拒绝、其余模式写进确认文案；只读引用项目外路径不受影响（不误伤）。
- **网络约束从「只有 fetch_url 过门」扩到 shell**：`sandbox.network=deny` 时，疑似联网的命令（URL /
  `git push|clone|fetch|pull` / `npm install` / `npx` / PowerShell 下载型 cmdlet / 脚本网络调用）直接拒绝，
  不试连。
- **`CODENODE_TEST` 的后门面收窄**：`bridge.confirm` 曾在该环境下无条件返回 `true` —— 确认通道是审批令牌的
  唯一来源，HIGH 级（删除 / 强推 / 清理这类不可撤销操作）被静默放行等于把「测试环境」变成后门。现在只自动
  批准可回滚的写入，**HIGH 默认拒绝**（需显式 `CODENODE_TEST_ALLOW_HIGH=1`），并提示一次。用例同时锁住
  「测试模式下越界写 / 只读上下文 / network=deny 三门照旧拒绝」，以及「仓库与 CI 里没有任何地方赋值
  `process.env.CODENODE_TEST`」。

### 新增（统一运行事件流 + 按 run 回放 CLI；2026-09-16）

- 事件此前散在五套并行文件里，其中 `tools_trace.jsonl` 每条只有 `{ts, iter, name…}`，**没有
  runId / turnId / toolCallId / attemptId** —— 多轮、多 run、父子代理的记录混在一条流里，「按 run 回放这一轮
  到底发生了什么」做不到。
  `electron/eventBus.cjs` 定义统一形状 `{v, ts, kind, runId, turnId, toolCallId, attemptId, …payload}` 并写入
  `.codenode/events.jsonl`（复用 runStore 的原子替换 / 坏行容忍 / 字节上限）；`logToolTrace` 双写，旧文件保留
  一个版本周期的兼容读取；主循环所有事件（tool / round_end / turn_end / compression / failure_taxonomy /
  truncation_nudge / scheduler / grounding_retry）都带上身份。
  `scripts/event-replay.cjs` 支持 `--run / --kinds / --limit / --json`，有事件退出码 0、无匹配退出码 1（可直接
  用于门禁）。

### 修复（PDF 文本提取对超大内容流爆栈 → 大 PDF 被误报「扫描版」；2026-09-16）

- **缺陷**：`extractPdfText`（`impl/pdfText.cjs`）用**一条巨型正则**反复 `exec` 内容流。内容流
  >~8MB 原始文本时 `RegExp.exec` 抛 `RangeError: Maximum call stack size exceeded`，异常被最外层
  `catch` 吞掉 → 整份 PDF 返回 null → `read_file` 把一份**完全可解析**的大 PDF 报成
  「扫描版或文字层不可用」，把用户往「换文件 / 上 OCR」的错误方向引。实测边界：5.15MB / 6.44MB 正常，
  8.58MB 起必现。
- **修法**：`extractContent` 从「巨型正则 + 反复 exec」改为**单次字符扫描**（O(n)、无回溯，无规模上限）——
  `Tm`/`Td`/`TD`/`T*`/`BT`/`ET`/`<hex>Tj`/`(lit)Tj`/`[...]TJ`/`(lit)'`/`(lit)"` 逐一手写分派；
  字面量读取改为「扫一遍定边界 + 一次 `slice`」；`isOpChar` 从每字符一次正则调用改为 charCode 判断
  （这两步让 5MB 内容流从 412ms → 104ms，比旧实现还快）。
- **等价性怎么保证**：写了新旧实现对拍脚本（14 例覆盖各操作符 + null 语义），一次就抓出扫描器最初
  漏掉的 `'` 操作符前导换行（旧实现是 `out += '\n' + unescapeLit(...)`）。修完 **14/14 逐字节一致**。
- **一处有意改进**（非等价重构，已在用例里注明）：真嵌套括号 `(outer(inner)…` —— 旧正则不处理嵌套、
  对这种输入整体返回 null；新扫描器按深度解析正确提取。
- **证据**：新增 `scripts/pdf-text-test.cjs`（18 条 + 1 条嵌套 = 19 条，进 CORE 门禁）锁各操作符的
  golden 输出与 `null` 语义，并断言大内容流 **8.58MB / 17.17MB 能提取且可打印字符数与理论值精确吻合**
  （7200000 / 14400000，不是「看起来有文本」就算）；`scripts/fs-worker-test.cjs` 的慢 PDF fixture
  提到 8.58MB（正是旧实现爆栈的规模，一并成为回归锁）。变异 3/3 有判别力：把 `printable < 30` 改大 →
  G17 红；去掉嵌套深度累计 → G12b 红；不跳过转义序列 → G11b 红（第 3 条最初的 fixture 因「转义括号深度
  抵消」抓不到变异，已换成「转义反斜杠紧跟真括号」）。

### 变更（read_file 的 PDF 分支搬进 worker；文本分支**刻意不搬**；2026-09-16）

- **先量测再动手**（本轮的关键）：worker 线程固定开销 —— 冷启动 + 一次往返 **35ms**、连续任务每次 **23.6ms**；
  主线程同步读 **2MB 文本 1.3ms**、读 **20MB 6.6ms**。所以「把单文件读统一搬 worker」是**负收益**（开销是
  2MB 读取的 18 倍），`read_file` 文本分支、`edit_file`（单文件读 + 已是原子写）、`code_review`
  （单文件读 + 轻量正则分析，还支持内联 `code`）**都不搬**，并在代码注释里写明理由，免得后人为了「统一」搬走。
- **真正值得搬的是 CPU 重活**：`read_file` 的 PDF 分支 —— 读（≤20MB）之后要跑自研解析
  （`extractPdfText`：zlib inflate + CMap 解析 + 文本重建）。实测一个 60MB 文本流**光 inflate 就 82ms**，
  真实 PDF 在 100–300ms 量级 —— 远超 worker 开销，且这段时间主线程被冻住、不可中断。
- **修法**：`fsCore` 新增任务 `readPdfText`（任务面 5 → 6）；`read_file` 的 PDF 分支改走 `fsRunner`
  （可 terminate、主线程不再被冻住、降级时 audit + 留痕）；`impl/pdfText.cjs` 加入 `build.asarUnpack`
  —— `fsCore` 现在 require 它，而 worker 只能 require **同样被 unpack** 的兄弟文件（漏配只有打包版炸）。
- **任务结果契约显式化**：每个任务的返回值都必须带 `cancelled`，runner 的同步/降级分支靠它把「半份结果」
  提升成 `outcome.cancelled`。新任务一开始漏了该字段，被 `check:js` 当场拦下 —— 现已补齐并写成注释契约。
- **证据**：`scripts/fs-worker-test.cjs` 新增 I 段 7 条 —— 走 worker 的文本层提取、`扫描版不可用` /
  `PDF 过大（>20MB）` 两种既有文案**逐字未变**、任务层 worker 与同步结果逐字节一致、
  **解析期间主线程心跳 ticks=12~14**（同步实现下必为 0）、慢 PDF 仍解析成功、取消返回 `CANCELLED`。
  变异 2/2 有判别力：强制走同步 → `A1`×5 + `I5` 全红；把 20MB 阈值改错 → `I3` 红（且落到错误的提示分支）。
- **顺带发现（未修，如实记录）**：`extractPdfText` 对**超大文本流**（实测 >~8MB 原始文本）会返回 null，
  于是一个可解析的大 PDF 会被报成「扫描版或文字层不可用」—— 这是它既有的规模限制，不是本轮搬动引入的，
  不在本次范围内。

### 变更（project_info / analyze_project 也搬进 worker，并修掉语言统计的 `undefined` bug；2026-09-16）

- **问题①（同类重活）**：`detectProjectInfo` 与 `scan_project` 干的是同一件事 —— 扫全项目、每个源文件读一遍算行数。
  它仍留在主线程同步跑，于是 `project_info` / `analyze_project` 一样会冻住界面、一样不可中断。
- **问题②（顺手查出的老 bug）**：`project_info` / `analyze_project` 返回的 `languages` / `languageSummary`
  **一直是 `{"undefined": <文件数>}`**。成因：`detectProjectInfo` 把 `scan().files`（只有 `relPath`/`absPath`/`size`）
  传给了 `languageSummary`，后者读 `f.language` / `f.binary` 全是 `undefined`。已修，并用回归锁盯住。
- **修法**：
  - `fsCore` 新增 `buildProjectInfo`（**纯函数**，接收 scan 的完整结果、语言统计用 `sourceFiles`）、
    `readTextFileSafe`（原 `impl/shared.cjs` 的 `readTextFile`）、`summarizeFile`（原 `analyzeProjectTool` 的私有函数），
    以及任务 `detectProjectInfo` / `analyzeProject`（`FS_TASKS` 3 → 5）。
  - `project_info` / `analyze_project` 改走 `fsRunner`（可 terminate、不阻塞主线程、降级时 audit + `workerMode` 留痕）。
  - `projectScan.detectProjectInfo` 退化成同步 thin wrapper（`buildProjectInfo(root, scan(root))`），
    降级路径与其他既有调用点不受影响。
  - `analyze_project` 改为**一次扫描**产出全部结果 —— 旧实现是 `detectProjectInfo(root)` + `scan(root)` 各扫一遍
    （等于把全项目读两轮）再逐文件摘要。
- **证据**：`scripts/fs-worker-test.cjs` 新增 H 段 —— 语言统计回归锁（断言 `languages` 无 `undefined` 键且含
  `typescript`）、**遍历次数判据**（新实现 `once=5` vs 旧路径 `twice=10`，直接证明少扫一遍）、两个新任务
  worker 与同步结果逐字节一致、`terminate` 取消生效；`scripts/sync-tool-cancel-test.cjs` 新增 5 段
  （`project_info` 期间主线程心跳、`workerMode`、`analyze_project` 取消返回 `CANCELLED`）。
  变异 2/2 有判别力：把 `languageSummary(sourceFiles)` 改回 `files` → 立刻复现 `{"undefined": 6}` 且 H1/H3 红；
  关掉 `onAbort` → H7 红。
- **仍未做**：`read_file` / `edit_file` / `code_review` 仍是主线程同步读（单文件读取，通常远小于一次全项目扫描）。

### 变更（文件遍历工具搬到 worker 线程：真可中断 + 不阻塞主进程；2026-09-16）

- **问题**：`scan_project` / `find_files` / `search_files` 是同步 fs 遍历。上一轮只加了「循环之间的
  取消检查点」，但两件事没解决：① **单次同步 fs 调用不可打断**（读一个 2MB 文件算行数、`statSync`
  撞上挂住的网络盘）；② 整个遍历跑在 **Electron 主进程**里，扫一个 2 万文件的项目会把界面冻住。
- **修法**：
  - 新增 `electron/tools/fsCore.cjs`：遍历 / 扫描的**唯一实现来源**（纯 `fs`/`path`，零 Electron 依赖）。
    `toolFiles.cjs` / `impl/shared.cjs` / `projectScan.cjs` 改为从这里 re-export —— 对外 API 不变，
    5 个既有调用点零改动，也避免 worker 里再抄一份实现后必然漂移。
  - 新增 `electron/tools/fsWorker.cjs`（worker 入口）+ `electron/tools/fsRunner.cjs`（主线程：启动 /
    `terminate` / 降级 / 进度）；三个工具改走 `fsRunner.runFsTask`。
  - **取消 = `worker.terminate()`**：连同步 fs 调用中途也能杀掉；进度用 `postMessage` 回报，
    取消时如实给出 `partial`（此前只能等它自己跑完）。
  - **降级必须显式留痕**：worker 起不来 / 崩了 → 主线程同步跑完（工具不能因为 worker 缺失就不可用），
    但必须写 audit + 结果里带 `workerMode: 'sync-fallback'` 与 `workerFallback`（原因）——
    不静默退回旧的阻塞行为，否则「已搬到 worker」就成了纸面结论。
  - **打包**：`build.asarUnpack` 加入这两个文件（`worker_threads` 需要真实文件系统上的入口；
    `app.asar` 路径会被重写到 `app.asar.unpacked`）。漏配只有**打包版**才炸、CI 看不出来，
    所以用例直接断言打包配置本身；并且**真跑了一次打包验证**：`electron-builder --dir` 产物里
    `app.asar.unpacked/electron/tools/{fsCore,fsWorker}.cjs` 都在，再用**打包后的 Electron**
    （`ELECTRON_RUN_AS_NODE=1 <CodeNode.exe> <script>`，带 asar 支持）从 asar 里 require 并真实启动
    worker —— 扫了 46 个文件、链路全通（这台机器签名环节不可用，用 `-c.win.signAndEditExecutable=false`
    绕过，与本次改动无关）。
  - 配置 `tools.fs_worker`（默认 **true**）；关掉 = 退回主线程同步执行（排障 / 老平台兜底）。
- **证据**：`scripts/sync-tool-cancel-test.cjs` 判据升级为**真 AbortSignal + 主线程 `setTimeout` 触发**
  —— 同步实现下遍历会占满事件循环，那个定时器根本轮不到执行，所以「取消真的生效」自身就证明了
  主线程没被占住；另加**心跳判据**（扫描期间 `setInterval` 仍在跳，同步实现下必为 0），
  以及「不取消时结果完整」的反向保护。新增 `scripts/fs-worker-test.cjs`：worker 与同步实现的
  结果**逐字节一致**、取消不被误判成 worker 故障而降级重跑、降级在 audit 与 data 里留痕、
  asar 路径重写（含 `app.asar.unpacked` 不被二次替换）、打包配置断言、含函数 payload 的可克隆性。
- **边界（仍未做）**：`project_info` 工具内部的 `detectProjectInfo` 仍是同步执行，未搬进 worker。

### 变更（工具契约闭合与显式化、循环上限可配置、grounding 门、同步工具可取消；2026-09-16）

- **参数 schema 闭合**：`validateInput` 只校验**已声明**字段 → 模型把 `maxLines` 拼成 `maxLine` 会静默走默认值
  （判据消失而不报错，实测 0/24 声明 `additionalProperties`）。现在注册时统一补
  `additionalProperties: false`（22/22 闭合，模型侧下发的 schema 与校验侧一致），未声明的字段**当场被拒**并
  指出字段名。
- **契约显式化**：22 个工具里此前只有 1 个显式声明契约。`toolkit.declareSemantics()` 在构建注册表后把语义
  固化成显式声明（`source: 'explicit'`，字段值逐字不变）；`requiresConfirmation` 原样传递，补声明**不会**
  给写工具凭空加一道审批。
- **顺带修掉一个真 bug**：模型自填审批字段（`confirmed` / `approvalToken`…）的剥离此前只在
  `requiresConfirmation` 为真的工具上执行，且审计判定把 `trace` 冻结对象当函数调用（恒假）。schema 闭合后
  这些残留字段会变成「未知参数」把正常调用打回（实测 `write_file` 带 `confirmed=true` →
  `INVALID_TOOL_ARGUMENTS`）。现在**所有工具、校验前**一律剥离，审计走 `trace.note`。
- **循环上限可配置**：`MAX_TOOL_ITERATIONS` / `MAX_TOTAL_TOOL_CALLS` / `DATA_TRUNCATE_CAP` 此前是源码常量，
  项目无法调整。改为 `agent.max_tool_iterations` / `agent.max_total_tool_calls` / `agent.data_truncate_cap`，
  默认值与旧常量逐字一致（不配就完全等价）。同时修掉「截断只作用于 `[data]` 附加段」：`buildToolContent`
  现在对**正文本身**也按上限截断，并带明确的截断标记与续读指引。
- **来源校验门 `agent.grounding.mode`**：`warn`（默认，只上报 —— 行为与之前逐字一致）/ `enforce`（引用不可信
  不允许直接交付：先让模型订正 `agent.grounding.max_retries` 次，仍不达标则回 `groundingBlocked=true` +
  独立事件，且**不把校验提示拼进交付正文**）。
- **同步遍历工具可取消**：`scan_project` / `find_files` / `search_files` 在遍历循环里加了取消检查点，用户点
  「停止」能在中途真的停下并如实回报「结果不完整」（`kind=failure` / `code=CANCELLED`）。**边界**：单次同步 fs
  调用（一次 `readFileSync` 大文件）依旧不可打断 —— 真正的可中断需要把工具挪到 worker/子进程，那部分**仍未做**。

### 修复（流式参数累加器：裸标量分片把真实参数整段替换掉，2026-09-16）

- **现象（真实模型跑出来的，离线评测看不见）**：用 `deepseek-v4-flash` 真实跑一轮画布任务，12 轮里 **9 次工具调用
  被拒为 `MALFORMED ARGS`**（`read_file` / `workbench_edit` 都有），模型反复重试直到迭代上限，终态
  `LIMIT_REACHED`，`prompt_tokens` 花了 15 万。同一套 harness 的离线评测（脚本化传输）当时 11/11 全绿——
  因为脚本化的分片形态是「工整的」。
- **根因**：`electron/streamAccumulator.cjs` 的 `mergeArgs` 用 `isJsonComplete()` 判断「本分片自身已是完整参数，
  说明供应商在重发/累积下发，应当替换而不是拼接」。但 `JSON.parse('40')` **也是合法的**：真实 DeepSeek 流会把
  args 切得很碎（实测 24 帧拼一个 `read_file` 参数），其中 `"maxLines": ` 之后**单独来一帧 `40`** →
  累积值被整段替换成 `40`，下一帧拼上 `}` 得到 `40}`，`argsValid=false`，工具被拒。
  抓到的真实异常尾巴正好是 `40}` / `92}` / `100}` / `201}` / `400}`（数字型参数越多越容易中招，所以画布编辑
  ——带 x/y 坐标——几乎必挂）。
- **修法**：新增 `isCompositeJsonComplete()`（必须 `JSON.parse` 出对象/数组；工具参数只可能是对象/数组），
  两条替换分支（`cumulative-args-chunk` / `args-resend-detected`）改用它；`isJsonComplete` 保留原语义
  （仍用于 `argsValid` 与「空串 = 无参数」判定）。
- **证据（可复跑）**：抓真实 SSE 60 行落盘后按不同到达边界重放累加器——修复前四种切分（整段一次到达 /
  每字节一块 / 每行对半切 / 9:1 分两块）**全部**得到 `args="40}"`、`valid=false`、异常
  `cumulative-args-chunk`；修复后四种切分全部得到 `{"path": "electron/streamAccumulator.cjs", "maxLines": 40}`、
  `valid=true`、零异常。`scripts/stream-accumulator-test.cjs` 加 8 条断言（真实分片形态 + `true`/`null`/字符串
  标量 + 「完整对象重发仍要替换」反向保护 + 判据本身），变异测试回退替换分支 → **6 条当场红**
  （`40}` / `true}` / `null}` / `"x"}`），还原即绿。
- **端到端复验**：修复后同一 prompt 真实跑通——`read_file` → `get_workbench_model` → `workbench_edit` 全部
  ok，画布 11 → 12 节点、5 → 6 连线，回答 303 字符且带引用校验通过（grounding=true）。

### 修复（CI 门禁：可选依赖把 check:js 打成三平台全红，2026-09-16）

- `scripts/vector-store-semantic-probe.cjs` 用**字面量** `require('@zilliz/milvus2-sdk-node')` 拿 SDK 清理临时
  collection。该 SDK 是刻意**不写进 `package.json`** 的可选依赖（保持默认零依赖/体积不变，见
  `electron/vectorStore/milvus.cjs` 头部注释）——于是本机（手动装过 SDK）`npm run check:js` 绿，CI（`npm ci`
  后没有它）在 **Windows / macOS / Linux 三平台**全部 `error TS2307: Cannot find module
  '@zilliz/milvus2-sdk-node'`。门禁自 2026-09-15 起连续 8 次运行全红在同一个点上，`npm test` 与打包步骤
  **从未被执行到**——门禁在纸面上存在、实际形同虚设。
- 改为走生产同款惰性入口 `loadSdk()`（模块名非常量 require ⇒ tsc 不做模块解析），同时保留「缺失时给出
  可执行修复指令而不是 MODULE_NOT_FOUND 栈」的语义。
- 新增门禁 `scripts/dep-declaration-test.cjs`（`npm run test:dep-declaration`，进 CORE：40 → 41）：扫描
  `electron/**` 与 `scripts/**` 的 .cjs，**未在 package.json 声明**的裸模块**字面量** require 一律失败
  （先剥注释再扫描，避免文档示例误报；带扫描范围自检，防止「逻辑失效 = 假绿」）。变异测试 1/1 有判别力：
  把探针改回字面量 require 后门禁当场红在 `scripts/vector-store-semantic-probe.cjs:114`，还原即绿。
- 验证：本机把 `node_modules/@zilliz` 改名模拟 CI 条件，修复前复现同一行同一列
  （`vector-store-semantic-probe.cjs(111,27)`），修复后该条件下 `npx tsc -p tsconfig.checkjs.json` 为 0 错；
  `npm run build` + `npm run check:js` + `npm test`（43/43，194.1s，含本轮新增门禁）全绿；探针无 `MILVUS_ADDR` 时仍明确
  SKIP（不静默通过）。

### 新增（S9：子代理收口 + 压缩成本可测，2026-09-16）

- **角色契约收敛为单一来源** `electron/tools/roles.cjs`：工具白名单 / 是否只读 / 授予的能力 / 角色提示
  只声明一次，`toolkit.filterByRole` 与 `subagents.cjs` 都从它取。此前三处各写一份，实测已经漂移
  （`ROLE_TOOLS` 5 个角色含 `canvas`、`READ_ONLY_ROLES` 3 个、`ROLE_PROMPTS` 4 个 —— `canvas`
  被子代理 enum 暴露给模型却没有角色提示，还能动画布/UI）。
- **只读门判据升级为「角色契约显式授予的能力」**（`registry.roleCapabilities`）：白名单只说「能用」，
  能力才说「允许产生这类副作用」。`verifier` 的 `execute_shell` 由 `shell.execute` 显式授予不受影响；
  `explorer` 的 `scan_project` 不再因白名单豁免而被放行 —— 并且 `scan_project` 在只读上下文里改为
  **如实失败**（`code=WORKBENCH_WRITE_DENIED`），修掉「画布没写却回报已写入工作台」的谎报。
- **子代理独立预算（父子链）** `electron/requestBudget.cjs`：`RequestBudget` 支持 parent 链 +
  `createSubagentBudget`，每个子代理有自己的配额（`agent.subagent.max_total_tokens`，默认 0 = 沿用旧行为），
  用量按实际值记回父账 —— 一个子代理刷爆额度只让它自己失败，父 run 与其他子代理继续，且不绕过
  `agent.max_total_tokens`。
- **子代理任务总时长**：`timeoutSeconds` 语义从「单轮超时」（实际可跑约 36 分钟）修正为**任务总时长**
  （默认 600s，钳制 [10s, 1h]）—— 组合信号（父 signal + 定时器）+ 单轮上限 180s，超时/取消分别落 `blocked`。
- **子代理结果合并契约**：回灌主上下文的结果带固定字段头（taskId/role/status/工具调用数/变更文件）+
  结构化 `contract`（toolCalls / changedFiles / usage / stageWarning / 判定留人工）+ 按
  `agent.subagent.result_max_chars` 截断并指向 `get_subagent_task`；失败文案显式劝退「原样重试」，
  避免主循环的失败提示诱发重复委派。
- **幂等账本可归因** `electron/sideEffects.cjs`：父子代理/多个子代理仍共用同一幂等域（续跑语义不变），
  但每次登记带 actor，去重文案改为「提交者 X，请求方 Y」并由账本给出；检查点 `tool_intent`/`tool_commit`
  也带 actor。
- **压缩（工具结果子代理压缩）成本可测且可控**：新增内容级缓存 `electron/compressionCache.cjs`
  （`sha256(工具名+预算+原文)`，LRU 200 条/2MB，落 `.codenode/metrics/compression-cache.json`，跨 run 复用）；
  压缩 system 提示改为**常量**、长度预算移到 user 段（前缀稳定，服务端前缀缓存可命中）；
  可配压缩专用模型并**默认关思考链**；`costLedger.tokenParts` 现在记录服务端的缓存命中 token
  （DeepSeek `prompt_cache_hit_tokens` / OpenAI `prompt_tokens_details.cached_tokens`），
  汇总里给出 `promptCacheHitRate`（无数据时为 `null`，不编造）。
- **画布痕迹不再静默丢**：stage 回写前校验节点存在与 `type==='stage'`，失败写 `task.stageWarning` 与审计事件；
  子代理状态落 run 事件 `subagent_state`（此前 run 记录里完全没有子代理痕迹）。
- 用例 `scripts/subagent-isolation-test.cjs`（A–J 共 11 段断言）进 CORE 门禁（**38 → 39**），
  变异测试 4/4 有判别力（只读门退回白名单豁免 / `scan_project` 不检查真写入 / context 不传 actor /
  子代理结果不截断，均当场变红）。

### 新增（运行回放接进界面 + 第 8 节逐条验证，2026-09-16）

- **运行回放 UI**：`eventBus.replayPayload()`（时间线 + 摘要 + 文件位置，与 CLI 同源）、IPC `agent:events`、
  preload `replayEvents`、`src/store/replayStore.ts`、`src/components/RunReplayPanel.tsx` ——
  在「工作流运行」标签里直接看到「这一轮发生了什么」（工具调用 / 失败码 / 审批 / 成本 / token 的时间线）。
  用例：`test:event-replay` 扩到 26 段，新增 `test:event-replay-ui`（offscreen Electron 真实渲染，12 段，进 DISPLAY 组）。
- **第 8 节 10 条推理项逐条验证**（见文档）：7 条闭环（含 S12 已修的 #9/#10）、1 条静态结论（#6）、
  1 条仍未取得可靠结论（#8 压缩上限后的体积曲线，需专门用例）。
- **修掉 #3 挖出的真问题**：缓存命中的 tool 消息此前退化成**裸 `result.text`** ——
  丢了「请勿重复调用」提示（模型继续空转重试）与首次那条的 `[data]` 段（信息缩水）。
  现在命中路径统一补提示前缀 + 正文取自缓存（没有则重建），并加两条断言 + 变异锁住。

### 新增（S8 补齐：六套日志全部并入统一事件流 + 回放摘要，2026-09-16）

- `runStore`（run 状态）/ `runCheckpoint` / `SideEffectLedger` / `CostLedger` / `AlertDispatcher` /
  `ipc` 审计 / 审批事件 —— **七条链路全部双写** `.codenode/events.jsonl`（旧文件保留一个版本周期）。
  至此「按 run 回放：这一轮到底发生了什么」能在一个文件里看全，不必再去翻五个文件。
- 新增 `eventBus.bridge()`（永不抛的旁路桥）与 `eventBus.summarize()`（回放摘要：工具序列、失败次数、
  失败码分布、审批签发/拒绝/消费、成本与 token —— 只统计实际字段，不补不猜）。
- `scripts/event-replay.cjs` 新增 `--summary` / `--json --summary`。
- 用例 `scripts/event-replay-test.cjs` 扩到 18 段（六套来源 + 成本/审批事件字段 + 摘要统计），
  变异测试 5/5 有判别力。

### 新增（S7：ApprovalService 令牌审批 + 画布写工具补审批，2026-09-16）

- **新增 `electron/tools/approval.cjs`**：审批令牌由**服务端签发**（绑定 `capability` / `scope` /
  `toolCallId` / `attemptId` 与有效期，**单次有效**），`verify()` 逐项校验后立即消费；令牌只存内存、重启失效。
- **注册表剥离模型自填的审批字段**（`confirmed` / `approved` / `approvalToken` …，在校验前剥离并落 trace）——
  审批只能走令牌，「模型自己批准自己」这条路被堵死；「没有审批通道」（`APPROVAL_REQUIRED`）与
  「用户拒绝」（`APPROVAL_DENIED`）分开报，提示按 S5 的失败分类给出不同指引。
- `workbench_edit` / `ui_control` / `create_nodes` 补审批声明（`declareContract`，
  `requiresConfirmation='WRITE'`）；`save_project` 原有声明不变。
- 配置 `tools.confirm_writes`（默认开，可整体关闭）/ `agent.approval.ttl_ms`（默认 5 分钟）。
- 用例 `scripts/approval-token-test.cjs`（12 段）进 CORE 门禁（**43 → 44**）；变异测试 4/4 有判别力。
- **行为变化**：画布类写操作执行前需用户批准一次（可用 `tools.confirm_writes=false` 关闭）。

### 新增（S6：ToolScheduler 只读并行 + withTimeout + 取消贯穿，2026-09-16）

- **新增 `electron/tools/scheduler.cjs`**：`ToolScheduler.prime()` 只**启动**本轮里可并行的**只读**调用
  （本轮含写操作/需确认 → 整轮串行；参数不完整 → 不预启动；受并发上限与调用额度约束），
  返回 `callId → Promise`；`withTimeout()` 到点返回 `code=TIMEOUT` 并 abort 底层执行；
  `linkAbort()` 把父 signal 的取消贯穿到子 controller。事件 `scheduler_parallel` 带
  `turnId`/`toolCallId`/`attemptId`。
- **主循环接入**：轮开始前预启动、执行处优先 `await` 预启动的 promise —— 只启动不等待，
  所以 record / messages / 幂等账本 / 检查点的顺序与串行执行逐字节相同。
- 配置 `agent.tools.parallel`（**默认 false**，行为等价）/ `agent.tools.parallel_concurrency`（默认 3，1–8）。
- 用例 `scripts/scheduler-parallel-test.cjs`（9 段，含挂钟断言：串行 328ms → 并行 169ms、写操作整轮独占、
  取消贯穿、顺序不变）进 CORE 门禁（**42 → 43**）；变异测试 3/3 有判别力。

### 新增（S5：结构化 ToolResult + FailureCode 分类，2026-09-16）

- **新增 `electron/tools/failures.cjs`**（FailureCode 唯一来源）：码表 + 每码的类别 / 是否可重试 /
  是否需要用户介入 / 给模型的指引，外加 legacy `data.code` → FailureCode 的**显式**归一表
  （`WORKBENCH_WRITE_DENIED`→`PERMISSION_DENIED`、`PATH_OUT_OF_ROOT`→`ARG_SEMANTIC`、
  `BUDGET_EXCEEDED`→`FATAL_FAILURE` 等）；认不出来的码一律 `FATAL_FAILURE` + `known:false`，不猜。
- **`AgentToolResult` 结构化**：`kind`（success/partial/failure）、`failure`、`failed[]`，
  新增 `failure(code, msg, data)` 与 `partial(text, data, failed)`；`ok`/`text`/`data` 保持兼容
  （60+ 处既有 `error(text, data)` 零改动）。
- **主循环提示改为分类化 + 限次**：参数类 → 修正参数；权限/用户拒绝 → 不要原样重试、要人介入；
  超时 → 缩小范围或改后台；副作用未知 → 先只读核对；未登记码 → 保守并如实标注。
  同一 `toolCallId` 最多提示 2 次（超限只落 `failure_taxonomy` trace，循环继续）。
- 注册表门失败显式化（角色无权 → `PERMISSION_DENIED`；未知工具 → `FATAL_FAILURE`）。
- 用例 `scripts/tool-failure-taxonomy-test.cjs`（10 段，含真实工具循环与请求体断言）进 CORE
  门禁（**41 → 42**），变异测试 3/3 有判别力。

### 新增（S11：压缩请求批量合并，2026-09-16；原编号 S10 与迁移表的 Grounding 门撞号，已更正）

- **同一轮工具循环里的多份大结果合并成一次压缩请求**（`agent.compression.batch`，默认开；
  `agent.compression.batch_max_items` 默认 4）：逐个压缩时 N 份结果要付 N 遍 system 前缀与 N 次请求
  固定开销（而 system 是常量、前缀缓存只对前缀有效），合并后这些只付一次。分段协议
  `<!-- summary i=N -->`；解析不出某一段 → 该条退回单条压缩；整批失败 → 降级为截断 ——
  宁可多花一次调用，也不把「多份结果混成一锅」的摘要塞进上下文。
- **主循环改为「先登记、轮末结算」**：tool 消息先按原文进上下文，轮末批量压缩后改写对应 tool 消息内容，
  `assistant(tool_calls) → tool` 配对与断点续跑快照结构不变。
- 用例 `scripts/compression-batch-test.cjs`（7 段断言）进 CORE 门禁（**39 → 40**），变异 3/3 有判别力。

### 新增（向量后端可插拔：memory / Milvus）

- **RAG 向量层从内联实现改为可插拔后端契约**（`electron/vectorStore/{index,memory,milvus}.cjs`）：
  `memory`（默认，进程内记忆化 + 只对 BM25 预筛 Top-K 打余弦，零外部服务）与 `milvus`
  （外部 Milvus 服务，chunk 向量写入 collection，检索走**全库 ANN**，不再受 BM25 预筛限制）。
  索引侧只依赖统一契约（`prefiltered / applyChanges / scoreCandidates / dropLocal / stats / close`），
  默认路径行为与重构前一致（`test:rag`、`test:scalar`、`test:agent-boundary` 未改断言即通过）。
- **向量写入天然增量**：`refresh()` 只收集「本次重新分块的文件」与其旧块，`retrieve()` 开头 `syncVectorStore()`
  按 `file` 先删后写；未变文件不重写（用例断言第二次检索不产生新写入、变更文件旧块必须删除）。
- **纯语义命中并入结果**：milvus 后端命中但 BM25 完全未召回的块以 `vector-only` 并入（要求向量贡献 ≥ 1 分，
  避免灌入无关行），工具文本与 `sources[]` 中标注，便于区分「词法命中」与「语义召回」。
- **降级而不中断**：Milvus 连接失败 / collection 维度不一致 / SDK 缺失时，本次检索降级为纯 BM25，
  在 `stats.vector.error`、审计日志与工具文本中显式告警（用例覆盖「失败 → 仍返回 BM25 结果 + 文本告警 → 恢复后不再告警」）。
- **SDK 刻意不进默认依赖**：启用 milvus 时才 `npm i @zilliz/milvus2-sdk-node`（保持零依赖与打包体积不变），
  缺失时抛出可执行的安装指令；配置项 `rag.vector_store` / `rag.milvus_address` / `rag.milvus_collection` /
  `rag.milvus_token` / `rag.milvus_username` / `rag.milvus_password` 见 `config/agent.properties.example`。
- 新增 core 用例 `test:vector-store`：memory 契约、Milvus 适配器全分支（建表/索引/load/分批写入/按文件删除/维度校验）、
  端到端 vector-only 与降级链路；真实 Milvus 端到端由 `MILVUS_ADDR` 守卫（未设置则明确 SKIP，不静默通过）。
- **已完成真机验证**（2026-09-15，Milvus v2.6.5 + SDK 3.0.5，本机 docker compose 栈）：
  写入 / 全库 ANN 检索 / 纯语义命中并入 / 按文件删除传播 / 索引端到端全部跑通，`realMilvus: pass`。
  真机暴露并已修的四个坑：显式传 `search_params` 会让 SDK 不注入 `topk`（服务端 `topk is required`）；
  SDK 把失败放在 `status.error_code` 而不抛异常（会退化成「静默零命中」，现统一 `assertSuccess` 转异常）；
  命中默认不含主键，`output_fields` 必须显式带 `id`（否则无法映射回 chunk）；
  默认 Bounded 一致性下删除有数秒可见性延迟（用例改为轮询等待）。用例新增「状态失败不得被当成零命中」回归项。
  详见 `docs/agentic-rag-scalar-vector.md` 2.2.1.1。
- **Milvus 检索一致性可配、默认 `Strong`**：实测默认 Bounded 下「按文件删除的旧块」约 3s 内仍会被召回
  （刚改完文件就提问会遇到旧内容），Strong 稳定即时可见；配置项 `rag.milvus_consistency`
  （strong|bounded|eventually|session|default），服务端不支持时自动退回服务端默认并在
  `stats.vector.store.consistencyFallback` 记录原因。
- **Milvus 生产参数档（对齐「百万级 / 1024 维 / HNSW」口径）**：索引类型、度量、HNSW 参数与写入批量全部可配，
  默认值即生产档：`rag.milvus_index_type=HNSW`（原为写死的 AUTOINDEX）、`metric_type=COSINE`、
  `index_m=16`、`index_ef_construction=200`、`search_ef=64`（HNSW 的 `ef` 经简单形态 `params` 下发）、
  `batch_size=128`（原 32）、`flush_every_batches=4`（原逐批 `flushSync`，百万级下代价过高，收尾必刷）。
  既有 collection 不重建索引，但会把「实际索引 ≠ 配置」写入 `stats.vector.store.indexNote` 以便诊断。
  嵌入侧新增 `rag.embed_dimensions`（OpenAI v3 模型降维到 1024；本地路线可用 ollama + bge-m3 原生 1024）。
  真机复验：Milvus v2.6.5 上以 **1024 维 + HNSW(M16/efC200/ef64) + COSINE + Strong** 跑通
  （`MILVUS_DIM=1024 MILVUS_ADDR=… node scripts/vector-store-test.cjs` → realMilvus=pass）；
  同机小 collection 单次 ANN 检索 p50 5ms / p90 6ms（200 条 × 1024 维，含 gRPC 往返，30 轮），
  分布式部署与读写分离属服务端拓扑（客户端只需指向 LB/proxy 入口）。见 docs 2.2.1.2。
- **真嵌入链路已验证**（2026-09-15）：llama.cpp `llama-server`（CPU 版 + `bge-m3-Q8_0.gguf`，`--embeddings
  --pooling cls`）暴露 OpenAI 兼容 `/v1/embeddings` → `embed_provider=openai` 指向它 → Milvus v2.6.5
  （HNSW/COSINE/Strong，1024 维）跑通 `realMilvus=pass`（中文查询 `topVectorScore=0.7033`）。
  语义判别：中文问句对相关代码 cosine 0.4597 vs 无关代码 0.3366（哈希向量无法通过该断言）。
  语义收益：三个与英文代码**无词面交集**的中文问句在纯 BM25 下 0 命中，真嵌入 + 全库 ANN 下全部命中
  正确文件并标记 `vector-only`（`scripts/vector-store-semantic-probe.cjs`，可复跑；未设 `MILVUS_ADDR`/`EMBED_BASE` 时 SKIP）。
  注：本机 `huggingface.co` 不可达，模型走 `hf-mirror.com`。见 docs 2.2.1.3。
- 文档同步：`docs/agentic-rag-scalar-vector.md` 增 2.2.1 节（含「Windows 无可用 Milvus Lite，只有外部服务形态」
  的边界说明）、README 与配置示例。

### 修复（Agent harness）

- **引用校验把真实引用判成伪造引用**：白名单只认 `retrieve_context` 的精确 citation 串，于是块内更精确的行区间
  （`docs/session.md#L1-L4` 里引用 `L3-L3`）、以及按系统提示用 `read_file` 深读候选文件后的实读路径都被判无效，
  提示还被拼进交付回答正文。现在可信来源改判「本轮真实读过的内容」（检索块范围 / `read_file` 实读区间 /
  `search_files` 命中行 / `query_scalars` 命中 key），没读过、或行号与读到的范围不相交仍判无效；提示改为独立事件
  （`onDelta {kind:'grounding'}`），不再污染回答正文。顺带修掉引用正则匹配不到 `[scalar:<key>]` 形态的问题。
- **只读结果缓存失效盲区**：缓存失效此前按「写工具清单」(`MUTATION_TOOLS`) 判定，而 `execute_shell`（脚本/构建）、
  `poll_job`（正在写盘的后台任务）、`delegate_task`（builder 子代理落盘）、扩展与 MCP 工具都可能改文件，
  执行后缓存不失效（实测 shell 写入后 `read_file` 仍返回旧内容）。现在按只读白名单保活：只有纯只读工具之间缓存
  继续有效，其余任何工具（含失败、未注册的）执行后一律清空；新增 core 用例 `test:agent-cache`。
- **执行隔离策略经 context 注入时被当成函数而静默降级**：`electron/ipc/agent.cjs` 写成 `sandbox: () => sandboxPolicy`，
  而 `AgentToolContext.sandbox()` 原样返回注入值 → `sandbox.currentPolicy()` 拿到函数、`mode/capabilities` 全为
  `undefined` → Windows 上 Job Object 的进程数/内存/CPU 限额不生效，macOS/Linux 退化成无隔离 spawn，
  `strict` 的 fail-closed 检查也被绕过（`sandbox-test` 因显式传策略对象而一直全绿）。现在传策略对象本身，
  `context.sandbox()` 兼容 getter 形式，并在 `sandbox-test` 增补接线断言。

### 修复（工程与门禁，本轮）

- **CI 触发条件写死 `n0_12`**：`ci.yml` 的 push 与 `production-gate.yml` 的 push/PR 都过滤了 `n0_12`，
  分支改名后门禁工作流再也不会触发（"存在但永不运行"比没有更危险）。现在两者对所有分支的 push
  与所有 PR 触发。
- **门禁集合统一**：两个 workflow 各自维护一份脚本清单，彼此不一致。现在都调用 `npm test`
  （清单只在 `scripts/run-all-tests.cjs` 里定义一次），并新增 `test:runtime-gate`。
- **新硬化门禁未接入 CI**：`runtime-gate` / `sandbox-test` / `agent-resume-test` / `cost-monitor-test`
  此前在 CI 里零引用（`npm run test:eval` 之外的这层硬化全靠人工跑），现已进入 core 套件。
- **`npm run build` 会弄脏工作区**：`postbuild` 每次都重渲染 8 个已入库的图标（跨平台渲染结果不同），
  以及 `.codenode/tools_trace.jsonl`（运行时流水）被 git 跟踪，跑一次测试/构建就产生无关改动。
  图标改为"源指纹清单 + 跳过重建"（`build/.icon-source.sha256`，`npm run icons:build -- --force` 可强制），
  流水日志移出版本控制。
- **`icons:build` 在跳过分支会挂住**：Electron 主进程未显式退出，`npm run build` 会一直等（无头 Linux 分支同样受影响）。

### 安全

- 渲染层权限请求默认全量拒绝（`setPermissionRequestHandler`，`src/` 内不使用任何浏览器权限）。
- 窗口外链一律交系统浏览器打开，站外导航拦截（`setWindowOpenHandler` + `will-navigate`）。
- CSP 补强：新增 `object-src 'none'`、`base-uri 'self'`、`form-action 'none'`
  （`frame-ancestors` 只对 HTTP 响应头有效，写在 `<meta>` 里会被浏览器忽略并报 console error，故未加）。

### 工程

- `electron/main.cjs` **按域拆分**（1372 → 519 行，只剩应用/窗口生命周期）：
  IPC 分到 `electron/ipc/{models,metrics,project,agent}.cjs`，每个导出 `register(ctx)`，
  依赖由显式 ctx 传入；通道集合与拆分前逐一对账一致（28 个）。工程域那套 helper
  （目录遍历/路径边界/命令白名单/流式执行/审计）随工程域一起搬走。
  为此新增 core 用例 `test:ipc`（用假 `ipcMain` 真跑各模块 `register()`，断言"哪个模块注册了哪几个通道"），
  并在 `runtime-gate` 里加了「每个 ipc 模块都必须被 main.cjs require 接线」的断言——
  拆分过程中真漏过一次 models/metrics 的接线，静态的"通道名出现过"检查看不出来。
- 新增 `npm run check:js`：对 `electron/**`、`scripts/**`（.cjs，不受 `src/` 的 tsc 覆盖）做 checkJs 静态检查；
  `npm run verify` = build + check:js + 全量回归。
- `.nvmrc` / `engines.node` 固定 Node 22；`.gitattributes`（一律 LF，二进制标记）+ `.editorconfig`。
- **LICENSE：MIT**（此前缺失，仓库是 public）。`package.json` 补 `license` 字段，作者邮箱统一为
  `yimi528 <148250049+yimi528@users.noreply.github.com>`（此前挂着另一台机器的 `2534311904@qq.com`）。
  发布入口 `npm run release:sign` / `release:hash` 指向 `scripts/release-sign.cjs`，补上"写了模块但无调用方"
  这个缺口；凭据（`CODENODE_WIN_CERT_PFX_BASE64` 等）与 fail-closed 规则见 `docs/release-process.md` 第 4 节。
- 新增 CONTRIBUTING.md、PR 模板、CODEOWNERS、dependabot（npm 每周 + Actions 每月）、`docs/release-process.md`。
- `scripts/vector-ui-test.cjs` 现在自己拉起 vite dev server（没有就跑，已有就复用），
  并让 `waitFor` 超时打印当时 DOM——此前该用例要求"先手动起 vite"，单跑必然超时。

### 修复（门禁首次真跑三平台后暴露的平台差异）

CI 一旦真的跑起来（此前只在已删除的 `n0_12` 上触发），六个平台组合里连爆 5 个**"本地绿、CI 红"**的问题，
全部与平台差异有关，且其中 3 个是被测代码的真缺陷：

- `scripts/run-all-tests.cjs` 在 macOS/Linux 上把整条命令当可执行文件 spawn（POSIX 上 `shell:false` + 命令串
  → ENOENT），CI 表现为 **25 项全部 0.00s、`exit=null`**；现在 POSIX 走参数数组，并把 spawn 的 `error`
  带进汇总表（否则只剩 `exit=null`，看不出是脚本失败还是没跑起来）。
- `electron/sandbox.cjs` 的 `withinWriteRoots` 只对可写根做 realpath、候选路径直接 `path.resolve`：
  CI Windows 的临时目录是短路径名（`RUNNER~1`），两侧前缀对不上 → **可写根内的合法路径被误判为越界**。
  现在两侧统一走 `canonicalPath()`（对不存在的目标也做"最长存在前缀 realpath"）。
- `sandboxExecProfile()` 的 `(subpath ...)` 需要真实路径：macOS 的 `os.tmpdir()` 是 `/var/folders/...`
  （符号链接到 `/private/var/...`），用符号链接形式会让**工作区内写盘被 sandbox-exec 拒绝**。
- 图标指纹把脚本文件原样入哈希：Windows 工作区是 CRLF、CI 检出是 LF → 指纹永不匹配 → CI 每次都重建图标，
  并在容器里因 `FATAL:setuid_sandbox_host` 挂掉。现在按 LF 归一化后再哈希；
  另外 Linux/CI 的构建与打包步骤显式给 `ELECTRON_DISABLE_SANDBOX=1`（该崩溃发生在脚本代码执行之前）。
- `test:shell-output` 借 `powershell ... Write-Output` 造长输出：harness 在 POSIX 上会把这类 Windows 命令
  翻译成 `printf`，只剩 33 字符 → `hasMore` 断言失败。改为平台无关的
  `node -e "process.stdout.write('x'.repeat(25000))"`。
- `test:bg` / `test:shell-output` 的时间余量与 `test:sandbox` 的两处平台假设（profile 断言按真实路径比对、
  越界探针必须落在所有可写根之外——默认策略把系统临时目录也算可写根）一并修正。
- `build.linux` 未配 `icon`：electron-builder 回落到 `build/icon.ico` 并报
  `image build/icon.ico must be at least 256x256`（Linux 目标要 PNG，推荐 512）。
  图标脚本新增 `PNG_SIZES = [512]`（只出 PNG、不进 ICO）与 `RENDER_SIZE = 1024` 下采样，
  `build.linux.icon` 指向 `build/icon-512.png`。

结果：`CodeNode CI` 的 3× Verify + 3× Package 与 `production-gate` 的 5 个任务在三个平台上全部通过。

### 修复（display 组：画布节点键盘归属 + 用例自备环境）

`npm run test:display` 三项目前全绿（此前 2 红）。关键不是改用例迁就实现，而是修掉两个真问题：

- **在画布节点里按 Delete 会把整个画布节点删掉**（数据损失级）：画布内快捷键的守卫要求
  `document.activeElement` 落在 `.vs-scope` 内，但 `src/` 里没有任何可聚焦元素（无 `tabIndex`），
  鼠标点进画布后焦点仍留在 `body` → 工作台的「删除选中节点」先一步触发，把节点删了。
  现在 `VectorNode.tsx` 在指针按到画布内容时把焦点收回 `.vs-scope`
  （`tabIndex={-1}` + `onPointerDown`，真正的输入控件不抢焦点），
  `App.tsx` 的 Delete 分支相应改为「焦点在画布节点内则让位」——
  两端分别是「选中画布节点后删不掉」与「在画布节点里 Delete 把节点删掉」，现在各归其位。
- **用例自身的两处环境缺口**（与实现无关，改的是脚本）：
  - `test:vector` 的 Edge target 选择取「第一个 page target」，Edge 启动时可能先开自己的内部页
    （`#app-root` + 混淆类名），于是连到错误的页面并一直等不到应用元素；现在按 BASE URL 匹配。
  - `test:vector` 在工具栏放置节点后有 240ms 的视口动画，动画期间按世界坐标派发的拖拽会整体漂掉
    （实测 160×110 的拖拽被记成 564×359）；新增 `waitForViewportIdle()`（判据是节点 rect 连续两次一致），
    `dragWorld`/`clickWorld` 都会先等它稳定。
  - `test:vector` 的 Delete 检查改为「真实点击图形 → Delete」，与用户路径一致（原先程序化 `selectIds`
    不带焦点，测的是另一条路径）。
  - `test:rag-ui` 放行启动门禁（先 `loadRoot` 到一个临时工程根）、展开侧栏并切到 Agent 标签——
    侧栏 tab 化之后消息列表只在 `tab === 'agent'` 时挂载，`.rag-grounding-*` 之前根本不在 DOM 里；
    固定 `setTimeout(100)` 也换成轮询等待。

### 已知问题（未修，需要产品决策）

- 历史 tag（`0.11`/`0.12`/`0.13`/`n0_11`/`v0.12.0`/`v0.3.0`/`v0.3.1`）与 `package.json` 版本号对不上，
  历史无法追改，从 `docs/release-process.md` 起统一为 `vX.Y.Z`。
- `npm run test:display` 仍未纳入 CI：`test:vector` 目前只认 `msedge.exe`（Windows 路径），
  要进 CI 需先把浏览器探测做成 `EDGE → CHROME → chromium` 的跨平台回退，再挂到带 xvfb 的任务上。
- **Milvus 真机用例未纳入 CI 门禁**：`test:vector-store` 的核心部分用假客户端覆盖全分支，真机端到端依赖
  `MILVUS_ADDR`（需外部服务，本机另需 Docker Desktop + 三个容器），CI 里只会输出 SKIP——这是**有意的**
  （门禁必须零外部依赖），但意味着 SDK 升级/服务端升级后的兼容性变化不会被 CI 拦住，需手动跑一次真机用例。


## [0.13.0] - 2026-09-14

### 新增（Agent 生产硬化，`0111b7b`）

- **执行隔离** `electron/sandbox.cjs` + `sandbox/winjob.cs`：Windows Job Object（进程数 / 内存 / CPU 上限、
  `KILL_ON_JOB_CLOSE` 孤儿清理）、Linux bubblewrap、macOS sandbox-exec；strict 模式 fail-closed，
  无后端时如实降级并写审计；`execute_shell`、后台任务、MCP / 项目命令面板均已接入。
- **断点续跑** `electron/runCheckpoint.cjs`：intent/commit 检查点、`planResume` 的 complete / auto / review /
  unknown 判定、续跑消息重建。
- **副作用幂等** `electron/sideEffects.cjs`：read / write / unknown 分类 + 幂等账本去重，崩溃窗口内的
  未知结果一律要求人工复核。
- **成本账本与告警** `electron/costLedger.cjs` + `electron/alerts.cjs`：主循环 / 压缩 / 子代理 / 嵌入统一记账，
  阈值告警带稳定 id 去重与冷却，落盘 `.codenode/metrics/`。
- **发布自检与签名** `electron/selfTest.cjs`（`--codenode-selftest`，无窗口）、`scripts/release-sign.cjs`
  （sha256/sha512、证书 / pfx / 自签、`release/manifest.json`）。
- **离线评测** `scripts/agent-eval.cjs` + `agent-eval-tasks.cjs` + `lib/scripted-model.cjs`：11 个多步任务，
  判据只看工作台终态（文件字节 / 工具返回 / Run JSONL / 独立复跑）。
- **运行时门禁** `scripts/runtime-gate.cjs`（可执行断言，取代"源码里出现过某字符串"），
  以及 `sandbox-test` / `agent-resume-test` / `cost-monitor-test` 真实回归。
- 修复 `sandbox.guardedSpawn` / `guardedMcpSpawn` 丢失 `cwd` / `env`（命令落到父进程目录执行、
  脱敏环境被忽略导致子进程继承全量环境变量）；`runtime-gate` 幂等场景补齐 `run_start`。

### 新增（界面与画布）

- 侧栏 tab 化、图像节点与视觉能力、启动门禁页与渲染崩溃兜底（`addef0c`、`ead6e7f`）。
- 矢量画布改为无限画布，操作对齐工程原画布（`5a21a17`）；画布节点与连线样式统一。

### 修复

- 点击文件后 Hook 顺序崩溃导致整窗白屏（`8a39bd2`）。
- Agent 重试与恢复：重试对账、恢复计划、恢复审查 UI（`24216b4`、`8c366af`、`09e6d62`）。

[未发布]: https://github.com/ZhuanTou33212/CodeNode/compare/v0.3.1...HEAD
[0.13.0]: https://github.com/ZhuanTou33212/CodeNode/releases
