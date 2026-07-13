---
name: codenode-go
description: Use the CodeNode Go language skill to generate and verify Go nodes or programs. Enable only when a CodeNode request selects Go.
---

# CodeNode Go

## 语言路由

仅在请求包含 `language: "go"` 或用户明确选择 Go 时启用。Java 和 PowerShell 请求分别使用它们自己的 Skill，不要同时加载多个语言 Skill。

## 制作规则

1. `build-node` 返回结构化节点定义和独立 Go 函数；`build-program` 生成包含 `package main` 与 `main()` 的可运行程序。
2. 使用 `gofmt` 格式化，使用 `go test ./...` 或与项目规模相称的命令验证。
3. 输出路径必须位于用户确认的工作区；覆盖文件、下载依赖和执行生成程序前需要确认。
4. 节点端口类型必须能映射为明确的 Go 类型，不允许隐式依赖全局变量。

## 验收标准

- 语言路由只启用本 Skill。
- 代码通过 `gofmt` 和编译/测试检查。
- `build-node` 与 `build-program` 的输出形态明确分离。
