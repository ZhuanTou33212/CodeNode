# CodeNode Codex 插件（本地申请槽版）

该插件配合 Java 21 / Swing 编写的 CodeNode Desktop 使用。正式链路不再包含 HTML 画布、浏览器、WebView 或 MCP 代理：

`CodeNode Desktop → 项目 .codenode/queue → Codex Skill → 项目 .codenode/results → 桌面节点标红`

## 两种互斥工作模式

- `executable-workflow`：节点包含可制作的代码职责。单节点申请生成对应节点；连接工作流申请经 DSL 规范化后生成完整程序，并把编译/运行诊断映射回 `nodeId`。
- `markdown-blueprint`：节点只引导项目、模块、文件、依赖、约束和章节结构，只生成 `.md`；不得启用语言 Skill、生成代码、编译或运行。

## 插件目录

- `.codex-plugin/plugin.json`：插件清单；没有 `mcpServers`。
- `skills/codenode-bridge/SKILL.md`：本地申请槽的领取、模式路由和结果回写规则。
- `skills/codenode-workflow-dsl/`：语言中立的表达式、AST 与可达子图规范化。
- `skills/codenode-java/`、`codenode-powershell/`、`codenode-go/`：代码模式的互斥语言 Skill。
- `scripts/local-queue.mjs`：原子领取和完成申请的命令行助手。
- `schemas/`：schema 3.0 请求、节点、边和结果契约。
- `assets/node-canvas/` 与 `experiments/react-flow-benchmark/`：Stage 0 历史原型，仅归档，不参与桌面程序运行。

## 本地申请目录

```text
<project>/.codenode/
  project.json
  queue/
    staging/
    inbox/
    processing/
    completed/
    failed/
    cancelled/
  results/<requestId>/result.json
```

桌面程序先写 `staging/<requestId>`，然后原子移动到 `inbox`。Codex 领取时原子移动到 `processing`；完成后先原子写结果，再移动到 `completed` 或 `failed`。这样桌面程序、Codex 和文件监听不会读到半份 JSON，也不会重复领取同一申请。

## 自检

```powershell
node .\scripts\request-codec.test.mjs
node .\scripts\local-queue.test.mjs
node .\skills\codenode-workflow-dsl\scripts\parse-workflow.test.mjs
node .\scripts\validate-json-schemas.mjs
```
