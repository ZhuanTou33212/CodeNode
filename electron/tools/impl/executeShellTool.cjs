/**
 * execute_shell：在项目根目录执行白名单命令（mvn/mvnw/git/java/javac/go/python/node/npm/nuget/cmd/powershell 等）。
 * 危险命令（删除/清理/强改/提交推送等）执行前必须用户确认（HIGH 级）；普通构建/查询命令直接放行并记录。超时强杀。
 */
'use strict';

const { spawn } = require('child_process');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');

const ALLOWED = new Set([
  'mvn', 'mvnw', 'mvnw.cmd', 'git', 'java', 'javac', 'gradle', 'gradlew', 'gradlew.bat',
  'go', 'python', 'python3', 'py', 'node', 'npm', 'npx', 'nuget', 'cmd', 'powershell', 'pwsh',
]);

/** 兼容解码子进程输出：UTF-8 优先，含乱码则按 GBK 解码，UTF-16LE（PowerShell）按 BOM/字节特征识别 */
function decodeOutput(buf) {
  if (!buf || buf.length === 0) return '';
  // UTF-16LE BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(buf.subarray(2)).replace(/\u0000/g, '');
    } catch {}
  }
  // 无 BOM 但高度疑似 UTF-16LE：偶数长度且奇数位多为 0
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let zeroOdd = 0;
    for (let i = 1; i < Math.min(buf.length, 64); i += 2) if (buf[i] === 0) zeroOdd++;
    if (zeroOdd >= 12) {
      try {
        return new TextDecoder('utf-16le').decode(buf).replace(/\u0000/g, '');
      } catch {}
    }
  }
  try {
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
  } catch {}
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {}
  return buf.toString('utf8');
}

function splitCommand(command) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(c) && !quoted) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isSensitiveCommand(tokens) {
  const flags = tokens.map((t) => t.toLowerCase());
  for (const f of flags) {
    if (['rm', 'del', 'rmdir', 'rd', 'clean', 'distclean', 'reset', 'hard', 'push', 'publish', '-f', '--force', '--hard'].includes(f)) {
      return true;
    }
  }
  const base = flags[0] || '';
  if (base.includes('git')) {
    for (const f of flags) {
      if (['reset', 'clean', 'push', 'rebase', 'checkout', '--hard', '-f'].includes(f)) return true;
    }
  }
  return false;
}

function isDestructiveCommand(tokens) {
  for (const t of tokens) {
    const f = t.toLowerCase();
    if (['rm', 'del', 'rmdir', 'clean', 'reset', '--hard', 'push'].includes(f)) return true;
  }
  return false;
}

/** 调整参数：让 PowerShell 输出 UTF-8，避免 UTF-16LE 乱码；其余原样 */
function prepareArgs(base, tokens) {
  const args = tokens.slice(1);
  if (base === 'powershell' || base === 'pwsh') {
    const ci = args.findIndex((a) => /^-command$/i.test(a));
    if (ci >= 0 && args[ci + 1] != null) {
      args[ci + 1] = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + args[ci + 1];
    } else {
      args.unshift('-NoProfile', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + tokens.slice(1).join(' '));
    }
  }
  return args;
}

function register(registry) {
  registry.register(
    'execute_shell',
    '在项目根目录执行白名单命令（mvn/mvnw/git/java/javac/go/python/node/npm/npx/cmd/powershell 等构建/工具命令）。' +
      '运行环境是 Windows，不要使用 ls/find/cat/~/head 等 Unix 命令（它们不可用）；探索项目用 scan_project / read_file。' +
      '危险命令（删除/清理/强改/提交推送等）执行前需用户确认；超时自动强杀。',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行' },
        timeoutSeconds: { type: 'integer', description: '超时秒数，默认 30' },
      },
      required: ['command'],
    },
    async (context, args) => {
      const command = String(args.command || '').trim();
      if (!command) return AgentToolResult.error('缺少 command');
      const tokens = splitCommand(command);
      if (tokens.length === 0) return AgentToolResult.error('空命令');
      const base = tokens[0].replace(/\\/g, '/');
      const normalized = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
      if (!ALLOWED.has(normalized)) return AgentToolResult.error('命令不在白名单：' + tokens[0]);
      const timeoutSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? Math.max(1, Math.floor(args.timeoutSeconds)) : 30;

      const sensitive = isSensitiveCommand(tokens);
      if (sensitive) {
        const what = '在项目目录执行命令：' + command;
        const detail = '这是一条' + (isDestructiveCommand(tokens) ? '具有破坏性' : '可能影响系统/仓库状态') + '的命令，执行后可能不可撤销。超时 ' + timeoutSeconds + ' 秒。';
        const ok = await context.confirm(ConfirmationLevel.HIGH, what, detail);
        if (!ok) return AgentToolResult.error('已取消执行');
      } else {
        await context.confirm(ConfirmationLevel.LOW, '执行命令：' + command, '普通构建/查询命令，直接执行。');
      }

      const root = context.projectRoot();
      return new Promise((resolve) => {
        let output = '';
        let child;
        try {
          const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
          child = spawn(tokens[0], prepareArgs(normalized, tokens), { cwd: root, shell: false, windowsHide: true, env });
        } catch (e) {
          resolve(AgentToolResult.error('执行失败：' + ((e && e.message) || e)));
          return;
        }
        child.stdout.on('data', (d) => {
          output += decodeOutput(d);
        });
        child.stderr.on('data', (d) => {
          output += decodeOutput(d);
        });
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          output += '\n…（执行超时，已强制终止）';
          context.audit('execute_shell ' + command + ' exit=TIMEOUT');
          resolve(AgentToolResult.ok('退出码 -1（超时强杀）\n' + output.trim(), { exitCode: -1, command, timedOut: true, output: output.slice(0, 4000) }));
        }, timeoutSeconds * 1000);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve(AgentToolResult.error('执行失败：' + ((e && e.message) || e)));
        });
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          context.audit('execute_shell ' + command + ' exit=' + exitCode);
          resolve(AgentToolResult.ok('退出码 ' + exitCode + '\n' + output.trim(), { exitCode, command, output: output.slice(0, 4000) }));
        });
      });
    }
  );
}

module.exports = { register };
