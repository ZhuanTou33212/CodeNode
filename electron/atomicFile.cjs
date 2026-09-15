'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
/** 原子写：先写临时文件、fsync、再 rename，避免崩溃后留下半截文件。 */
/**
 * @param {string} file
 * @param {string|Buffer} data
 * @param {BufferEncoding} [encoding]
 */
function atomicWriteFile(file, data, encoding = 'utf8') {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    if (fs.existsSync(temporary)) try { fs.unlinkSync(temporary); } catch {}
  }
}
module.exports = { atomicWriteFile };
