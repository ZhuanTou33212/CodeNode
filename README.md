# CodeNode

CodeNode 是一个原生桌面节点制作台，通过项目本地文件申请槽与 Codex 协作。正式运行链路不使用 HTML、Electron、WebView 或 MCP。

## 当前 Stage 0

- `codenode-desktop/`：Java 21 Swing 独立桌面程序，包含节点拖拽、端口连线、检查器、双模式申请、结果监听和错误节点标红。
- `CodeNode/codenode/`：Codex 插件，负责领取 `.codenode/queue` 中的本地申请、解析 DSL、调用互斥语言 Skill 并回写结果。
- `java-node-demo/`：Java 21、Maven、JUnit 和结构化编译诊断的 Stage 0 验证项目。
- `CodeNode/`：方案、协议、实施记录和历史网页实验。

## 正式工作流

```text
CodeNode Desktop
  → <project>/.codenode/queue/inbox/<requestId>
  → 用户把自动复制的“处理 CodeNode 本地申请 ...”发给 Codex
  → Codex 插件原子领取、生成/验证产物
  → <project>/.codenode/results/<requestId>/result.json
  → 桌面程序显示结果，并按 nodeId 标红错误节点
```

两种模式严格隔离：

- 代码工作流：单节点生成节点，多节点连接图生成完整程序，允许按申请编译/运行。
- Markdown 蓝图：节点只引导项目结构，只生成 `.md`，不加载语言 Skill、不生成代码、不编译运行。

## 启动独立程序

已构建入口：`codenode-desktop\dist\CodeNodeDesktop\CodeNodeDesktop.exe`。

重新构建：

```powershell
cd .\codenode-desktop
$env:JAVA_HOME = "E:\CodeNode\tools\jdk-21.0.9+10"
.\mvnw.cmd test
& "$env:JAVA_HOME\bin\jar.exe" --create --file target\codenode-desktop.jar --main-class local.codenode.CodeNodeApp -C target\classes .
.\scripts\package-app.ps1 -JavaHome $env:JAVA_HOME
```

## 文档入口

- [原生桌面与本地申请槽 Stage 0 记录](CodeNode/原生桌面与本地申请槽Stage0落实记录.md)
- [插件说明](CodeNode/codenode/README.md)
- [桌面程序说明](codenode-desktop/README.md)
- [完整执行方案](CodeNode/CodeNode项目执行方案.md)
