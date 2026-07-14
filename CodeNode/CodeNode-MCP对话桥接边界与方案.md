---
title: CodeNode MCP 对话桥接边界与方案
date: 2026-07-14
tags: [CodeNode, MCP, Codex, Stage0]
---

# CodeNode MCP 对话桥接边界与方案

## 检查结论

当前页面到 MCP 的链路工作方式如下：

1. `canvas.js` 将节点请求转换为 Markdown；
2. 页面通过 `http://127.0.0.1:32145/markdown` 提交到本地 MCP 队列；
3. MCP 服务把文件放入插件数据目录的 `inbox`；
4. 用户在 Codex 中发起一个任务回合后，Codex 调用 `codenode_read_latest_markdown` 读取请求；
5. 完成后调用 `codenode_mark_processed` 移入已处理目录。

该链路已通过自动化冒烟测试。此前网页看起来“不能发送到 Codex”，有两个原因：个人市场实际指向的插件源仍是旧副本，缺少 `.mcp.json` 和 `mcp/server.mjs`；同时页面文案错误地把“进入 MCP 队列”说成“进入当前对话”。两项均已修正。

## 协议边界

MCP 是 Codex 主动调用外部工具、资源和提示的协议。MCP 服务端不能主动伪造一个用户消息，也不能把文本直接注入当前 Codex 对话输入框。因此 HTTP 请求成功仅代表 `queued`，不代表当前任务已经开始处理。

服务的 `/health` 和 `/markdown` 响应会明确返回：

```json
{
  "delivery": "mcp-queue",
  "canInjectCodexConversation": false,
  "requiresUserTurn": true,
  "nextPrompt": "处理最新 CodeNode 请求"
}
```

## 后续直接对话方案

若 Stage 1 要实现网页点击后直接创建或继续 Codex 任务，应使用 Codex App Server 构建受控的本地主机桥接，而不是让 MCP 服务尝试反向推送。桥接层需要：

- 明确选择目标任务，禁止默认猜测当前对话；
- 使用 App Server 的线程/回合接口发送结构化请求并订阅流式事件；
- 把授权、审批、取消和错误事件反馈到画布；
- 只监听回环地址，并校验来源、请求大小和一次性令牌；
- 将“提交队列”和“发送到任务”作为两种不同的 UI 状态；
- 在实现 Codex 页面入口时一并完成，不纳入本次 Stage 0 范围。

## 验收命令

```powershell
node .\codenode\scripts\test-mcp.mjs
```

通过标准：健康检查声明 `mcp-queue`、Markdown 返回 `requiresUserTurn: true`，并且 MCP 工具可读回相同内容。
