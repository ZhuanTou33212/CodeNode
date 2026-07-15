# 原生桌面与本地申请槽 Stage 0 落实记录

更新时间：2026-07-14

## 决策

CodeNode 正式前端改为 Java 21 Swing 原生桌面程序，不采用 Electron、WebView 或 HTML。选择 Java 是为了复用 Stage 0 已固定的 JDK 21、Maven Wrapper 和 Java 诊断链路，同时避免引入第二套桌面运行时。

MCP 代理从正式链路取消。桌面程序与 Codex 通过项目内 `.codenode` 文件申请槽协作；用户提交后手动把软件复制的申请指令发送给 Codex。

## 已完成

- 新增 `E:\CodeNode\codenode-desktop` Maven 工程。
- Swing 节点画布支持节点拖拽、选择、端口连线和节点检查器。
- 工具栏支持项目初始化、双模式切换、Java/PowerShell/Go 选择、单节点提交和连接工作流提交。
- 申请采用 `staging → inbox` 原子目录移动，Codex 采用 `inbox → processing` 原子领取。
- 结果采用临时文件到 `result.json` 的原子移动，再进入 `completed` 或 `failed`。
- 桌面程序轮询结果，读取 `diagnostics[].nodeId/file/line/column` 并把失败节点标红。
- `markdown-blueprint` 不写 `language`，且强制 `compile=false/run=false`。
- 插件清单删除 `mcpServers`，MCP 服务入口和 `.mcp.json` 已删除。
- 新增 `scripts/local-queue.mjs` 和生命周期测试。
- 保留 Stage 0 网页/React Flow 内容为历史实验，不参与正式运行。

## 工作模式边界

| 项目 | 代码工作流 | Markdown 蓝图 |
|---|---|---|
| 单节点 | `build-node` | `build-markdown` |
| 多节点 | `build-program` + `reachable-graph` | `analyze-project` + `project` |
| 语言 Skill | Java / PowerShell / Go 三选一 | 禁止 |
| 编译运行 | 按申请执行 | 永远禁止 |
| 节点含义 | 可生成代码的处理单元 | 项目结构与文档章节 |
| 结果 | 程序/节点、诊断、节点状态 | `.md`、文档诊断、节点状态 |

## 独立软件交付

`codenode-desktop/scripts/package-app.ps1` 使用 JDK 21 `jpackage --type app-image` 构建带运行时的 Windows 应用目录，入口为 `dist\CodeNodeDesktop\CodeNodeDesktop.exe`。
