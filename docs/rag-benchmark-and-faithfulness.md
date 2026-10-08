# RAG 冻结评测、结构分块与支持性校验

## 1. 冻结基线

`scripts/fixtures/rag-benchmark-v1.json` 是独立的受控业务语料：32 题、24 个有答案问题、8 个负样本（25%），覆盖会话续期、后台重试、税费结算与缓存失效。跨文件题只有全部必要片段进入前 6 条结果才计为成功。development 与 holdout 按业务域分开，黄金证据由文件与原文片段共同指定。

这是模拟业务场景，不是采集到的真实用户问题；holdout 已在本轮用于诊断，因此后续应建立新的、未用于调优的验收集。不能将本语料的 100% 召回率宣传为通用代码检索效果。

基线在实现修改前冻结，SHA-256 绑定语料。`--check` 校验哈希以及文件召回、全部证据召回、MRR 和负样本误判率不倒退；脚本已进入核心回归清单。旧 `rag-eval.cjs` 保留为当前仓库诊断，默认改为纯词法配置。

```powershell
npm run test:rag-benchmark
npm run rag:ablation -- --out=out/rag-ablation.json
node scripts/eval/rag-eval.cjs --out=out/rag-repository-eval.json
```

v1 冻结基线的 holdout 全证据召回率为 58.3%。评测定位到 `src/cache` 被通用 cache 排除规则跳过；RAG 现在允许嵌套业务 cache 目录，根目录 cache 和 `.cache` 仍排除。修复后该小语料的 development/holdout 全证据召回均为 100%。两组检索 `answerable` 的负样本误判率仍为 50%，这是尚未解决的质量缺口，不等于最终回答误判率。

## 2. AST 与检索元数据

TS/JS 保留函数、方法、接口等结构段。长段优先在后半段的语句开始前切开；没有合适边界时按行数上限切开，保留有界重叠。闭包不成为重叠的独立主片段，而是给包含其起点范围的片段提供闭包签名元数据。方法保留父类符号，后续长函数片段补独立引用的原始签名上下文。

`content` 始终为原始代码行；`searchText` 单独加入文件、符号、父符号、签名与闭包信息，供 BM25、Embedding 和 Reranker 使用。装饰文本不作为引用证据。

`sourceMapping` 使用原文件 UTF-16 字符偏移，`startOffset` 包含、`endOffset` 排除，覆盖完整索引片段（包含行分隔符）。它不是字节偏移，也不是截断展示片段的范围。展示引用仍由实际输出的 `startLine/endLine` 决定。CRLF、Unicode、长方法、闭包和无漏行覆盖均有回归测试。

## 3. 消融实验

离线实验包含默认词法、关闭关系图的 BM25、哈希混合对照。真实实验显式提供 `EMBED_BASE/EMBED_MODEL/EMBED_DIM/EMBED_KEY`，使用同一冻结语料；`RERANK_URL/RERANK_MODEL/RERANK_KEY` 可增加重排对照。缺向量分数或重排失败会报错，不能把降级后的 BM25 记为真实模型结果。

```powershell
node scripts/eval/rag-benchmark.cjs --ablation --real --confirm-send --out=out/rag-real.json
```

本轮利用本机已有 Jina 代码 ONNX 量化模型（768 维、均值池化、归一化、512 token 截断、CPU）跑通环回接口，无模型下载。实验服务仅供诊断，不属于安装包依赖：

```powershell
python scripts/eval/rag-local-onnx-server.py --model-dir=.cache/rag-experiment/jina-code
```

修复后 holdout MRR：默认词法 0.771、向量优先 0.819、真实混合 0.785；全证据召回均为 1.0，负样本误判率均为 0.5。向量优先模式沿用产品 `mode=vector`，仍保留 15% 词法排名贡献，因此不是严格纯 Dense 实验。延迟包含冷启动建索引，不能直接作为稳态 SLA。

本轮未配置真实 Reranker，未测其效果。也未完成大型真实项目、多语言和用户问题采集评测。默认继续使用 `embedProvider=none`。

## 4. 事实支持性

原有路径与行号校验继续使用。启用 `agent.grounding.semantic_mode=warn|enforce` 后，额外模型调用逐条判定答复断言的 `entailed/contradicted/insufficient`，检查否定、数值、条件、因果与跨文件关系。正文来源作为不可信数据，判定不能执行其中指令。

每个支持判定必须包含本次来源中确实存在的原文引句。遗漏断言、非法 JSON、伪造引句、证据超预算、缺少正文或请求失败一律不算支持。超过 24 条断言或 24000 字符证据时返回 unknown，不静默裁剪后宣称通过。判定调用共用主 Run 请求预算和取消信号，并写入追踪与费用记录。

```properties
agent.grounding.mode=enforce
agent.grounding.semantic_mode=enforce
agent.grounding.max_retries=1
```

两项 enforce 配合才阻断交付；默认语义判定关闭。判定结果会缓存，避免同一答复被订正检查和最终检查重复调用。

模型判定具有概率性，原文引句存在也不能证明逻辑判断一定正确。本轮验证了失败处理、判定契约和运行级阻断/通过，未使用真实判定模型测准确率。下一轮需要人审标注的矛盾、条件遗漏、跨文件拼接负例及独立模型准确率实验。
