# Agentic RAG 标量化 + 向量化方案

> 目标：让本地 Agentic RAG 在「需要精准数据时走标量查询，需要语义联想时走向量查询，混合场景自动融合」，
> 全程零云端索引，精准数据（画布节点 prompt/属性等）不随上下文返回云端。

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
                    │  │ scalars.json │   │ provider=local        │ │
                    │  │ node:<id>... │   │   (n-gram 哈希向量)    │ │
                    │  └──────────────┘   │ provider=openai/ollama│ │
                    │                     └──────────┬──────────┘ │
                    │  ┌─────────────────────────────▼──────────┐ │
                    │  │ 文件索引 LocalRagIndex（BM25 增量缓存）    │ │
                    │  └────────────────────────────────────────┘ │
                    │  向量后端 rag.vector_store：                 │
                    │    memory（默认，进程内记忆化 + BM25 预筛）   │
                    │    milvus（可选，外部服务 + 全库 ANN）        │
                    └──────────────────────────────────────────────┘
```

### 2.1 标量层（精准数据，本地 KV）
- **存储**：`electron/scalars/index.cjs` → `<root>/.codenode/scalars.json`，原子写入，按工程根缓存单例。
- **写入**：画布工具（`get_workbench_model` / `workbench_edit` / `bulk_edit` / `write_analysis_md`）执行时，
  把节点完整属性（`name/label/prompt/goal/members/filePath/role/status/position` 等）写成标量
  `node:<id>`（完整对象）与 `node:<id>:<attr>`（单属性），**不随工具结果返回上下文/云端**。
- **读取**：
  - `query_scalars`：`key=node:n1` / `key=node:n1:prompt` / `prefix=node:` 精确查询。
  - `retrieve_context mode=scalar`：标量精确/语义命中，来源以 `scalar:<key>` 引用。
  - `retrieve_context mode=auto`：**自动路由**，查询含节点名字/prompt/具体数据/属性时按语义在标量库查找（无需精确 key）。
- **隔离**：`.codenode/` 被 RAG 硬排除（`EXTRA_IGNORED_DIRS`），标量内容永不进入文件检索索引。

### 2.2 向量层（语义联想，可插拔）
- **接口**：`electron/embedder/index.cjs`，`embed(texts) → vectors`，统一 `cosine(a,b)`。
- **provider**：
  - `local`（默认）：确定性 n-gram 哈希向量（FNV-1a 桶 + 正负号 + L2 归一），无网络、跨会话稳定。
  - `openai`：`rag.embed_base + embed_key + embed_model`，走 `/v1/embeddings`。
  - `ollama`：`rag.embed_base + embed_model`，走 `/api/embeddings`。
  - `none`：关闭向量层，退化为纯 BM25。
- **融合策略（agentic）**：BM25 先做**预筛**（`rag.embed_top_k`，默认 40），只对预筛候选做向量余弦，
  兼顾效率与召回；向量分 `vectorScore * 100 * weight` 并入 `rankScore`，`mode` 决定权重：
  - `file`：weight=0（纯词法）
  - `auto`/`hybrid`：weight=`rag.vector_weight`（默认 0.35）
  - `vector`：weight=1（语义优先）

### 2.2.1 向量后端（`rag.vector_store`，chunk 向量存哪里）

| 后端 | 位置 | 检索方式 | 外部依赖 |
| --- | --- | --- | --- |
| `memory`（默认） | 进程内 `Map`（记忆化） | 仅对 BM25 预筛 Top-K 打余弦 | 无 |
| `milvus` | 外部 Milvus collection | **全库 ANN**（不受 BM25 预筛限制），命中并回 BM25 结果一起融合 | Milvus 服务 + `@zilliz/milvus2-sdk-node` |

- 实现：`electron/vectorStore/{index,memory,milvus}.cjs`；`LocalRagIndex` 只依赖统一契约
  （`prefiltered / applyChanges / scoreCandidates / dropLocal / stats / close`），两种后端可互换。
- **写入时机**：`refresh()` 只收集「本次重新分块的文件」与「变更/删除文件的旧块」，
  `retrieve()` 开头调用 `syncVectorStore()` 落库（先按 `file` 过滤删除旧块，再写入新块），
  未变文件不重写——向量写入天然是增量的。
- **纯语义命中**：milvus 后端命中的块若 BM25 完全未召回，会以 `vector-only` 并入结果
  （要求向量贡献 ≥ 1 分，避免灌入无关行），工具文本中标注 `vector-only（BM25 未召回，仅语义命中）`。
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

### 2.3 自动路由（名字/具体数据 → 标量库；代码/语义 → 向量库）

`retrieve_context.mode`：
- `auto`（默认）：**自动路由**。`ScalarStore.search` 对标量库做语义检索（无需精确 key），
  名字/prompt/具体数据/属性类查询或形如 `node:` 的 key 命中时并入 `scalar:<key>` 来源并提升可信度；
  代码/文档/语义联想查询走文件 BM25(+向量) 检索（`path#Lx-Ly`）。
  混合场景两类来源都返回，并在结果中给出 `routing` 决策（`标量库优先 / 向量库优先 / 混合`）说明应优先采信哪一类。
- `hybrid`：标量语义 + 文件向量按配置权重融合（标量命中阈值比 auto 更宽松）。
- `scalar`：仅本地标量（精确 key + 语义匹配）。
- `file` / `vector`：仅文件检索。

路由判定由 `routeIntent`（查询关键词打分 + 实际命中情况）完成，全部本地、零网络。

## 3. 数据流（一次典型问答）

```
1. Agent 需要画布节点详情
   └─► query_scalars key=node:n1:prompt      → 本地精确值（scalar:n1:prompt）
2. Agent 需要相关源码
   └─► retrieve_context mode=auto query=…    → BM25 预筛 → local 向量余弦 → RRF 融合
3. 低可信度时
   └─► 改写查询 / 缩小 path / retrieve_context mode=vector / 标量精确查询
```

## 4. 安全与成本

- 索引、向量、标量全部本地；向量 API 提供方只在显式配置后启用。
- 画布节点 prompt 等精准数据不发送云端（标量层落地）；文件检索结果仍受 `path#Lx-Ly` 引用白名单校验。
- `retrieve_context` / `query_scalars` 结果默认不经过子代理压缩（保证引用/值保真），由 `agent.compression.exclude` 控制。

## 5. 配置速查

```properties
# 向量层
rag.embed_provider=local          # local | openai | ollama | none
rag.embed_dim=4096
rag.embed_model=                  # openai: text-embedding-3-small / ollama: nomic-embed-text
rag.embed_base=                   # openai: https://api.openai.com/v1 / ollama: http://localhost:11434
rag.embed_key=
rag.embed_top_k=40
rag.vector_weight=0.35
# 向量后端
rag.vector_store=memory           # memory（默认）| milvus（外部服务，需 npm i @zilliz/milvus2-sdk-node）
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

## 6. 后续演进（未在本期实现）

1. **向量增量失效**：文件变更时同步失效对应 chunk 向量，避免本地 API 向量重算全量。
   （已部分落地：milvus 后端按文件 delete+insert；chunk 级复用仍未实现）
2. **索引内存换磁盘**：chunk 向量/词频持久化，支持大仓库内存可控。
   （已部分落地：milvus 后端把向量外置到服务端持久化；memory 后端仍全内存）
3. **标量命名空间化**：`node:`/`edge:`/`tool:`/`project:` 独立命名空间 + TTL，支持过期清理。
4. ~~**混合路由自动打分**~~ ✅ **已落地**：`ScalarStore.search` 语义检索 + `retrieve_context` 的 `routeIntent` 关键词路由，Agent 无需预判来源。
5. **跨工程标量**：项目模板/共享模块的标量只读复用。
6. **向量后端多租户/共享**：同一 Milvus 服务上按工程分 collection（已按 `codenode_rag_<目录名>_<hash8>` 自动命名），
   进一步支持团队共享语料库与跨机复用索引。
