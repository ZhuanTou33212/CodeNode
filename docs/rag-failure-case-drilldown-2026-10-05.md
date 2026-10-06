# RAG 未通过题逐题下钻与典型抽检

## 先核对统计口径

后续状态：三项修复及完整 100 题对照已完成，见[修复报告](rag-citation-pruning-json-repair-2026-10-05.md)。本页保留修复前下钻数据。此前“5 道负样本 JSON 异常”的简称需要更正：实际为 4 道 JSON 格式异常 + N12 引句真实性失败；unknown 不等同 JSON 格式失败。

来源：`out/rag-stages-after-completed-100.json`，57/100 通过；43 道唯一未通过题。原始 100 题成绩未修改。

| 分组 | 数量 | 实际交付状态 |
| --- | ---: | --- |
| 负样本失败 | 14 | 全部 groundingBlocked=true，错误草稿没有作为最终答案放行 |
| 正样本失败 | 29 | 20 道被强制阻断，8 道交付限定范围拒答，1 道 X26 交付了未满足问题的答案 |
| 其中跨文件失败 | 17 | 是上述 29 的子集，不另加；14 道已有完整参考证据，3 道缺证据 |

“负样本失败”不能写成“负样本放行”。“正样本失败”也不等于 29 道都被误杀。原始失败中有 5 道引用位置失败（S22、S29、S40、X03、X13），6 道最终判定 unknown（X19、N01、N12、N16、N19、N27），这些归因可重叠。

跨文件缺完整参考证据的题为 X04、X13、X26；其余 14 道更值得先查生成/引用/校验。此处完整证据只说明原始运行的来源池包含参考锚点，不说明模型实际使用或蕴含了正确答案。

## 证据留存与方法

原始评测保存了最终答复、被拒草稿、最终 grounding 和完整参考证据覆盖标记，但没有逐次工具调用和每次校验的完整记录。安全拒答 fallback 又可能覆盖初始判定结果。因此不能回头声称知道原始 3 道缺证题的第一跳原因，也不能从最终 abstained 反推出原草稿为什么失败。

新增 `scripts/rag-agent-case-diagnostic.cjs`，对 S04、S19、X11、X13、N22、N27 六题复跑。使用原冻结 after runtime、同模型、原题集和 production/native-read-only 配置；新增完整工具序列、来源池、对话与 grounding 事件记录。诊断为新的随机运行，不替换原始 100 题，不计入新通过率。

结果：3/6 通过（S04、S19、N27），3/6 未通过（X11、X13、N22），执行/评分错误 0。复跑改变了轨迹，不能用新轨迹冒充原运行。

## 典型 Case

| Case | 原始问题与失败 | 诊断所见 | 判断 |
| --- | --- | --- | --- |
| N22 | Vault 动态凭据机制；草稿从环境变量代码推导全项目没有 Vault/轮换 | 在 candidateConfig 等局部文件有证据；“整个快照没有 Vault”和“唯一凭据机制”没有全范围证明，被校验阻断 | 校验阻断具有合理依据，不是错误答案放行；应回答当前证据范围与限制 |
| N27 | 外部 schema 注册中心；最终 JSON 判定不完整，unknown | 首次 retrieve_context 已有 !reference.startsWith('#/')；补读 outputSchema 后最终通过。途中一次 quote 真实性失败引发订正 | 原失败是判定协议/格式错误，不是放行；复跑通过不证明原判定 JSON 错误原因已修复 |
| X13 | 答案断言上限与跨服务凭据两问；原始缺完整证据并有未读引用 | 复跑第 1 个工具已获 claims.length > 24，第 2 个工具已获凭据分支；但草稿引用后的来源投影不含 24 条上限，校验看不到关键行 | 此次不是第一跳未召回，而是生成引用范围导致证据投影丢失；也有核心行为推理被判不充分 |
| X11 | 4000 字符上限与 contains 的 null/undefined 处理；原始完整证据已到 | 复跑两个核心事实都被判 entailed；原运行旁支 2000 字符缺证据，复跑新增“两个链各有独立预算”被判 insufficient；整答阻断 | 无关补充断言把核心正确答复拖入阻断；存在判定过严嫌疑，不能等同漏召回 |
| S19 | 条件文本 trim；原始交付拒答，最终理由转而讨论输出侧 trim | 复跑精确区分条件文本与输出，通过 | 有对象绑定/问法歧义嫌疑；未稳定复现，不能量化成已确认误杀 |
| S04 | 默认 embedding=none；原始完整证据已到但 fallback 拒答 | 复跑先因 vectorStore 默认配置旁支缺证据订正，移除旁支后通过 | 旁支断言和订正质量是实际阻断点，不能把全部失败归因于 embedding 召回 |

### 引用投影丢失的确定性检查

对诊断工具结果分别运行 `buildEvidence(toolCalls)` 与 `buildEvidence(toolCalls, draft)`：X13 的 `claims.length > 24` 在全来源池中存在，在实际草稿引用范围投影中不存在；modelRouting 核心分支两者均存在。校验不能根据未被该引用支持的其他行直接放行，应修复引用绑定或继续补读/订正。

### 最小核心回答限定对照

沿用诊断复跑实际读到的同一来源，使用作者核心事实构造简短回答、绑定真实读取的引用，再调用同一最终校验器。该实验有参考答案介入，是 Oracle 限定对照，不是自然 Agent 任务成绩：

- S19：条件文本字符串化后 trim；通过。
- X11：4000 字符；null/undefined 转为空字符串后 includes；通过。
- X13：24 条断言；跨服务候选没有独立环境变量则报错；通过。
- N22：“就本次读到的证据，无法确认 Vault 动态凭据获取和轮换实现”；safeForDelivery=true，supported=false（没有把拒答假称事实通过）。

说明：同一证据并非只能拒答，核心回答/准确引用/限定范围能避开实测阻断。但不能据 4 个对照推导 100 题准确率，也不能自动删除问题必需的条件或关系断言。

### S28：确认一项断言级判定错误

原草稿说：schema 含循环引用时，normalizeOutputSchema 抛出带路径的 Error。原判定模型将其标为 contradicted，理由声称默认 `$` 意味着不能体现循环位置。

在与评测相同的冻结 outputSchema 源码中，构造 `schema.properties.self = schema`，确定性执行得到：

```text
outputSchema $.properties.self: 输出存在循环引用
```

因此该条“带路径 Error”事实的 contradicted 判定有误，已获得代码执行反证。仍不能把整个 S28 失败归结为这一个错误：原回答还有“交给序列化之前”等另外一条 insufficient，需独立核对。当前确认的是 1 项断言误判，不是已统计完整 29 题误杀率。

## 优先处理顺序

1. **证据绑定与订正补读**：保留候选/深读/引用投影三层来源；当已有关键行却没进入引用范围时，提示具体缺失行并纠正引用或补读。不能扩大未读来源权限。
2. **核心回答与旁支拆分**：先回答所问事实；旁支需独立支持。不能把“存在某个未支持旁支”直接描述为“问题无答案”。针对 X11/S04 保存确定性回归，禁止删掉问题所需的条件/否定/跨文件关系来刷分。
3. **判定协议和语义复核**：单独记录 raw/finish_reason/格式修复/每轮 verdict；unknown 是协议失败而非事实裁决。S28 路径推理、S19 主体绑定需要专门样例和独立人工复核。
4. **负样本范围**：避免从局部源码推导全项目不存在。分别统计不安全放行、因范围过宽而拦截、格式 unknown、安全限定拒答。

本轮完成诊断与反证，尚未修改生产运行时来修复上述问题；不能宣称误杀问题已解决。题集仍为已暴露、AI 编写、同模型评分，真实误杀率需独立人工裁定。

## 可审计产物

- `out/rag-failure-drilldown-43.json`：43 道唯一失败索引，原报告 SHA256、最终状态、未支持断言、草稿和交付文本。
- `out/rag-stage-case-diagnostic-6.json`：六题完整新链路，未替换原 100 题。
- `out/rag-stage-case-diagnostic-summary.json`：逐文件首次核心证据工具位置与引用投影覆盖。
- `out/rag-case-core-counterfactual.json`：四个 Oracle 核心回答/限定拒答对照。
- `out/rag-s28-circular-path-probe.json`：S28 冻结源码执行反证。

## 全部未通过题索引

| ID | 类别 | 完整参考证据 | 实际交付 | 最终语义状态 | 引用状态 |
| --- | --- | --- | --- | --- | --- |
| S01 | single | 缺 | blocked | judged | valid |
| S03 | single | 缺 | scoped-abstention | abstained | valid |
| S04 | single | 有 | scoped-abstention | abstained | valid |
| S12 | single | 有 | blocked | judged | valid |
| S19 | single | 有 | scoped-abstention | abstained | valid |
| S22 | single | 有 | blocked | judged | invalid |
| S26 | single | 缺 | scoped-abstention | abstained | valid |
| S28 | single | 有 | blocked | judged | valid |
| S29 | single | 有 | blocked | judged | invalid |
| S30 | single | 缺 | blocked | judged | valid |
| S32 | single | 有 | blocked | judged | valid |
| S40 | single | 有 | blocked | judged | invalid |
| X03 | cross-file | 有 | blocked | judged | invalid |
| X04 | cross-file | 缺 | scoped-abstention | abstained | valid |
| X05 | cross-file | 有 | scoped-abstention | abstained | valid |
| X06 | cross-file | 有 | blocked | judged | valid |
| X07 | cross-file | 有 | blocked | judged | valid |
| X08 | cross-file | 有 | blocked | judged | valid |
| X09 | cross-file | 有 | blocked | judged | valid |
| X11 | cross-file | 有 | blocked | judged | valid |
| X12 | cross-file | 有 | blocked | judged | valid |
| X13 | cross-file | 缺 | blocked | judged | invalid |
| X14 | cross-file | 有 | blocked | judged | valid |
| X17 | cross-file | 有 | blocked | judged | valid |
| X19 | cross-file | 有 | blocked | unknown | valid |
| X24 | cross-file | 有 | scoped-abstention | abstained | valid |
| X25 | cross-file | 有 | blocked | judged | valid |
| X26 | cross-file | 缺 | delivered-answer | judged | valid |
| X28 | cross-file | 有 | scoped-abstention | abstained | valid |
| N01 | negative | 缺 | blocked | unknown | valid |
| N08 | negative | 缺 | blocked | judged | valid |
| N11 | negative | 有 | blocked | judged | valid |
| N12 | negative | 有 | blocked | unknown | valid |
| N13 | negative | 缺 | blocked | judged | valid |
| N15 | negative | 缺 | blocked | judged | valid |
| N16 | negative | 缺 | blocked | unknown | valid |
| N19 | negative | 有 | blocked | unknown | valid |
| N22 | negative | 有 | blocked | judged | valid |
| N24 | negative | 缺 | blocked | judged | valid |
| N26 | negative | 缺 | blocked | judged | valid |
| N27 | negative | 有 | blocked | unknown | valid |
| N29 | negative | 缺 | blocked | judged | valid |
| N30 | negative | 缺 | blocked | judged | valid |
