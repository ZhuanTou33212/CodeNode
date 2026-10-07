# Coding Agent 检索职责解耦

本次默认流程改为搜索符号/错误、读取文件、修改和执行测试。保留现有本地词法、结构、文档及可选向量检索，不删除历史证据评估模块。

- `query_scalars` 不受 `rag.enabled` 影响；按 key、prefix 或名字读取画布数据。
- `retrieve_context` 从常驻 core 工具组移除，可按需通过 `discover_tools` 启用。
- 主循环不再安装 Query 规划模型，检索器也不调用旧 `queryPlanner` / `answerabilityJudge`。显式 `queries` 仍可由主 Agent 提供。旧 `agent.rag.answerability` 字段兼容保留但不再启用额外模型调用。
- 向量模型默认 `none`，严格答案校验默认 `warn/off`（引用警告保留，无语义模型请求）。设置页按项目开关本地检索和严格校验，默认选项集中于 `config/ui.rag.json`。既有显式配置仍生效。
- 默认依赖与锁文件移除 `sqlite-vec`，SQLite/Milvus 保留惰性加载的扩展适配器，默认安装无需这些服务或模块。

## 本地性能测量

`out/coding-slim-local-latency.json`：12 文件固定样例，真实后台 worker、默认无向量模型，首次查询包含索引构建。

| 指标 | 实测 |
| --- | ---: |
| 冷查询 | 190.43 ms |
| 暖查询 p50（30 次） | 1.37 ms |
| 暖查询 p95 | 2.27 ms |
| 隐藏模型规划请求 | 0 |

此结果不包含主 Agent 生成时间，不代表大项目、文档解析或显式向量服务的 SLA。

## 验证

标量回归覆盖关闭 RAG 后的精确属性及前缀读取。检索回归覆盖旧配置/旧 planner 不再触发、主 Agent 两次模型轮次、显式查询改写及保留的证据边界。设置回归覆盖开关持久化和关闭扩展时不访问失效服务。

真实 Electron 设置窗口通过 IPC 保存/重读，两种主题使用相同控件结构和状态；切换主题及设置保留会话、输入草稿、模型和侧栏。截图见 `out/coding-slim-settings-light.png` 与 `out/coding-slim-settings-dark.png`。

共享工作区同时存在符号导航及先前界面改动，交付验证会保留并检查完整当前源码。旧测试夹具修复限于 JSON 导入编译路径、原子写入故障注入、相对模块解析与 Zustand 柯里化接口；未放宽安全断言。

## 交付结果（2026-10-07）

- 完整核心套件 139/139 通过；构建与主进程/脚本静态检查通过。
- 新设置 UI 在源码和实际 ASAR 中均通过，包含昼夜主题与配置/会话状态保留。
- 既有显示套件 11/13 通过；压缩卡左边框像素断言与 Edge CDP 启动用例失败。本次未修改压缩卡或矢量画布产品逻辑，也未将这两项标成通过。
- 模拟测试的成长记录已改为临时文件隔离，原全局成长配置恢复到本轮开始时的干净版本；定向 6/6 回归证明测试不再改写全局配置。
- 暂存和固定目录的 EXE 自检均 `ok=true`、退出码 0，固定 `appPath=E:\CodeNode\release\win-unpacked\resources\app.asar`。
- 原位替换前确认旧版未运行，不保留旧交付备份。170 个打包文件与当前源码一致，运行依赖中没有 SQLite 向量扩展和 Milvus SDK；真实后台检索与符号导航通过。

验证记录：`out/coding-slim-core-final.log`、`out/coding-slim-stage-ui.log`、`out/coding-slim-fixed-selftest.json`、`out/coding-slim-package-check.json`、`out/coding-slim-delivery-hashes.json`。

后续（2026-10-07）：两项旧 UI 失败已修复，完整显示套件 13/13 通过，详见 [UI 回归修复](ui-compaction-and-browser-repair-2026-10-07.md)。上面的失败记录保留为当时结果。
