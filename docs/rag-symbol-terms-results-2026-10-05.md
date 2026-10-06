# 符号检索术语与相近判定器诊断

## 检索缺口

冻结源码的原始中文 S13 查询，没有将 `verifyFaithfulness` 排入前 6；S15 虽有该函数，但排在 `assessAnswerability` 后面。两者使用不同的阈值和 verdict，不能仅因名称相近就交换答案。

新增 `symbolTerms.cjs`，从真实符号名的词元匹配通用技术概念的中英文术语，例如 faithfulness、answerability、embedding、checkpoint。仅增加检索元数据，不增加阈值、参考答案或源码断言；原始 content、行号、UTF-16 映射和引用证据不变。

离线回放中 S13/S15 的首位候选变为 `verifyFaithfulness`。

## 受控消融

`out/rag-symbol-terms-controlled-ablation.json`：相同冻结文件、相同当前代码、BM25/graph/topK=6/12000 字符配置；独立同步实验进程中仅抑制或启用术语函数，不更改生产开关，不请求模型。

| 术语 | 正样本全部证据命中 | Recall@6 |
| --- | ---: | ---: |
| 关闭 | 36/70 | 51.43% |
| 启用 | 41/70 | 58.57% |

新增命中 S13、S14、X05、X13、X14，没有丢失原命中题目。这是曝光数据上的离线检索收益，不是最终答案准确率，也不是未见泛化结论。

## 契约回归与真实 Agent

首次完整套件发现新 metadata 字段被严格输出 schema 拒绝，造成 5 套失败。已只增加 `retrievalTerms` 字符串声明，保持其他未知字段禁用；相关 5 套复跑通过，最终完整 **135/135** 通过。

`out/rag-symbol-terms-agent-smoke.json` 在契约缺口存在时运行，不用于认定功能收益。修复后 `out/rag-symbol-terms-agent-verified.json` 四题实际 Agent 运行 **1/4**，S13 正确区分 24 条答案断言和另一个组件的 12 条事实；S15/X04/X06 未达任务门槛。仍有只搜索未深读、缺少事实证据及跨文件拒答问题，不能宣称对象混淆全部解决。

## 验证和交付

新增测试验证相近概念检索、元数据不进入证据、偏移及原文不变、术语不注入 12/24 等答案。冻结开发集检查、静态检查和构建通过。实际 ASAR 后台扫描、事实/拒答协议及界面检查通过。

暂存与固定目录自检检查退出码、报告新写入时间及 appPath。确认旧版未运行后无备份覆盖 `E:\CodeNode\release\win-unpacked`。EXE 244440576 字节，ASAR 9881014 字节，固定路径 `ok=true`。

人工金标准、新未见集、跨文件任务达成率和完整对象绑定仍未完成；总目标尚未达成。
