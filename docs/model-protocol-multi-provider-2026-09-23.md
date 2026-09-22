# 多厂商 / 多协议模型接入（S13，2026-09-23）

> 起因：用户口径「**把模型兼容做全，让 CodeNode 兼容市面上所有主流模型的 api key**」。

## 改造前的问题（可复现的三条）

1. 请求形状写死：`apiBase + '/chat/completions'`、`Authorization: Bearer`。→ **Claude 原生、Gemini 原生、
   Azure 企业版这三档 key 直接不可用**（404 / 401 / 400），而它们的占比在「主流 key」里最大。
2. `reasoning_effort` / `stream_options.include_usage` 的下发只由**全局配置**决定，模型级没有开关；
   「支持推理强度」这个勾选框只影响界面，不勾也照样发 → 对不认该字段的网关每次请求都 400。
3. 输出上限字段名固定 `max_tokens`：OpenAI o 系列 / GPT-5 家族只认 `max_completion_tokens`。
   另有「本地服务免鉴权」被 apiKey 非空检查挡住（Ollama / LM Studio / llama.cpp 配不进）。

## 现在的形状

**协议**与**认证**是两个正交维度，端点风格是第三个：

| protocol | 端点 | 认证（默认） | 关键翻译 |
| --- | --- | --- | --- |
| `openai`（默认） | `{base}/chat/completions`（Azure：`{base}/openai/deployments/<部署名>/chat/completions?api-version=`） | `Authorization: Bearer`（Azure：`api-key` 头） | 无（原生形状） |
| `anthropic` | `{base}/v1/messages` | `x-api-key` + `anthropic-version` | system→顶层；`tool_calls`↔`tool_use`/`tool_result`；`parameters`→`input_schema`；`reasoning_effort`→`thinking.budget_tokens`（被 `max_tokens` 夹住）；SSE `content_block_delta`→`choices[].delta`；`input_tokens`+`cache_read`→`prompt_tokens` |
| `gemini` | `{base}/v1beta/models/<model>:streamGenerateContent?alt=sse` | `x-goog-api-key`（或 `?key=`） | system→`systemInstruction`；assistant→`role:'model'`；tool→`functionResponse`（按 id 反查函数名）；`parameters`→`functionDeclarations` 且**剥掉 `additionalProperties`/`$schema`**（Gemini 的 schema 子集不认）；`maxOutputTokens`；`usageMetadata`→内部用量；`thought:true`→`reasoning` |

**流式一律翻译成 OpenAI SSE 文本再进 `streamAccumulator`** —— 于是「中途断线整轮重发、停滞判定、
重复/累积分片、usage 帧归并、坏 JSON 记 anomaly」这些已经用 `test:stream-*` / `test:stream-recovery`
锁死的语义，四档协议**原样复用**（`openai` 档 translate 是恒等函数，零开销）。

## 用户侧的三条路径

1. **厂商预设**（32 条）：模型管理 → 从预设添加 → 选厂商（国内 14 / 国际 12 / 本地 4 类 / 自定义），
   再「全部加入」；Anthropic / Gemini / Azure 的协议与认证头自动配对，用户不用知道 `/v1/messages`、
   `api-key`、`functionDeclarations` 的存在。
2. **测试连接**：真发一次最小请求；失败时**再补一次最小形态请求**（不带工具 / 思考链 / stream_options），
   据此区分「密钥或地址不对」与「附加字段不认」，并给出可照做的建议（供应商原话照带）。
3. **拉取模型列表**：OpenAI 兼容 `/models`、Anthropic `/v1/models`、Gemini `/v1beta/models`；
   Azure 明确回复「无此端点，模型由部署决定」。

## 验证（`npm run test:model-protocol`，**94 条断言**；核心套件 103 → 104）

四个 mock 服务端**各自严格校验自己的协议**（路径 / 认证头 / 禁用字段，不合规回 4xx）并记录原始请求：

| 组 | 判据 |
| --- | --- |
| A | OpenAI 档**逐字节**不变（原始报文直接字符串比对，含字段顺序）+ 可关字段「消失而不是发空值」 |
| B | Claude 原生：路径 / `x-api-key` / 版本头 / system 提升 / 无 `stream_options`·`reasoning_effort` / `input_schema` / thinking 预算被夹 / 流式正文与工具参数分片 / `stop_reason` 与 usage 映射 / `thinking_delta`→reasoning / 非流式三类块 / **图片→base64 source** / 首条必须 user（补占位 + 负向不补）/ 相邻同角色合并 |
| C | Gemini 原生：`:streamGenerateContent?alt=sse` / `x-goog-api-key` / `systemInstruction` / `functionDeclarations` / **全树无 `additionalProperties`** / `maxOutputTokens` / `functionCall`→工具调用 / `functionResponse` 按 id 反查函数名 / `usageMetadata` / `STOP`→`stop` / **图片→inlineData** / 首条必须 user |
| D | Azure：部署名路径 + `api-version` + `api-key` 头（`Authorization` 必须缺席）+ 可单独指定部署名 |
| E | **端到端**：真实 `runAgentChat` + 真实工具注册表跑完 Claude 原生两轮工具循环，第 2 轮请求里出现 Anthropic 形状的 `tool_result` 且 `tool_use_id` 与上一轮 `tool_use` 对得上 |
| F | **判别力**：协议接错 → 404、认证头接错 → 401（证明 A–D 不是空转） |
| G | 预设清单点名（22 家主流厂逐个核对，共 32 条）+ 协议白名单 + 预设→模型条目的字段完整性 |
| H | 存储往返：协议别名归一（`CLAUDE`→`anthropic`）、非法值收敛、seed 不漂移 |
| I | 接线：四条新通道（presets / preset-apply / test / fetch）主进程 → preload → 类型 → UI 四段齐全 |
| J | **通道级**：注入确定性密钥环桩后真跑四个 handler —— 落盘加密（文件里无明文）、`models:test` 如实回报协议与延迟、失败时 404 + 建议 + 最小形态对照、Azure 无列表端点如实说明、`models:list` 只回 `apiKeySet` 布尔 |

## 变异校验（7/7 被杀）

判据本身也要有判别力：把源码真改错一遍，用例必须红在**预期的那条断言**上。

| 变异 | 结果 |
| --- | --- |
| 不把 system 提升为顶层参数 | 红在 B4 |
| Claude 用 `Authorization: Bearer` | 被服务端 401 拒掉 |
| 不剥 Gemini 不认的 schema 关键字 | 被服务端 400 拒掉 |
| OpenAI 档多下发一个字段 | 红在 A3（逐字节） |
| 不下发 thinking 预算 | 红在 B7 |
| 用量帧只替换不合并 | 红在 B11 |
| UI 把「拉取模型列表」的方法名写错 | 红在 I 组 |

其中两条**第一次是存活的**，修的是判据不是实现：③ 夹具里的工具 schema 没带 `additionalProperties`
（生产注册表 `closeInputSchema()` 会加）→ C5 空转；⑦ 接线断言原本只判「字符串出现过」→ 写错方法名照样通过。
两条都改成与生产同形 / 按函数体内的调用形态判之后被杀。

## 如实说明（未验证 / 需用户自己的 key）

- **没有用真实厂商 key 跑过**：本轮的取证全部是「协议形状 + 服务端视角」，真机验证要靠用户自己的 key
  （界面里的「测试连接」就是为这条准备的）。CI 侧留了口子：`CODENODE_E2E_PROTOCOL` / `_AUTH` / `_ENDPOINT`
  三个变量可把 `test:provider-smoke` 切到非 OpenAI 档（真实 key 由 secret 注入）。
- **预设里的模型 ID 与价格会过期**：价格只写有把握的（DeepSeek / OpenAI / Anthropic / Gemini 公开价），
  人民币计价的国内厂商一律留 0（0 = 不参与成本统计），模型 ID 请以「拉取模型列表」的结果为准。
- **Gemini 的 thinkingConfig 只做档位映射**（low/medium/high → 预算），未按 2.5 pro / flash 分别调参。
- **Azure 的「列出模型」不存在**，模型由部署决定 —— 界面与 IPC 都如实返回这条说明，不编造列表。
- **AWS Bedrock / Vertex AI** 走 SigV4 / OAuth 签名，不属于「api key 直连」这一档，本轮未纳入。
