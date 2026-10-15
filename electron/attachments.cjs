'use strict';
/**
 * 用户附件规格与校验：图片走多模态输入，文本/代码文件转成有边界的文本上下文。
 * 渲染端（浏览器）与主进程（Node）共用，避免两边规则不一致。
 *
 * 说明：DeepSeek 的图片输入走 OpenAI 兼容格式 ——
 *   content = [{ type:'text', text }, { type:'image_url', image_url:{ url: <dataURL> } }]
 * 实测该payload与 tools（工具调用）可以同一请求下发。
 */

/** 允许的图片 MIME（DeepSeek 视觉接口支持范围） */
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_MIME = new Set(['application/json', 'application/ld+json', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/typescript', 'application/sql']);
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','json','jsonl','yaml','yml','toml','xml','csv','tsv','log','js','jsx','mjs','cjs','ts','tsx','css','scss','html','htm','py','rb','go','rs','java','kt','kts','swift','c','h','cpp','hpp','cs','php','sh','zsh','bash','fish','ps1','sql','graphql','gql','env','properties','ini','conf']);

/** 单张图片上限（base64 解码后的字节数）——服务端也有自己的上限，这里先兜住 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
/** 单条消息最多几个附件 */
const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const MAX_IMAGES_PER_MESSAGE = MAX_ATTACHMENTS_PER_MESSAGE;
/** 一次请求里所有附件的总字节上限 */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function textMime(mime, name) {
  mime = String(mime || '').toLowerCase();
  if (mime.startsWith('text/') || TEXT_MIME.has(mime)) return mime;
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  if (!TEXT_EXTENSIONS.has(ext)) return null;
  if (ext === 'json' || ext === 'jsonl') return 'application/json';
  if (ext === 'xml') return 'application/xml';
  if (['js','jsx','mjs','cjs'].includes(ext)) return 'application/javascript';
  if (['ts','tsx'].includes(ext)) return 'application/typescript';
  return 'text/plain';
}

/** data URL → { mime, base64, bytes } */
function parseDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const base64 = m[2].replace(/\s+/g, '');
  // 粗略但足够：base64 长度 → 字节数
  const pad = /(=+)$/.exec(base64);
  const bytes = Math.floor((base64.length * 3) / 4) - (pad ? pad[1].length : 0);
  return { mime, base64, bytes };
}

/**
 * 校验并归一化附件。失败分支带 error，成功分支带 attachments（旧实现的联合类型会让调用方
 * 必须先用 ok 收窄，TS 反而判为不可访问，这里统一成可选字段）。
 * @param {any} input
 * @returns {{ ok: boolean, attachments?: Array<{ mime: string, dataUrl: string, name?: string, bytes: number }>, error?: string }}
 */
function normalizeAttachments(input) {
  if (input == null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: '附件格式错误' };
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, error: `一次最多发送 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件` };
  }
  const out = [];
  let total = 0;
  for (const item of input) {
    const parsed = parseDataUrl(item && item.dataUrl);
    if (!parsed) return { ok: false, error: '附件需要是 base64 的 data URL' };
    const image = ALLOWED_MIME.includes(parsed.mime);
    const normalizedTextMime = image ? null : textMime((item && item.mime) || parsed.mime, item && item.name);
    if (!image && !normalizedTextMime) return { ok: false, error: `不支持的附件格式：${parsed.mime}` };
    if (image && parsed.bytes > MAX_IMAGE_BYTES) return { ok: false, error: `图片过大（${(parsed.bytes / 1048576).toFixed(1)}MB，上限 4MB）` };
    if (normalizedTextMime && parsed.bytes > MAX_TEXT_FILE_BYTES) return { ok: false, error: `文本附件过大（${(parsed.bytes / 1048576).toFixed(1)}MB，上限 2MB）` };
    if (normalizedTextMime) {
      const decoded = Buffer.from(parsed.base64, 'base64').toString('utf8');
      if (decoded.includes('\0')) return { ok: false, error: '文本附件包含二进制内容' };
    }
    total += parsed.bytes;
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: '图片总量过大，请减少数量或压缩后再发' };
    out.push({
      mime: normalizedTextMime || parsed.mime,
      dataUrl: `data:${normalizedTextMime || parsed.mime};base64,${parsed.base64}`,
      name: item && item.name ? String(item.name).slice(0, 120) : undefined,
      bytes: parsed.bytes,
    });
  }
  return { ok: true, attachments: out };
}

/**
 * 构造 OpenAI 兼容的多模态 user 消息。
 * 没有图片时返回纯文本消息（保持与旧行为完全一致）。
 */
function buildUserMessage(text, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return { role: 'user', content: String(text ?? '') };
  let enriched = String(text ?? '');
  for (const attachment of list.filter(item => item && !String(item.mime || '').startsWith('image/'))) {
    const parsed = parseDataUrl(attachment.dataUrl);
    if (!parsed) continue;
    const name = String(attachment.name || 'attachment').replace(/[<>\r\n]/g, '_').slice(0, 120);
    const body = Buffer.from(parsed.base64, 'base64').toString('utf8');
    enriched += `\n\n<attachment name="${name}" mime="${attachment.mime || parsed.mime}">\n${body}\n</attachment>`;
  }
  const images = list.filter(item => item && String(item.mime || '').startsWith('image/'));
  if (!images.length) return { role: 'user', content: enriched };
  /** @type {Array<{ type: string, text?: string, image_url?: { url: string } }>} */
  const parts = [{ type: 'text', text: enriched }];
  for (const a of images) {
    if (a && a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  }
  return { role: 'user', content: parts };
}

/** 估算一次请求里图片带来的额外 token（粗估：约 每 750 字节 ≈ 1 token，仅用于预算展示） */
function estimateImageTokens(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.reduce((sum, a) => sum + Math.ceil((Number(a && a.bytes) || 0) / 750), 0);
}

module.exports = {
  ALLOWED_MIME,
  MAX_IMAGE_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_BYTES,
  parseDataUrl,
  normalizeAttachments,
  buildUserMessage,
  estimateImageTokens,
};
