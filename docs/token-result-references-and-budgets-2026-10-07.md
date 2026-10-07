# 第二轮成本优化：重复结果引用与角色预算

## 重复结果按引用复用

之前相同只读工具和参数命中运行内缓存后，虽然不重新执行工具，仍向模型历史追加整份正文。本次默认开启 `agent.repeat_result_references`：若先前同一工具的完整正文仍在上下文中，重复结果改为短引用；引用比原文长时保持原文。

引用包含来源调用 ID、正文长度和 SHA-256。每次实际模型请求前检查来源，覆盖压缩、硬裁剪、超窗重试以及恢复的历史；来源不完整或哈希不同，就改为明确的失效提示，不假称正文仍可用。随后模型用同参数重取时，缓存恢复完整正文。工具记录、UI 数据、产物证据及本地审计仍保留完整结果。

引用只作用于已命中只读缓存的结果。文件写入、shell、子任务、未知工具等继续清空缓存；不同分页参数不共享结果。图片结果保留既有多模态行为，失败不缓存；部分结果沿用既有缓存规则并保留未完成状态，不通过引用标成完整成功。设置入口为“设置 → 成本与模型 → 重复只读结果使用引用”，开关按项目持久化，昼夜共用。

## 角色预算

每个角色可在同一设置页展开预算，分别配置模型轮次、累计 token 和单次输出 token；0 继承原有父／子任务配置。默认保持继承，复杂任务不自动缩减配额。可选轻量探查预设为 6 轮、60000 累计 token、8192 单次输出。

```properties
agent.subagent.budget.explorer.maxTurns=6
agent.subagent.budget.explorer.tokenBudget=60000
agent.subagent.budget.explorer.maxOutputTokens=8192
```

角色预算与 `delegate_task` 参数只能收紧父上限，不能放大总预算。角色输出上限也在实际模型路由处钳制，压缩及备用候选不能扩张它。触及预算继续返回未完成／上限状态，不把截断结果包装为成功。无效预算不会覆盖设置文件。

累计 token 包含每轮输入与输出，缓存命中输入也计入用量；缓存单价影响费用，不改变累计 token 的上限。

## 对比口径与验证

`scripts/token-result-reference-test.cjs` 驱动真实工具循环，分别关闭／开启引用；两侧工具参数、模型响应序列、最终结果、调用轮数和完整数据相同。对序列化请求使用相同输入 token 估算，并将受控用量写入账本。它测量输入请求规模，没有调用真实商业模型，不证明模型质量、实际账单或全部任务的平均节省。

重复读取用例：4 轮请求、3 次读取；估算输入从 112105 降至 60724，减少 45.83%。输出与工具原始数据一致；来源被替换、移出或压缩后失效，正文裁剪后重取恢复。详见 `out/token-result-reference-comparison.json`、`out/token-result-reference.log`。

角色预算在真实 HTTP 请求与 Electron 聊天 IPC 中验证，包括保存预设、重新打开、昼夜控件一致、会话／草稿／主模型／侧栏状态保留。相关用例：`scripts/token-cost-policy-test.cjs`、`scripts/token-cost-ui-test.cjs`。

## 最终交付

核心套件 146/146、显示套件 19/19、前端构建和主进程／脚本静态检查通过。日志：`out/token-cost-2-core.log`、`out/token-cost-2-display.log`、`out/token-cost-2-build.log`、`out/token-cost-2-checkjs.log`。

暂存 ASAR 182 个文件与最终源码一致；实际打包 UI 中预算预设及角色输出上限生效，普通工具自动执行和删除审批保留。暂存 EXE 自检后原位覆盖 `E:\CodeNode\release\win-unpacked`，覆盖前确认旧版未运行；固定路径启动、自检标记、EXE／ASAR 哈希和源码核对通过。

ASAR SHA-256：`12bdbba463b183bd965226c200888ecb4abd2739da672529cf31c05ea6fd0594`。记录：`out/token-cost-2-packaged-ui.log`、`out/token-cost-2-packaged-approval.log`、`out/token-cost-2-stage-selftest.json`、`out/token-cost-2-fixed-selftest.json`、`out/token-cost-2-fixed-asar.log`、`out/token-cost-2-delivery.json`。不保留旧版备份，独立暂存及隔离自检数据在交付后清理。
