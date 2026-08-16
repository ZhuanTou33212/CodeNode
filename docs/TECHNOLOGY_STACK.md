# CodeNode 推荐技术栈

## 结论

CodeNode 应继续采用 **Java 原生桌面技术栈**，整体架构定位为：

> **Java 25 LTS + Swing/Java2D + 模块化单体 + Maven + 本地优先存储 + 可插拔 AI Provider + MCP Java SDK**

当前不建议迁移到 Electron、Web 前端、Spring Boot 或微服务。现有项目已经具备桌面画布、Agent、MCP、JFR、项目扫描和打包链路，优先演进现有架构的收益高于重写。

## 当前项目基线

| 项目 | 当前情况 |
|---|---|
| 主语言 | Java |
| 当前编译版本 | Java 21 |
| 构建工具 | Maven Wrapper |
| 桌面 UI | Swing、AWT、Java2D |
| 主代码规模 | 约 2.2 万行、123 个 Java 文件 |
| 测试规模 | 50 个测试文件 |
| 运行方式 | JAR、`jpackage` app-image、Windows EXE |
| AI 接入 | OpenAI-compatible HTTP API，默认支持 DeepSeek 配置 |
| Agent 能力 | 工具调用、权限确认、任务、记忆、知识图谱、Trace、Eval |
| MCP | 已有 STDIO Client/Server 能力 |
| 工程格式 | `.cnode` ZIP 容器 + JSON Schema |
| 持久化 | JSON、JSONL、本地文件系统 |

## 推荐技术栈

| 层级 | 推荐选型 | 使用原则 |
|---|---|---|
| 开发语言 | Java 25 LTS | 从 Java 21 分阶段升级；优先使用 Eclipse Temurin 25 |
| 桌面 UI | Swing + AWT + Java2D | 保留现有界面和节点画布 |
| UI 主题 | 现有 `UiTheme` | 需要成熟跨平台主题时再评估 FlatLaf |
| 架构 | 模块化单体 | 一个桌面进程，按领域拆包，不引入微服务 |
| 构建工具 | Maven Wrapper 3.9.x | 保持开发机和 CI 的构建一致 |
| 并发模型 | Virtual Threads + Swing EDT | 后台任务使用虚拟线程，界面更新统一回到 EDT |
| HTTP 客户端 | JDK `HttpClient` | 逐步替换旧的 `HttpURLConnection` |
| JSON | Jackson 3.1 LTS | 优先用于模型 API、MCP 和持久化边界 |
| AI 接入 | `ModelProvider` 抽象层 | 同时支持 OpenAI-compatible 和厂商原生 Provider |
| OpenAI 接入 | Responses API | 用于推理、工具调用、多轮状态和流式输出 |
| MCP | 官方 MCP Java SDK Core | 支持 STDIO、SSE、Streamable HTTP，不依赖 Spring |
| 项目文件 | `.cnode` ZIP + JSON Schema | 继续作为可移植、可版本化的权威工程格式 |
| 本地状态 | JSON / JSONL | 保存会话、任务、审计和 Agent trace |
| 查询索引 | SQLite（按需引入） | 只保存可重建的索引、缓存和跨项目检索数据 |
| 日志 | SLF4J 2 + Logback | 统一日志级别、滚动策略和敏感信息脱敏 |
| 性能诊断 | JFR + 结构化 JSONL Trace | 延续现有 JFR 和 Agent trace 能力 |
| 单元测试 | JUnit 6.x + AssertJ | 覆盖模型、编解码、工具、权限和 Agent Harness |
| UI 测试 | Robot/E2E 冒烟测试 | 覆盖启动、打开工程、扫描、运行和 Agent 主路径 |
| 质量工具 | JaCoCo + SpotBugs + Spotless | 覆盖率、静态检查和代码格式统一 |
| 桌面打包 | `jlink` + `jpackage` + WiX | 生成自带运行时的 Windows EXE/MSI |
| CI | GitHub Actions Windows Runner | 自动测试、打包、冒烟测试并保存产物 |
| 密钥存储 | Windows Credential Manager / DPAPI | API Key 不以明文 properties 作为主要存储方式 |

## 推荐架构

```text
local.codenode
├── app             # 启动、依赖装配、生命周期
├── domain          # Workflow、Node、Port、Project 等纯领域模型
├── application     # 扫描、构建、运行、保存等用例
├── ui              # Swing 界面
│   ├── canvas      # Java2D 节点画布
│   ├── agent       # Agent 对话界面
│   └── project     # 文件、构建、运行界面
├── agent           # 会话、规划、记忆、任务、评测
├── model           # 模型 Provider、请求和流式事件
├── mcp             # MCP Client/Server 适配
├── persistence     # .cnode、JSON、JSONL、SQLite 索引
├── process         # Maven、Gradle、Java、Shell 进程控制
├── observability   # 日志、JFR、Agent Trace
└── infrastructure  # HTTP、凭据、文件系统等外部实现
```

前期先完成包级边界，不必立即拆成多个 Maven 模块。只有当核心模型需要被 CLI、桌面端或其他程序独立复用时，再拆成：

```text
codenode-core
codenode-agent
codenode-desktop
```

## AI 层设计

界面和业务代码不应直接依赖某一家模型接口，建议统一抽象：

```java
public interface ModelProvider {
    Flow.Publisher<ModelEvent> execute(ModelRequest request);
    void cancel(String requestId);
    ProviderCapabilities capabilities();
}
```

建议实现：

```text
OpenAIResponsesProvider
OpenAICompatibleProvider
LocalModelProvider        # 后续可选
```

工具调用、权限确认、重试、超时、Trace 和 Eval 应保持在 CodeNode 自己的 Agent Harness 中，不绑定某个模型 SDK。

## 数据存储原则

- `.cnode` 是工程数据的唯一权威来源。
- JSON Schema 管理格式版本和兼容性。
- Agent trace 使用 append-only JSONL。
- SQLite 仅用于全文检索、跨项目索引、缓存和统计。
- SQLite 数据必须可以由 `.cnode`、源文件和 JSONL 重新生成。
- API Key 使用系统凭据库，并在日志、Trace 和错误信息中统一脱敏。

## 不建议采用

- 不建议迁移到 Electron、React 或 Vue。
- 不建议迁移到 JavaFX，除非未来决定整体重写 UI。
- 不建议引入 Spring Boot、Spring AI 或完整依赖注入框架。
- 不建议使用微服务、Redis、PostgreSQL。
- 不建议把 `.cnode` 工程格式直接改成数据库。
- 不建议一次性替换现有 JSON、MCP 和 Agent 实现，应按边界渐进迁移。

## 实施顺序

1. 升级到 Temurin Java 25 LTS，并保持全部测试通过。
2. 建立 GitHub Actions Windows CI 和可重复打包流程。
3. 将后台任务迁移到虚拟线程，明确 Swing EDT 边界。
4. 用 JDK `HttpClient` 替换 `HttpURLConnection`。
5. 在外部数据边界引入 Jackson 3.1 LTS。
6. 建立 `ModelProvider` 抽象，分离兼容接口与原生 Responses API。
7. 需要 HTTP MCP、资源、Prompt 等能力时迁移到官方 MCP Java SDK。
8. 统一日志、错误码、敏感信息脱敏和 Trace。
9. 出现大规模跨项目检索需求后再引入 SQLite。

## 最终选型摘要

```yaml
language: Java 25 LTS
jdk: Eclipse Temurin
desktop_ui: Swing + AWT + Java2D
architecture: Modular Monolith
build: Maven Wrapper
concurrency: Virtual Threads + Swing EDT
http: JDK HttpClient
json: Jackson 3.1 LTS
ai: Provider Abstraction + Responses API
mcp: Official MCP Java SDK Core
project_format: .cnode ZIP + JSON Schema
local_storage: JSON + JSONL
search_index: SQLite (optional)
logging: SLF4J 2 + Logback
observability: JFR + Structured Agent Trace
testing: JUnit 6.x + AssertJ
quality: JaCoCo + SpotBugs + Spotless
packaging: jlink + jpackage + WiX
ci: GitHub Actions
secrets: Windows Credential Manager / DPAPI
```

## 参考依据

- [Oracle Java SE Support Roadmap](https://www.oracle.com/de/java/technologies/java-se-support-roadmap.html)
- [Eclipse Temurin 25 Releases](https://adoptium.net/temurin/releases?version=25)
- [Jackson Project](https://github.com/FasterXML/jackson)
- [MCP Java SDK](https://java.sdk.modelcontextprotocol.io/latest/)
- [OpenAI Model Guidance](https://developers.openai.com/api/docs/guides/latest-model)
