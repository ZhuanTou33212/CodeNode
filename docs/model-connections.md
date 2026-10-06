# 模型连接与选择

管理模型默认采用连接流程：选择供应商 → 填 API Key → 获取模型 → 选择模型 → 连接并使用。已连接的模型可搜索并切换。现有 18 个供应商预设：DeepSeek、OpenAI、Anthropic、Gemini、百炼国内/新加坡、Kimi、GLM、豆包/方舟、文心/千帆、硅基流动、OpenRouter、Groq、Mistral、Grok、MiniMax 国内/国际、Together AI。

另支持自定义 OpenAI 兼容 HTTPS 地址和本机 HTTP 地址（Ollama、LM Studio 等）；本机免鉴权服务可不填 Key。自定义端点的模型 ID 包含地址指纹，不同端点不会互相覆盖凭据。地址不可带用户名、密码、查询或 fragment；任意远程 HTTP 与自动重定向被拒绝。

不开放 /models 的供应商可展开选填模型/部署 ID，不会猜测或伪造清单。手动入口仅配置模型，不发送验证调用，也不宣称已经鉴权。地区、Coding Plan、企业工作空间和 Azure 等特殊端点可通过兼容入口指定对应地址/部署配置；独立协议和授权方式仍受现有 OpenAI/Anthropic/Gemini 适配范围限制，不是无限制支持所有 API。

不依赖静态模型名称清单：向用户明确选择的供应商查询实时模型列表。相同的 `sk-` 格式可能属于不同供应商，因此不扫描多个厂商试探 Key。读取模型清单不证明所有模型都拥有推理调用权限；权限、余额、地域和接口能力仍由供应商实际调用决定。列表不返回能力字段时不猜测视觉/推理强度，价格不由用户填写，也不伪造供应商单价。

Key 不进入模型列表返回值，不放 URL、不跟随重定向；主进程暂存的连接凭证绑定窗口、十分钟到期，确认连接后由 Electron safeStorage 加密保存。关闭/失效的旧凭据不会在保存新连接时被重新加密或清空。

旧 Key 解密失败时，列表保留模型元数据并显示“需重新连接”。重新填写有效 Key 可以接入新的模型，不能从已损坏的密文恢复原 Key。其他模型仍正常读取；切换激活模型只验证其自身凭据。

验证：供应商目标隔离、HTTP 错误、分页、无明文 Key 返回的离线测试；真实 Electron UI + IPC + 操作系统加密存储验证，覆盖失效 Key、选模型、加密保存、旧密文保留与窄窗口。测试使用合成 Key 和供应商响应替身，未声称真实账号访问权限已验证。

接口参考：[DeepSeek 模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic 模型列表](https://platform.claude.com/docs/en/api/models/list)、[Gemini 模型列表](https://ai.google.dev/api/models)。
