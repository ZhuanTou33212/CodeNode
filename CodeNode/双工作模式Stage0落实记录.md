---
title: CodeNode 双工作模式 Stage 0 落实记录
stage: 0
status: complete
date: 2026-07-14
---

# CodeNode 双工作模式 Stage 0 落实记录

## 已落实的产品边界

CodeNode 使用一个画布、一个本地 MCP/HTTP 桥接服务和两个互斥工作模式：

- `executable-workflow`：Stage0 冻结单节点与可达子图的请求协议；封装代码节点、生成完整程序、编译运行与诊断映射推迟到后续阶段。
- `markdown-blueprint`：选择单个或全部可复用节点，将其 Prompt 与连接结构输出为面向目标语言 Agent 的 Markdown 制作请求；允许选择语言以加载规划约束，但禁止携带可执行代码或启动编译/运行。

工作模式与操作范围已经拆分为 `mode`、`action` 和 `scope`。工作区存在节点时切换模式必须确认并清空画布，避免两种节点对象混用。

## 请求与结果闭环

1. 画布生成 schema 3.0 请求，并将唯一的 `BuildRequest` JSON 放入 Markdown 信封。
2. `mcp/request-codec.mjs` 解码并验证 JSON；缺少请求块、模式/动作冲突、越界路径和 Markdown 携带代码均会被拒绝。
3. MCP 保存请求并向 Codex 暴露已解码对象。旧版或损坏请求会在队列中显示为 invalid，仍可删除，不会阻塞整个队列。
4. 两种模式只路由到选定的一个语言 Skill；`markdown-blueprint` 强制使用该 Skill 的规划模式。
5. Codex 通过 `codenode_mark_processed.result` 写回结构化结果。
6. 画布按请求文件名读取结果；`diagnostics[].nodeId` 和 `nodeResults[]` 可更新任意相关节点，失败节点标红。

MCP 仍不能伪装成用户向当前 Codex 对话主动注入消息。网页提交后，用户需要在 Codex 输入“处理最新 CodeNode 请求”；这是宿主边界，不属于队列故障。

## Stage 0 验收结果

| 项目 | 结果 |
| --- | --- |
| JSON Schema 3.0 与模式隔离 | 通过 |
| Markdown 严格解码与非法组合拒绝 | 通过 |
| MCP 请求排队、读取、删除和结构化结果回传 | 通过 |
| 旧队列请求不阻塞列表且可以删除 | 通过 |
| 画布双模式、范围请求和诊断标红契约 | 通过 |
| DSL 嵌套、未知引用、环和秘密值测试 | 4/4 通过 |
| Java 21 + Maven Wrapper | 6/6 通过 |
| 本地 Agent 请求规范化金丝雀 | 20/20 通过 |
| 1000 节点规范化 | 1000/1000，约 6 ms |
| React Flow 生产构建 | 通过 |
| 插件清单验证 | 通过 |
| personal 市场重装及已安装缓存复测 | 通过 |

已安装版本：`0.3.1+codex.20260715052648`。

## Stage 1 边界

Stage 0 完成的是可验证的协议与原型闭环。自动领取 MCP 队列、无需用户回合的后台 Agent、生产级项目沙箱、完整 source map 生成器、持久化画布和 React 产品界面仍属于 Stage 1 及以后。
