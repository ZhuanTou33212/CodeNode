'use strict';
const { invalid } = require('./acpClient.cjs');
const limit = require('../../config/agent.backends.json').acpLimits.contentBytes;
function contentBlock(block, caps) {
  if (!block || typeof block !== 'object' || Buffer.byteLength(JSON.stringify(block)) > limit) throw invalid('ACP 内容无效或超过上限');
  const need = { image: 'image', audio: 'audio', resource: 'embeddedContext' }[block.type];
  if (caps && need && caps[need] !== true) throw invalid('Agent 未声明 ' + need + ' prompt 能力');
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (['image', 'audio'].includes(block.type) && typeof block.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data) && typeof block.mimeType === 'string' && new RegExp('^' + block.type + '/[a-zA-Z0-9.+-]+$').test(block.mimeType) && block.mimeType !== 'image/svg+xml') return { type: block.type, data: block.data, mimeType: block.mimeType };
  if (block.type === 'resource_link' && typeof block.uri === 'string' && /^(?:https?:|file:|[a-z][a-z0-9+.-]*:)/i.test(block.uri) && !/^(javascript|data|vbscript):/i.test(block.uri) && typeof block.name === 'string') return { type: block.type, uri: block.uri, name: block.name, ...(typeof block.title === 'string' ? { title: block.title } : {}) };
  const r = block.resource;
  if (block.type === 'resource' && r && typeof r.uri === 'string' && (typeof r.text === 'string' || typeof r.blob === 'string')) return { type: 'resource', resource: { uri: r.uri, ...(typeof r.mimeType === 'string' ? { mimeType: r.mimeType } : {}), ...(typeof r.text === 'string' ? { text: r.text } : { blob: r.blob }) } };
  throw invalid('不支持或无效的 ACP ContentBlock');
}
function promptContent(input, text, caps) {
  /** @type {any[]} */
  const blocks = [{ type: 'text', text }];
  for (const attachment of input.attachments || []) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(attachment.dataUrl || '');
    if (!match) throw invalid('附件必须是内嵌 base64');
    const type = match[1].split('/')[0];
    blocks.push(contentBlock(['image', 'audio'].includes(type) ? { type, mimeType: match[1], data: match[2] } : { type: 'resource', resource: { uri: 'attachment://' + encodeURIComponent(attachment.name || 'resource'), mimeType: match[1], blob: match[2] } }, caps));
  }
  for (const block of input.acpContent || []) blocks.push(contentBlock(block, caps));
  if (Buffer.byteLength(JSON.stringify(blocks)) > limit) throw invalid('ACP prompt 超过内容上限');
  return blocks;
}
module.exports = { contentBlock, promptContent };
