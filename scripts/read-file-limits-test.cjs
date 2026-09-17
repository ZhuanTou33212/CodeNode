/**
 * read-file-limits-test.cjs —— read_file 的体积上限与「错误归因」（任务单第 9 项）的回归用例
 *
 * 缺陷：`readTextFileSafe` 会区分三种失败（超过字节上限 / 二进制 / 非 UTF-8），
 * 但 read_file 把它们**统一**渲染成「是二进制或不可读文件，不能用 read_file 读取；请按建议解析：…」。
 * 实测 20MB 的纯文本 .txt 也被这么说 → 模型据此去试别的解析方式（甚至装 Python 库），
 * 把「文件太大」当成「文件坏了」，白烧轮次。
 *
 * 修复：按原因分流报错（超上限 → 明确说上限 + 给出 offset/search_files 的做法；
 * 二进制/编码问题 → 保留原来的解析建议），并把上限提成常量 MAX_TEXT_BYTES。
 *
 * 判据：三种原因的报错**互不冒充**，且 2MB 内的正常文本照常读到内容（反向锁，防过度修复）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

/** Windows 上 rmSync(recursive) 对长/含空格路径会 EPERM → 逐项删（既有用例同款做法） */
function cleanup(dir) {
  const walk = (target) => {
    let items = [];
    try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(target, item.name);
      if (item.isDirectory()) walk(full);
      else try { fs.unlinkSync(full); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
  };
  walk(dir);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-readfile-limits-'));

(async () => {
  // 3MB 纯文本（> 2MB 上限）
  const bigLines = [];
  for (let i = 0; i < 40000; i++) bigLines.push('line ' + i + ' ' + 'x'.repeat(70));
  fs.writeFileSync(path.join(root, 'big.txt'), bigLines.join('\n'), 'utf8');
  const bigSize = fs.statSync(path.join(root, 'big.txt')).size;
  // 二进制（含 NUL）
  const bin = Buffer.concat([Buffer.from('ELF\u0000\u0001'), Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256))]);
  fs.writeFileSync(path.join(root, 'blob.bin'), bin);
  // 非 UTF-8（latin1 高位字节，无 NUL）
  fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from(Array.from({ length: 100 }, () => 0xd6)), 'latin1');
  // 正常小文本
  fs.writeFileSync(path.join(root, 'ok.txt'), 'hello\nworld\n', 'utf8');

  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
  sandbox.setDefaultPolicy(policy);
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['read_file'] });
  const context = new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });

  const over = await registry.execute('read_file', { path: 'big.txt', maxLines: 5 }, context);
  check('① 超过 2MB 的纯文本：报「超过字节上限」并给出分段读法',
    over.ok === false && /字节上限/.test(String(over.text)) && /offset|maxLines/.test(String(over.text)),
    String(over.text).slice(0, 90));
  check('①b 不再把它冒充成「二进制或不可读文件」（这就是被修掉的错误归因）',
    !/二进制或不可读文件/.test(String(over.text)), String(over.text).slice(0, 60));
  check('①c 上限值写进报错（用户知道是 2MB 而不是「文件坏了」）', /2MB/.test(String(over.text)), String(over.text).slice(0, 90));

  const binary = await registry.execute('read_file', { path: 'blob.bin' }, context);
  check('② 真二进制（含 NUL）：仍报二进制并给出解析建议',
    binary.ok === false && /二进制或不可读文件/.test(String(binary.text)) && !/字节上限/.test(String(binary.text)),
    String(binary.text).slice(0, 80));

  const gbk = await registry.execute('read_file', { path: 'gbk.txt' }, context);
  check('③ 非 UTF-8：报编码原因（不冒充二进制，也不冒充超限）',
    gbk.ok === false && /UTF-8/.test(String(gbk.text)) && !/字节上限/.test(String(gbk.text)),
    String(gbk.text).slice(0, 80));

  const okFile = await registry.execute('read_file', { path: 'ok.txt' }, context);
  check('④ 正常小文件照常读到内容（反向锁：错误分流不能误伤正常路径）',
    okFile.ok === true && /hello/.test(String(okFile.text)), String(okFile.text).slice(0, 40));

  check('⑤ 上限常量与实测文件大小关系正确（本次 fixture ' + bigSize + ' 字节确实超过 2MB）', bigSize > 2 * 1024 * 1024, String(bigSize));

  cleanup(root);
  console.log('READ FILE LIMITS TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('READ FILE LIMITS TEST: ERROR', error);
  process.exit(1);
});
