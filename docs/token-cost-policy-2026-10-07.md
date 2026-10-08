# Token 成本控制：角色模型、委派准入与任务归因

设置入口为“设置 → 成本与模型”，应用于当前项目并持久化到 `.codenode/agent.properties`。默认值集中于 `config/ui.costs.json`，昼夜主题共用状态及控件。

## 模型分配

主 Agent 继续使用对话输入框所选模型。explorer、builder、verifier、reviewer、canvas 各自可选择已接入模型；默认留空，跟随主 Agent。不根据名称或推测价格自动选择模型，也不新增外部模型依赖。

```properties
agent.subagent.delegation_gate=true
agent.subagent.model.explorer=<已接入模型 ID>
```

角色连接使用自己的地址、凭据、协议、上下文窗口与价格。模型被删除、禁用或凭据不可用时明确失败，不偷偷换回主模型。父子共享的总预算、重试额度及工具权限保持原有约束。

高级手工配置的 `agent.model_route.subagent_explorer` 等角色候选路由优先于通用 `agent.model_route.subagent`；设置界面显式选定的角色连接优先于这两类路由。显式配置的备用候选仍遵循已有故障切换规则。

## 委派准入

本地确定性规则拒绝模型声明为 `taskSize=single_step` 的普通探查／实现任务，以及整个目标仅为读取一个明确文件的任务。返回 `DELEGATION_NOT_NEEDED` 和 `execute_in_main`，不创建任务、不消耗子任务名额、不发起模型请求。主 Agent 随后直接使用文件工具，不把“未启动”伪装成完成。

独立验证、审查、画布任务、绑定阶段、依赖任务和不明确的复杂目标保留委派。规则不会判断所有自然语言小任务；工具说明同时引导主 Agent 优先直接完成简单工作。用户可关闭该规则。

## 成本口径

每笔请求保留 runId、taskId、executionId、role、实际模型及调用分类，主请求、子 Agent、压缩、失败尝试可以按任务归属查询。逐轮记账，外层不再次计费。使用连接中配置的单价和供应商用量；缺失价格或不完整计费数据时显示未知。缓存命中、推理 token 和重试单独观测，推理 token 作为输出的子集不重复收费。

任务终态和局部校验结果独立落盘。模型正常结束只表示“已完成”；局部校验通过不代表完整任务正确率，子 Agent 候选结论不自动视为已验证。指标的分子包含记录范围内失败／取消及子 Agent 的费用，分母分别是完成运行数和通过局部校验的完成运行数，避免只统计成功调用而隐藏失败成本。历史成本有大小上限，统计范围是当前保留的账本。

## 验证

- `scripts/core/token-cost-policy-test.cjs`：真实本地 HTTP 调用验证连接隔离、角色优先级、父预算、零请求准入、无重复记账、重启持久化、失败成本与未知价格。
- `scripts/ui/token-cost-ui-test.cjs`：实际 Electron IPC 保存／重新打开，五角色下拉框与开关，昼夜一致，会话、草稿、主模型及侧栏状态保留。
- 日志与主题截图：`out/token-cost-policy.log`、`out/token-cost-ui.log`、`out/token-cost-settings-light.png`、`out/token-cost-settings-dark.png`。

未给出整体节省百分比；真实收益需在相同任务与验收标准下比较完成成本。

验证结果（2026-10-07）：核心套件 145/145、显示套件 19/19 通过；构建与主进程／脚本静态检查通过。暂存 ASAR 181 个文件与当前源码一致，打包 UI 实际模型序列为主模型 → 角色模型 → 主模型；普通工具自动执行及删除审批回归通过。暂存 EXE 0.13.0 的工程、模型配置和持久化标记自检通过。

完整日志：`out/token-cost-core-final.log`、`out/token-cost-display-final.log`、`out/token-cost-build-final.log`、`out/token-cost-checkjs-final.log`、`out/token-cost-asar.log`、`out/token-cost-packaged-ui.log`、`out/token-cost-packaged-approval.log`、`out/token-cost-stage-selftest.json`。

已原位覆盖 `E:\CodeNode\release\win-unpacked`；覆盖前确认旧版未运行。固定路径 EXE 自检、持久化标记及 ASAR 源码核对通过，记录见 `out/token-cost-fixed-selftest.json`、`out/token-cost-fixed-asar.log`、`out/token-cost-delivery.json`。ASAR SHA-256：`f3b63bef69a96360eccaa710dc8579642425d57f8c8fd1491ab41f71a5d1b241`。未保留旧版备份。
