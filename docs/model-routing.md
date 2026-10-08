# 显式模型路由与故障转移

`electron/modelRouting.cjs` 为真实模型请求选择候选；主请求、子代理、意图分类和两类压缩共用请求队列及 Run 的 Token、重试、费用预算。没有配置时仍使用当前选中模型及原有重试策略。

在全局 `config/agent.properties` 或项目 `.codenode/agent.properties` 中配置，例如：

```properties
# 候选 ID 与供应商的 model ID 分开；以下模型名称需替换为服务实际支持的名称。
agent.model_candidate.economy.model=your-small-model
agent.model_candidate.economy.max_tokens=4096
agent.model_candidate.economy.reasoning_effort=off
agent.model_candidate.backup.model=your-backup-model

# 调用用途：main、subagent、intent、compression、compaction。
# 桌面和命令行也可显式映射 code/research/ops/canvas/orchestration/chat 等任务类别。
agent.model_route.compression=economy
agent.model_route.compaction=economy
agent.model_fallbacks=backup

# 候选共用原本请求次数上限；至少两次 HTTP 额度才能尝试备用模型。
agent.request_max_attempts=3
agent.max_total_retries=12

# 费用硬上限开启时，所有可能使用的模型都必须有显式单价。
agent.max_cost_usd=1
cost.price.your-small-model=0.1,0.2
cost.price.your-backup-model=1,2
```

按任务路由是明确任务类型到候选的映射；已有任务识别器提供 code/research 等类别，只有对应配置存在才改变模型，否则沿用 main。子代理优先采用 subagent 用途映射，避免继承父任务类别。工具名单、权限、沙箱和用户审批不会因为换模型放宽。调用 API 时还可用 `options.taskType` 指定其他已配置的任务类型。系统没有额外调用分类模型猜测任务复杂度。

候选可选字段：`api_base`、`api_protocol`、`api_auth`、`api_endpoint`、`api_version`、`azure_deployment`、`anthropic_version`、`max_tokens_field`、`api_key_env`、`max_tokens`、`reasoning_effort`。`model` 必填。除显式覆盖的字段外，候选继承当前请求配置；输出上限只允许降低，不扩大当前请求预留。Azure 候选须用对应部署名配置 `azure_deployment`。

跨服务候选的 `api_base` 改变 origin 时必须配置自己的 `api_key_env`，运行时读取该环境变量；主模型密钥不会复制到另一个服务。协议与认证相关字段跨服务默认清空，交给协议层按地址识别，需要时显式声明。候选明文密钥不写入 properties，也不进入路由事件。

发生网络连接故障、流停滞、流不完整或 HTTP 408/429/500/502/503/504 时，才按 `agent.model_fallbacks` 顺序尝试已配置候选。备用耗尽后可在原有次数和时间额度内重试最后一个候选。参数/认证/授权错误、取消、总超时、Token/重试/费用额度错误、缺少价格、无效配置均不会绕过错误切换模型。费用按每次请求的实际模型单价预留，所有候选共享同一预算；候选数量不会放大 HTTP 次数上限。

失败流中的正文、推理和未完成工具调用在重试前作废。主循环发送既有 `content_reset`，后续工具仅来自成功的新流。每次切换记录 `model_fallback` 与结构化原因；任务选择记录 `model_route`。成功用量记录实际模型，失败请求继续计入预算与账本。

费用硬上限开启且请求带图片时，每个实际候选还需配置 `cost.image_input_tokens.<model>` 每图输入上界；换模型不会继承另一模型的图片计费假设。Gemini 的响应候选与思考 Token 一起计入输出，符合[官方用量说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking)；其他无法归入输入/输出的总量差额按配置最高单价保守占用预算，账本保留计费不确定性。

验证：`node scripts/core/model-routing-test.cjs` 使用本地真实 HTTP 服务，覆盖候选模型请求、生产压缩任务接线、断流复位、非重试错误、实际模型账单，以及父子共享 Token/重试/费用上限。测试不调用收费模型。
