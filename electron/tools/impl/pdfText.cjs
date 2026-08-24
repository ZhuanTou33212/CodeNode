/**
 * pdfText：纯 Node 的 PDF 文本提取（无第三方依赖）。
 *
 * 适用：常规文本型 PDF（含 CID/Identity-H 字体 + ToUnicode CMap，如 Word 另存的 PDF）。
 * 对扫描版 / 无文字层 / 缺 ToUnicode 映射的 PDF 返回 text=null，由调用方给出明确提示。
 */
'use strict';

const zlib = require('zlib');

/** 解压所有 stream（FlateDecode），失败跳过 */
function inflateStreams(buf) {
  const out = [];
  const s = buf.toString('latin1');
  const re = /stream\r?\n(.*?)\r?\nendstream/gs;
  let m;
  while ((m = re.exec(s))) {
    try {
      const raw = Buffer.from(m[1], 'latin1');
      const text = zlib.inflateSync(raw).toString('latin1');
      if (text) out.push(text);
    } catch (e) {
      /* 非 FlateDecode 的 stream 跳过 */
    }
  }
  return out;
}

/** 16 进制 → Unicode 字符串（2/4/8 位十六进制，UTF-16BE） */
function hexToUnicode(hex) {
  const h = hex.trim();
  if (h.length === 2) return String.fromCodePoint(parseInt(h, 16));
  if (h.length === 4) {
    const cp = parseInt(h, 16);
    return cp >= 0xd800 && cp <= 0xdfff ? '' : String.fromCodePoint(cp);
  }
  if (h.length >= 8) {
    const a = parseInt(h.slice(0, 4), 16);
    const b = parseInt(h.slice(4, 8), 16);
    return String.fromCharCode(a, b);
  }
  return '';
}

/** 解析所有 ToUnicode CMap（bfchar + bfrange），得到 CID→字符 映射 */
function parseCMaps(streamTexts) {
  const map = new Map();
  for (const st of streamTexts) {
    if (!/beginbfchar|beginbfrange/.test(st)) continue;
    const lines = st.split('\n');
    let section = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^\d*\s*beginbfchar$/i.test(line)) {
        section = 'bfchar';
        continue;
      }
      if (/^\d*\s*beginbfrange$/i.test(line)) {
        section = 'bfrange';
        continue;
      }
      if (/^\d*\s*endbfchar$/i.test(line) || /^\d*\s*endbfrange$/i.test(line)) {
        section = null;
        continue;
      }
      if (!section) continue;
      const hex = line.match(/<([0-9A-Fa-f]+)>/g);
      if (!hex || hex.length < 2) continue;
      const cid = parseInt(hex[0].slice(1, -1), 16);
      if (section === 'bfchar' && hex.length >= 2) {
        const ch = hexToUnicode(hex[1].slice(1, -1));
        if (ch) map.set(cid, ch);
        continue;
      }
      if (section === 'bfrange') {
        const lo = cid;
        const hi = parseInt(hex[1].slice(1, -1), 16);
        // 增量式：<lo> <hi> <dst>（dst 每 +1 递增）
        if (hex.length >= 3) {
          const dst = hexToUnicode(hex[2].slice(1, -1));
          if (dst && dst.length === 1) {
            const base = dst.codePointAt(0);
            for (let c = lo; c <= hi && c <= lo + 0x1000; c++) {
              map.set(c, String.fromCodePoint(base + (c - lo)));
            }
          } else if (dst) {
            // 数组式展开兼容：<lo> <hi> [ <d1> <d2> ... ] 用括号内的项
            const arr = line.match(/\[([\s\S]*)\]/);
            if (arr) {
              const items = arr[1].match(/<([0-9A-Fa-f]+)>/g) || [];
              for (let k = 0; k < items.length && lo + k <= hi; k++) {
                const ch = hexToUnicode(items[k].slice(1, -1));
                if (ch) map.set(lo + k, ch);
              }
            }
          }
        }
      }
    }
  }
  return map;
}

/** 把一段字节按 Identity-H（每 2 字节一个 CID）解码为字符 */
function decodeHex(bytes, cidMap) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const cid = (bytes[i] << 8) | bytes[i + 1];
    const ch = cidMap.get(cid);
    out += ch != null ? ch : '\uFFFD';
  }
  return out;
}

const NUM_RE = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b/;

function unescapeLit(str) {
  return str.replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '(': '(', ')': ')', '\\': '\\' }[c])).replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCodePoint(parseInt(o, 8)));
}

/** 提取单个内容流的文本（按 y 坐标下移换行，跨 BT/ET 块跟踪） */
function extractContent(text, cidMap) {
  let out = '';
  let inText = false;
  let prevY = null;
  const re =
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]\b|T\*|BT\b|ET\b|<([0-9A-Fa-f]+)>\s*Tj\b|\(((?:\\.|[^()\\])*)\)\s*Tj\b|\[([^\]]*)\]\s*TJ\b|\(((?:\\.|[^()\\])*)\)\s*['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const full = m[0];
    if (m[6] !== undefined) {
      // Tm：a b c d e f。换行 = 行间距明显（相对缩放 |d| 计算阈值，兼容不同字体尺寸）
      const scale = Math.abs(parseFloat(m[4]));
      const y = parseFloat(m[6]);
      const thr = Math.max(3, scale * 6);
      if (inText && out && prevY != null && Math.abs(prevY - y) > thr) out += '\n';
      prevY = y;
      continue;
    }
    if (m[8] !== undefined) {
      // Td / TD
      if (inText && Math.abs(parseFloat(m[8])) > 0.5) out += '\n';
      continue;
    }
    if (/^T\*/.test(full)) {
      if (inText) out += '\n';
      continue;
    }
    if (/^BT\b/.test(full)) {
      inText = true;
      continue;
    }
    if (/^ET\b/.test(full)) {
      inText = false;
      continue;
    }
    if (m[9] !== undefined) {
      if (inText) out += decodeHex(Buffer.from(m[9], 'hex'), cidMap);
      continue;
    }
    if (m[10] !== undefined) {
      if (inText) out += unescapeLit(m[10]);
      continue;
    }
    if (m[11] !== undefined) {
      if (inText) {
        const order = m[11].match(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^()\\])*)\)/g) || [];
        let s = '';
        for (const o of order) {
          if (o[0] === '<') s += decodeHex(Buffer.from(o.slice(1, -1), 'hex'), cidMap);
          else s += unescapeLit(o.slice(1, -1));
        }
        out += s;
      }
      continue;
    }
    if (m[12] !== undefined) {
      if (inText) out += '\n' + unescapeLit(m[12]);
      continue;
    }
  }
  return out;
}

/** 兜底：当字形定位聚类失败、出现大量单字成行时，把连续单字行合并为整句，避免 read_file 一调用只读到单个文字 */
function mergeSingleCharLines(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (!nonEmpty.length) return text;
  const single = nonEmpty.filter((l) => {
    const t = l.trim();
    return t && t.length <= 2 && !/\s/.test(t) && t !== '\uFFFD';
  }).length;
  if (single / nonEmpty.length < 0.35) return text; // 正常文本不动
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  for (const ln of lines) {
    const t = ln.trim();
    if (t && t.length <= 2 && !/\s/.test(t) && t !== '\uFFFD') {
      buf += t;
    } else {
      flush();
      out.push(ln);
    }
  }
  flush();
  return out.join('\n');
}

/**
 * 提取 PDF 文本。
 * @returns {null | { text: string, printable: number }} text=null 表示无法提取（扫描版/无文字层）
 */
function extractPdfText(pdfBuf) {
  if (!pdfBuf || pdfBuf.length < 8) return null;
  try {
    const streams = inflateStreams(pdfBuf);
    if (!streams.length) return null;
    const cidMap = parseCMaps(streams);
    let text = '';
    for (const st of streams) {
      if (!/BT/.test(st)) continue;
      text += extractContent(st, cidMap);
    }
    text = mergeSingleCharLines(text);
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]{2,}/g, ' ');
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    const printable = (text.match(/[^\s\uFFFD]/g) || []).length;
    if (printable < 30) return null;
    return { text, printable };
  } catch (e) {
    return null;
  }
}

module.exports = { extractPdfText };
