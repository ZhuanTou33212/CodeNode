'use strict';
const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'ComSpec', 'COMSPEC', 'LANG', 'LC_ALL', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);
/**
 * 白名单化环境变量：只保留系统必需项 + 显式 extra / allowlist，避免把父进程的密钥透传给子进程。
 * @param {Record<string, string|undefined>} [extra]
 * @param {string[]} [allowlist]
 * @returns {Record<string, string>}
 */
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
