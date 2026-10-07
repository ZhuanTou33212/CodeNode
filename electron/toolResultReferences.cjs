'use strict';
const { createHash } = require('node:crypto');
const NOTICE = '（相同参数已重复调用，直接复用上次结果，请勿再次重复）';
const PREFIX = NOTICE + '\n【已有工具结果】';
const LOST = '（该引用的来源正文已被压缩或移出上下文；请先查看已保留的摘要和结果，需要原文细节时再用原参数获取。本次未重新执行工具。）';
const digest = text => createHash('sha256').update(text).digest('hex');
function bodyText(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  return content.startsWith(NOTICE) ? content.slice(NOTICE.length) : content;
}
function project(body, tool, messages, enabled) {
  const baseline = NOTICE + body;
  if (!enabled || !body || tool === 'view_image') return { content: baseline, source: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const text = bodyText(message);
    if (message.role !== 'tool' || message.name !== tool || !message.tool_call_id || !(text === body || text.startsWith(body + '\n\n'))) continue;
    const metadata = { source: message.tool_call_id, tool, chars: body.length, sha256: digest(body) };
    const content = PREFIX + JSON.stringify(metadata) + '\n正文仍在上文，复用该结果；本次未重新执行。';
    if (content.length >= baseline.length) break;
    return { content, source: metadata.source };
  }
  return { content: baseline, source: null };
}
// The self-contained marker also survives checkpoints and resumed conversations.
// Compression/trim may remove the source; never leave a claim of available text.
function repair(messages) {
  let repaired = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'tool' || typeof message.content !== 'string' || !message.content.startsWith(PREFIX)) continue;
    let valid = false;
    try {
      const metadata = JSON.parse(message.content.slice(PREFIX.length).split('\n')[0]);
      const source = messages.slice(0, i).find(candidate => candidate.role === 'tool' && candidate.tool_call_id === metadata.source && candidate.name === metadata.tool);
      const text = source && bodyText(source);
      valid = Number.isSafeInteger(metadata.chars) && metadata.chars > 0 && typeof text === 'string' && text.length >= metadata.chars && digest(text.slice(0, metadata.chars)) === metadata.sha256;
    } catch {}
    if (!valid) { message.content = LOST; repaired++; }
  }
  return repaired;
}
module.exports = { project, repair, NOTICE, LOST };
