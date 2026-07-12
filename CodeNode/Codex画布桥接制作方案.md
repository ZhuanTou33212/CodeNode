---
title: CodeNode Codex 画布桥接制作方案
type: architecture-proposal
stage: 1
status: proposed
date: 2026-07-13
tags:
  - CodeNode
  - Codex-plugin
  - MCP
  - bridge
---

# CodeNode Codex 画布桥接制作方案

## 结论

不能把一个 Codex 插件“内嵌”到普通 HTML 中，再从网页直接控制当前 Codex 对话。插件由 Codex 宿主安装和加载，HTML 只能作为插件的界面资源。当前没有已验证的公开浏览器接口可以让任意页面调用类似 `window.codex.sendMessage()` 的能力。

正确方向是反过来：由 Codex 插件承载画布，并由插件配置的 MCP 服务或本地桥接服务接收画布请求。网页只提交结构化请求，不直接保存文件、不打开系统保存窗口，也不持有 Codex 凭据。

## 目标流程

```text
用户编辑节点
    ↓
画布生成 BuildRequest
    ↓
插件桥接层提交请求
    ↓
Codex/MCP 工具读取并审核请求
    ↓
Codex 生成 Java 或 PowerShell 文件
    ↓
受控写入工作区目标目录
    ↓
编译/运行验证
    ↓
结果回传画布，节点显示成功或错误
```

用户期望的业务顺序保持为：

1. 选择工作区内的输出位置。
2. 将节点文字、语言、连接关系和输出要求提交给 Codex。
3. Codex 生成程序。
4. Codex 将文件写到目标位置。
5. Codex 验证程序并把结果返回画布。

## 为什么不能继续用浏览器保存

当前页面运行在 Codex 内置浏览器的 `file://` 环境中。以下接口会进入浏览器宿主或 Windows 原生文件窗口：

- `showSaveFilePicker()`
- `FileSystemFileHandle.createWritable()`
- Blob URL 与 `<a download>`

这些调用在当前内置浏览器中会导致 Codex 崩溃，而且宿主层崩溃无法被 JavaScript 的 `try/catch` 捕获。后续版本必须删除这些调用。

## 推荐架构

### 1. 插件界面层

保留现有 `canvas.html` 作为原型，后续迁移为插件正式 UI。界面层负责：

- 节点编辑、拖拽、连线和语言选择。
- 只允许填写工作区相对路径，例如 `output/CreateFolder.ps1`。
- 构造请求并显示状态。
- 不直接访问任意本地文件系统。
- 不直接调用模型 API。

### 2. BuildRequest 协议

```json
{
  "requestId": "build-20260713-001",
  "action": "build-program",
  "language": "powershell",
  "prompt": "新建一个文件夹，如果已存在则返回已存在",
  "output": {
    "workspaceRoot": "E:\\CodeNode",
    "relativePath": "output/CreateFolder.ps1"
  },
  "nodes": [],
  "edges": [],
  "requiresConfirmation": true
}
```

路径协议必须只接受工作区相对路径。服务端解析后的绝对路径必须仍位于允许的工作区中。

### 3. 本地桥接服务

在插件中增加一个受控本地服务，建议目录：

```text
codenode/
├─ apps/codex-ui/
├─ local-service/
├─ mcp-server/
└─ packages/workflow-schema/
```

最小接口：

- `POST /build-requests`：提交请求。
- `GET /build-requests/{id}`：查询状态。
- `POST /build-requests/{id}/cancel`：取消请求。
- `GET /health`：确认桥接服务可用。

服务只监听 `127.0.0.1`，使用随机会话令牌，并配置严格 CORS，只允许插件界面来源访问。

### 4. MCP 工具层

插件提供 MCP 工具，让 Codex 能读取和处理请求：

- `codenode_submit_build_request`
- `codenode_get_build_request`
- `codenode_write_generated_files`
- `codenode_run_verification`
- `codenode_report_result`

推荐由工具执行确定性操作：参数校验、路径校验、写文件、启动受控编译和收集日志。代码设计与修改仍由 Codex 完成。

### 5. 对话衔接

“自动把网页文字发送到当前 Codex 对话”需要 Codex 宿主公开且受支持的消息或工具调用接口。目前项目中没有验证到这种浏览器 API，因此不能依赖私有注入对象。

第一版采用显式触发：

1. 画布提交请求到桥接服务。
2. 画布显示请求 ID 和“已等待 Codex 处理”。
3. 用户在当前对话发送“处理 CodeNode 请求”。
4. CodeNode Skill 调用 MCP 工具读取最新请求并执行。

如果后续确认 Codex 插件 UI 支持由界面直接触发工具调用，再把第 3 步自动化。即使可以自动触发，敏感写入和程序执行仍应要求确认。

## 状态模型

```text
draft
  → submitted
  → awaiting_confirmation
  → generating
  → writing
  → verifying
  → success | error | cancelled
```

画布轮询请求状态，并把诊断映射回节点。页面刷新后可通过请求 ID 恢复状态。

## 安全要求

- 目标路径只能位于用户选定的工作区。
- 禁止 `..` 路径穿越、UNC 路径和未经允许的盘符切换。
- 写文件前显示拟写入文件清单。
- 覆盖已有文件必须二次确认。
- 程序执行必须单独确认。
- Java 固定使用项目 JDK 21/Maven 工具链。
- PowerShell 默认只做语法检查；执行时使用受控进程、超时和输出上限。
- 请求、确认、生成结果和验证日志均写入审计记录。

## 分阶段制作计划

### 阶段 A：立即止崩

1. 删除画布中的系统保存窗口和 Blob 下载代码。
2. 将“选择保存位置”改为工作区相对路径输入框。
3. “制作成程序”只生成并展示 BuildRequest JSON。
4. 增加复制请求按钮，作为临时对话衔接方式。

### 阶段 B：本地请求队列

1. 建立本地桥接服务。
2. 将请求保存到 `.codenode/requests/`。
3. 增加状态查询和崩溃恢复。
4. CodeNode Skill 能读取指定请求并生成文件。

### 阶段 C：MCP 插件闭环

1. 把桥接操作封装为 MCP 工具。
2. 插件声明 MCP 服务。
3. Codex 读取请求、生成文件并验证。
4. 画布实时显示结果和错误节点。

### 阶段 D：宿主能力预研

验证目标 Codex 版本是否提供以下正式能力：

- 插件 UI 直接触发 MCP 工具。
- UI 获得当前任务/对话的受控上下文。
- 工具完成后向同一任务追加结构化结果。

如果官方接口不存在，保留“用户在对话中显式触发”的交互，不使用未公开的宿主对象。

## 验收标准

- 保存操作不再导致 Codex 崩溃。
- 页面不调用任何原生文件保存 API。
- 请求格式可验证并带版本号。
- 输出路径无法逃逸工作区。
- Codex 能根据请求生成 Java/PowerShell 文件。
- 写入前有确认，写入后有验证结果。
- 页面刷新后可以恢复请求状态。

## 官方资料与待验证项

- Codex 官方文档入口：<https://developers.openai.com/codex/>
- Codex customization/MCP：<https://developers.openai.com/codex/concepts/customization#mcp>
- Codex plugins：<https://developers.openai.com/codex/plugins/build>

2026-07-13 本地拉取 Codex manual 时因网络不可用失败；公开文档检索未确认存在“任意 HTML 直接向当前 Codex 对话发送消息”的受支持接口。因此该能力被列为待验证项，方案不依赖它。

## 阶段 A 实施记录（2026-07-13）

已将节点画布切换到无崩溃的请求预览流程：

- 移除浏览器原生保存对话框、文件句柄写入和 Blob 下载，避免 `file://` 页面触发宿主崩溃。
- 工具架新增“输出路径”输入框，仅接受工作区相对路径（默认 `output/CodeNodeProgram`）。
- “打板制作”下拉菜单保留“制作成节点/制作成程序”两种动作；动作会生成对应的 `build-node` 或 `build-program` BuildRequest。
- 检查器展示完整 JSON，可通过“复制制作请求”复制到当前 Codex 对话，由 Codex 按请求生成 Markdown 或 Java/PowerShell 程序。
- 请求包含 `requiresConfirmation: true`、节点和连线快照，后续本地桥接服务可直接消费；当前阶段不会自动写入磁盘。

验证：`node --check codenode/assets/node-canvas/canvas.js` 通过；源码中已无 `showSaveFilePicker`、`createWritable`、`Blob`、`download` 等浏览器保存路径。
