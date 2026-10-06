/**
 * 提取 PDF 与现代 Office（OOXML）文档中的可检索文字。
 * ZIP 只在内存中按中央目录读取必要 XML；不解包到文件系统，也不解析外部实体。
 */
'use strict';

const path = require('path');
const zlib = require('zlib');
const { extractPdfText } = require('./pdfText.cjs');

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);
const MAX_ZIP_ENTRIES = 5000;
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_000_000;

function isDocumentFile(name) {
  return DOCUMENT_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

function decodeXml(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())) return named[entity.toLowerCase()];
    const value = entity.toLowerCase().startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : whole;
  });
}

function cleanText(text) {
  return String(text || '').replace(/\r/g, '').split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

function xmlAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(?:\\s|^)'+ escaped +'\\s*=\\s*(["\\\'])(.*?)\\1', 'i').exec(tag);
  return match ? decodeXml(match[2]) : '';
}

/** Parse text runs and paragraph boundaries without evaluating DTDs or entities. */
function textRuns(xml, textTag, paragraphTag) {
  const out = [];
  const tokenPattern = /<[^>]*>|[^<]+/g;
  let inText = false;
  let token;
  while ((token = tokenPattern.exec(xml))) {
    const value = token[0];
    if (!value.startsWith('<')) {
      if (inText) out.push(decodeXml(value));
      continue;
    }
    const tag = /^<\s*(\/?)\s*(?:[\w.-]+:)?([\w.-]+)/.exec(value);
    if (!tag) continue;
    const closing = !!tag[1];
    const name = tag[2].toLowerCase();
    if (name === textTag) inText = !closing && !/\/\s*>$/.test(value);
    if (!closing && (name === 'tab' || name === 'br' || name === 'cr')) out.push(' ');
    if (closing && name === paragraphTag) out.push('\n');
  }
  return cleanText(out.join(''));
}

/** Central-directory ZIP reader; local-header sizes may be zero when data descriptors are used. */
function openZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  const min = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let at = buffer.length - 22; at >= min; at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_ZIP_ENTRIES || count === 0xffff || directoryOffset === 0xffffffff ||
      directoryOffset + directorySize > end) return null;

  /** @type {Map<string, {method: number, flags: number, compressed: number, uncompressed: number, offset: number}>} */
  const entries = new Map();
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameSize = buffer.readUInt16LE(at + 28);
    const extraSize = buffer.readUInt16LE(at + 30);
    const commentSize = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const next = at + 46 + nameSize + extraSize + commentSize;
    if (next > end) return null;
    const name = buffer.toString('utf8', at + 46, at + 46 + nameSize).replace(/\\/g, '/');
    if (!entries.has(name)) entries.set(name, { method, flags, compressed, uncompressed, offset });
    at = next;
  }
  let extractedBytes = 0;
  const read = (name) => {
    const entry = entries.get(name);
    if (!entry || (entry.flags & 1) || (entry.method !== 0 && entry.method !== 8) ||
        entry.uncompressed > MAX_XML_ENTRY_BYTES || entry.compressed > buffer.length) return null;
    const start = entry.offset;
    if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== 0x04034b50) return null;
    const dataStart = start + 30 + buffer.readUInt16LE(start + 26) + buffer.readUInt16LE(start + 28);
    if (dataStart + entry.compressed > buffer.length || extractedBytes + entry.uncompressed > MAX_TOTAL_XML_BYTES) return null;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressed);
    let decoded;
    try {
      decoded = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_XML_ENTRY_BYTES });
    } catch {
      return null;
    }
    if (decoded.length !== entry.uncompressed) return null;
    extractedBytes += decoded.length;
    const xml = decoded.toString('utf8');
    return xml.includes('\ufffd') ? null : xml;
  };
  return { entries, read };
}

function docxText(zip) {
  const body = zip.read('word/document.xml');
  if (!body) return null;
  const parts = [textRuns(body, 't', 'p')];
  const related = [...zip.entries.keys()]
    .filter((name) => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name)).sort();
  for (const name of related) {
    const xml = zip.read(name);
    if (xml) parts.push(textRuns(xml, 't', 'p'));
  }
  return cleanText(parts.join('\n'));
}

function sheetNames(zip) {
  const workbook = zip.read('xl/workbook.xml') || '';
  const relationships = zip.read('xl/_rels/workbook.xml.rels') || '';
  const targets = new Map();
  for (const match of relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
    const id = xmlAttribute(match[0], 'Id');
    const target = xmlAttribute(match[0], 'Target');
    if (!id || !target) continue;
    const normalized = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
    if (normalized.startsWith('xl/worksheets/')) targets.set(id, normalized);
  }
  const names = new Map();
  let ordinal = 1;
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/gi)) {
    const name = xmlAttribute(match[0], 'name') || 'Sheet ' + ordinal;
    const target = targets.get(xmlAttribute(match[0], 'r:id')) || 'xl/worksheets/sheet' + ordinal + '.xml';
    names.set(target, name);
    ordinal++;
  }
  return names;
}

function cellValue(inner, type, shared) {
  if (type === 'inlineStr') return textRuns(inner, 't', 'is').replace(/\n/g, ' ');
  const value = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v\s*>/i.exec(inner);
  if (value) {
    const raw = decodeXml(value[1].trim());
    if (type === 's') return shared[Number(raw)] || '';
    if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
    return raw;
  }
  const formula = /<(?:[\w.-]+:)?f\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?f\s*>/i.exec(inner);
  return formula ? '=' + decodeXml(formula[1].trim()) : '';
}

function xlsxText(zip) {
  const sharedXml = zip.read('xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si\s*>/gi)]
    .map((match) => textRuns(match[1], 't', 'si').replace(/\n/g, ' '));
  const names = sheetNames(zip);
  const sheets = [...zip.entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/sheet(\d+)/i.exec(a)?.[1]) - Number(/sheet(\d+)/i.exec(b)?.[1]));
  if (!sheets.length) return null;
  const lines = [];
  let used = 0;
  for (const sheet of sheets) {
    const xml = zip.read(sheet);
    if (!xml) continue;
    const heading = 'Sheet: ' + (names.get(sheet) || path.posix.basename(sheet, '.xml'));
    lines.push(heading);
    used += heading.length + 1;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row\s*>/gi)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c\s*>/gi)) {
        const location = xmlAttribute(cell[1], 'r');
        const value = cellValue(cell[2], xmlAttribute(cell[1], 't'), shared);
        if (value) cells.push((location ? location + '=' : '') + value.slice(0, 10000));
      }
      if (cells.length) {
        const line = cells.join(' | ');
        lines.push(line);
        used += line.length + 1;
      }
      if (used >= MAX_TEXT_CHARS) break;
    }
    if (used >= MAX_TEXT_CHARS) break;
  }
  return cleanText(lines.join('\n'));
}

function pptxText(zip) {
  const slides = [...zip.entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/slide(\d+)/i.exec(a)?.[1]) - Number(/slide(\d+)/i.exec(b)?.[1]));
  if (!slides.length) return null;
  const parts = [];
  let used = 0;
  for (const slide of slides) {
    const number = /slide(\d+)/i.exec(slide)?.[1] || '';
    const xml = zip.read(slide);
    if (xml) {
      const part = 'Slide ' + number + '\n' + textRuns(xml, 't', 'p');
      parts.push(part);
      used += part.length + 1;
    }
    const notes = zip.read('ppt/notesSlides/notesSlide' + number + '.xml');
    if (notes) {
      const part = 'Slide ' + number + ' notes\n' + textRuns(notes, 't', 'p');
      parts.push(part);
      used += part.length + 1;
    }
    if (used >= MAX_TEXT_CHARS) break;
  }
  return cleanText(parts.join('\n'));
}

/** @returns {{text: string, format: string, truncated: boolean}|null} */
function extractDocumentText(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || !isDocumentFile(fileName)) return null;
  const ext = path.extname(fileName).toLowerCase();
  try {
    let text;
    if (ext === '.pdf') text = extractPdfText(buffer)?.text || '';
    else {
      const zip = openZip(buffer);
      if (!zip) return null;
      if (ext === '.docx' || ext === '.docm') text = docxText(zip);
      else if (ext === '.xlsx' || ext === '.xlsm') text = xlsxText(zip);
      else text = pptxText(zip);
    }
    if (!text || !text.trim()) return null;
    // PDF 的行号必须和 read_file 使用的原始提取结果一致；Office 则统一清理 XML 段落空白。
    const normalized = ext === '.pdf' ? text : cleanText(text);
    const truncated = normalized.length > MAX_TEXT_CHARS;
    return { text: normalized.slice(0, MAX_TEXT_CHARS), format: ext.slice(1), truncated };
  } catch {
    return null;
  }
}

module.exports = { isDocumentFile, extractDocumentText, MAX_TEXT_CHARS };
