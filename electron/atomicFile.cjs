'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
/** 原子写：先写临时文件、fsync、再 rename，避免崩溃后留下半截文件。 */
/**
 * @param {string} file
 * @param {string|Buffer} data
 * @param {BufferEncoding} [encoding]
 * @param {{expectedSha256: string}|null} [guard]
 * @param {{expectedSha256?: string}|null} [guard]
 */
function atomicWriteFile(file, data, encoding = 'utf8', guard = null) {
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
    if (guard && guard.expectedSha256) {
      const actual = fs.existsSync(target) ? require('crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex') : 'absent';
      const expected = String(guard.expectedSha256).replace(/^sha256:/, '');
      if (actual !== expected) throw Object.assign(new Error('提交前文件版本已变化'), { code: 'CONFLICT_STALE', actual });
    }
    fs.renameSync(temporary, target);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    if (fs.existsSync(temporary)) try { fs.unlinkSync(temporary); } catch {}
  }
}
module.exports = { atomicWriteFile };
