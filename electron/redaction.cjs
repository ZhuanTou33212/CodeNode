'use strict';
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization)$/i;
function redact(value) {
  if (typeof value === 'string') {
    // Structured tool arguments often arrive as JSON strings.
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed));
    } catch {}
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      .replace(/(bearer\s+)[^\s,"']+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
module.exports = { redact };

