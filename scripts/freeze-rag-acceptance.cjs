'use strict';
// One-shot authoring tool. Never rebuild a frozen set after inspecting its scores.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(__dirname, 'fixtures/rag-acceptance-v2.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (fs.existsSync(target)) throw new Error('Already frozen; create a new version instead');
const facts = [
  ['retrieval','electron/rag/index.cjs','maxFiles: 5000','文件索引默认最多收集多少个文件？','默认最多 5000 个文件。'],
  ['retrieval','electron/rag/index.cjs','maxFileBytes: 512 * 1024','普通文本文件的默认大小上限是多少？','默认大小上限为 512 KiB。'],
  ['retrieval','electron/rag/index.cjs','maxContextChars: 12000','检索上下文默认字符预算是多少？','默认字符预算为 12000。'],
  ['retrieval','electron/rag/index.cjs',"embedProvider: 'none'",'没有配置 Embedding 时是否默认启用向量层？','默认 provider 为 none，向量层不启用。'],
  ['mapping','electron/rag/chunkMetadata.cjs',"unit: 'utf16'",'sourceMapping 的字符偏移使用什么单位？','偏移单位为 UTF-16。'],
  ['mapping','electron/rag/chunkMetadata.cjs','const endings = /\\r\\n|\\r|\\n/g','原文偏移计算识别哪些换行形式？','识别 CRLF、CR 和 LF。'],
  ['mapping','electron/rag/chunkMetadata.cjs',"chunk.searchText = header + '\\n\\n' + chunk.content",'检索文本的元数据与正文怎样拼接？','header 与正文之间使用两个换行，存入 searchText。'],
  ['mapping','electron/rag/codeStructure.cjs',"'.ts', '.tsx', '.js', '.jsx'",'结构分析是否支持 TSX 与 JSX 文件？','支持 TSX 与 JSX 文件。'],
  ['answerability','electron/rag/answerability.cjs',"if (typeof judge !== 'function')",'没有事实判定函数时可回答性返回什么状态？','返回 unknown，answerable 为 false。'],
  ['answerability','electron/rag/answerability.cjs','plan.facts.length > 12','问题最多允许提取多少项核心事实？','最多允许 12 项核心事实。'],
  ['answerability','electron/rag/answerability.cjs','String(question).length > 4000','事实判定对问题字符长度的上限是多少？','问题不能超过 4000 字符。'],
  ['answerability','electron/rag/answerability.cjs','source.text.includes(item.quote)','支持事实的引句如何核对来源真实性？','指定来源的正文必须包含原文引句。'],
  ['faithfulness','electron/rag/faithfulness.cjs','claims.length > 24','答案支持性校验最多接受多少条断言？','最多接受 24 条断言。'],
  ['faithfulness','electron/rag/faithfulness.cjs','options.maxChars || 24000','答案支持性校验的默认证据字符预算是多少？','默认预算为 24000 字符。'],
  ['faithfulness','electron/rag/faithfulness.cjs',"!['entailed', 'contradicted', 'insufficient'].includes",'答案判定允许哪三种 verdict？','允许 entailed、contradicted 和 insufficient。'],
  ['faithfulness','electron/rag/faithfulness.cjs',"if (call.ok === false || call.name !== 'retrieve_context') continue",'失败的检索调用会进入答案校验证据集吗？','失败的检索调用会被跳过。'],
  ['conditions','electron/workflowConditions.cjs',"new Set(['equals', 'not_equals', 'contains', 'truthy', 'falsy'])",'工作流条件 DSL 支持哪些运算？','支持 equals、not_equals、contains、truthy、falsy。'],
  ['conditions','electron/workflowConditions.cjs',"reason: '自然语言条件需人工核对'",'自然语言完成条件是否被当成已强制执行的检查？','不会，enforced 为 false，需人工核对。'],
  ['conditions','electron/workflowConditions.cjs',"String(condition || '').trim()",'完成条件匹配前是否会去掉两侧空白？','会先将条件转为字符串并 trim。'],
  ['conditions','electron/workflowConditions.cjs',"if (c.op === 'contains')",'contains 条件怎样处理 null 或 undefined 的实际值？','先转换为空字符串，再做 includes 匹配。'],
  ['routing','electron/modelRouting.cjs','fallbacks.length > 4','模型配置最多允许几个备用候选？','最多允许四个备用候选。'],
  ['routing','electron/modelRouting.cjs',"if (changesOrigin && !candidate.apiKeyEnv)",'跨服务候选没有独立凭据环境变量时会怎样？','抛出配置错误，必须显式指定 api_key_env。'],
  ['routing','electron/modelRouting.cjs',"if (!key) throw invalid('候选凭据环境变量尚未设置')",'候选指定的凭据环境变量为空时会静默沿用原 key 吗？','不会，环境变量未设置会抛错。'],
  ['routing','electron/modelRouting.cjs','Math.min(Number(cfg.maxTokens) || candidate.maxTokens, candidate.maxTokens)','候选输出上限能超过主配置的上限吗？','不能，使用两者的较小值。'],
  ['schema','electron/tools/outputSchema.cjs','const MAX_DEPTH = 64','工具 JSON 输出校验的最大深度是多少？','最大深度为 64。'],
  ['schema','electron/tools/outputSchema.cjs','const LIMIT = 100000','工具输出 JSON 校验节点预算是多少？','节点预算为 100000。'],
  ['schema','electron/tools/outputSchema.cjs',"!reference.startsWith('#/')",'输出 schema 的引用能指向远程文档吗？','不能，只支持文档内 JSON Pointer 引用。'],
  ['schema','electron/tools/outputSchema.cjs',"if (ancestors.has(value))",'工具 JSON 输出含循环引用时会发生什么？','返回循环引用校验错误。'],
  ['effects','electron/sideEffects.cjs',"if (!name) return 'unknown'",'空工具名的副作用类别是什么？','类别为 unknown。'],
  ['effects','electron/sideEffects.cjs',"if (READ_TOOLS.has(name)) return 'read'",'登记在 READ_TOOLS 中的工具如何分类？','分类为 read。'],
  ['effects','electron/sideEffects.cjs',"if (WRITE_TOOLS.has(name)) return 'write'",'登记在 WRITE_TOOLS 中的工具如何分类？','分类为 write。'],
  ['effects','electron/sideEffects.cjs','crypto.createHash(\'sha256\')','副作用 digest 使用什么摘要算法？','使用 SHA-256。'],
  ['budget','electron/requestBudget.cjs','this.money = this.parent ? this.parent.money','子预算是否另建完全独立的费用账本？','不会，子预算共享父预算的 money。'],
  ['budget','electron/requestBudget.cjs','if (this.parent) return this.parent.claimRetry()','子预算的重试额度如何处理？','向父预算委托 claimRetry。'],
  ['budget','electron/costBudget.cjs','const SCALE = 1e9','费用内部整数单位的缩放系数是多少？','缩放系数为 1e9。'],
  ['budget','electron/costBudget.cjs',"COST_PRICE_MISSING",'启用费用硬上限但缺少模型单价时会怎样？','抛出 COST_PRICE_MISSING。'],
  ['storage','electron/atomicFile.cjs','fs.fsyncSync(fd)','临时文件替换前是否执行 fsync？','会对临时文件调用 fsyncSync。'],
  ['storage','electron/atomicFile.cjs',"fs.openSync(temporary, 'wx', 0o600)",'原子写临时文件的创建标志和权限是什么？','标志为 wx，权限为 0o600。'],
  ['settings','electron/ragSettings.cjs',"if (!['memory', 'sqlite'].includes(backend))",'检索设置页能直接选择 Milvus 吗？','不能，设置页仅支持 memory 和 sqlite。'],
  ['settings','electron/ragSettings.cjs','dim < 256 || dim > 8192','检索设置页允许的向量维度范围是多少？','允许 256 到 8192 的整数维度。'],
];
const files = {};
function source(spec) {
  const [domain, file, anchor] = spec;
  if (!files[file]) files[file] = fs.readFileSync(path.join(root, file), 'utf8');
  const text = files[file], position = text.indexOf(anchor);
  if (position < 0) throw new Error('Missing evidence: ' + file + ' ' + anchor);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const line = text.slice(0, position).replace(/\r\n?/g, '\n').split('\n').length;
  const startLine = Math.max(1, line - 3), endLine = Math.min(lines.length, line + 4);
  return { citation: file + '#L' + startLine + '-L' + endLine, path: file,
    startLine, endLine, excerpt: lines.slice(startLine - 1, endLine).join('\n'), anchor, domain };
}
const cases = /** @type {any[]} */ (facts.map((spec, i) => ({ id: 'S' + String(i + 1).padStart(2, '0'), type: 'single', domain: spec[0],
  query: spec[3], expectedAnswerable: true, requiredFacts: [spec[4]], referenceAnswer: spec[4],
  sources: [source(spec)], labelProvenance: 'source-grounded-author-label', humanReviewed: false })));
for (let i = 0; i < 30; i++) {
  const a = facts[i], b = facts[(i + 9) % facts.length];
  cases.push({ id: 'X' + String(i + 1).padStart(2, '0'), type: 'cross-file', domain: a[0] + '+' + b[0],
    query: '请跨文件核对以下两个问题，逐项给出处：' + a[3] + '另外，' + b[3],
    expectedAnswerable: true, requiredFacts: [a[4], b[4]], referenceAnswer: a[4] + ' ' + b[4],
    sources: [source(a), source(b)], labelProvenance: 'source-grounded-author-label', humanReviewed: false });
}
const negativeQuestions = [
  '文件索引如何使用 Elasticsearch 的分片路由实现分布式 BM25？',
  '普通文本读取怎样通过 OCR 自动识别扫描文档的图片？',
  '上下文字符预算怎样用强化学习自动选择每轮最佳数值？',
  '默认嵌入器如何在首次启动时自动下载 ONNX 模型？',
  'sourceMapping 怎样保存 UTF-8 字节到 GPU 张量位置的映射？',
  '换行扫描怎样识别源文件编码并将 Shift-JIS 自动转换成 UTF-8？',
  '检索元数据 header 如何通过数字签名验证发布者身份？',
  '语法分析器如何通过 Python AST 解析装饰器及类继承？',
  '核心事实判定器怎样在缺少模型时调用本地 NLI 神经网络？',
  '核心事实计划如何验证数学定理并输出可机检的证明？',
  '证据超预算后怎样自动分页检验全部来源而不返回 unknown？',
  '原文引句存在性检查如何通过 SAT 求解器证明逻辑蕴含？',
  '答案断言超过上限时如何通过自动分批判定覆盖所有断言？',
  '事实校验怎样自动请求额外网页补足预算内没有的证据？',
  '判定模型怎样根据人工纠错日志自动微调并热更新权重？',
  '失败的检索调用如何通过远程证据公证服务恢复正文？',
  '工作流 DSL 的自定义 JavaScript 表达式如何在隔离 VM 中求值？',
  '自然语言完成条件如何被自动编译成形式化约束并强制执行？',
  '工作流条件在匹配前怎样进行 Unicode 语义等价归一化？',
  'contains 条件如何利用向量相似度判定中文同义句？',
  '备用模型如何根据在线 A/B 测试自动创建候选并分配流量？',
  '跨服务凭据如何通过 Vault 动态获取并轮换？',
  '缺少环境变量的模型候选如何通过 OAuth 登录刷新凭据？',
  '模型输出上限如何根据用户满意度在线训练预测器？',
  '输出 schema 如何通过下载远程引用文档补齐类型定义？',
  'JSON 校验怎样利用 WebAssembly 实现流式并行执行？',
  '输出 schema 的递归引用怎样通过外部 schema 注册中心解析？',
  'JSON 循环引用怎样自动转为对象 ID 再判为合法输出？',
  '未知副作用如何通过 Saga 自动生成补偿操作并回滚远端订单？',
  '费用预算怎样通过供应商账单 API 自动获取单价并对账？',
];
for (let i = 0; i < 30; i++) cases.push({ id: 'N' + String(i + 1).padStart(2, '0'), type: 'negative',
  domain: facts[i][0], query: negativeQuestions[i], expectedAnswerable: false,
  requiredFacts: ['问题所要求的额外实现机制'], referenceAnswer: '给定来源不足以证明问题所要求的实现，不能据相关名称编造细节。',
  sources: [source(facts[i])], expectedMissing: negativeQuestions[i],
  labelProvenance: 'bounded-context-insufficiency-author-label', humanReviewed: false });
if (cases.length !== 100 || new Set(cases.map(item => item.query)).size !== 100) throw new Error('Dataset must contain 100 distinct queries');
const dataset = { version: '2.0.0', createdAt: new Date().toISOString(), role: 'frozen-acceptance-candidate',
  provenance: 'AI-authored scenarios grounded in a real CodeNode source snapshot; not human gold or collected production questions',
  counts: { single: 40, crossFile: 30, negative: 30 }, sourceHashes: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])), files, cases };
fs.writeFileSync(target, JSON.stringify(dataset, null, 2) + '\n');
fs.writeFileSync(target.replace('.json', '.lock.json'), JSON.stringify({ datasetSha256: hash(fs.readFileSync(target)),
  judgeHashes: Object.fromEntries(['answerability', 'faithfulness'].map(name => [name, hash(fs.readFileSync(path.join(root, 'electron/rag/' + name + '.cjs')))])) }, null, 2) + '\n');
console.log('Frozen 100 source-grounded scenarios; human labels pending');
