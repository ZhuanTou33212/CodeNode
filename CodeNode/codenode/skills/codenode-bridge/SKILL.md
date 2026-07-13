---
name: codenode-bridge
description: Process Markdown build requests submitted by the CodeNode canvas through the CodeNode MCP inbox. Use when the user asks to process the latest CodeNode request.
---

# CodeNode MCP Bridge

当用户说“处理最新 CodeNode 请求”或指定 CodeNode Markdown 请求编号时：

1. 调用 `codenode_read_latest_markdown` 或 `codenode_read_markdown` 读取请求。
2. 请求包含 `expression`、`entry`、`environment`、范围节点、条件节点或嵌套结构时，先启用 `codenode-workflow-dsl`，生成规范化 AST 和可达子图。
3. 根据请求中的 `language` 只启用对应语言 Skill：`java`、`powershell` 或 `go`。语言 Skill 必须使用规范化结果，不得重新猜测 DSL 含义。
4. 在写入文件或执行程序前遵守 `requiresConfirmation`。
5. 完成后调用 `codenode_mark_processed`，记录结果摘要。

网页提交只会把 `.md` 放入 MCP 收件箱；MCP 不会伪装成用户向当前对话自动注入消息。
