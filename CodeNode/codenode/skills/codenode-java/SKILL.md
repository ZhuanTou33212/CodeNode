---
name: codenode-java
description: Use the CodeNode first-stage Codex plugin to check Java/Maven prerequisites, create a minimal Java node-workflow demo, and prepare structured inputs for the future CodeNode canvas. Use when the user asks to start CodeNode, validate the Java toolchain, or create a Java node example.
---

# CodeNode Java（第一阶段）

## 语言路由

本目录只负责 Java 语言请求。检测到 `language: "java"` 或用户明确要求 Java 时才启用本 Skill；PowerShell 请求必须改用 `codenode-powershell/SKILL.md`，不要同时加载两种语言的实现规则。

## 目标

本 Skill 对应 CodeNode 第一阶段：在 Codex 中验证 Java 21 + Maven 的最小执行闭环。当前实现是 Codex 插件辅助能力，不包含最终的可视化节点画布。

## 全语言工作流输入

请求包含 `expression`、`environment` 或嵌套范围时，先使用 `codenode-workflow-dsl` 解析并校验。仅根据其输出的 `ast`、`reachableNodeIds`、`nodes` 和 `environment` 生成 Java，不得重新解释原始表达式。

## 操作顺序

1. 先确认用户选择的工作目录，不要默认扫描或修改整个项目。
2. 运行 `scripts/check-java-env.ps1 -ProjectDirectory <demo-directory>`，记录 JDK 21、Maven、Git 和路径检查结果。
3. 如果用户同意创建演示项目，运行 `scripts/create-java-demo.ps1 -OutputDirectory <目录>`。
4. 生成项目后使用 `scripts/test-java-demo.ps1 -ProjectDirectory <demo-directory>`，通过固定 Maven Wrapper 执行测试。
5. 只在用户确认后执行生成项目的 Maven 测试；不要自动安装依赖或覆盖已有文件。
6. 汇报结果时明确区分：环境检查、项目生成、编译测试，以及尚未实现的节点画布能力。

## 节点输入协议（第一阶段约定）

自然语言节点先整理成以下结构，再交给后续 Agent/画布实现：

```json
{
  "name": "AddIntegers",
  "category": "transform",
  "prompt": "将两个整数相加并输出结果",
  "inputs": [
    { "name": "left", "dataType": "int", "required": true },
    { "name": "right", "dataType": "int", "required": true }
  ],
  "outputs": [
    { "name": "result", "dataType": "int", "required": true }
  ]
}
```

代码生成必须经过用户审查；编译成功不等于业务逻辑正确。涉及文件覆盖、依赖安装、联网或执行未知脚本时，必须先说明并获得确认。

## 验收标准

- 插件清单可被 Codex 识别；
- 环境脚本能明确报告 Java 版本和 Maven 可用性；
- 演示项目可以通过 Maven 测试；
- 失败时能指出具体前置条件；
- 不声称第一阶段已经完成节点画布或错误回溯。

## PowerShell 兼容性规则

生成 `build-program` 的 PowerShell 脚本时，必须兼容 Windows PowerShell 5.1 和 PowerShell 7：

- 不要使用 `[Environment]::GetFolderPath('Desktop')` 作为桌面路径发现方式；部分 Windows PowerShell 环境会将其解析为函数参数错误。
- 使用 `$env:USERPROFILE` 与 `Join-Path` 定位桌面，例如：`Join-Path $env:USERPROFILE 'Desktop'`。
- 默认参数和诊断文本优先使用 ASCII；中文内容应明确保存为 UTF-8 with BOM，避免 Windows PowerShell 5.1 将 UTF-8 无 BOM 误判为 ANSI。
- 生成后必须执行 PowerShell 解析检查，并记录目标 PowerShell 版本，不能只用 Node.js 或字符串检查代替。
- 脚本执行前仍需用户确认，不得因为生成程序而自动修改用户桌面。

已知问题记录（2026-07-13）：上述静态方法写法曾导致“函数参数列表中缺少 )”。修复方案是改用 `$env:USERPROFILE`，并使用 ASCII 默认名称。
