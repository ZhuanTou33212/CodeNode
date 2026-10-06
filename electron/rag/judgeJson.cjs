'use strict';
function invalid(code, message) { return Object.assign(new Error(message), { code, judgeFormat: true }); }
function parseObject(raw) {
  if (raw && typeof raw === 'object' && typeof raw.content === 'string') {
    if (raw.finishReason === 'length' || raw.finishReason === 'max_tokens') throw invalid('JUDGE_OUTPUT_TRUNCATED', '判定输出因 token 上限截断');
    raw = raw.content;
  }
  let text = String(raw || '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1];
  let value;
  try { value = JSON.parse(text); } catch { throw invalid('JUDGE_JSON_INVALID', '判定模型没有返回完整 JSON 对象'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('JUDGE_SCHEMA_INVALID', '判定结果必须是 JSON 对象');
  return value;
}
async function judgeJson(judge, messages, validate) {
  /** @type {Array<{attempt:number,finishReason:any,chars:number,error?:string}>} */
  const protocol = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await judge(messages);
      protocol.push({ attempt: attempt + 1, finishReason: typeof raw === 'object' ? raw?.finishReason || null : null,
        chars: typeof raw === 'object' ? String(raw?.content || '').length : String(raw || '').length });
      const value = parseObject(raw);
      validate(value);
      Object.defineProperty(value, 'judgeProtocol', { value: protocol, enumerable: false });
      return value;
    } catch (error) {
      if (protocol.length) protocol[protocol.length - 1].error = error.code || 'JUDGE_REQUEST_FAILED';
      error.judgeProtocol = protocol;
      if (!error.judgeFormat || attempt === 1) throw error;
      messages = [...messages, { role: 'user', content: 'JSON validation failed: ' + error.code + ': ' + error.message + '. Return the complete JSON object matching the specified schema. Keep reasons short and quote only necessary premises to fit the output budget. Preserve ALL requested IDs and the source evidence constraints. Copy questionSpan and evidence quotes verbatim from original text; do not translate or paraphrase these fields. Do not invent evidence, add markdown, or include commentary. This is the only repair attempt.' }];
    }
  }
}
function validateQuote(sources, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) throw invalid('JUDGE_QUOTE_MISSING', '支持判定缺少原文证据');
  for (const item of evidence) {
    if (typeof item?.quote !== 'string' || item.quote.trim().length === 0 ||
        !sources.some((source) => source.citation === item.citation &&
          String(source.text).replace(/\r\n?/g, '\n').includes(item.quote.replace(/\r\n?/g, '\n')))) {
      throw invalid('JUDGE_QUOTE_INVALID', '支持证据不存在于指定原文');
    }
  }
}
module.exports = { invalid, parseObject, judgeJson, validateQuote };
