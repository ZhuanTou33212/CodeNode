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
                    │ 本地层（零云端索引）                          │
                    │  ┌──────────────┐   ┌─────────────────────┐ │
                    │  │ 标量库 ScalarStore                        │ │
                    │  │ .codenode/   │   │ 向量层 Embedder        │ │
                    │  │ scalars.json │   │ provider=local        │ │
                    │  │ node:<id>... │   │   (n-gram 哈希向量)    │ │
                    │  └──────────────┘   │ provider=openai/ollama│ │
                    │                     └─────────────────────┘ │
                    │  ┌─────────────────────────────────────────┐│
                    │  │ 文件索引 LocalRagIndex（BM25 增量缓存）    ││
                    │  └─────────────────────────────────────────┘│
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
2. **索引内存换磁盘**：chunk 向量/词频持久化，支持大仓库内存可控。
3. **标量命名空间化**：`node:`/`edge:`/`tool:`/`project:` 独立命名空间 + TTL，支持过期清理。
4. ~~**混合路由自动打分**~~ ✅ **已落地**：`ScalarStore.search` 语义检索 + `retrieve_context` 的 `routeIntent` 关键词路由，Agent 无需预判来源。
5. **跨工程标量**：项目模板/共享模块的标量只读复用。
