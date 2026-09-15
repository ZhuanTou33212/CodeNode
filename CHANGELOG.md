# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号见 `package.json`（唯一来源）。

## [未发布]

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

- 新增 `npm run check:js`：对 `electron/**`、`scripts/**`（.cjs，不受 `src/` 的 tsc 覆盖）做 checkJs 静态检查；
  `npm run verify` = build + check:js + 全量回归。
- `.nvmrc` / `engines.node` 固定 Node 22；`.gitattributes`（一律 LF，二进制标记）+ `.editorconfig`。
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

- `LICENSE` 仍然缺失（仓库是 public）：选哪个许可证属于你的决定，未擅自添加。
- 历史 tag（`0.11`/`0.12`/`0.13`/`n0_11`/`v0.12.0`/`v0.3.0`/`v0.3.1`）与 `package.json` 版本号对不上，
  历史无法追改，从 `docs/release-process.md` 起统一为 `vX.Y.Z`。
- `npm run test:display` 仍未纳入 CI：`test:vector` 目前只认 `msedge.exe`（Windows 路径），
  要进 CI 需先把浏览器探测做成 `EDGE → CHROME → chromium` 的跨平台回退，再挂到带 xvfb 的任务上。


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
