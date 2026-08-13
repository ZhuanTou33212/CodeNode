# CodeNode Project Format 1.1

`.cnode` 是 CodeNode Desktop 的可编辑工程文件。它是 UTF-8 ZIP 容器，MIME 为 `application/vnd.codenode.project+zip`；第一个条目必须是未压缩的 `mimetype`。

## 必需条目

- `manifest.json`：格式版本、稳定 `documentId`、创建/修改时间和生成器版本。
- `graph.json`：节点、声明端口、模板来源、范围/文件归属、容器尺寸、连线、整理点以及活动/草稿代码槽。不保存申请队列和运行诊断。
- `workspace.json`：节点位置、画布视口、选择、当前模式和语言。
- `output-profiles.json`：节点程序与 Markdown 请求的独立输出配置；两种模式复用同一个 `graph.json`。
- `integrity.json`：上述四个 JSON 条目的 SHA-256。

## 可选 Agent 与长期知识条目

- `agent-context.json`：当前文档独立的 Agent 会话摘要与消息窗口，最大 1,000,000 字符。
- `agent-info.json`：保存时的软件与运行环境只读快照，敏感字段和绝对项目路径会过滤。
- `knowledge-graph.dsl`：当前项目固化的分层长期知识，采用 `parent(child1,child2)`、摘要、关键词和定位元数据语法。
- `knowledge-meta.json`：可丢弃的轻量缓存标记，只保存根元素、元素计数和生成时间；启动时不作为知识来源，完整索引从固化 DSL 在内存重建。

多个同时打开的 `.cnode` 文档各自持有会话与图谱；切换文档时先快照当前模型和 Agent 上下文，再恢复目标文档，禁止跨项目混用。所有存在的可选条目都必须列入 `integrity.json` 并通过 SHA-256 校验。

运行时的有效输入类型由连线重新推导。代码草稿保存其申请 ID、基础修订和白名单分类；接受草稿会增加活动修订，防止旧 Agent 结果覆盖新代码。`request.json`、`request.md`、申请队列、编译结果和用户停靠窗口布局均不进入工程文件。

`workspace.json.selection.nodeIds` 按顺序保存当前多节点选择，最后一项是主选择节点。旧文件中只有一个节点 ID 或空数组时仍按相同规则读取。

## 保存与恢复

正式保存先写入同目录临时文件，重新读取并验证后再替换目标，同时保留 `<name>.cnode.bak`。桌面程序每 15 分钟生成恢复快照并原子保存正式工程；保存失败时保留 `.codenode/recovery/<documentId>/checkpoint.cnode`。

格式限制为 10,000 个节点、50,000 条边、单 Prompt 1 MiB、Agent 上下文 1,000,000 字符、单 ZIP 条目 20 MiB、解压总量 100 MiB。路径穿越、绝对产物路径、未知节点分类、无效文件/范围归属、重复 ID、悬空边和摘要不一致会被拒绝。1.0 可兼容编辑；未来 2.x 格式只读打开，防止未知字段被旧版本覆盖。
