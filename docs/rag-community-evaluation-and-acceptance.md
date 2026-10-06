# 社区评测方法与 CodeNode 100 题验收

## 参考方法（2026-10-05 查询）

- [Ragas Faithfulness](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/faithfulness/)：拆分答案断言，再判断每条断言是否可从检索上下文推出。忠实度不同于检索命中率，也不同于回答是否来自模型已有知识。
- [ARES 原始论文](https://arxiv.org/abs/2311.09476)：分开评估上下文相关性、答案忠实度与答案相关性，利用人审样本校准自动判定，并用 prediction-powered inference 报告统计不确定性。本项目没有实现 ARES 微调或 PPI，不能把普通置信区间称为 PPI。
- [RAGBench 原始论文](https://arxiv.org/abs/2407.11005)：通过可解释标注区分上下文相关性、利用情况、答案依据与完整性。本项目采用逐事实证据与来源定位来支持失败分析，没有直接复用其数据集。
- [LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)：离线数据集验证与线上观测互补，可使用代码判定、模型判定和人工复核。本项目先采用本地 JSON 数据集与复核文件，不要求安装这些平台，也不把源码同步到这些平台。

社区并没有通用的“100 题即证明可靠”标准。样本构成、标签准确性、独立验收和不确定性必须一起报告。

## 新增交付

`scripts/fixtures/rag-acceptance-v2.json`：40 道单文件事实问答、30 道跨文件双事实核对、30 道相似但给定证据不支持的问题，100 个不同问题。跨文件题要求分别找到两处证据，不声称这 30 题全是运行时调用链追踪。

题目来自真实 CodeNode 源码快照，包含来源文件 SHA-256、精确行号、证据原文与事实标签。数据集以及 answerability/faithfulness 判定代码均绑定 SHA-256。生成器只允许首次冻结，不能看过结果后覆盖重建。

全部标签由 AI 作者依据源码建立，尚未经独立人工裁决，不是人审金标准，也不是收集到的真实用户日志。验证只检查与旧开发集没有完全相同问题，不能证明语义无重叠。题目共享源码域，统计样本也不完全独立。

首次评测后，应记录已曝光状态。若根据这些失败题改检索或判定代码，后续跑分只能算回归评测，必须另建未用于调优的验收版本。

## 分层实验

### A. 离线检索

```powershell
npm run rag:acceptance -- --retrieval-only --out=out/rag-acceptance-retrieval-only.json
```

使用产品默认纯词法检索，不调用任何模型。黄金来源只用于评分，不传给检索器。

本次实测：70 个正样本的全部必要证据 Recall@6 为 0.4571，全部证据 MRR 为 0.3288。检索器与判定器的缺口不能混为一谈；没有判定模型时 verificationCoverage 为 0，未知项不计作正确拒答。

### B. Oracle 判定器校准

```powershell
npm run rag:acceptance -- --mode=oracle --confirm-send --out=out/rag-acceptance-oracle.json
```

直接提供冻结的来源原文，单独验证事实判定器，排除检索漏召回造成的失败。同时用正确参考回答与故意无依据的回答测答案支持性。模型输入只有问题/断言和证据，不包含标准标签、标准事实列表或答案正负标签。

### C. 真实检索后的判定

```powershell
npm run rag:acceptance -- --mode=retrieval --confirm-send --out=out/rag-acceptance-retrieval.json
```

使用检索器实际输出的上下文，验证最终证据链。负样本 gold 针对指定的有限上下文；真实检索可能提供额外证据，因此 oracle 和 retrieval 的分歧应人工检查，不能机械视为模型出错。

评测复用现有模型协议与 token/费用预算；关闭候选故障切换以固定判定模型，超时或非法结果记录为 unknown。默认最多一百万保守预算 token，最多三组并发，断点结果持续写入报告。真实模型使用现有配置，支持 CODENODE_API_BASE、CODENODE_API_KEY、CODENODE_MODEL 环境变量，不把密钥写入结果。

首次正式源码评测被自动审批拦截；用户随后明确确认授权发送至 https://api.deepseek.com。现已使用 deepseek-chat 跑完 Oracle / Retrieval 两组各 100 题，详见[真实模型实验结果](rag-real-model-results-2026-10-05.md)。结果仍是相对 AI 作者标签的一致率，尚无人审准确率。

## 指标与复核

报告包含 TP/TN/FP/FN、正负样本 unknown、有效校验覆盖率、正样本通过率、负样本错误通过率与正确拒答率。unknown 在总体准确率中计为错误；另报仅有效结果的条件准确率。全 unknown 或全拒答不能被解释为好成绩。

Wilson 95% 区间只是当前 AI 标签下的名义比例区间。重复源码与相关问题降低有效样本独立性，它不能证明生产泛化，也不是人审校准后的 PPI 估计。

```powershell
npm run rag:acceptance -- --export-review --out=out/rag-acceptance-human-review.json
```

复核文件与数据集哈希绑定，复核者填写 humanLabel、reviewer、reviewedAt 和理由。缺失字段不计为已审阅；禁止模型代填人名并冒充人工复核。人审标签是“所供证据是否足以回答当前问题”，不是“整个项目有没有这个功能”。

评测器可读 `--reviews=<path>`，分别报告作者标签和人审标签下的可回答性结果。当前只支持 answerability 人审校准，答案逐断言的人审标注仍需扩展。报告始终标为 provisional，不能因脚本通过就自动批准上线。

## 已验证 / 待完成

已验证：100 题数量与唯一性、40/30/30 构成、跨文件来源、原文行号与快照哈希、无完全相同开发问题、unknown 惩罚规则、名义置信区间、实际离线检索结果。

待完成：独立人审及标签纠偏、修复后的新版本独立验收、真实运行调用链追踪题与用户日志采样、更大项目与判定模型间一致性验证。真实模型评测的结果不得伪装成人工准确率。
