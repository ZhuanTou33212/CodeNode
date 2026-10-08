# 检索准入与最终结论支持校验拆分

## 责任边界

| 阶段 | 输入与职责 | 输出 | 不承担的职责 |
| --- | --- | --- | --- |
| 查询规划 | 原问题，核心需求、英文/符号查询建议；失败沿用原查询 | 查询与规划诊断 | 不接收候选来源，不判定最终结论支持 |
| 候选准入 | 文件、标量、混合检索的可读来源 | admission: candidates_available / empty，相关性质量 | 不因词法覆盖、模型未知或缺少某项需求直接判定问题无答案 |
| 生成与补证 | 原问题、当前候选，必要时继续搜索与深读 | 带引用的候选回答 | 不把获准候选等同可靠答案 |
| 最终交付 | 实际生成断言、读过的来源与最新版本 | 引用、逻辑支持、版本校验后的正文；必要时限定范围拒答 | 不用 admission.admitted 绕过校验 |

LocalRagIndex 与 retrieve_context 默认路径已停止调用 assessAnswerability。该判定器保留为独立诊断工具，避免把诊断与线上准入混用。公开 quality 不再携带 answerable、evidenceVerified、answerabilityStatus、evidenceChain。所有成功的文件、标量、混合、空结果路径提供 admission，finalSupportEvaluated 固定为 false。

兼容配置 agent.rag.answerability=verify 仅开启查询规划；最终事实判定由 agent.grounding.semantic_mode 控制。本轮完整任务实验采用 mode=enforce、semantic_mode=enforce。产品原默认 warn/off 未更改，不能把严格实验配置描述为默认产品行为。

## 可复现完整对照

修改前后运行时分别冻结在 out/rag-stages-before-runtime 与 out/rag-stages-after-runtime。两组使用相同冻结 100 题、deepseek-chat、production 预算/压缩、native-read-only 系统提示、评分 v2。运行时完整 SHA256 清单在 out/rag-stages-runtime-manifests.json；差异为 agent、index、输出契约、context、retrieve_context 和新 admission 模块。

命令形式：

```powershell
node scripts/eval/rag-agent-task-eval.cjs --runtime-root=out/rag-stages-before-runtime --limit=100 --runtime-profile=production --system-prompt=native-read-only --token-budget=8000000 --confirm-send --out=out/rag-stages-before-100.json
node scripts/eval/rag-agent-task-eval.cjs --runtime-root=out/rag-stages-after-runtime --limit=100 --runtime-profile=production --system-prompt=native-read-only --token-budget=8000000 --confirm-send --out=out/rag-stages-after-100.json
```

必须以 finishedAt 存在、100 个唯一题号完成为完整结果。两组题号运行均已终态。修改前完整执行/评分 100 题；修改后首批仅 90 题完成执行与评分，N21 评分与 N22–N30 执行曾收到 DeepSeek HTTP 402 Insufficient Balance。用户确认余额恢复后，于 2026-10-05 10:19:59 UTC 完成同冻结运行时、同模型、同评分器的 10 题补跑。运行时与评分脚本 SHA256、题集、压缩和单题预算已核对一致；仅替换余额失败记录，合并结果 100 个唯一题号全部完成执行与评分，错误均为 0。合并为两批，不能描述为一次连续运行。

| 指标 | 本轮修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| 正样本任务通过 | 42/70（60%） | 41/70（58.57%） | -1 题，-1.43 个百分点 |
| 单文件通过 | 29/40（72.5%） | 28/40（70%） | -1 题 |
| 跨文件通过 | 13/30（43.33%） | 13/30（43.33%） | 不变 |
| 正样本完整参考证据覆盖 | 62/70（88.57%） | 63/70（90%） | +1 题 |
| 全部负样本安全拒答通过 | 16/30（53.33%） | 16/30（53.33%） | 不变 |
| 总任务通过 | 58/100（58%） | 57/100（57%） | -1 题 |
| 执行错误 | 0 | 0 | 补跑后完整 |
| 评分错误 | 0 | 0 | 补跑后完整 |

历史原生版本正样本 47/70、跨文件 15/30；修改后跨文件比该历史成绩少 2 题，但历史版本与本轮基线之间还有其他代码变化，不能把全部差异归因于本次阶段拆分。修改前总分 58/100，补跑合并后修改后 57/100。两者严格参考锚点口径均为 57/100。修改后首批原始总分 53/100 含余额不足失败，仅作为历史原始记录保留。

**结论：职责拆分已完成，但单次真实对照未证明正样本或跨文件任务改善，不能声称过度拒答已解决。** 完整证据覆盖增加 1 题，任务通过未增加，下一步需要区分生成阶段遗漏/错答、引用位置失败、后置事实校验判定失败，而不是继续放宽检索准入。不能直接把每个被阻断的正样本叫作判定器误拒，需复核其真实生成断言。

原始报告保留不覆盖：

- out/rag-stages-before-100.json：修改前完整批次。
- out/rag-stages-after-100.json：修改后首批，含余额失败。
- out/rag-stages-after-balance-recovery-10.json：余额恢复补跑，4/10 通过，6/10 被后置校验阻断，错误 0。
- out/rag-stages-after-completed-100.json：完整合并报告，每题 sourceBatch 和 aggregation 标明来源批次、文件 SHA256 与预算，保留所有实际调用费用，未把失败尝试的费用删除。
- out/rag-stages-completed-comparison.json：最终完整对照，completeExecutionAndGrading=true，incompleteIds=[]。
- out/rag-stages-after-completed-100-summary.json：完整分组与失败归因。

负样本 14 题未通过主要因最终事实/拒答校验阻断。评分器未检出已交付答案虚构实现；“14 题未通过”不能直接换算成 46.67% 不安全误放率，也不能据同模型评分器宣称真实误放为零。

已实际执行的补跑命令：

```powershell
node scripts/eval/rag-agent-task-eval.cjs --runtime-root=out/rag-stages-after-runtime --ids=N21,N22,N23,N24,N25,N26,N27,N28,N29,N30 --limit=100 --runtime-profile=production --system-prompt=native-read-only --token-budget=1000000 --confirm-send --out=out/rag-stages-after-balance-recovery-10.json
```

补跑及合并已完成，原始与补跑来源均保留，未更换模型。合并脚本 out/merge-rag-stage-recovery.cjs 校验补跑仅覆盖原 HTTP 402 失败题、10 个唯一题号、每题执行与评分成功、冻结代码/模型/评分器一致，并拒绝覆盖已有合并报告。正样本 70 题的源记录保留，不重跑或择优选择。

仍未完成的可靠性工作：正样本任务通过未改善；需要逐题复核 29 道正样本失败与 14 道负样本阻断的真实原因。独立人工标签与新的未污染验收集也未完成。本次完成的是余额恢复后的完整回归对照。

题集已用于调优，标签仍为 AI 编写且未经过真实人工独立复核，评分模型与生成模型相同。这是暴露回归的任务一致率，不能称作未污染独立验收准确率。单次模型对照也不等同统计显著的因果收益。

## 验证与交付

首轮 135/135 项核心回归、静态检查与前端构建通过。补跑核心回归为 134/135，其中缓存测试连接本地测试 HTTP 服务时 fetch failed；未改代码的单独复跑通过，保留 out/rag-stages-final-core.log 与 out/rag-stages-cache-recheck.log，未判定已知原因。阶段边界回归覆盖三种来源模式、规划故障降级、空候选语义，以及候选准入后错误断言依然被最终蕴含判定拒绝。打包 worker 与界面检查通过，暂存及固定路径启动自检 exit=0、ok=true，报告实际 appPath 指向固定 resources/app.asar。

交付路径：E:/CodeNode/release/win-unpacked/CodeNode.exe。EXE 244440576 字节，ASAR 9886761 字节。未保留旧备份。
