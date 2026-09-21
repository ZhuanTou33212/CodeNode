/**
 * intent-test.cjs —— 意图识别 / 授权判定（照 Codex guardian 分类器，2026-09-21）
 *
 * 参照物：`codex-rs/prompts/templates/guardian/classifier_instructions.md`（一次独立模型调用判定
 * `risk_level` + `user_authorization`，证据分层，缺失就保守判高）与两个取值域 schema
 * （`GuardianRiskLevel.ts` / `GuardianUserAuthorization.ts`）。实现见 `electron/intent.cjs` 顶部注释。
 *
 * 判据（分块，全部表驱动或字节级）：
 *   A. SQL 式的**解析 + 回落**：JSON 用 ```json 包裹/前后带废话/大小写/非法枚举/缺字段/空串
 *      —— 唯一权威口径是「跑到就跑通、跑不通就保守」，不允许出现「猜一个像是的」。
 *   B. **只收紧**（I1）：verdict → 策略的两个出口（routeHint / forceConfirm），逐条触发器单独验，
 *      并穷举断言「没有任何输入会让审批更容易通过」。
 *   C. **无信号 ≠ 低风险**（I2）：source='unavailable' 时一条收紧规则都不成立 ——
 *      这是「模型没跑/报错/超时」与「模型跑通了但输出不可用」的分界，两句必须分别可判。
 *   D. 分类器的**工程不变量**：无通道/抛异常/次数用尽 → unavailable（绝不 reject）；
 *      同一输入只调一次（缓存）；trace 事件齐全。
 *   E. 提示词路由：`resolvePromptLayers` 的 intentHint 分支**只增不减**（救回漏判），
 *      且与 `canvasMode=always` **逐字节相同**；hint 为 null/非法时与加这个功能前**逐字节一致**。
 *   F. 审批门禁的**单向性**：命中免打扰规则 + 门禁收紧 → 必须回到问用户（含 confirm 拒绝时真的拒绝）；
 *      门禁自身抛异常 → 不收紧但留痕；无门禁 → 与现状逐字节一致（事件流也一样）。
 *   G. 接线（防「实现了但没接线」）：ipc 真的把 intentHint 传进 buildSystemPrompt、把 intentPolicy
 *      传进工具上下文，并落 run 事件；Context 懒建的审批服务真的带上了 riskGate。
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const intent = require(path.join(ROOT, 'electron', 'intent.cjs'));
const agent = require(path.join(ROOT, 'electron', 'agent.cjs'));
const { ApprovalService } = require(path.join(ROOT, 'electron', 'tools', 'approval.cjs'));
const { AgentToolContext } = require(path.join(ROOT, 'electron', 'tools', 'context.cjs'));

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** 造一个「模型正常跑通」的输出 */
const jsonOut = (patch) =>
  JSON.stringify(Object.assign({ intent: 'code', risk: 'low', authorization: 'high', confidence: 0.9, reason: '用户明确要求改代码' }, patch));

const CANVAS_DETAIL = 'a) 一条完整的节点链路必须有开始节点(start)和结束节点(end)';
const PROMPT_ARGS = ['', '', '', '', ''];

/** 只变 canvas 相关入参，其余位置参数固定（与 prompt-layers-test 同款） */
function build(opts = {}) {
  return agent.buildSystemPrompt('', opts.canvasSummary || '', [], '', '', {
    prompt: opts.prompt,
    canvasMode: opts.canvasMode,
    intentHint: opts.intentHint,
  });
}

async function main() {
  // ============================ A. 解析 + 回落 ============================
  console.log('== A. parseIntentOutput：解析口径与保守回落 ==');
  {
    const plain = intent.parseIntentOutput(jsonOut({}));
    check('[A] 纯 JSON → source=model 且三字段原样', plain.source === 'model' && plain.intent === 'code' && plain.risk === 'low' && plain.authorization === 'high', JSON.stringify(plain));

    const fenced = intent.parseIntentOutput('```json\n' + jsonOut({ intent: 'canvas', risk: 'medium', authorization: 'medium' }) + '\n```');
    check('[A] ```json 包裹也能解析', fenced.source === 'model' && fenced.intent === 'canvas' && fenced.risk === 'medium', JSON.stringify(fenced));

    const chatty = intent.parseIntentOutput('好的，这是我的判定：' + jsonOut({ intent: 'research' }) + ' —— 以上。');
    check('[A] 前后有废话 → 取第一个 JSON 对象', chatty.source === 'model' && chatty.intent === 'research', JSON.stringify(chatty));

    const upper = intent.parseIntentOutput('{"intent":"CANVAS","risk":"HIGH","authorization":"UNKNOWN","confidence":0.4}');
    check('[A] 枚举大小写不敏感（归一成小写）', upper.intent === 'canvas' && upper.risk === 'high' && upper.authorization === 'unknown', JSON.stringify(upper));

    const badEnums = intent.parseIntentOutput('{"intent":"写代码","risk":"很危险","authorization":"随便","confidence":0.8}');
    check('[A] 非法 intent → unknown（不许猜）', badEnums.intent === 'unknown', badEnums.intent);
    check('[A] 非法 risk → high（照 Codex「保守判高」）', badEnums.risk === 'high', badEnums.risk);
    check('[A] 非法 authorization → unknown（保守）', badEnums.authorization === 'unknown', badEnums.authorization);

    const missing = intent.parseIntentOutput('{"intent":"code"}');
    check('[A] 缺字段 → 各自保守默认且 reason 留痕', missing.risk === 'high' && missing.authorization === 'unknown' && /缺字段:risk,authorization/.test(missing.reason), JSON.stringify({ risk: missing.risk, reason: missing.reason }));

    const badConf = intent.parseIntentOutput('{"intent":"code","risk":"low","authorization":"high","confidence":"高"}');
    check('[A] 非法 confidence → 0（= 不确定）', badConf.confidence === 0, String(badConf.confidence));
    check('[A] 越界 confidence 夹到 [0,1]', intent.parseIntentOutput(jsonOut({ confidence: 9 })).confidence === 1 && intent.parseIntentOutput(jsonOut({ confidence: -3 })).confidence === 0);

    const empty = intent.parseIntentOutput('   ');
    check('[A] 空输出 → source=invalid + 保守判高（有信号但不可用）', empty.source === 'invalid' && empty.risk === 'high' && empty.authorization === 'unknown', JSON.stringify(empty));

    const notJson = intent.parseIntentOutput('我觉得这轮还行吧');
    check('[A] 不是 JSON → source=invalid + 保守判高', notJson.source === 'invalid' && notJson.risk === 'high', JSON.stringify(notJson));

    const truncated = intent.parseIntentOutput('{"intent":"code","risk":"low"');
    check('[A] JSON 被截断 → invalid（不半信半疑地当成 low）', truncated.source === 'invalid' && truncated.risk === 'high');

    check('[A] 取值域来自 schema：risk 只有 low/medium/high/critical', JSON.stringify(intent.RISK_LEVELS) === JSON.stringify(['low', 'medium', 'high', 'critical']));
    check('[A] 取值域来自 schema：authorization 只有 unknown/low/medium/high', JSON.stringify(intent.AUTHORIZATION_LEVELS) === JSON.stringify(['unknown', 'low', 'medium', 'high']));
  }

  // ============================ B. 只收紧（I1）============================
  console.log('\n== B. createIntentPolicy：收紧判定逐条可判 ==');
  {
    /** @type {Array<[string, boolean, string[]]>} */
    const cases = [
      [jsonOut({ risk: 'high' }), true, ['risk-high']],
      [jsonOut({ risk: 'critical' }), true, ['risk-high']],
      [jsonOut({ authorization: 'unknown' }), true, ['authorization-unknown']],
      [jsonOut({ authorization: 'low' }), true, ['authorization-low']],
      [jsonOut({ confidence: 0.49 }), true, ['low-confidence']],
      [jsonOut({}), false, []],
      [jsonOut({ risk: 'medium', authorization: 'medium', confidence: 0.7 }), false, []],
    ];
    for (const [text, wantTighten, wantSignals] of cases) {
      const policy = intent.createIntentPolicy(intent.parseIntentOutput(text));
      const got = policy.signals.slice().sort().join('+');
      check('[B] ' + text.slice(0, 64) + ' → tighten=' + wantTighten, policy.tighten === wantTighten && got === wantSignals.slice().sort().join('+'), JSON.stringify({ tighten: policy.tighten, signals: policy.signals }));
    }

    // 多条件同时命中要全部列出（否则事后归因只看得到一半原因）
    const multi = intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'critical', authorization: 'unknown', confidence: 0.1 })));
    check('[B] 多条件命中 → signals 全列', multi.signals.length === 3 && multi.tighten === true, JSON.stringify(multi.signals));

    // routeHint 只在「模型跑通 + intent=canvas」时给
    check('[B] intent=canvas → routeHint=canvas', intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ intent: 'canvas' }))).routeHint === 'canvas');
    check('[B] intent=code → routeHint=null', intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ intent: 'code' }))).routeHint === null);
    check('[B] forceConfirm() 返回布尔（签名与 ApprovalService 的 riskGate 一致）', typeof intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))).forceConfirm === 'function');
    check('[B] describe() 含归因字段（run 事件里可读）', /source=model/.test(intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))).describe()) && /tighten=risk-high/.test(intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))).describe()));

    // I1 穷举：策略只有「收紧 / 不收紧」两种输出，没有任何「放行」字段
    const policyKeys = Object.keys(intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' })))).sort();
    check('[B] 策略对象只有收紧语义的字段（没有 allow/skip/approve 之类放行口）', JSON.stringify(policyKeys) === JSON.stringify(['forceConfirm', 'routeHint', 'signals', 'tighten', 'verdict', 'describe'].sort()), policyKeys.join(','));
    check('[B] forceConfirm 只随 tighten 变化（不以任何入参放宽）', intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))).forceConfirm({ tool: 'write_file', capability: 'workspace.write' }) === true && intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({}))).forceConfirm({ tool: 'write_file' }) === false);
  }

  // ============================ C. 无信号 ≠ 低风险（I2）============================
  console.log('\n== C. unavailable 与 invalid 必须分开可判 ==');
  {
    const noSignal = intent.createIntentPolicy(intent.unavailableVerdict('call-failed:boom'));
    check('[C] unavailable → source=unavailable', noSignal.verdict.source === 'unavailable');
    check('[C] unavailable → 一条收紧规则都不成立（不收紧、也不放宽）', noSignal.tighten === false && noSignal.signals.length === 0, JSON.stringify(noSignal.signals));
    check('[C] unavailable → 无 routeHint（不改变既有提示词判定）', noSignal.routeHint === null);
    check('[C] 即使硬塞 risk=high，unavailable 也不收紧（I2 的判据本体）', intent.createIntentPolicy({ source: 'unavailable', risk: 'high', authorization: 'unknown', confidence: 0 }).tighten === false);

    const invalid = intent.createIntentPolicy(intent.parseIntentOutput('不是 JSON'));
    check('[C] invalid（有信号但不可用）→ 收紧（照 Codex 保守判高）', invalid.tighten === true && invalid.verdict.source === 'invalid' && invalid.signals.indexOf('risk-high') >= 0, JSON.stringify(invalid.signals));

    check('[C] invalid 即使自称 intent=canvas 也不给 routeHint（不可用信号不能改路由）', intent.createIntentPolicy({ source: 'invalid', intent: 'canvas', risk: 'high' }).routeHint === null);

    const nullP = intent.nullPolicy();
    check('[C] nullPolicy（未启用/未接线）与 unavailable 等价', nullP.tighten === false && nullP.routeHint === null && nullP.verdict.source === 'unavailable');

    const weird = intent.createIntentPolicy(null);
    check('[C] 归一畸形输入：createIntentPolicy(null) 不炸且不收紧', weird.tighten === false && weird.verdict.source === 'unavailable');
  }

  // ============================ D. 分类器的工程不变量 ============================
  console.log('\n== D. createIntentClassifier：缓存 / 上限 / 失败不阻断 ==');
  {
    const cfg = intent.parseIntentConfig({});
    check('[D] 出厂默认：auto + 8000ms + 256 tokens + 单 run 5 次', cfg.mode === 'auto' && cfg.timeoutMs === 8000 && cfg.maxTokens === 256 && cfg.maxCallsPerRun === 5, JSON.stringify(cfg));
    check('[D] 非法配置回落默认（不炸）', intent.parseIntentConfig({ 'agent.intent_recognition': '乱写', 'agent.intent_timeout_ms': '-5', 'agent.intent_max_calls_per_run': 'x' }).mode === 'auto');
    check('[D] max_calls_per_run=0 表示不限制（显式语义）', intent.parseIntentConfig({ 'agent.intent_max_calls_per_run': '0' }).maxCallsPerRun === 0);
    check('[D] intent_model 未配置 → null（用主模型）', intent.parseIntentConfig({}).model === null);

    // 无通道
    const noChannel = intent.createIntentClassifier({ cfg });
    const r0 = await noChannel.classify({ prompt: 'x' });
    check('[D] 没注入 callModel → unavailable（且不 reject）', r0.source === 'unavailable', JSON.stringify(r0));

    // 抛异常
    let calls = 0;
    const boom = intent.createIntentClassifier({ cfg, callModel: async () => { calls += 1; throw new Error('网关 502'); } });
    const r1 = await boom.classify({ prompt: '改代码' });
    check('[D] callModel 抛异常 → unavailable 且 reason 带原因（绝不 reject）', r1.source === 'unavailable' && /call-failed/.test(r1.reason) && /502/.test(r1.reason), JSON.stringify(r1));

    // 缓存
    const events = [];
    const cached = intent.createIntentClassifier({
      cfg,
      callModel: async () => { calls += 1; return jsonOut({ intent: 'canvas' }); },
      trace: (event, data) => events.push({ event, data }),
    });
    const first = await cached.classify({ prompt: '帮我理一下这个业务' });
    const second = await cached.classify({ prompt: '帮我理一下这个业务' });
    check('[D] 同一输入第二次命中缓存（不再花一次请求）', first.intent === 'canvas' && second.intent === 'canvas' && cached.stats().calls === 1 && cached.stats().cachedHits === 1, JSON.stringify(cached.stats()));
    check('[D] 缓存命中与真实分类都留痕（run 事件可回放）', events.some((e) => e.event === 'intent_classified') && events.some((e) => e.event === 'intent_cache_hit'), JSON.stringify(events.map((e) => e.event)));

    // 上限
    let limited = 0;
    const capped = intent.createIntentClassifier({
      cfg: intent.parseIntentConfig({ 'agent.intent_max_calls_per_run': '2' }),
      callModel: async () => { limited += 1; return jsonOut({}); },
    });
    await capped.classify({ prompt: 'a' });
    await capped.classify({ prompt: 'b' });
    const over = await capped.classify({ prompt: 'c' });
    check('[D] 超过单 run 次数上限 → unavailable（不静默多花钱）', over.source === 'unavailable' && /budget-exhausted/.test(over.reason) && limited === 2, JSON.stringify({ limited, reason: over.reason }));

    // 组装
    const msgs = intent.buildClassifierMessages({ prompt: '把 add 改成乘法', history: [{ role: 'user', content: '先看看 utils' }, { role: 'assistant', content: '好的' }], canvasSummary: '[]', projectNotes: 'AGENTS.md: 只用 pnpm' });
    check('[D] 分类请求 = system 指令 + user 证据包', msgs.length === 2 && msgs[0].role === 'system' && msgs[0].content === intent.CLASSIFIER_INSTRUCTIONS && msgs[1].role === 'user');
    check('[D] 证据包标出 user 消息 / 历史 / 画布状态 / 项目约定', /<user_message>/.test(msgs[1].content) && /<recent_transcript/.test(msgs[1].content) && /<canvas_state/.test(msgs[1].content) && /<project_notes/.test(msgs[1].content));
    check('[D] 历史明确标注为不可信证据（不能用来确立授权）', /不可信证据/.test(msgs[1].content));
    const longHistory = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'm' + i }));
    const clipped = intent.buildClassifierMessages({ prompt: 'x', history: longHistory });
    check('[D] 历史只带最近 ' + intent.TRANSCRIPT_MESSAGES + ' 条（上下文有界）', (clipped[1].content.match(/- \[user\]/g) || []).length === intent.TRANSCRIPT_MESSAGES);
    const huge = intent.buildClassifierMessages({ prompt: 'x'.repeat(9000) });
    check('[D] 超长用户消息被截断（分类不需要全文）', huge[1].content.length < 9000, String(huge[1].content.length));
    check('[D] 同内容 → 同一缓存指纹', intent.buildClassifierMessages({ prompt: 'x' })[1].content === intent.buildClassifierMessages({ prompt: 'x' })[1].content);
  }

  // ============================ E. 提示词路由（只增不减）============================
  console.log('\n== E. resolvePromptLayers / buildSystemPrompt 的 intentHint ==');
  {
    const hinted = agent.resolvePromptLayers({ canvasSummary: '[]', prompt: '帮我把这个业务做成一条可执行的路子', intentHint: 'canvas' });
    check('[E] 画布为空 + 无画布词 + hint=canvas → 注入（reason=intent-canvas）', hinted.canvas === true && hinted.reason === 'intent-canvas', JSON.stringify(hinted));
    check('[E] hint=canvas 也不能压过 mode=never（配置强制优先）', agent.resolvePromptLayers({ canvasSummary: '[]', prompt: 'x', mode: 'never', intentHint: 'canvas' }).canvas === false);
    check('[E] 画布非空时判定不变（hint 不参与）', agent.resolvePromptLayers({ canvasSummary: '[{"id":"n1"}]', intentHint: 'canvas' }).reason === 'canvas-not-empty');
    check('[E] 关键词命中时判定不变（hint 不参与）', agent.resolvePromptLayers({ canvasSummary: '[]', prompt: '帮我建一条链路', intentHint: 'canvas' }).reason === 'prompt-mentions-canvas');
    check('[E] hint=code/null/乱写 → 与现状一致（pure-code-task）', ['code', null, undefined, '乱写'].every((h) => agent.resolvePromptLayers({ canvasSummary: '[]', prompt: '把 add 改成乘法', intentHint: h }).reason === 'pure-code-task'));

    // 字节级：救回的那一层必须与「强制注入」逐字节相同
    const byHint = build({ intentHint: 'canvas' });
    const byAlways = build({ canvasMode: 'always' });
    check('[E] intent-canvas 的 system prompt 与 canvasMode=always 逐字节相同', byHint === byAlways && byHint.length > 0, 'len ' + byHint.length + ' vs ' + byAlways.length);
    check('[E] 救回时确实含画布细则（不是只把 reason 改了）', byHint.includes(CANVAS_DETAIL));

    // 负向：hint 为 null / 非法时，必须与「加这个功能之前」逐字节一致
    const alwaysPure = build({ canvasMode: 'always' });
    const noHint = build({ canvasMode: 'auto', prompt: '把 add 的减法改成加法' });
    check('[E] hint=null 时与分层前逐字节相同（只差画布层那块）', noHint === alwaysPure.replace(agent.CANVAS_RULES, agent.CANVAS_RULES_STUB), 'len ' + noHint.length);
    const junkHint = build({ canvasMode: 'auto', prompt: '把 add 的减法改成加法', intentHint: 'unknown' });
    check('[E] hint=unknown（未分类）时逐字节不变', junkHint === noHint);
    const unavailableHint = build({ canvasMode: 'auto', prompt: '把 add 的减法改成加法', intentHint: intent.createIntentPolicy(intent.unavailableVerdict('x')).routeHint });
    check('[E] unavailable 策略的 routeHint（null）→ 逐字节不变', unavailableHint === noHint);
    check('[E] 省层时不含任何画布细则', !noHint.includes(CANVAS_DETAIL));

    // 配置出口
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-'));
    fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
    const writeCfg = (text) => fs.writeFileSync(path.join(projDir, '.codenode', 'agent.properties'), text);
    writeCfg('');
    check('[E] 空配置 → loader 出口是 auto', agent.loadConfig(projDir).intent.mode === 'auto');
    writeCfg('agent.intent_recognition=always\n');
    check('[E] 配置 always → loader 出口读到 always', agent.loadConfig(projDir).intent.mode === 'always');
    writeCfg('agent.intent_recognition=never\n');
    check('[E] 配置 never → loader 出口读到 never', agent.loadConfig(projDir).intent.mode === 'never');
    check('[E] shouldClassify: never 永不 / always 每轮 / auto 仅空画布', intent.shouldClassify({ mode: 'never' }, '[]') === false && intent.shouldClassify({ mode: 'always' }, '[{"id":"n1"}]') === true && intent.shouldClassify({ mode: 'auto' }, '') === true && intent.shouldClassify({ mode: 'auto' }, '[]') === true && intent.shouldClassify({ mode: 'auto' }, '[{"id":"n1"}]') === false);
    check('[E] shouldClassify: 非法 mode 与 auto 同口径（不额外花钱也不静默变 never）', intent.shouldClassify({ mode: '乱写' }, '[]') === true && intent.shouldClassify({ mode: '乱写' }, '[{"id":"n1"}]') === false);
    fs.rmSync(projDir, { recursive: true, force: true });
  }

  // ============================ F. 审批门禁的单向性 ============================
  console.log('\n== F. ApprovalService.riskGate：只能收紧 ==');
  {
    const RULE = { id: 'r-write', capability: 'workspace.write', tool: 'write_file', level: 'WRITE' };
    const req = { capability: 'workspace.write', level: 'WRITE', what: 'write_file', detail: '写文件', scope: {}, toolCallId: 'c1' };

    // 现状（无门禁）：命中即免打扰
    {
      let confirms = 0;
      const svc = new ApprovalService({ confirm: async () => { confirms += 1; return true; }, rules: [RULE] });
      const token = await svc.request(req);
      check('[F] 无门禁 + 命中规则 → 免打扰（与现状一致）', !!token && confirms === 0, 'confirms=' + confirms);
      check('[F] 无门禁 → 事件流与现状一致（有 rule_hit、无 risk_gate）', (svc.events || []).some((e) => e.event === 'approval_rule_hit') && !(svc.events || []).some((e) => e.event === 'approval_risk_gate'));
    }

    // 收紧：命中规则也要问，且 confirm 拒绝就真的拒绝
    {
      let confirms = 0;
      const svc = new ApprovalService({ confirm: async () => { confirms += 1; return false; }, rules: [RULE], riskGate: () => true });
      const token = await svc.request(req);
      check('[F] 门禁收紧 + confirm 拒绝 → 不签发令牌（收紧是真的）', token === null && confirms === 1, JSON.stringify({ token: !!token, confirms }));
      check('[F] 收紧时留痕 approval_risk_gate（含规则 id，可归因）', (svc.events || []).some((e) => e.event === 'approval_risk_gate' && e.ruleId === 'r-write'));
      check('[F] 收紧时不再伪造 approval_rule_hit（免打扰确实没生效）', !(svc.events || []).some((e) => e.event === 'approval_rule_hit'));
    }
    {
      const svc = new ApprovalService({ confirm: async () => true, rules: [RULE], riskGate: () => true });
      const token = await svc.request(req);
      check('[F] 门禁收紧 + confirm 批准 → 正常签发令牌', !!token);
    }

    // 门禁不管闲事：无规则也没门禁时，审批通道照旧
    {
      let confirms = 0;
      const svc = new ApprovalService({ confirm: async () => { confirms += 1; return true; }, rules: [], riskGate: () => true });
      const token = await svc.request(req);
      check('[F] 没命中规则时门禁无从收紧（照常问用户）', !!token && confirms === 1, 'confirms=' + confirms);
    }
    // 门禁不能无中生有：没有审批通道时，它也没法「放行」
    {
      const svc = new ApprovalService({ confirm: null, rules: [], riskGate: () => true });
      check('[F] 无规则 + 无确认通道 → 仍然没有令牌（门禁不能无中生有地放行）', (await svc.request(req)) === null && (svc.events || []).some((e) => e.event === 'approval_unavailable'));
    }

    // 门禁自身抛异常 → 不收紧，但必须留痕
    {
      let confirms = 0;
      const svc = new ApprovalService({ confirm: async () => { confirms += 1; return true; }, rules: [RULE], riskGate: () => { throw new Error('门禁坏了'); } });
      const token = await svc.request(req);
      check('[F] 门禁抛异常 → 回落到规则免打扰（不阻断审批）', !!token && confirms === 0, 'confirms=' + confirms);
      check('[F] 门禁抛异常 → 留痕 approval_risk_gate_error（不静默降级）', (svc.events || []).some((e) => e.event === 'approval_risk_gate_error' && /门禁坏了/.test(e.message || '')));
    }

    // 源码级单向性：gated 只能出现在「收紧」的两个分支里
    {
      const src = fs.readFileSync(path.join(ROOT, 'electron', 'tools', 'approval.cjs'), 'utf8');
      check('[F] 源码里 gated 不参与任何放行判断（只做 !gated / || gated 两种收紧语义）', /if \(ruleHit && !gated\)/.test(src) && /if \(!ruleHit \|\| gated\)/.test(src) && !/gated[^\n]*approved = true/.test(src));
    }
  }

  // ============================ G. 接线 ============================
  console.log('\n== G. 接线：ipc / context 真的用上了 ==');
  {
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'agent.cjs'), 'utf8');
    check('[G] ipc 把 intentHint 传进 buildSystemPrompt（防「实现了但没接线」）', /buildSystemPrompt\([^)]*\{[\s\S]{0,300}intentHint:/.test(ipcSrc));
    check('[G] ipc 把 intentPolicy 传进工具上下文', /checkpoint: checkpointSink,\s*\n\s*\/\/[^\n]*\n\s*intentPolicy,/.test(ipcSrc) || /intentPolicy,\s*\n\s*\/\/ web_search/.test(ipcSrc));
    check('[G] ipc 用纯函数判定「要不要分类」（shouldClassify）', /intentLib\.shouldClassify\(/.test(ipcSrc));
    check('[G] ipc 把判定结果落 run 事件（可回放/审计）', /runStore\.appendEvent\(projectRoot, runId, 'intent'/.test(ipcSrc));
    check('[G] ipc 的分类调用记进成本账（kind=intent，不混进主对话）', /kind: 'intent'/.test(ipcSrc));
    check('[G] 续跑不重新分类（resumePlan 短路）', /if \(!resumePlan\) \{[\s\S]{0,200}shouldClassify/.test(ipcSrc));

    // Context：懒建的审批服务带上 riskGate
    {
      const ctx = new AgentToolContext({ projectRoot: ROOT, intentPolicy: intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))) });
      check('[G] Context 暴露 intentPolicy()', ctx.intentPolicy() && ctx.intentPolicy().tighten === true);
      check('[G] Context 的审批服务带 riskGate（且门禁返回收紧结论）', ctx.approval().riskGate && ctx.approval().riskGate({ tool: 'write_file' }) === true);
      const bare = new AgentToolContext({ projectRoot: ROOT });
      check('[G] 未注入策略 → 无 riskGate（与旧行为逐字节一致）', bare.intentPolicy() === null && bare.approval().riskGate === null);
      const bad = new AgentToolContext({ projectRoot: ROOT, intentPolicy: { forceConfirm: () => { throw new Error('x'); } } });
      check('[G] 门禁抛异常 → Context 层吞掉并返回 false（审批不受影响）', bad.approval().riskGate({ tool: 'x' }) === false);
    }

    // 端到端：带 approvals.json 的项目 + 收紧策略 → 命中规则也要问
    {
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-gate-'));
      fs.mkdirSync(path.join(projDir, '.codenode'), { recursive: true });
      fs.writeFileSync(path.join(projDir, '.codenode', 'approvals.json'), JSON.stringify({ version: 1, rules: [{ id: 'r1', capability: 'workspace.write', tool: 'write_file', level: 'WRITE' }] }));
      let confirms = 0;
      const base = { projectRoot: projDir, confirm: async () => { confirms += 1; return true; } };
      const relaxed = new AgentToolContext(base);
      const req = { capability: 'workspace.write', level: 'WRITE', what: 'write_file', detail: '', scope: {}, toolCallId: 't1' };
      check('[G] 端到端：无策略 → 命中规则免打扰', !!(await relaxed.approval().request(req)) && confirms === 0, 'confirms=' + confirms);
      const tightened = new AgentToolContext(Object.assign({}, base, { intentPolicy: intent.createIntentPolicy(intent.parseIntentOutput(jsonOut({ risk: 'high' }))) }));
      check('[G] 端到端：高风险策略 → 同一条规则被收紧（必须问用户）', !!(await tightened.approval().request(req)) && confirms === 1, 'confirms=' + confirms);
      // 负向：unavailable 策略与「没有策略」等价
      confirms = 0;
      const noSignal = new AgentToolContext(Object.assign({}, base, { projectRoot: projDir, intentPolicy: intent.unavailableVerdict ? intent.createIntentPolicy(intent.unavailableVerdict('x')) : null }));
      check('[G] 端到端：无信号策略 → 与旧行为一致（仍然免打扰）', !!(await noSignal.approval().request(req)) && confirms === 0, 'confirms=' + confirms);
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  }

  // ============================ H. 真实请求链路 ============================
  console.log('\n== H. 端到端：分类请求真的走主通道（本机 HTTP 端点）==');
  {
    const http = require('http');
    const { RequestBudget } = require(path.join(ROOT, 'electron', 'requestBudget.cjs'));
    const { CostLedger } = require(path.join(ROOT, 'electron', 'costLedger.cjs'));
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ intent: 'canvas', risk: 'high', authorization: 'unknown', confidence: 0.8, reason: '用户要把业务流程画成节点链路' }) } }],
          usage: { prompt_tokens: 700, completion_tokens: 60, total_tokens: 760 },
        }));
      });
    });
    await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined)));
    const bound = server.address();
    const port = bound && typeof bound === 'object' ? bound.port : 0;
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-intent-live-'));
    try {
      const cfg = agent.loadConfig(null);
      cfg.apiBase = 'http://127.0.0.1:' + port;
      cfg.apiKey = 'test-key';
      cfg.model = 'mock-model';
      cfg.maxTokens = 512;
      cfg.requestBudget = new RequestBudget(100000);
      cfg.costLedger = new CostLedger({ projectRoot: projDir, runId: 'run-intent-live' });
      cfg.costRunId = 'run-intent-live';
      const classifier = intent.createIntentClassifier({
        cfg: intent.parseIntentConfig({ 'agent.intent_recognition': 'always', 'agent.intent_max_tokens': '128' }),
        callModel: async ({ messages, maxTokens, timeoutMs }) => {
          const callCfg = Object.assign({}, cfg, { maxTokens: maxTokens || cfg.maxTokens });
          const startedAt = Date.now();
          const res = await agent.chatCompletion(callCfg, messages, { timeoutMs });
          // 与 ipc 里的实现同口径：调用方按用途记账（kind=intent）
          agent.recordCost(cfg, { kind: 'intent', model: callCfg.model, usage: res && res.usage, latencyMs: Date.now() - startedAt, runId: cfg.costRunId });
          return (res && res.content) || '';
        },
      });
      const verdict = await classifier.classify({ prompt: '帮我把这个业务流程画成节点链路', history: [], canvasSummary: '[]' });
      check('[H] 真起 HTTP 端点：分类请求确实发出去了一次', seen.length === 1 && /\/chat\/completions$/.test(seen[0].url || ''), JSON.stringify(seen.map((s) => s.url)));
      check(
        '[H] 请求体是分类指令 + 证据包（不是把用户消息原样丢过去）',
        Array.isArray(seen[0].body.messages) && seen[0].body.messages[0].content === intent.CLASSIFIER_INSTRUCTIONS && /<user_message>/.test(seen[0].body.messages[1].content),
      );
      check('[H] 用配置的模型与更小的输出上限（分类不占主对话的输出额度）', seen[0].body.model === 'mock-model' && seen[0].body.max_tokens === 128, JSON.stringify({ model: seen[0].body.model, max_tokens: seen[0].body.max_tokens }));
      check('[H] 授权头沿用主通道形状（Bearer）', /^Bearer /.test(String(seen[0].auth || '')), String(seen[0].auth || '').slice(0, 12) + '…');
      check('[H] 真实响应 → 判定可解析（canvas / high / unknown）', verdict.intent === 'canvas' && verdict.risk === 'high' && verdict.authorization === 'unknown' && verdict.source === 'model', JSON.stringify(verdict));
      check('[H] 该判定生成收紧策略（高风险 + 授权 unknown）', intent.createIntentPolicy(verdict).tighten === true);
      check('[H] 分类调用进了同一条成本账（kind=intent，可单独查）', (cfg.costLedger.entries || []).length >= 1 && cfg.costLedger.entries[0].kind === 'intent', 'entries=' + JSON.stringify((cfg.costLedger.entries || []).map((e) => e.kind)));
      check('[H] 分类调用扣了请求预算（长任务不会因此悄悄超支）', Number(cfg.requestBudget.used) > 0, 'used=' + cfg.requestBudget.used);
    } finally {
      server.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  }

  console.log('\n' + (failures === 0 ? 'INTENT TEST: PASS（意图识别：解析/收紧/无信号/路由/审批/接线）' : 'INTENT TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('INTENT TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
