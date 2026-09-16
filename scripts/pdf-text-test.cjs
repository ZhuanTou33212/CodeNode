/**
 * pdf-text-test.cjs —— PDF 文本提取的回归锁（含「大内容流不再爆栈」）
 *
 * 背景（本轮修的既有缺陷）：`extractPdfText` 原用一条**巨型正则**反复 `exec` 内容流，
 * 内容流 >~8MB 原始文本时 `RegExp.exec` 会抛 `RangeError: Maximum call stack size exceeded`，
 * 异常被最外层 `catch` 吞掉 → 整份 PDF 返回 null → `read_file` 把一份**完全可解析**的大 PDF
 * 误报成「扫描版或文字层不可用」，把用户往「换文件 / 上 OCR」的错误方向引。
 * 现已改为**单次字符扫描**（O(n)、无回溯，无规模上限）。
 *
 * 这个用例锁两件事：
 *   1. 各操作符的提取结果与**旧实现逐字一致** —— 下面每条 golden 都是从旧实现跑出来、并对拍确认过的
 *      （对拍脚本一次就抓出了扫描器最初漏掉的一处 `'` 操作符前导换行）；
 *   2. 大内容流（8.58MB / 17.17MB）不再返回 null，且可打印字符数与理论值**精确吻合**
 *      （不是"看起来有文本"就算了）。
 */
'use strict';

const zlib = require('zlib');

const { extractPdfText } = require('../electron/tools/impl/pdfText.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** 造一个只含一个 FlateDecode 流的 PDF */
function makePdf(content) {
  const def = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = '%PDF-1.4\n1 0 obj\n<< /Length ' + def.length + ' /Filter /FlateDecode >>\nstream\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), def, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
}

/** 折掉空白做比较（golden 关心的是文字内容与分段，不关心空白形状） */
const norm = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');

const PAD = ' padding text to cross the printable threshold ';
const PAD_WORDS = 'padding text to cross the printable threshold';

// ---------------- 1. 各操作符的提取结果（golden 与旧实现一致） ----------------
{
  const r = extractPdfText(makePdf('BT /F1 12 Tf 50 700 Td (Hello CodeNode PDF' + PAD + ') Tj ET'));
  check('G1 Tj 基本提取', r && norm(r.text) === 'Hello CodeNode PDF ' + PAD_WORDS, r && norm(r.text));
  check('G2 可打印字符数精确（17 + 38）', r && r.printable === 55, r && String(r.printable));
  check('G3 Td 之后有前导换行（旧行为）', r && r.text.startsWith('\n'), JSON.stringify(r && r.text.slice(0, 8)));
}

{
  const r = extractPdfText(
    makePdf(
      [
        'BT /F1 12 Tf 50 700 Td (Line one' + PAD + ') Tj ET',
        'BT /F1 12 Tf 50 680 Td (Line two' + PAD + ') Tj ET',
        'BT /F1 12 Tf 50 660 Td (Line three' + PAD + ') Tj ET',
      ].join('\n'),
    ),
  );
  check('G4 多 BT/ET 块各自成行', r && norm(r.text) === ('Line one ' + PAD_WORDS + ' Line two ' + PAD_WORDS + ' Line three ' + PAD_WORDS), r && norm(r.text));
  check('G5 可打印字符数精确（8+38 / 8+38 / 10+38）', r && r.printable === 140, r && String(r.printable));
}

{
  const r = extractPdfText(makePdf('BT /F1 12 Tf [(Hello' + PAD + ') -300 (World' + PAD + ')] TJ ET'));
  check('G6 TJ 数组按顺序拼接', r && norm(r.text) === 'Hello ' + PAD_WORDS + ' World ' + PAD_WORDS, r && norm(r.text));
  check('G7 TJ 无 Td 时不带前导换行', r && !r.text.startsWith('\n'), JSON.stringify(r && r.text.slice(0, 8)));
}

{
  const r = extractPdfText(makePdf('BT /F1 12 Tf 10 10 Td (A' + PAD + ') Tj T* (B' + PAD + ') Tj 10 5 Td (C' + PAD + ') Tj ET'));
  check('G8 T* 与第二个 Td 都产生换行（3 段）',
    r && norm(r.text) === ('A ' + PAD_WORDS + ' B ' + PAD_WORDS + ' C ' + PAD_WORDS),
    r && norm(r.text));
}

{
  // `'` 操作符：旧实现是 out += '\n' + text —— 扫描器最初漏了这个前导换行，被对拍抓出来
  const r = extractPdfText(makePdf("BT /F1 12 Tf (Quoted" + PAD + ") ' ET"));
  check("G9 ' 操作符带前导换行（对拍抓到的差异点）",
    r && r.text.startsWith('\n') && norm(r.text) === 'Quoted ' + PAD_WORDS,
    JSON.stringify(r && r.text.slice(0, 12)));
}

{
  const r = extractPdfText(
    makePdf('BT /F1 12 Tf 1 0 0 1 50 700 Tm (At 700' + PAD + ') Tj 1 0 0 1 50 600 Tm (At 600' + PAD + ') Tj ET'),
  );
  check('G10 Tm 的 y 位移超过阈值才换行', r && norm(r.text) === ('At 700 ' + PAD_WORDS + ' At 600 ' + PAD_WORDS), r && norm(r.text));
}

{
  const r = extractPdfText(makePdf('BT /F1 12 Tf (a\\(b\\)c \\\\ d' + PAD + ') Tj ET'));
  check('G11 转义与嵌套括号', r && norm(r.text) === 'a(b)c \\ d ' + PAD_WORDS, r && norm(r.text));
}

{
  // 转义反斜杠紧跟真括号：内容 `a\)b`。如果扫描器不跳过转义序列，
  // 会把 `\)` 里的 `)` 当成字符串结束 → 解析错位（这条是变异测试逼出来的：
  // 最初只测 `\(` / `\)` 这种**深度抵消**的输入，改坏跳过逻辑也照样绿）。
  const r = extractPdfText(makePdf('BT /F1 12 Tf (a\\)b' + PAD + ' tail) Tj ET'));
  check('G11b 转义反斜杠后紧跟真括号（不跳过转义就会错位）',
    r && norm(r.text).includes('a)b') && norm(r.text).includes('tail'),
    r && norm(r.text));
}

{
  const r = extractPdfText(makePdf('BT\n% comment line\n/F1 12 Tf 50 700 Td (With comment' + PAD + ') Tj\nET'));
  check('G12 注释行被跳过', r && norm(r.text) === 'With comment ' + PAD_WORDS, r && norm(r.text));
}

{
  // 真嵌套括号：PDF 规范允许（字面量里的括号要按深度配对）。旧正则在**这种**输入上整体
  // 返回 null（实测），于是整份可解析的 PDF 被报成「扫描版」；新扫描器按深度正确解析。
  // 这是**有意**的行为改进（不是等价重构），用这条锁住。
  const r = extractPdfText(makePdf('BT /F1 12 Tf (outer(inner)' + PAD + 'more) Tj ET'));
  check('G12b 真嵌套括号按深度解析（有意改进：旧实现这里返回 null）',
    r && norm(r.text).includes('outer(inner)') && norm(r.text).includes('more'),
    r && norm(r.text));
}

// ---------------- 2. null 语义不变 ----------------
{
  check('G13 无流 → null', extractPdfText(Buffer.from('%PDF-1.4\ntrailer\n', 'latin1')) === null);
  check('G14 有流但无 BT → null', extractPdfText(makePdf('<< /Type /Page /MediaBox [0 0 595 842] >>')) === null);
  check('G15 空 buffer → null', extractPdfText(Buffer.alloc(0)) === null);
  check('G16 扫描版（内容流无文字层）→ null', extractPdfText(makePdf('0 0 1 RG 0 0 100 100 re f')) === null);
}

// ---------------- 3. 大内容流：不再爆栈（本轮修的核心） ----------------
{
  const unit = 'the quick brown fox jumps over the lazy dog. ';
  const marks = [
    [200000, 7200000], // 8.58MB 原始文本 —— 正是旧实现爆栈的规模
    [400000, 14400000], // 17.17MB
  ];
  for (const [n, expectedPrintable] of marks) {
    const buf = makePdf('BT /F1 12 Tf 50 700 Td (' + unit.repeat(n) + ') Tj ET');
    const t0 = Date.now();
    const r = extractPdfText(buf);
    const ms = Date.now() - t0;
    check(
      'G17 内容流 ' + (unit.length * n / 1048576).toFixed(2) + 'MB 能提取（旧实现此处返回 null）',
      r && typeof r.text === 'string' && r.text.includes('quick brown fox'),
      r ? 'ok' : 'null',
    );
    check(
      'G18 ' + (unit.length * n / 1048576).toFixed(2) + 'MB 可打印字符数与理论值精确吻合',
      r && r.printable === expectedPrintable,
      r ? String(r.printable) + ' vs ' + expectedPrintable + ' (' + ms + 'ms)' : 'null',
    );
  }
}

console.log('PDF TEXT TEST: ' + (failures ? 'FAIL' : 'PASS'));
process.exit(failures ? 1 : 0);
