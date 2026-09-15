/**
 * 「主进程源码」的统一定义：electron/main.cjs + 已拆出的 electron/ipc/*.cjs。
 *
 * 为什么需要它：门禁里有一类断言是「模块必须真的接进主进程」（避免"写了模块但没接线"的假完成），
 * 做法是 grep 主进程源码。而主进程代码按域拆进 electron/ipc/ 之后，只看 main.cjs 就会把
 * "已迁移"误报成"未接线"。所以门禁统一用这份并集，而不是各自 read('electron/main.cjs')。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** @returns {string} 主进程全部源码（按文件名排序拼接，便于 diff 与稳定复现） */
function readMainProcessSource() {
  const dir = path.join(ROOT, 'electron', 'ipc');
  const parts = [fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8')];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs'));
  } catch {}
  for (const name of names.sort()) {
    parts.push(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return parts.join('\n');
}

module.exports = { readMainProcessSource };
