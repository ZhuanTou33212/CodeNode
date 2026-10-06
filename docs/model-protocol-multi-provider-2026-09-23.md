# 模型接入：一个 API Key 就够（2026-09-23，承 8b39ba3 后按反馈精简）

> 用户反馈原文：「你只需要提供 api key 接口，其他的根本不需要，请删除」。
> 本轮把**界面上**多出来的东西全删掉，**协议适配留在后台**（Claude / Gemini / Azure 的 key 靠它才连得上），
> 改成按 API 地址自动判定 —— 用户只需要填一个 Key（以及地址/模型 ID），不用选厂商、协议、认证方式。

## 现在长什么样

模型管理（`src/components/ModelManager.tsx`）回到改动前的形态：显示名称 / 模型 ID / API 地址 / API Key /
上下文窗口 / 三个价格 / 支持推理强度 / 视觉 / 启用。**没有任何**厂商下拉、协议选择、认证头、端点风格、
「测试连接」、「拉取模型列表」。

协议与端点由 `electron/modelProtocol.cjs` 的 `resolveProtocol()` / `normalizeEndpoint()` 从地址判定：

| API 地址 | 协议 | 认证 | 端点 |
| --- | --- | --- | --- |
| `api.anthropic.com`（或含 `/v1/messages`） | anthropic（`/v1/messages`） | `x-api-key` + `anthropic-version` | 标准 |
| `generativelanguage.googleapis.com`（或含 `/v1beta`） | gemini（`contents` + `functionDeclarations`） | `x-goog-api-key` | 标准 |
| `*.openai.azure.com` | openai | `api-key` | azure（部署名路径 + `api-version`） |
| 其余（DeepSeek / Qwen / Kimi / GLM / 豆包 / OpenRouter / Groq / Ollama…） | openai（`/chat/completions`） | `Authorization: Bearer` | 标准 |

语义要点：
- **判定是确定性的、离线的**（只看域名特征，不做联网探测）；判不出来回落 OpenAI 兼容。
- **「未指定」与「指定 openai」是两回事**：`models.json` 里留空 = 按地址判定；写了 `openai` 就以此为准。
  归一化函数（`modelStore.normalizeModelInput`）对未知/缺省值一律**留空**，不钉成 openai ——
  钉死会让「把地址改成 Claude」的模型突然 404。
- 想强制指定仍有两处：`config/agent.properties` 的 `api_protocol`，或模型条目里的 `protocol` 字段（界面不暴露）。

## 删除清单（本轮）

- 界面：厂商预设下拉、「全部加入」、接入协议区（协议/认证头/输出上限字段/端点风格）、Azure 部署名与
  api-version 输入、价格提示行、测试结果框、模型列表选择器、「测试连接」「拉取模型列表」按钮、列表项协议标签；
  相应 CSS 段一并删除。
- 主进程：`models:presets` / `models:preset-apply` / `models:test` / `models:fetch` 四条通道、
  `electron/providerPresets.cjs`（32 条预设目录）、`buildModelListRequest` / `parseModelList`。
- 类型与桥：`preload.cjs` 的四条方法、`global.d.ts` 的方法声明与两个预设/测试 DTO。

保留（都属于「不是界面、也不是网络行为」的部分）：`electron/modelProtocol.cjs` 的协议翻译、
`bin/codenode-agent.cjs` 与 `scripts/agent-eval.cjs` / `provider-smoke.cjs` 的 `*_PROTOCOL/_AUTH/_ENDPOINT`
环境变量覆盖（headless / CI 真机档）、`config/agent.properties.example` 里的可选配置键。

## 判据（`npm run test:model-protocol`，**79 条断言**；核心套件仍 104 项）

- A–D：四档协议的请求形状与流式/非流式解析（OpenAI 兼容档**逐字节**不变、Claude 原生、Gemini 原生、Azure）
- E：真实 `runAgentChat` + 真实工具注册表跑完 Claude 原生两轮工具循环
- F：判别力（协议接错 → 404、认证头接错 → 401）
- **G：协议自动判定**（Claude/Gemini/Azure 地址各归各位；普通地址**仍是** openai + standard + Bearer；
  显式声明优先；空地址不炸；判定结果真的进了请求构造 —— URL 与认证头逐条核对）
- H：`models.json` 往返（别名归一、未知值留空、种子不带协议字段）
- **I：界面精简的负向断言**（界面里没有预设/协议/认证/端点/测连接/拉列表字样；preload 与类型声明同步删除；
  主进程只剩 4 条模型通道；预设库文件确实不存在；`resolveProtocol` 真的被 `buildRequest` 用到）

## 如实说明

- 自动判定靠**域名特征**：把自建/内网端点伪装成 Claude 域名是不可能的，这类场景请写 `api_protocol`。
- 没有用真实厂商 key 跑过（本机无 key）；真机连通性仍需你实际配一次。
- 本轮改动没有新增 UI 交互，界面点击级验证回到「改动前形态」（该形态此前已在真实使用中）。
