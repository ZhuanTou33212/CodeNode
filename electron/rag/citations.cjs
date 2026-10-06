'use strict';
function normalizePath(raw) {
  let value = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  while (value.startsWith('/')) value = value.slice(1);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
/** @returns {{kind:'range',path:string,start:number,end:number}|{kind:'scalar',key:string}|{kind:'other',raw:string}} */
function parseCitation(raw) {
  const text = String(raw || '').replace(/^source:\s*/i, '').trim();
  const scalar = /^scalar:(.+)$/i.exec(text);
  if (scalar) return { kind: 'scalar', key: scalar[1].trim() };
  const range = /^(.*?)#L(\d+)(?:-L(\d+))?$/i.exec(text);
  if (!range || !range[1].trim()) return { kind: 'other', raw: text };
  const start = Number(range[2]), end = Number(range[3] || range[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return { kind: 'other', raw: text };
  return { kind: 'range', path: normalizePath(range[1]), start, end };
}
// A path with an explicit #L suffix is provenance even without Markdown wrappers.
function citationSpans(answer) {
  const text = String(answer || '');
  const regex = /\[([^\]\r\n]+)\]\((?:<([^>\r\n]+)>|([^\r\n)]+))\)|\[([^\]\r\n]+)\]|`([^`\r\n]+)`/g;
  const spans = [];
  for (const match of text.matchAll(regex)) {
    const linked = match[2] || match[3];
    const explicit = (raw) => /^(?:.+#L\d+(?:-L\d+)?|scalar:.+)$/i.test(String(raw || '').replace(/^source:\s*/i, '').trim());
    const raw = String(linked && explicit(linked) ? linked : match[1] || match[4] || match[5] || '').replace(/^source:\s*/i, '').trim();
    // Include invalid zero/reversed ranges so the location gate rejects them, rather than ignores them.
    if (!/^(?:.+#L\d+(?:-L\d+)?|scalar:.+)$/i.test(raw)) continue;
    const label = linked ? parseCitation(match[1]) : null, target = parseCitation(raw);
    const sameLabel = label && (label.kind === 'range' && target.kind === 'range' && label.path === target.path && label.start === target.start && label.end === target.end ||
      label.kind === 'scalar' && target.kind === 'scalar' && label.key === target.key);
    const replacement = linked && /\s+["']/.test(linked) ? match[0] : linked && !sameLabel ? match[1] : '';
    spans.push({ citation: raw, start: match.index, end: match.index + match[0].length, replacement });
  }
  const plain = /(?<![\p{L}\p{N}_.\/\\-])(?:[\p{L}\p{N}_.-]+[\/\\])*[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_-]+#L\d+(?:-L\d+)?/gu;
  for (const match of text.matchAll(plain)) {
    const start = match.index, end = start + match[0].length;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    spans.push({ citation: match[0], start, end, replacement: '' });
  }
  return spans.sort((a, b) => a.start - b.start);
}
function extractCitations(answer) { return [...new Set(citationSpans(answer).map((span) => span.citation))]; }
function stripCitations(answer) {
  let text = String(answer || '');
  for (const span of citationSpans(text).reverse()) text = text.slice(0, span.start) + span.replacement + text.slice(span.end);
  return text;
}
module.exports = { normalizePath, parseCitation, citationSpans, extractCitations, stripCitations };
