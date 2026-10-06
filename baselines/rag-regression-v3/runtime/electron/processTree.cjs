'use strict';
const { spawn } = require('child_process');
function killProcessTree(child, force = false) {
  if (!child || !child.pid) return false;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      return true;
    } catch {}
  }
  try {
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
    } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch { return false; }
}
module.exports = { killProcessTree };
