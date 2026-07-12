# CodeNode Java Codex 插件（第一阶段）

这是 CodeNode 的第一阶段 Codex 插件实现，用于验证 Java 节点编排项目的基础条件和工作流。

## 当前可检查能力

- Codex 插件清单与 Skill 加载；
- Java 21/JDK、Maven Wrapper、Git 和工作目录检查；
- 生成一个可编译、可运行、带 JUnit 测试的最小 Java 示例项目；
- 约定自然语言节点的输入、输出和验收方式；
- 为后续 Codex 内节点画布和本地编排服务预留目录。

## 当前明确未完成

本阶段尚未实现可视化节点画布、Agent 自动生成 Java 代码、编译错误回溯节点和 Codex 专用 UI。插件不会把这些未完成能力伪装成已完成；使用 Skill 可以先验证 Java 工具链和示例闭环。

## 目录

- `.codex-plugin/plugin.json`：插件清单；
- `skills/codenode-java/SKILL.md`：Codex 使用说明；
- `scripts/check-java-env.ps1`：环境检查；
- `scripts/create-java-demo.ps1`：生成 Java/Maven 演示项目；
- `assets/`：后续插件资源目录。

## 本地检查

在插件目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-java-env.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create-java-demo.ps1 -OutputDirectory .\demo
```

生成完成后进入 `demo`，使用 `./mvnw.cmd test`（Windows）或 `./mvnw test`（macOS/Linux）验证。
