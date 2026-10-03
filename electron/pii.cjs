'use strict';

// Opt-in, deterministic PII guard for model input and final output.
const DETECTORS = Object.freeze({
  email: { label: '邮箱', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
  phone: { label: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[REDACTED_PHONE]' },
  card: { label: '银行卡号', pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, replacement: '[REDACTED_CARD]' },
  national_id_cn: { label: '中国大陆身份证号', pattern: /(?<![0-9Xx])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9Xx])/g, replacement: '[REDACTED_NATIONAL_ID]', validate: validChineseId },
  ssn_us: { label: '美国 SSN', pattern: /(?<!\d)(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g, replacement: '[REDACTED_SSN]' },
});
function validChineseId(value) {
  const text = String(value || '').toUpperCase();
  if (!/^\d{17}[0-9X]$/.test(text)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const sum = text.slice(0, 17).split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return codes[sum % 11] === text[17];
}
function parseConfig(cfg) {
  const raw = String((cfg && cfg['agent.pii.mode']) || 'off').trim().toLowerCase();
  const mode = ['off', 'warn', 'redact'].includes(raw) ? raw : 'off';
  const categories = String((cfg && cfg['agent.pii.categories']) || 'email,phone').split(',')
    .map((item) => item.trim().toLowerCase()).filter((item) => Object.prototype.hasOwnProperty.call(DETECTORS, item));
  return { mode, categories: [...new Set(categories.length ? categories : ['email', 'phone'])] };
}
function inspect(value, config) {
  const text = String(value == null ? '' : value); const findings = [];
  for (const category of (config && config.categories) || ['email', 'phone']) {
    const detector = DETECTORS[category]; if (!detector) continue;
    detector.pattern.lastIndex = 0; const matches = text.match(detector.pattern);
    const validMatches = matches && detector.validate ? matches.filter((match) => detector.validate(match)) : matches;
    if (validMatches && validMatches.length) findings.push({ category, label: detector.label, count: validMatches.length });
  }
  return findings;
}
function apply(value, config) {
  const text = String(value == null ? '' : value); const policy = config || { mode: 'off', categories: ['email', 'phone'] };
  const findings = inspect(text, policy);
  if (policy.mode !== 'redact' || !findings.length) return { text, findings, changed: false };
  let output = text;
  for (const category of policy.categories || []) { const detector = DETECTORS[category]; if (!detector) continue; detector.pattern.lastIndex = 0; output = output.replace(detector.pattern, (match) => !detector.validate || detector.validate(match) ? detector.replacement : match); }
  return { text: output, findings, changed: output !== text };
}
module.exports = { DETECTORS, parseConfig, inspect, apply };
