/**
 * shellGuard.cjs —— execute_shell 的命令静态审计（写路径越界 / 网络意图）
 *
 * 为什么需要它（2026-09-15 实测复现的缺口）：
 *   `execute_shell` 的白名单包含 cmd / powershell / node / npm / npx，而 Windows 后端
 *   （windows-job）**不隔离文件系统** —— `writeRoots` 只对 Linux bwrap / macOS sandbox-exec
 *   生效。于是 `cmd /c echo X > <项目外路径>` 与 `node -e "writeFileSync(<项目外>)"` 都能
 *   真的越界写盘。当时唯一的兜底是用户点确认，而确认文案只说「执行命令」——用户无法从
 *   文案判断这条命令会写到工作区外面。
 *
 * 本模块把这两件事变成**命令文本级的静态判定**，让工具层在确认之前 fail-closed 拒绝：
 *   - `outsideWrites`    命令显式要写到 writeRoots 之外 → 拒绝（不靠用户点确认）
 *   - `unresolvedWrites` 写目标含变量/通配，无法判定 → strict 模式拒绝，否则提示
 *   - `network`          命令疑似需要联网（URL / git push / npm install / npx / fetch …）
 *
 * 判定范围是**保守的启发式，不做命令模拟**：只认显式的写出口（重定向、写选项、
 * 写动词、脚本 API 字面量），宁可漏判也不误伤（只读地引用工作区外路径仍然放行）。
 */
'use strict';

const path = require('path');

/** 「未解析」写目标的内部前缀（不可能是合法路径首字符） */
const INDIRECT_PREFIX = '\u0000';

const DEVICE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', 'nul', 'null', '-']);

/** 会产生「写」的命令 → 其后第一个非选项参数即写目标 */
const WRITE_VERBS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'truncate',
  'cp', 'copy', 'mv', 'move', 'mkdir', 'md', 'touch', 'tee', 'dd', 'ln',
  'install', 'rsync', 'scp',
  'set-content', 'add-content', 'out-file', 'new-item', 'set-item',
  'remove-item', 'move-item', 'copy-item', 'clear-content',
]);

/**
 * 「源 → 目标」型动词：写目标是**最后一个**非选项参数（cp a b / mv a b / robocopy a b）。
 * 其余写动词（rm / mkdir / touch / Set-Content …）的目标是第一个非选项参数。
 */
const TWO_ARG_VERBS = new Set(['cp', 'copy', 'mv', 'move', 'install', 'rsync', 'scp', 'ln', 'xcopy', 'robocopy', 'copy-item', 'move-item']);

/** 选项名 → 其值是一个写目标路径（刻意不含 -Path/-LiteralPath：它们在读命令里同样常见） */
const WRITE_OPTIONS = new Set([
  '-o', '--output', '--out', '--outfile', '--out-file', '--output-file',
  '--output-dir', '--out-dir', '--destination', '--dest',
  '-outfile', '-filepath', '-destination',
]);

/** 脚本 API 里的写目标字面量：writeFileSync('x') / createWriteStream("y") / Path('z').write_text(...) */
const API_WRITE_RE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|rmdirSync|rm|unlinkSync|unlink|copyFileSync|renameSync|cpSync|symlinkSync|truncateSync|write_text|write_bytes)\s*\(\s*(['"`])([^'"`\n]+)\1/g;

/** API 的写目标是变量/表达式（writeFileSync(variable)）→ 无法静态判定，记为「未解析」 */
const API_INDIRECT_RE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|rmSync|rmdirSync|unlinkSync|copyFileSync|renameSync|cpSync)\s*\(\s*([A-Za-z_$][\w$.]*)/g;

/** 重定向：> >> 2> &> ...（排除 2>&1 这类句柄复制） */
const REDIRECT_RE = /(?:^|[\s;&|])(\d?>>?|&>)\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;

/** 疑似联网的命令（第一段） */
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'telnet', 'nc', 'ncat']);

/** 疑似联网的子命令：<base> <sub> */
const NETWORK_SUBCOMMANDS = Object.freeze({
  git: new Set(['clone', 'fetch', 'pull', 'push', 'remote', 'ls-remote', 'submodule']),
  npm: new Set(['install', 'i', 'ci', 'publish', 'update', 'add', 'audit', 'view']),
  pnpm: new Set(['install', 'i', 'add', 'publish']),
  yarn: new Set(['install', 'add', 'publish']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  go: new Set(['get', 'install']),
  nuget: new Set(['install', 'restore']),
  dotnet: new Set(['restore', 'add']),
  npx: new Set(['*']),
});

/** 命令里出现 URL（含变量拼接的 http 片段）即为联网意图 */
const URL_RE = /https?:\/\//i;
const PS_NETWORK_RE = /\b(invoke-webrequest|invoke-restmethod|start-bitstransfer|iwr|irm|downloadstring|downloadfile)\b/i;
const SCRIPT_NETWORK_RE = /\b(fetch|axios|httpx|requests\.get|requests\.post|urllib|http\.client|net\.connect|https?\.get)\s*\(/i;

/**
 * 切分命令（引号内保持整体，去掉引号字符）。
 * `>` 不参与切分，因为它要和目标贴着（`>out.txt`）。
 * @param {string} command
 * @returns {string[]}
 */
function tokenize(command) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (/\s/.test(c) || c === ';' || c === '|' || c === '&') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** `/c/Users/x` → `C:/Users/x`（Windows 上的 MSYS 风格路径）；POSIX 平台原样保留 */
function normalizeCandidate(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) s = s.slice(1);
  if (s.length >= 2 && (s.endsWith('"') || s.endsWith("'"))) s = s.slice(0, -1);
  if (process.platform === 'win32') {
    const msys = s.match(/^\/([a-zA-Z])(\/.*)?$/);
    // 只认「单字母盘符」形态，避免把 /usr/bin 当成 U: 盘
    if (msys) s = msys[1].toUpperCase() + ':' + (msys[2] || '/');
  }
  return s;
}

/** 无法静态判定的写目标（含变量、通配、shell 展开） */
function isUnresolved(value) {
  return /[$%*?]/.test(value) || /^~/.test(value) || value === '';
}

/**
 * 目标是否落在某个可写根之内（Windows 大小写不敏感）。
 * @param {string} target 绝对路径
 * @param {string[]} roots
 */
function withinAnyRoot(target, roots) {
  const fold = process.platform === 'win32';
  const t = fold ? path.resolve(target).toLowerCase() : path.resolve(target);
  for (const root of Array.isArray(roots) ? roots : []) {
    const r = fold ? path.resolve(root).toLowerCase() : path.resolve(root);
    if (t === r) return true;
    if (t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
  }
  return false;
}

/**
 * 在一组 token 里按「写动词的位置参数 / 写选项的值」收集写目标。
 * @param {string[]} tokens
 * @param {string[]} targets
 */
function collectFromTokens(tokens, targets) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const bare = token.replace(/\\/g, '/');
    const head = (bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare)
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/, '');
    const isOption = WRITE_OPTIONS.has(token.toLowerCase());
    if (isOption) {
      // --output=path 形式
      const eq = token.indexOf('=');
      if (eq > 0 && token[0] === '-') {
        targets.push(token.slice(eq + 1));
        continue;
      }
      const next = tokens[i + 1];
      if (next) targets.push(next);
      continue;
    }
    if (!WRITE_VERBS.has(head)) continue;
    if (TWO_ARG_VERBS.has(head)) {
      // 源 → 目标：取其后若干个非选项参数里的最后一个作为写目标
      /** @type {string[]} */
      const positional = [];
      for (let j = i + 1; j < tokens.length && j <= i + 4; j++) {
        const next = tokens[j];
        if (!next) continue;
        if (next.startsWith('-') && next.length > 1) continue;
        positional.push(next);
      }
      if (positional.length) targets.push(positional[positional.length - 1]);
      continue;
    }
    for (let j = i + 1; j < tokens.length && j <= i + 2; j++) {
      const next = tokens[j];
      if (!next) continue;
      if (next.startsWith('-') && next.length > 1) continue; // 跳过 -r / --force 这类开关
      targets.push(next);
      break;
    }
  }
}

/**
 * 抽出一条命令里**显式声明的写目标**（原文 token，未解析为绝对路径）。
 * 「未解析」项带 INDIRECT_PREFIX 前缀。
 * @param {string} command
 * @returns {string[]}
 */
function extractWriteTargets(command) {
  /** @type {string[]} */
  const targets = [];
  const text = String(command || '');
  if (!text) return targets;

  // 1) 重定向（排除 2>&1 / >&2 这类句柄复制）
  let m;
  REDIRECT_RE.lastIndex = 0;
  while ((m = REDIRECT_RE.exec(text)) !== null) {
    const raw = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
    if (!raw || raw.startsWith('&') || raw.startsWith('>')) continue;
    targets.push(raw);
  }

  // 2) 写动词 + 写选项
  const tokens = tokenize(text);
  collectFromTokens(tokens, targets);
  // 2b) 引号包裹的子命令（powershell -Command "Out-File -FilePath E:\x"）—— 引号内容被 tokenize
  //     当成一个整体 token，这里把它再切一次，否则内层写目标完全看不见。
  for (const token of tokens) {
    if (!/\s/.test(token)) continue;
    const inner = tokenize(token);
    if (inner.length >= 2) collectFromTokens(inner, targets);
  }

  // 3) 脚本 API 字面量
  API_WRITE_RE.lastIndex = 0;
  while ((m = API_WRITE_RE.exec(text)) !== null) {
    targets.push(m[2]);
  }
  // 3b) API 的写目标是变量/表达式 → 无法静态判定，记为未解析
  API_INDIRECT_RE.lastIndex = 0;
  while ((m = API_INDIRECT_RE.exec(text)) !== null) {
    targets.push(INDIRECT_PREFIX + m[1]);
  }
  return targets;
}

/**
 * 命令是否疑似需要联网。
 * @param {string} command
 * @returns {string[]} 命中的理由（空数组 = 没有联网意图）
 */
function detectNetwork(command) {
  const text = String(command || '');
  /** @type {string[]} */
  const hits = [];
  if (!text) return hits;
  if (URL_RE.test(text)) hits.push('含 URL');
  if (PS_NETWORK_RE.test(text)) hits.push('PowerShell 下载型 cmdlet');
  if (SCRIPT_NETWORK_RE.test(text)) hits.push('脚本网络调用');
  const tokens = tokenize(text);
  let seq = tokens.map((t) => t.toLowerCase().replace(/\\/g, '/'));
  // powershell -Command "git push ..." 这种：把内层命令也当一段看
  const inner = seq.indexOf('-command');
  if (inner >= 0) seq = seq.slice(inner + 1);
  /**
   * 程序名归一化：**去掉目录与扩展名**（`C:/tools/nuget.exe` → `nuget`）。
   * 与 executeShellTool 的 normalizeProgram / 高危判据同一口径 —— 否则「换个写法」就能同时绕过
   * 断网策略与高危确认：实测 `nuget restore` 被判联网而 `C:/tools/nuget.exe restore` 不算联网
   * （同一件事两种判定），在出厂 deny 下前者被拒、后者却只弹一次确认（2026-09-21 实测）。
   */
  const rawBase = (seq[0] || '').replace(/^["']|["']$/g, '').replace(/\.(exe|cmd|bat|ps1)$/, '');
  const base = rawBase.slice(rawBase.lastIndexOf('/') + 1);
  if (NETWORK_COMMANDS.has(base)) hits.push('联网命令 ' + base);
  const subs = NETWORK_SUBCOMMANDS[base];
  if (subs) {
    const sub = (seq[1] || '').replace(/^-+/, '');
    if (subs.has('*') || subs.has(sub)) hits.push(base + ' ' + sub);
  }
  return hits;
}

/**
 * 静态审计一条 shell 命令。
 * @param {string} command
 * @param {{ projectRoot?: string, writeRoots?: string[] }} [options]
 *   writeRoots 缺省时退回 [projectRoot]；应传入隔离策略的 writeRoots（含 tmp / userData）
 * @returns {{ outsideWrites: string[], unresolvedWrites: string[], network: string[], reasons: string[] }}
 */
function analyzeShellCommand(command, options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : process.cwd();
  const roots = Array.isArray(opts.writeRoots) && opts.writeRoots.length ? opts.writeRoots.slice() : [projectRoot];
  /** @type {string[]} */
  const outside = [];
  /** @type {string[]} */
  const unresolved = [];

  for (const raw of extractWriteTargets(command)) {
    const indirect = raw.startsWith(INDIRECT_PREFIX);
    const candidate = normalizeCandidate(indirect ? raw.slice(1) : raw);
    if (!candidate) continue;
    if (DEVICE_TARGETS.has(candidate.toLowerCase())) continue;
    if (indirect || isUnresolved(candidate)) {
      unresolved.push(candidate);
      continue;
    }
    const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(projectRoot, candidate);
    if (!withinAnyRoot(abs, roots)) outside.push(abs);
  }

  const outsideWrites = Array.from(new Set(outside));
  const unresolvedWrites = Array.from(new Set(unresolved));
  const network = detectNetwork(command);
  /** @type {string[]} */
  const reasons = [];
  if (outsideWrites.length) reasons.push('命令会写入工作区之外的路径：' + outsideWrites.join(', '));
  if (unresolvedWrites.length) reasons.push('写目标含变量/通配，无法静态判定是否越界：' + unresolvedWrites.join(', '));
  if (network.length) reasons.push('命令疑似需要联网：' + network.join('、'));

  return { outsideWrites, unresolvedWrites, network, reasons };
}

module.exports = {
  analyzeShellCommand,
  detectNetwork,
  extractWriteTargets,
  tokenize,
  withinAnyRoot,
  INDIRECT_PREFIX,
};
