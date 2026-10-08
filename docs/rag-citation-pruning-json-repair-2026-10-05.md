# 引用对齐、旁支裁剪与判定 JSON 修复

## 实现与交付边界

本次修复接入严格交付配置（来源 enforce 或语义 enforce）。没有修改用户原有默认 warn/off 偏好；不能把严格实验描述为默认配置的安全保证。

### 1. 引用绑定容错

`electron/rag/deliveryRepair.cjs` 从 currentEvidenceCalls 后的实际可读来源寻找同文件、包含原引用的最小读取范围，只在该范围内扩展前后各最多 4 行。没有新读取权限，不跨文件、不跨读取间隙、不扩展越界/倒序/未知引用，也不扩展半行读取记录。保留原回答事实文本与链接标签。引用更改后重新跑事实判定、位置和当前文件版本门，未通过则不交付。

### 2. 旁支降级裁剪

只对已得到 entailed 核心事实但仍有 insufficient/contradicted 断言的草稿尝试。模型可从 eligible 列表选择最多 6 条完整行删除，不能改写、替换数值或任意生成新正文；混合已支持与未支持事实的行、重复无法对应的行不允许删除。

规划与独立覆盖检查分开：覆盖检查根据原问题和原/新正文枚举每项必要事实、条件、否定、范围和跨文件关系，必须提供原问题及保留正文的逐字引句。任一项 missing、未知、无效 JSON，裁剪均不批准。候选之后再过完整事实、位置、版本校验；“planner 认为可删”不是交付依据。未支持全部核心事实时保留原来的阻断/限定范围拒答流程。

### 3. 判定 JSON

事实判定分为每批最多 4 个断言，跨批保留原始 ID，校验每批全部 ID、唯一性和逐字证据，任一批失败则整轮不计支持。24 条总断言上限保持。

judgeJson 接受带 content/finishReason 的模型结果；即便 JSON 可以 parse，finishReason=length/max_tokens 仍标为 JUDGE_OUTPUT_TRUNCATED。格式订正只允许一次，要求短 reason、最少必要引句和完整 ID。该次输出预算从 3072 提升至 6144，所有调用仍共用 Run token/cost 预算；没有无限重试。API/预算错误不伪装为格式错误。

每批结果带 protocol（尝试次数、finishReason、字符数、错误码），生产 trace 记录 judge_protocol。合法 JSON 只是协议有效，不代表事实判定准确；没有降低原文证据真实性和完整断言覆盖要求。

## 验证

- 新增脚本 `scripts/core/rag-delivery-repair-test.cjs`：未读/越界/半行限制、事实文本不变、缺核心不能裁剪、裁剪后事实仍失败则不交付、分批完整 ID、截断的合法 JSON 仍需修复、真实 runAgentChat 最终发布与版本门。
- 最终完整核心回归 136/136 通过，静态检查与构建通过。首轮发现现有 UI 新模型菜单渲染测试缺失浏览器全局尺寸；补齐测试模拟后 87 条渲染断言通过。未删除无障碍断言。
- 打包 worker 测试新增包内引用对齐与 JSON 截断保护；通过。界面脚本按照当前项目导航 + Agent 侧栏布局检查连续且不重叠，并验证文件树/输入区；7 项通过。
- 先独立暂存并自检，再确认 CodeNode 未运行后原位替换，无旧备份。固定路径 E:/CodeNode/release/win-unpacked/CodeNode.exe。
- 固定目录之后出现另一次包更新，已重新核验其中 5 个核心模块（agent、faithfulness、judgeJson、deliveryRepair、citations）的 SHA256 与冻结评测代码逐个相同，并再次通过固定包 worker/启动自检。未覆盖该后续新包。
- 最新核验 EXE 244440576 字节，ASAR 9908568 字节；当前固定包 fresh 自检 exit=0、ok=true、appPath 指向固定 resources/app.asar。identity 清单在 out/rag-repair-fixed-code-identity.json，最终交付验核在 out/rag-repair-final-delivery.json（启动前后包哈希稳定）。

## 真实模型对照

6 道典型题使用相同冻结题集、deepseek-chat、production/native-read-only、同评分规则复跑，从先前诊断的 3/6 变为本轮 6/6。只有 S19、X13 显示接受了自动引用修复，其余变化不能全部归因于裁剪。诊断样本已暴露，单次随机复跑不能推导全局准确率。

完整 100 题于 2026-10-05 11:37:58 UTC 终态，100 个唯一题号全部完成执行与评分，错误均为 0。题集、模型、单题预算、压缩、production/native-read-only 和 v2 评分器一致；完整运行时 SHA256 差异仅为上述 5 个修复文件，见 out/rag-repair-runtime-manifests.json。

| 指标 | 修复前 | 修复后 | 变化 |
| --- | ---: | ---: | ---: |
| 总任务通过 | 57/100（57%） | 63/100（63%） | +6 个百分点 |
| 正样本通过 | 41/70（58.57%） | 50/70（71.43%） | +9 题，+12.86 个百分点 |
| 单文件 | 28/40（70%） | 34/40（85%） | +6 题 |
| 跨文件 | 13/30（43.33%） | 16/30（53.33%） | +3 题 |
| 负样本安全应答通过 | 16/30（53.33%） | 13/30（43.33%） | -3 题 |
| 严格参考锚点总通过 | 57/100 | 61/100 | +4 题 |
| 最终 JSON 格式失败 | 4 | 0 | 按 JUDGE_JSON_INVALID/JUDGE_OUTPUT_TRUNCATED 统计 |
| 最终 unknown | 6 | 2 | 新剩余为 X23 Claim limit exceeded 与 N06 JUDGE_QUOTE_INVALID |
| 执行错误 / 评分错误 | 0 / 0 | 0 / 0 | 均完整 |

**结论：本次正样本与总任务一致率改善，但负样本安全应答通过率下降，不能称三项修复已经解决所有可靠性问题。** 新的 17 道负样本失败全部 groundingBlocked=true，没有作为最终答案交付；同模型评分器未检出交付答案虚构实现，这不等同独立人工证明真实误放为零。

此前把 5 道负样本 unknown 简称“JSON 异常”不准确：旧完整基线实际为 4 道 JSON 格式失败 + N12 引句真实性失败；另有正样本 X19 引句真实性失败。本页按 failureCode 纠正口径。最终失败数没有统计所有已在中途修复的格式错误，不能说每个原始模型响应都无异常。

新评测记录了 9 道被接受的自动修复，均任务通过：S02、S06、S18、S23、X04、X17、X24、N25、N28；其中 S06、S18 删旁支（各 1 行），其余为引用范围对齐。不要把这 9 道修复都当作相对旧基线的因果增益，部分旧版本本已通过，且两次随机轨迹不同。

资源代价：Run 预算计数 5247394→5980257，约增加 14%；平均单题耗时 17.49s→22.63s，约增加 29%。预算计数不是供应商实际账单；旧基线由 90+10 余额恢复批次合并，本轮为单批，性能和随机性比较均需保留该差异。分批和裁剪的附加判定仍受现有共享 Run 预算约束。

下一步优先处理剩余 17 道负样本的范围拒答阻断、N06 引句真实性，以及 X23 超过 24 条断言；同时继续独立人工复核、新未污染验收与分项消融。

已观测到真实裁剪：S06 去掉不能从来源核实的工具调用旁述，保留 CRLF/CR/LF 事实；S18 去掉未获得全项目证明的“没有其他调用点”旁支，保留自然语言完成条件 enforced=false 及其范围。两题都通过独立核心覆盖和最终事实/位置/版本检查。原草稿、引用变更、删除行和覆盖引句保留在 grounding.deliveryRepair。

## 产物

- out/rag-repair-runtime：独立冻结运行时，源代码没有凭据。
- out/rag-repair-diagnostic-6.json 与 out/rag-repair-diagnostic-comparison.json。
- out/rag-repair-agent-100.json：完整 100 题真实任务原始结果。
- out/rag-repair-full-comparison.json：完整前后对照、配对题号增减、9 道修复审计与资源计数。
- out/rag-repair-agent-100-summary.json：完整分组和失败分类。
- out/rag-repair-final-core.log：136/136。
- out/rag-repair-fixed-code-identity.json、out/rag-repair-final-fixed-selftest.json。

评测题集是已暴露的 AI 作者回归集，尚无独立人工标签复核，生成和评分使用同模型。这里报告任务一致率，不称作真实独立验收准确率。
