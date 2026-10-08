'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { LocalRagIndex } = require("../../electron/rag/index.cjs");
const { parseRagConfig } = require("../../electron/agent.cjs");
const { extractDocumentText } = require("../../electron/tools/impl/documentText.cjs");
const { extractPdfText } = require("../../electron/tools/impl/pdfText.cjs");
const fsCore = require("../../electron/tools/fsCore.cjs");
const fsRunner = require("../../electron/tools/fsRunner.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const toolkit = require("../../electron/tools/toolkit.cjs");

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Real ZIP headers with data descriptors: local sizes are zero, central sizes are authoritative. */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const flags = 0x808; // UTF-8 + data descriptor
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(0), u32(0), u16(name.length), u16(0), name, data,
      u32(0x08074b50), u32(crc), u32(data.length), u32(raw.length),
    ]);
    const directory = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(raw.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    parts.push(local);
    central.push(directory);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([...parts, directory,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0),
  ]);
}

function pdf(content) {
  const packed = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + packed.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    packed, Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-rag-doc-'));
const files = {
  'policy.pdf': pdf('BT /F1 12 Tf 50 700 Td (Quarterly invoice reconciliation deadline is Friday afternoon.) Tj ET'),
  'agreement.docx': zip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>合同审批时限为三天</w:t></w:r></w:p><w:p><w:r><w:t>逾期需要主管复核</w:t></w:r></w:p></w:body></w:document>' },
    { name: 'word/media/cover.bin', data: crypto.randomBytes(600 * 1024), store: true },
  ]),
  'budget.xlsx': zip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="年度预算" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>预算总额</t></si><si><r><t>四百万</t></r></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>4000000</v></c></row></sheetData></worksheet>' },
  ]),
  'launch.pptx': zip([
    { name: 'ppt/slides/slide1.xml', data: '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>产品发布计划</a:t></a:r></a:p><a:p><a:r><a:t>先完成灰度验证</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ]),
};

(async () => {
  try {
    assert.strictEqual(parseRagConfig({}).maxDocumentBytes, 20 * 1024 * 1024);
    assert.strictEqual(parseRagConfig({ 'rag.max_document_mb': '3' }).maxDocumentBytes, 3 * 1024 * 1024);
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root, name), data);
    const realFixtures = path.join(__dirname, "../fixtures/rag-documents");
    for (const name of fs.readdirSync(realFixtures)) {
      fs.copyFileSync(path.join(realFixtures, name), path.join(root, name));
    }
    assert.ok(files['agreement.docx'].length > 512 * 1024, 'Office archive must exceed ordinary text-file limit');
    assert.match(extractDocumentText(files['agreement.docx'], 'agreement.docx').text, /合同审批时限为三天/);
    assert.match(extractDocumentText(files['budget.xlsx'], 'budget.xlsx').text, /年度预算[\s\S]*A1=预算总额 \| B1=四百万/);
    assert.match(extractDocumentText(files['launch.pptx'], 'launch.pptx').text, /产品发布计划/);
    assert.match(extractDocumentText(files['policy.pdf'], 'policy.pdf').text, /invoice reconciliation deadline/);
    const multilinePdf = pdf('BT /F1 12 Tf (First approval paragraph has enough printable content.) Tj T* T* (Second paragraph follows after a blank line.) Tj ET');
    assert.strictEqual(extractDocumentText(multilinePdf, 'multiline.pdf').text, extractPdfText(multilinePdf).text,
      'RAG PDF citation lines must match read_file PDF extraction exactly');
    const index = new LocalRagIndex(root, { embedProvider: 'none' });
    for (const [query, expected] of [
      ['invoice reconciliation deadline', 'policy.pdf'],
      ['合同审批时限', 'agreement.docx'],
      ['预算总额', 'budget.xlsx'],
      ['产品发布计划', 'launch.pptx'],
      ['法务复核', 'real-word.docx'],
      ['华东地区收入', 'real-excel.xlsx'],
      ['季度发布计划', 'real-powerpoint.pptx'],
    ]) {
      const result = await index.retrieve(query);
      assert.strictEqual(result.results[0]?.path, expected, query + ' should recall ' + expected);
      assert.match(result.results[0].citation, new RegExp('^' + expected.replace('.', '\\.') + '#L\\d+-L\\d+$'));
    }
    assert.strictEqual(index.stats.indexedFiles, 7, 'synthetic and standard Office documents must all be indexed');
    assert.strictEqual(index.accepts('agreement.docx', files['agreement.docx'].length), true);
    assert.strictEqual(index.accepts('too-large.pdf', 21 * 1024 * 1024), false);

    const registry = toolkit.buildDefaultRegistryWithConfig({ toolsEnabled: true, toolsAllowed: ['read_file'] });
    const context = new AgentToolContext({ projectRoot: root, audit: () => {}, signal: new AbortController().signal });
    const officePayload = { path: path.join(root, 'agreement.docx'), maxBytes: 20 * 1024 * 1024 };
    const officeSync = fsCore.runTaskSync('readOfficeText', officePayload);
    const officeWorker = await fsRunner.runFsTask('readOfficeText', officePayload, {});
    assert.strictEqual(officeWorker.mode, 'worker', 'Office extraction should use the file worker');
    assert.deepStrictEqual(officeWorker.result, officeSync, 'worker and fallback extraction must agree');
    for (const [name, phrase] of [
      ['agreement.docx', '合同审批时限'], ['budget.xlsx', '年度预算'], ['launch.pptx', '产品发布计划'],
      ['real-word.docx', '法务复核'], ['real-excel.xlsx', '华东地区收入'],
      ['real-powerpoint.pptx', '季度发布计划'],
    ]) {
      const result = await registry.execute('read_file', { path: name }, context);
      assert.ok(result.ok, name + ': ' + result.text);
      assert.ok(result.text.includes(phrase), name + ' read_file must expose extracted text');
      assert.ok(result.data.lineCount >= 1 && result.data.sourceSha256, name + ' must return traceable metadata');
    }
    const malformed = Buffer.from(files['agreement.docx']);
    const central = malformed.indexOf(Buffer.from('PK\x01\x02', 'binary'));
    const documentName = malformed.indexOf(Buffer.from('word/document.xml'), central);
    malformed.writeUInt32LE(9 * 1024 * 1024, documentName - 46 + 24);
    assert.strictEqual(extractDocumentText(malformed, 'agreement.docx'), null, 'oversized XML must fail closed');
    const revised = zip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>紧急采购须当天复核</w:t></w:p></w:body></w:document>' }]);
    fs.writeFileSync(path.join(root, 'agreement.docx'), revised);
    index.invalidate('agreement.docx');
    const updated = await index.retrieve('紧急采购须当天复核');
    assert.strictEqual(updated.results[0]?.path, 'agreement.docx', 'edited Office document must be reindexed');
    fs.unlinkSync(path.join(root, 'launch.pptx'));
    await index.retrieve('季度发布计划');
    assert.ok(!index.chunks.some((chunk) => chunk.path === 'launch.pptx'), 'deleted presentation chunks must be removed');
    const packageConfig = require("../../package.json");
    assert.ok(packageConfig.build.asarUnpack.includes('electron/tools/impl/documentText.cjs'),
      'Office extractor must be unpacked beside fsCore for packaged workers');
    console.log('RAG DOCUMENT TEST: PASS (PDF, DOCX, XLSX, PPTX, worker read, limits)');
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
