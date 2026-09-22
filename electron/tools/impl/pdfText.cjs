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
            const base = dst.codePointAt(0) || 0;
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

/**
 * 提取单个内容流的文本（按 y 坐标下移换行，跨 BT/ET 块跟踪）。
 *
 * 实现方式：**单次字符扫描**（O(n)、无回溯），不再用「一条巨型正则反复 exec 长字符串」。
 * 原因：旧实现在超长内容流上 `RegExp.exec` 会抛 `RangeError: Maximum call stack size exceeded`
 * （实测内容流 >~8MB 原始文本必现），异常被 `extractPdfText` 外层 catch 吞掉后整份 PDF 变成 null，
 * `read_file` 于是把一份**完全可解析**的大 PDF 误报成「扫描版或文字层不可用」。
 * 扫描器没有这个规模上限，语义与旧实现对齐（`scripts/pdf-text-parity-test.cjs` 对拍新旧输出）。
 *
 * 支持的操作符（与旧实现一致）：`Tm` / `Td` / `TD` / `T*` / `BT` / `ET` / `<hex>Tj` /
 * `(lit)Tj` / `[...]TJ` / `(lit)'` / `(lit)"`。
 */
function extractContent(text, cidMap) {
  let out = '';
  let inText = false;
  let prevY = null;
  /** 最近的数字操作数（只留末尾若干个；被操作符消费后清空） */
  const nums = [];

  const isWs = (code) => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
  const isDigit = (code) => code >= 0x30 && code <= 0x39;
  const isNameChar = (code) =>
    code > 0x20 &&
    code !== 0x28 && code !== 0x29 && code !== 0x3c && code !== 0x3e &&
    code !== 0x5b && code !== 0x5d && code !== 0x7b && code !== 0x7d &&
    code !== 0x2f && code !== 0x25;
  // 用 charCode 判断而不是每字符跑一次正则：扫描 5MB 内容流时这是热点（实测占总耗时的一大截）
  const isOpCharCode = (code) =>
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x2a || code === 0x27 || code === 0x22;

  const n = text.length;
  let i = 0;
  /** 最近的字符串操作数：{ kind: 'lit'|'hex', value } */
  let lastStr = null;
  /** 最近的 TJ 数组：{ kind: 'lit'|'hex', value }[] */
  let lastArr = null;

  /**
   * 读一个字面量字符串（从 '(' 之后开始），返回 { lit, next }。
   * 内容**原样**返回（保留转义序列），交给 unescapeLit 处理 —— 与旧正则的捕获组一致。
   * 实现上只扫描一次定边界再 `slice`：逐字符 `lit += ch` 在几 MB 的字面量上是热点
   * （实测单这一步就让 5MB 内容流慢了近 3 倍）。
   */
  const readLiteral = (from) => {
    let j = from;
    let depth = 1;
    while (j < n) {
      const cj = text.charCodeAt(j);
      if (cj === 0x5c) {
        j += 2; // 反斜杠：跳过被转义的字符
        continue;
      }
      if (cj === 0x28) depth += 1;
      else if (cj === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    return { lit: text.slice(from, j), next: j + 1 };
  };

  const emitStr = (s) => {
    if (!inText || !s) return;
    out += s.kind === 'hex' ? decodeHex(Buffer.from(s.value, 'hex'), cidMap) : unescapeLit(s.value);
  };

  /** 按操作符语义更新状态（与旧正则的各分支一一对应） */
  const handleOp = (op) => {
    if (op === 'Tm') {
      // a b c d e f Tm：换行 = 行间距明显（相对缩放 |d| 计算阈值，兼容不同字体尺寸）
      if (nums.length >= 6) {
        const scale = Math.abs(nums[nums.length - 3]);
        const y = nums[nums.length - 1];
        const thr = Math.max(3, scale * 6);
        if (inText && out && prevY != null && Math.abs(prevY - y) > thr) out += '\n';
        prevY = y;
      }
      nums.length = 0;
      return;
    }
    if (op === 'Td' || op === 'TD') {
      if (inText && nums.length >= 2 && Math.abs(nums[nums.length - 1]) > 0.5) out += '\n';
      nums.length = 0;
      return;
    }
    if (op === 'T*') {
      if (inText) out += '\n';
      nums.length = 0;
      return;
    }
    if (op === 'BT') {
      inText = true;
      nums.length = 0;
      return;
    }
    if (op === 'ET') {
      inText = false;
      nums.length = 0;
      return;
    }
    if (op === 'Tj') {
      emitStr(lastStr);
      lastStr = null;
      nums.length = 0;
      return;
    }
    if (op === 'TJ') {
      if (inText && lastArr) for (const item of lastArr) emitStr(item);
      lastArr = null;
      nums.length = 0;
      return;
    }
    if (op === "'" || op === '"') {
      // 注意：旧实现在这两个操作符上是 `out += '\n' + unescapeLit(...)` —— 先补一个换行。
      // 这一点由 `scripts/pdf-text-parity-test.cjs` 对拍发现（最初漏了，输出少一个前导换行）。
      if (inText) {
        out += '\n';
        emitStr(lastStr);
      }
      lastStr = null;
      nums.length = 0;
      return;
    }
    // 其他操作符（Tf / Tc / rg / cm / re …）：消费掉数字操作数
    nums.length = 0;
  };

  while (i < n) {
    const code = text.charCodeAt(i);
    if (isWs(code)) {
      i += 1;
      continue;
    }
    const ch = text[i];

    if (ch === '%') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < n && isNameChar(text.charCodeAt(i))) i += 1;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      i += 2;
      continue;
    }
    if (ch === '>') {
      i += text[i + 1] === '>' ? 2 : 1;
      continue;
    }
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close < 0) break;
      lastStr = { kind: 'hex', value: text.slice(i + 1, close) };
      i = close + 1;
      continue;
    }
    if (ch === '(') {
      const r = readLiteral(i + 1);
      lastStr = { kind: 'lit', value: r.lit };
      i = r.next;
      continue;
    }
    if (ch === '[') {
      const items = [];
      let j = i + 1;
      while (j < n && text[j] !== ']') {
        const cj = text[j];
        if (cj === '(') {
          const r = readLiteral(j + 1);
          items.push({ kind: 'lit', value: r.lit });
          j = r.next;
          continue;
        }
        if (cj === '<') {
          const close = text.indexOf('>', j + 1);
          if (close < 0) {
            j = n;
            break;
          }
          items.push({ kind: 'hex', value: text.slice(j + 1, close) });
          j = close + 1;
          continue;
        }
        j += 1;
      }
      lastArr = items;
      i = j + 1;
      continue;
    }
    if (isDigit(code) || ch === '-' || ch === '+' || ch === '.') {
      let j = i;
      if (ch === '-' || ch === '+') j += 1;
      while (j < n && (isDigit(text.charCodeAt(j)) || text[j] === '.')) j += 1;
      const val = parseFloat(text.slice(i, j));
      if (Number.isFinite(val)) {
        nums.push(val);
        if (nums.length > 8) nums.shift();
      }
      i = j;
      continue;
    }
    if (isOpCharCode(code)) {
      let j = i;
      while (j < n && isOpCharCode(text.charCodeAt(j))) j += 1;
      const op = text.slice(i, j);
      i = j;
      // ' 与 " 是单字符操作符，可能被一并读进来（如 `Tj'`）：拆开依次处理
      if (op.length > 1 && (op.endsWith("'") || op.endsWith('"'))) {
        handleOp(op.slice(0, -1));
        handleOp(op.slice(-1));
        continue;
      }
      handleOp(op);
      continue;
    }
    i += 1;
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
