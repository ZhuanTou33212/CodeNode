'use strict';
const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'ComSpec', 'COMSPEC', 'LANG', 'LC_ALL', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);
function safeEnvironment(extra = {}, allowlist = []) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (SAFE_ENV_KEYS.has(key)) env[key] = value;
  for (const key of Array.isArray(allowlist) ? allowlist : []) {
    const name = String(key || '').trim();
    if (name && process.env[name] != null &&
      !/(key|token|secret|password|credential|private|auth)/i.test(name) &&
      !/^(NODE_|LD_|DYLD_|PYTHONPATH|PYTHONHOME|ELECTRON_|CODENODE_)/i.test(name)) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}
module.exports = { SAFE_ENV_KEYS, safeEnvironment };
