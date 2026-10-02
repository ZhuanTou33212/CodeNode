# Agentic RAG 标量化 + 向量化方案

> 目标：让本地 Agentic RAG 在「需要精准数据时走标量查询，需要语义联想时走向量查询，混合场景自动融合」，
> 默认零云端索引；画布节点属性先保留在本地，Agent 按需查询后才进入模型上下文。

## 1. 现状与问题

| 能力 | 现状 | 问题 |
| --- | --- | --- |
| 文件检索 | BM25 + 路径/短语/覆盖率，多查询 RRF | 词法匹配，近义词/语义改写命中弱 |
| 画布数据 | 节点完整属性随工具结果进上下文 → 发送云端 | 大量 prompt/goal/members 挤压上下文、泄漏到云端 |
| 精准数据 | 无本地 KV | Agent 只能靠模糊检索，拿不到节点 prompt 等确定值 |

## 2. 总体架构（已落地 + 本期实现）

```
                    ┌────────────────────────────────────────────┐
   Agent(主 LLM) ──►│  retrieve_context  mode=auto/file/vector/   │
                    │                     hybrid/scalar            │
                    │  query_scalars      key/prefix 精确查询       │
                    └──────────────────────┬─────────────────────┘
                                           │
                    ┌──────────────────────▼─────────────────────┐
                    │ 本地层（默认零云端索引）                       │
                    │  ┌──────────────┐   ┌─────────────────────┐ │
                    │  │ 标量库 ScalarStore                        │ │
                    │  │ .codenode/   │   │ 向量层 Embedder        │ │
                    │  │ scalars.json │   │ provider=none 默认    │ │
                    │  │ node:<id>... │   │ local 可选哈希向量    │ │
                    │  └──────────────┘   │ provider=openai/ollama│ │
                    │                     └──────────┬──────────┘ │
                    │  ┌─────────────────────────────▼──────────┐ │
                    │  │ 文件索引 LocalRagIndex（BM25 增量缓存）    │ │
                    │  └────────────────────────────────────────┘ │
                    │  向量后端 rag.vector_store：                 │
                    │    memory（启用向量后的默认本地后端）         │
                    │    milvus（可选，外部服务 + 全库 ANN）        │
                    └──────────────────────────────────────────────┘
```

### 2.1 标量层（精准数据，本地 KV）
- **存储**：`electron/scalars/index.cjs` → `<root>/.codenode/scalars.json`，原子写入，按工程根缓存单例。
- **写入**：画布工具（`get_workbench_model` / `workbench_edit` / `bulk_edit` / `write_analysis_md`）执行时，
  把节点完整属性（`name/label/prompt/goal/members/filePath/role/status/position` 等）写成标量
  `node:<id>`（完整对象）与 `node:<id>:<attr>`（单属性），默认不随画布工具结果返回；Agent 按需查询后，命中的值会进入模型上下文。
- **读取**：
  - `query_scalars`：`key=node:n1` / `key=node:n1:prompt` / `prefix=node:` 精确查询。
  - `retrieve_context mode=scalar`：标量精确/语义命中，来源以 `scalar:<key>` 引用。
  - `retrieve_context mode=auto`：同时查文件与标量，并标明优先来源；标量按 key 或文本匹配（无需精确 key）。
- **隔离**：`.codenode/` 被 RAG 硬排除（`EXTRA_IGNORED_DIRS`），标量内容永不进入文件检索索引。

### 2.2 向量层（语义联想，可插拔）
- **接口**：`electron/embedder/index.cjs`，`embed(texts) → vectors`，统一 `cosine(a,b)`。
- **provider**：
  - `none`（默认）：关闭向量层，仅使用 BM25 文件检索。
  - `local`（可选）：确定性 n-gram 哈希向量（FNV-1a 桶 + 正负号 + L2 归一），无网络、跨会话稳定。
  - `openai`：`rag.embed_base + embed_key + embed_model`，走 `/v1/embeddings`。
  - `ollama`：`rag.embed_base + embed_model`，走 `/api/embeddings`。
- **融合策略（agentic）**：显式启用的哈希向量只重排 BM25 预筛候选（`rag.embed_top_k`，默认 40）；
  学习式嵌入 + `memory` 且块数不超过 `rag.memory_semantic_max_chunks` 时独立扫描块向量；SQLite 在工程本地持久化向量，Milvus 走外部 ANN。
  BM25 与向量各自排序后按倒数排名融合，并为高分纯向量命中保留少量 Top-K 席位；`mode` 决定权重：
  - `file`：weight=0（纯词法）
  - `auto`/`hybrid`：weight=`rag.vector_weight`（默认 0.35）
  - `vector`：weight=1（语义优先）

**下一步候选**：本地 Jina Code embedding 在小规模代码检索实验中改善了目标片段召回，
但模型下载、CPU 建索引时长和无答案质量门槛需要继续评估。本期不随安装包内置、
不自动下载，也不作为默认检索层；需要语义检索时仍可显式配置本地 Ollama
或 OpenAI 兼容嵌入服务。

BM25 的词频饱和与长度归一化分别由 `rag.bm25_k1`（默认 1.35，范围 0.1–3）和
`rag.bm25_b`（默认 0.72，范围 0–1）控制；可在「检索设置」中连同向量融合权重按项目保存。
这些默认值是兼容旧检索行为的起点，不代表针对每个代码库的最优值。

### 2.2.1 向量后端（`rag.vector_store`，chunk 向量存哪里）

| 后端 | 位置 | 检索方式 | 外部依赖 |
| --- | --- | --- | --- |
| `memory`（启用向量层后的默认后端） | 进程内 `Map`（有界记忆化） | 哈希向量重排 BM25；学习式嵌入的小项目可独立召回 | 无额外向量库 |
| `sqlite` | 工程 `.codenode/rag-vectors-*.sqlite` | 本地精确近邻检索，文件范围在查询前过滤 | 可选 `sqlite-vec`，无需服务进程 |
| `milvus` | 外部 Milvus collection | **全库 ANN**（不受 BM25 预筛限制），命中并回 BM25 结果一起融合 | Milvus 服务 + `@zilliz/milvus2-sdk-node` |

- 实现：`electron/vectorStore/{index,memory,sqlite,milvus}.cjs`；`LocalRagIndex` 只依赖统一契约
  （`prefiltered / applyChanges / scoreCandidates / dropLocal / stats / close`），三种后端可互换。
- SQLite 后端依赖当前 Electron 的 `node:sqlite` 与 `sqlite-vec` 扩展，默认不启用；它减少进程内向量缓存并保留跨会话索引，当前使用精确扫描。较大项目应按实际数据量测延迟，再决定是否使用 Milvus ANN。
- **写入时机**：`refresh()` 只收集「本次重新分块的文件」与「变更/删除文件的旧块」，
  `retrieve()` 开头调用 `syncVectorStore()` 落库（先按 `file` 过滤删除旧块，再写入新块），
  未变文件不重写——向量写入天然是增量的。
- **纯向量命中**：SQLite、Milvus 或 memory 全量扫描命中的块若 BM25 完全未召回，会以 `vector-only` 并入结果；
  SQLite/memory 要求余弦分 ≥ 0.4，Milvus 要求向量分达到最低门槛，工具文本会标明来源。
  该分数只决定候选是否进入检索结果；纯向量命中本身不把质量判定升级为「可回答」。
  Agent 需深读原文件，核实片段确实支持结论后才能据此回答。
- **检索一致性默认 `strong`**（`rag.milvus_consistency`，可选 bounded/eventually/session/default）：
  默认 Bounded 时**按文件删除的旧块有几秒仍会被召回**（实测 ~3s），刚改完文件就问会出现旧内容；
  Strong 让刚写入/刚删除立即可见（真机探针 4/4 稳定）。服务端不支持该级别时（部分云托管只支持 Bounded）
  自动退回服务端默认，并在 `stats.vector.store.consistencyFallback` 记录原因，不影响可用性。
- **降级**：Milvus 连接失败、collection 维度不一致或 SDK 缺失时，本次检索降级为纯 BM25——
  不抛错、不中断，但会在 `stats.vector.error`、审计日志与工具文本中显式标注「向量后端降级」。
- **SDK 策略**：`@zilliz/milvus2-sdk-node` **刻意不写进默认依赖**（保持零依赖与打包体积）；
  需要时 `npm i @zilliz/milvus2-sdk-node`，`npm run dist:win` 会把它一并打进产物。
- **代价与边界**：Milvus 需要自建服务（docker compose standalone）或 Zilliz Cloud——这是本项目
  唯一会把 chunk 向量落到外部服务的形态；Windows 上**没有**可嵌入的 Milvus Lite（官方与 Node 封装
  均无 win32 目标），所以「桌面应用开箱即用 Milvus」这条路不通，只有外部服务形态。

#### 2.2.1.1 真机验证结论（2026-09-15：Milvus v2.6.5 + SDK 3.0.5）

已跑通真实服务端到端：写入 → 全库 ANN 检索 → 纯语义命中并入 → 按 file 删除传播 → 索引端到端
（`MILVUS_ADDR=http://127.0.0.1:19530 node scripts/vector-store-test.cjs`，`realMilvus: pass`）。
过程中暴露四个「只有真机才会出现」的坑，均已修入 `electron/vectorStore/milvus.cjs`：

1. **不要显式传 `search_params`**：SDK 的 `buildSearchParams` 只在未提供 `search_params` 时才注入
   `topk`；一旦显式传就把你的对象原样透传，服务端直接报 `topk is required`。
   正确形态是简单形态：`{ data:[vec], limit:N, topk:N, anns_field, output_fields, metric_type:'COSINE', params:{} }`。
2. **SDK 的失败不抛异常**：错误放在 `status.error_code` 里（且有的方法返回裸 status、有的包一层 `{status}`），
   若只看 `results` 就会把「请求被拒」当成「零命中」——静默错误。适配器统一走 `assertSuccess()` 转异常，
   于是降级原因能出现在 `stats.vector.error` 与工具文本里。
3. **主键必须显式取回**：命中默认只含 `score` + 请求的字段，`id` 不会自动返回；
   `output_fields` 要写成 `['id', 'file']`，否则索引侧无法把命中映射回 chunk（表现为检索永远 0 命中）。
4. **删除/写入的可见性取决于一致性级别**（默认 Bounded 下按文件删除的旧块约 3s 内仍会被召回，
   刚改完文件就问会遇到旧内容）：检索默认改为 `consistency_level=Strong`（`rag.milvus_consistency` 可切回
   bounded/eventually/session/default），服务端不支持时自动退回服务端默认并在
   `stats.vector.store.consistencyFallback` 记录原因；用例相应补「默认下发 Strong」「被拒后自动退回并仍返回命中」。

建栈要点（2.6 起）：官方 standalone 配方是 etcd + minio + milvus 三件套，**嵌入式 etcd 已不可用**
（`ETCD_USE_EMBED=true` 直接 `panic: embedded etcd can not be used under distributed mode`）；
minio 官方镜像已从 Docker Hub 撤下（404），改用 `quay.io/minio/minio:RELEASE.2024-05-28T17-19-04Z`。
本仓库内的现成 compose（gitignore 区域）：`.cache/milvus-dev/docker-compose.yml`，只暴露 19530/9091。

#### 2.2.1.2 生产参数档（百万级向量 / 1024 维 / HNSW）

按生产环境口径（约百万条向量、每条 **1024 维**、**HNSW** 索引、单次查询 20–50ms）落成的默认档：

| 生产口径 | 配置键（默认值） | 说明 |
| --- | --- | --- |
| 1024 维 | `rag.embed_dim=1024`（+ `rag.embed_dimensions=1024` 用于 OpenAI v3 降维） | local 哈希向量维度上限 8192，1024 合法；真语义建议 `ollama` + `bge-m3`（原生 1024，中文友好）或 `openai` + `text-embedding-3-*` 降维 |
| HNSW 索引 | `rag.milvus_index_type=HNSW` | 建索引参数 `rag.milvus_index_m=16`、`rag.milvus_index_ef_construction=200` |
| 检索召回面 | `rag.milvus_search_ef=64` | HNSW 的 `ef` 经**简单形态的 `params`** 下发（不能显式传 `search_params`，见 2.2.1.1）；须 ≥ 召回条数 |
| 距离度量 | `rag.milvus_metric_type=COSINE` | 与归一化嵌入一致；换 IP/L2 需同步一致 |
| 百万级写入 | `rag.milvus_batch_size=128`、`rag.milvus_flush_every_batches=4` | 逐批 `flushSync` 在百万级下代价过高：每 N 批刷一次，收尾必刷 |
| 召回上限 | `rag.embed_top_k`（默认 40，上限 500） | milvus 后端下即 ANN 的 `topk` |
| 分布式部署 / 读写分离 | 服务端拓扑，**不是客户端参数** | 客户端只需把 `rag.milvus_address` 指向 LB / proxy 入口（多 querynode、WAL 由服务端负责）；本适配器的 create/load/insert/delete 均幂等，可直连分布式集群 |
| 延迟 20–50ms | —— | 主要由服务端规模与 HNSW 参数决定。**同机小 collection 对照实测**（1024 维 / HNSW M16·efC200 / ef64 / topk 40 / Strong 一致性 / 200 条）：p50 **5ms**、p90 6ms、max 7ms（含一次 gRPC 往返，30 轮）；200 条 insert+flush 212ms。百万级下延迟由服务端规模主导，客户端侧只叠加这一趟往返 |

一致性取舍（2.2.1.1 第 4 条）：`strong` 保证「刚改完文件立即可见」，在分布式集群上会带来额外的
同步等待；若生产更看重延迟，可切 `rag.milvus_consistency=bounded`（代价：按文件删除的旧块在数秒内仍可能被召回）。

#### 2.2.1.3 真嵌入验证（bge-m3 / 1024 维，2026-09-15）

链路：`llama.cpp llama-server`（CPU 版，`bge-m3-Q8_0.gguf`，`--embeddings --pooling cls --ctx-size 8192`）
暴露 OpenAI 兼容 `/v1/embeddings` → 本适配器 `embed_provider=openai` 指向它 → Milvus v2.6.5（HNSW/COSINE/Strong）。

- 端到端：`MILVUS_ADDR=… MILVUS_DIM=1024 EMBED_PROVIDER=openai EMBED_MODEL=bge-m3 EMBED_BASE=http://127.0.0.1:8080/v1 node scripts/vector-store-test.cjs`
  → `realMilvus=pass`，`dim=1024`、`indexType=HNSW`、`M16/efC200/ef64`；中文查询 `topVectorScore=0.7033`。
- **语义判别**（哈希向量必然通不过的断言）：中文问句「会话令牌续期怎么做」对
  「刷新令牌实现代码」cosine **0.4597** vs 对「发票金额计算代码」**0.3366** —— 真嵌入能区分相关/无关。
- **语义收益**（`node scripts/vector-store-semantic-probe.cjs`，可复跑）：

  | 中文问句（与代码无词面交集） | 纯 BM25 | 真嵌入 + 全库 ANN |
  | --- | --- | --- |
  | 会话怎么续期 | 0 命中 | `src/auth/session.ts`（0.5218，vector-only） |
  | 账单金额怎么算 | 0 命中 | `src/payments/invoice.ts`（0.5848，vector-only） |
  | 日期格式化 | 0 命中 | `src/format/date.ts`（0.5699，vector-only） |

  这就是 `vector-only` 合并路径的真实价值：BM25 一条都召不回，向量层每次都对。
- 本机取模型的注意点：`huggingface.co` 在本机不可达，用 `hf-mirror.com`
  （`/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf`，605MB）；向 llama-server 发含中文的请求体
  要用 UTF-8 文件承载（Windows 控制台 GBK 会把 body 里的中文转坏，服务端报 ill-formed UTF-8）。

### 2.3 自动路由（名字/具体数据 → 标量库；代码/语义 → 向量库）

`retrieve_context.mode`：
- `auto`（默认）：同时检索标量与项目文件；`ScalarStore.search` 按 key/文本匹配节点属性，
  文件走 BM25 和已配置的向量层。结果中的 `routing` 标明优先查看哪类来源。
- `hybrid`：标量语义 + 文件向量按配置权重融合（标量命中阈值比 auto 更宽松）。
- `scalar`：仅本地标量（精确 key + 语义匹配）。
- `file` / `vector`：仅文件检索。

路由判定由 `routeIntent`（查询关键词打分 + 实际命中情况）完成，全部本地、零网络。

### 2.4 结构索引、关系扩展与结果整理

- TS/JS 使用 TypeScript AST 将函数、类、方法等声明分块；长声明再按行拆分。命中方法或长函数中段时，单独附上可引用的父级声明。其他语言保留原有行级策略。
- 索引项目内符号定义、静态调用、标识符引用和相对导入。跨文件问题或弱匹配时默认沿关系扩展 1 跳；工具参数 `hops` 可限定为 0–2。关系是静态近似，动态分派需深读原文。
- 选块时去掉高度重叠的片段；主片段和父级上下文共用 `rag.max_context_chars` 预算。可选重排器只处理前排候选，发送查询与候选片段到显式配置的 URL；失败时保留 RRF 排序。

## 3. 数据流（一次典型问答）

```
1. Agent 需要画布节点详情
   └─► query_scalars key=node:n1:prompt      → 本地精确值（scalar:n1:prompt）
 2. Agent 需要相关源码
    └─► retrieve_context mode=auto query=…    → AST/行级块 + BM25/向量 → RRF → 有界关系扩展 → 去重/可选重排
 3. 低匹配度时
    └─► 关系扩展候选 / 改写查询 / 缩小 path / read_file 深读 / 标量精确查询
```

## 4. 安全与成本

- 索引、向量、标量全部本地；向量 API 提供方只在显式配置后启用。
- 画布节点 prompt 等数据先存于本地标量库，按需查询后才进入模型上下文；文件引用校验核对本轮读过的路径与行号范围。
- `retrieve_context` / `query_scalars` 结果默认不经过子代理压缩（保证引用/值保真），由 `agent.compression.exclude` 控制。

## 5. 配置速查

```properties
# BM25；也可在项目的「检索设置」中修改
rag.bm25_k1=1.35
rag.bm25_b=0.72
# 向量层
rag.embed_provider=none           # none（默认）| local | openai | ollama
rag.embed_dim=4096
rag.embed_model=                  # openai: text-embedding-3-small / ollama: nomic-embed-text
rag.embed_base=                   # openai: https://api.openai.com/v1 / ollama: http://localhost:11434
rag.embed_key=
rag.embed_top_k=40
rag.graph_hops=1                 # 0=关闭，最多 2
rag.memory_semantic_max_chunks=128  # 学习式嵌入 + memory 的全量扫描上限；超出后回到 BM25 预筛
rag.vector_weight=0.35
rag.rerank_url=                  # 可选完整 POST URL；默认空，使用时发送查询和候选代码
rag.rerank_model=
rag.rerank_key=
rag.rerank_top_k=24
rag.rerank_timeout_ms=10000
# 向量后端
rag.vector_store=memory           # memory（默认）| sqlite（本地持久化）| milvus（外部服务）
rag.milvus_address=http://127.0.0.1:19530
rag.milvus_collection=            # 留空 = codenode_rag_<目录名>_<hash8>
rag.milvus_token=
rag.milvus_username=
rag.milvus_password=
rag.milvus_consistency=strong     # strong（默认）| bounded | eventually | session | default
rag.milvus_index_type=HNSW        # HNSW（默认生产档）| AUTOINDEX | IVF_FLAT ...
rag.milvus_metric_type=COSINE
rag.milvus_index_m=16             # HNSW 建索引 M
rag.milvus_index_ef_construction=200
rag.milvus_search_ef=64           # HNSW 检索 ef（须 ≥ 召回条数）
rag.milvus_batch_size=128         # 单批嵌入+写入条数
rag.milvus_flush_every_batches=4  # 每 N 批 flush 一次，收尾必刷
# 向量层降维（OpenAI v3 模型）
rag.embed_dimensions=
# 标量层
scalars.enabled=true
# 工具结果子代理压缩（减少上下文占用，不压缩 RAG/标量/交互类工具）
agent.compression.enabled=true
agent.compression.threshold_chars=2400
agent.compression.budget_chars=1500
agent.compression.max_calls=8
```

### 5.1 离线检索评测

运行 `node scripts/rag-eval.cjs --out=out/rag-eval-report.json`，会用
`scripts/rag-eval-cases.json` 中固定的问题与目标代码片段，对比默认配置、两组 BM25 参数、
不同哈希向量权重、纯词法及关闭图扩展的结果。报告分别记录文件与目标片段的
Recall@3、Recall@6，以及片段 MRR、
无答案问题的误判率、各问题排名与检索耗时。评测在本地运行，不调用嵌入服务。

这些样例只覆盖当前仓库的少量文件定位问题，适合发现排序回退，不足以证明某个参数或
嵌入模型普遍更好。决定更改生产默认值前，应补入真实使用问题及人工标注的答案片段，
并分别比较精确符号、自然语言改写、跨文件关系和无答案查询。

## 6. 后续演进（未在本期实现）

1. **更细粒度的增量更新**：当前文件级失效与 SQLite 块哈希复用已落地；后续可减少变更文件内未变化块的重嵌入。
2. **更大规模索引**：SQLite 已持久化向量，Milvus 可外置；词法块与关系图仍在进程内，需实测大仓库内存与延迟。
3. **标量命名空间化**：`node:`/`edge:`/`tool:`/`project:` 独立命名空间 + TTL，支持过期清理。
4. ~~**混合路由自动打分**~~ ✅ **已落地**：`ScalarStore.search` 语义检索 + `retrieve_context` 的 `routeIntent` 关键词路由，Agent 无需预判来源。
5. **跨工程标量**：项目模板/共享模块的标量只读复用。
6. **向量后端多租户/共享**：同一 Milvus 服务上按工程分 collection（已按 `codenode_rag_<目录名>_<hash8>` 自动命名），
   进一步支持团队共享语料库与跨机复用索引。
