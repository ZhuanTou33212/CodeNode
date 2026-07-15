---
name: codenode-powershell
description: Use the CodeNode PowerShell language skill to validate and generate safe PowerShell node programs. Enable only when a CodeNode request selects PowerShell.
---

# CodeNode PowerShell

## 语言路由

本 Skill 只负责 PowerShell。检测到 `language: "powershell"` 或用户明确要求 PowerShell 时启用；Java 请求只启用 `codenode-java`，不要同时加载本 Skill。

## 生成规则

1. 请求包含 `expression`、`environment` 或嵌套范围时，先使用 `codenode-workflow-dsl` 解析并校验；仅根据规范化 AST 和可达子图生成 PowerShell。
2. 读取并校验 `build-program` 或 `build-node` 请求中的 `prompt`、输出路径和确认标记。
3. 兼容 Windows PowerShell 5.1 和 PowerShell 7；桌面路径使用 `Join-Path $env:USERPROFILE 'Desktop'`，不要使用 `[Environment]::GetFolderPath('Desktop')`。
4. 默认参数和诊断文本优先使用 ASCII；包含中文时保存为 UTF-8 with BOM，避免 Windows PowerShell 5.1 误判编码。
5. 生成后执行 PowerShell 解析检查，并记录实际 PowerShell 版本；不能只用 Node.js 语法检查。
6. 执行脚本、写入用户目录或覆盖文件前必须获得用户确认；默认只生成文件，不自动运行。

## 节点输出协议

`build-node` 应返回结构化节点定义，至少包含 `name`、`category`、`prompt`、`inputs`、`outputs` 和 `code`。`build-program` 应返回 `.ps1` 文件内容、目标相对路径和验证结果，不应将程序伪装成画布节点。

## 验收标准

- 语言路由只启用本 Skill，不加载 Java Skill。
- 生成的脚本能通过 Windows PowerShell 5.1 解析。
- 输出路径限制在用户确认的工作区或目标位置。
- 未经确认不执行脚本，不修改桌面或其他用户目录。

处理本地申请槽请求后，将结构化状态、文件、诊断和节点结果写入申请的 `result.draft.json`，再由 `scripts/local-queue.mjs complete` 原子回写。解析或运行错误能定位节点时必须填写 `diagnostics[].nodeId`，供桌面画布标红。
