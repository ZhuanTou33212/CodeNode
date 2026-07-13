---
name: codenode-bridge
description: Process Markdown build requests submitted by the CodeNode canvas through the CodeNode MCP inbox. Use when the user asks to process the latest CodeNode request.
---

# CodeNode MCP Bridge

当用户说“处理最新 CodeNode 请求”或指定 CodeNode Markdown 请求编号时：

1. 调用 `codenode_read_latest_markdown` 或 `codenode_read_markdown` 读取请求。
2. 根据请求中的 `language` 只启用对应语言 Skill：`java`、`powershell` 或 `go`。
3. 在写入文件或执行程序前遵守 `requiresConfirmation`。
4. 完成后调用 `codenode_mark_processed`，记录结果摘要。

网页提交只会把 `.md` 放入 MCP 收件箱；MCP 不会伪装成用户向当前对话自动注入消息。
