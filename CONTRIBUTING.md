# 参与开发

CodeNode 桌面端：Electron 主进程（`electron/`）+ React 渲染层（`src/`）+ 一整套可执行的回归/门禁脚本（`scripts/`）。

## 环境

| 项 | 要求 |
|---|---|
| Node | **22**（`.nvmrc` 与 `package.json` 的 `engines` 是唯一来源；CI 用 `node-version-file: .nvmrc`） |
| 包管理 | npm（有 `package-lock.json`，CI 用 `npm ci`） |
| 行尾 | 一律 LF（`.gitattributes` 强制；Windows 上不要开 `core.autocrlf=true` 提交 CRLF）、缩进 2 空格（`.editorconfig`） |

```bash
npm ci
npm run dev          # 渲染层 vite + Electron（VITE_DEV_SERVER_URL）
```

## 提交前必须跑

```bash
npm run verify       # = build（tsc + vite）+ check:js（Electron/scripts 静态检查）+ 全量回归与门禁
```

拆开单独跑：

| 命令 | 覆盖 |
|---|---|
| `npm run build` | `src/` 的 `tsc --noEmit` + vite 构建 + 图标 |
| `npm run check:js` | `electron/**`、`scripts/**` 的 checkJs 静态检查（这些是 `.cjs`，不受 `src/` 的 tsc 覆盖） |
| `npm test` | **core 套件**：25 项，无显示环境、无网络、确定性（CI 跑这个） |
| `npm run test:display` | 需要 Electron 窗口 / 本机无头 Edge 的用例（smoke、RAG UI、矢量画布） |
| `npm run test:list` | 打印套件清单 |

单项排查：`npx npm run test:sandbox`、`npm run test:eval -- --list` 等。统一入口 runner 支持
`--only test:eval,test:sandbox`、`--stop-on-fail`。

### 测试理念（请遵守）

1. **判据只看终态**：文件字节、工具真实返回值、Run JSONL、独立复跑退出码——不采信模型自述。
2. **不许绕过内置 Agent 工具链**：走 `AgentToolkit.buildDefaultRegistry + registry.execute` / `agent.runAgentChat`，
   不要为了"通过"直接调 `RunLauncher` / `BuildRunner`。
3. **不许假装**：能力不足要如实降级并写审计（`sandbox.capabilities()` 不虚报隔离项、无后端时不假装隔离）。
4. **断言要有强制力**：隔离类断言应验证"内核真的拦住了"（进程数/内存上限、孤儿清理），而不是"返回了错误字符串"。

## 结构约定

| 目录 | 说明 |
|---|---|
| `electron/` | 主进程：`main.cjs`（窗口与 IPC）、`agent.cjs`（工具循环）、`tools/`（工具注册表与实现）、`sandbox.cjs`（执行隔离）、`runCheckpoint.cjs`（断点续跑）、`sideEffects.cjs`（幂等）、`costLedger.cjs` + `alerts.cjs`（成本与告警）、`selfTest.cjs`（发布自检） |
| `src/` | 渲染层（React + zustand + xyflow）；`src/vector/` 是矢量工作室 |
| `scripts/*-test.cjs` | 回归用例（纯 Node 断言，见上） |
| `scripts/runtime-gate.cjs` | **运行时门禁**：断言上述能力真的接线可用（不是"源码里出现过某个字符串"） |
| `docs/` | 设计与评审文档；`docs/eval-reports/` 是**生成物**（CI 以 artifact 上传，不入库） |

## 生成物不要入库

- `docs/eval-reports/`（Agent 评测报告，`npm run test:eval` 产出）
- `.codenode-selftest/`（发布自检的临时构建与备份）、`.codenode/tmp-sandbox/`
- `.codenode/tools_trace.jsonl`（运行时流水，跑一次测试就追加）
- `out/`（UI 校验截图）

`build/icon.ico`、`build/icon-*.png` 由 `npm run icons:build` 从 `codenode-icon.png` 生成：**渲染结果依赖平台**，
因此脚本带源文件哈希清单（`build/.icon-source.sha256`），源图没变时不会重写——不要为了"看上去干净"重复提交图标。

## 分支与 PR

- 默认分支 `main`（与 `0_2` 同线）。
- 直接推 `main` 也可以，但**改动门禁 / 隔离 / 签名 / 发布流程**请走 PR，用 `.github/pull_request_template.md` 的清单自检。
- CI（`.github/workflows/ci.yml`）与门禁（`production-gate.yml`）对所有分支的 push 与所有 PR 触发；
  两个 workflow 都调用 `npm test`，**门禁清单只在 `scripts/run-all-tests.cjs` 里维护一处**。
- 提交信息用中文 + 约定式前缀：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:`，第二行起写清动机与验证方式。

## 发布

见 `docs/release-process.md`。要点：版本号只在 `package.json` 维护；标签格式 `vX.Y.Z`；发布产物必须带签名
（`npm run release:sign`），Windows 便携包未签名会被安全软件误判/篡改。
