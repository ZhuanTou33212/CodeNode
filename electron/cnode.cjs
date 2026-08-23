/**
 * CodeNode Next 专属工程格式（.cnode）
 *
 * 参考原版 .cnode（codenode-desktop）：
 *  - UTF-8 ZIP 容器，`mimetype` 作为首条目（不压缩）
 *  - 条目：mimetype / manifest.json / graph.json / workspace.json / integrity.json
 *  - integrity.json 记录各文件的 SHA-256，用于完整性校验
 *  - 未知字段忽略、缺失字段使用默认值（宽松读取）
 *
 * 本版为 1.0：节点语义为「Agent 工作流节点」，无代码槽/端口类型等旧概念。
 * mimetype: application/vnd.codenode.project+zip
 */
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

const MIME = 'application/vnd.codenode.project+zip';
const FORMAT = 'codenode-project';
const FORMAT_VERSION = '1.0';
const GENERATOR = { application: 'codenode-desktop-next', version: '0.1.0' };

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- ZIP（store 法，无压缩，mimetype 首个） ----------
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const dateVal = 0x0021;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: store
      u16(dateVal), // last mod time
      u16(dateVal), // last mod date
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra len
      name,
    ]);
    parts.push(local, data);
    central.push(
      Buffer.concat([
        u32(0x02014b50), // central dir signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method
        u16(dateVal), // last mod time
        u16(dateVal), // last mod date
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra len
        u16(0), // comment len
        u16(0), // disk number
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        name,
      ])
    );
    offset += local.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cdBuf.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function unzip(buf) {
  const files = new Map();
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig === 0x06054b50 || sig === 0x02014b50) break; // EOCD / central dir
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf-8', off + 30, off + 30 + nameLen);
    let data = buf.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + compSize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) return files;
    files.set(name, Buffer.from(data));
    off = off + 30 + nameLen + extraLen + compSize;
  }
  return files;
}

// ---------- 默认值 ----------
function defaultManifest(doc) {
  const now = new Date().toISOString();
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    documentId: (doc && doc.documentId) || crypto.randomUUID(),
    name: (doc && doc.name) || 'CodeNode 工作流',
    createdAt: (doc && doc.createdAt) || now,
    modifiedAt: now,
    generator: GENERATOR,
  };
}

// ---------- 编码 ----------
function encodeCnode({ manifest, graph, workspace, canvases }) {
  const m = defaultManifest(manifest);
  const g = { revision: (graph && graph.revision) || 1, nodes: (graph && graph.nodes) || [], edges: (graph && graph.edges) || [] };
  const w = workspace && typeof workspace === 'object' ? workspace : {};
  const c = canvases && typeof canvases === 'object' ? canvases : null;
  const mimeBuf = Buffer.from(MIME, 'utf-8');
  const manifestBuf = Buffer.from(JSON.stringify(m), 'utf-8');
  const graphBuf = Buffer.from(JSON.stringify(g), 'utf-8');
  const wsBuf = Buffer.from(JSON.stringify(w), 'utf-8');
  const canvasesBuf = c ? Buffer.from(JSON.stringify(c), 'utf-8') : null;
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const filesMap = {
    'manifest.json': sha(manifestBuf),
    'graph.json': sha(graphBuf),
    'workspace.json': sha(wsBuf),
  };
  if (canvasesBuf) filesMap['canvases.json'] = sha(canvasesBuf);
  const integrity = { algorithm: 'SHA-256', files: filesMap };
  const integrityBuf = Buffer.from(JSON.stringify(integrity), 'utf-8');
  const entries = [
    { name: 'mimetype', data: mimeBuf },
    { name: 'manifest.json', data: manifestBuf },
    { name: 'graph.json', data: graphBuf },
    { name: 'workspace.json', data: wsBuf },
  ];
  if (canvasesBuf) entries.push({ name: 'canvases.json', data: canvasesBuf });
  entries.push({ name: 'integrity.json', data: integrityBuf });
  return zipStore(entries);
}

// ---------- 解码（宽松） ----------
function decodeCnode(buf) {
  const warnings = [];
  const files = unzip(buf);
  if (files.size === 0) return { ok: false, error: '不是有效的 .cnode 文件' };
  const mime = files.get('mimetype') ? files.get('mimetype').toString('utf-8').trim() : '';
  if (mime !== MIME) warnings.push('mimetype 不匹配');
  const parse = (name, fallback) => {
    const b = files.get(name);
    if (!b) {
      warnings.push('缺少 ' + name);
      return fallback;
    }
    try {
      return JSON.parse(b.toString('utf-8'));
    } catch (e) {
      warnings.push(name + ' 解析失败');
      return fallback;
    }
  };
  const manifest = parse('manifest.json', { format: FORMAT, formatVersion: FORMAT_VERSION });
  const graph = parse('graph.json', { revision: 0, nodes: [], edges: [] });
  const workspace = parse('workspace.json', {});
  // canvases 为可选（旧版无），静默读取
  const canvasesBuf = files.get('canvases.json');
  let canvases = null;
  if (canvasesBuf) {
    try {
      canvases = JSON.parse(canvasesBuf.toString('utf-8'));
    } catch {
      warnings.push('canvases.json 解析失败');
    }
  }
  const integrity = parse('integrity.json', null);

  if (integrity && integrity.algorithm === 'SHA-256' && integrity.files) {
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    for (const key of ['manifest.json', 'graph.json', 'workspace.json', 'canvases.json']) {
      const expected = integrity.files[key];
      const b = files.get(key);
      if (expected && b && sha(b) !== expected) warnings.push(key + ' 完整性校验失败');
    }
  }
  if (manifest.formatVersion && !manifest.formatVersion.startsWith('1.')) {
    warnings.push('工程格式版本 ' + manifest.formatVersion + ' 高于本应用支持范围，将只读打开');
  }
  return { ok: true, manifest, graph, workspace, canvases, integrity, warnings };
}

module.exports = { encodeCnode, decodeCnode, MIME, FORMAT, FORMAT_VERSION };
