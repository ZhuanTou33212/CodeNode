---
name: codenode-java
description: Use the CodeNode first-stage Codex plugin to check Java/Maven prerequisites, create a minimal Java node-workflow demo, and prepare structured inputs for the future CodeNode canvas. Use when the user asks to start CodeNode, validate the Java toolchain, or create a Java node example.
---

# CodeNode Java（第一阶段）

## 目标

本 Skill 对应 CodeNode 第一阶段：在 Codex 中验证 Java 21 + Maven 的最小执行闭环。当前实现是 Codex 插件辅助能力，不包含最终的可视化节点画布。

## 操作顺序

1. 先确认用户选择的工作目录，不要默认扫描或修改整个项目。
2. 运行 `scripts/check-java-env.ps1`，记录 JDK、Maven、Git 和路径检查结果。
3. 如果用户同意创建演示项目，运行 `scripts/create-java-demo.ps1 -OutputDirectory <目录>`。
4. 只在用户确认后执行生成项目的 Maven 测试；不要自动安装依赖或覆盖已有文件。
5. 汇报结果时明确区分：环境检查、项目生成、编译测试，以及尚未实现的节点画布能力。

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
