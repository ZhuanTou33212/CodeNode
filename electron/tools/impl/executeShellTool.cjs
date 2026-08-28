/**
 * execute_shell：在项目根目录执行跨平台白名单命令（mvn/mvnw/git/java/javac/go/python/node/npm/nuget/cmd/powershell 等）。
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

/**
 * 后台任务注册表：execute_shell async=true 启动的长任务，跨 Agent 轮次存活，
 * 由 poll_job 轮询进度/取结果。任务结束后在 poll 时清理；超过 1 小时的陈旧任务自动回收。
 */
const BACKGROUND_JOBS = new Map(); // jobId -> { projectRoot, command, startedAt, status, output, exitCode, error, child }
let jobSeq = 0;
const JOB_TTL_MS = 60 * 60 * 1000;

function sweepJobs() {
  const now = Date.now();
  for (const [jobId, job] of BACKGROUND_JOBS) {
    if (job.status === 'running' && now - job.startedAt > JOB_TTL_MS) {
      try { job.child && job.child.kill('SIGKILL'); } catch {}
      job.status = 'timeout';
      job.output += '\n…（后台任务超时，已强制终止）';
    }
    if (job.status !== 'running' && now - job.startedAt > 10 * 60 * 1000) {
      BACKGROUND_JOBS.delete(jobId);
    }
  }
}

/** 后台启动一个白名单命令，立即返回 jobId。 */
function startBackgroundJob(root, tokens, normalized, command, timeoutSeconds) {
  sweepJobs();
  const jobId = 'job-' + Date.now().toString(36) + '-' + (++jobSeq).toString(36);
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  let child;
  try {
    const spec = spawnSpec(normalized, tokens);
    child = spawn(spec.file, spec.args, { cwd: root, shell: false, windowsHide: true, env, detached: process.platform !== 'win32' });
  } catch (e) {
    return { jobId: null, error: String((e && e.message) || e) };
  }
  const job = { jobId, projectRoot: root, command, startedAt: Date.now(), status: 'running', output: '', exitCode: null, error: null, child };
  BACKGROUND_JOBS.set(jobId, job);
  child.stdout.on('data', (d) => { job.output += decodeOutput(d); });
  child.stderr.on('data', (d) => { job.output += decodeOutput(d); });
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    job.status = 'timeout';
    job.output += '\n…（后台任务超时，已强制终止）';
  }, timeoutSeconds * 1000);
  child.on('error', (e) => {
    clearTimeout(timer);
    job.status = 'error';
    job.error = String((e && e.message) || e);
  });
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    job.status = 'done';
    job.exitCode = exitCode;
  });
  return { jobId };
}

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

/** 跨平台执行适配：Windows 命令在 macOS/Linux 开发环境中也能跑基本任务。 */
function spawnSpec(base, tokens) {
  if (process.platform === 'win32' || (base !== 'powershell' && base !== 'pwsh' && base !== 'cmd')) {
    return { file: tokens[0], args: prepareArgs(base, tokens) };
  }
  const raw = tokens.slice(1).join(' ');
  if (base === 'cmd') return { file: '/bin/sh', args: ['-lc', raw] };
  const sleep = raw.match(/Start-Sleep\s+(?:-Seconds\s+)?(\d+)/i);
  const output = raw.match(/Write-Output\s+(.+)$/i);
  const parts = [];
  if (sleep) parts.push('sleep ' + Math.min(3600, Number(sleep[1])));
  if (output) {
    const value = output[1].trim().replace(/^['"]|['"]$/g, '').replace(/'/g, "'\\''");
    parts.push("printf '%s\\n' '" + value + "'");
  }
  return { file: '/bin/sh', args: ['-lc', parts.join('; ') || 'true'] };
}

function register(registry) {
  registry.register(
    'execute_shell',
      '在项目根目录执行跨平台白名单命令（mvn/mvnw/git/java/javac/go/python/node/npm/npx/cmd/powershell 等构建/工具命令）。' +
      '命令会按当前系统适配；探索项目优先使用 scan_project / read_file。' +
      '危险命令（删除/清理/强改/提交推送等）执行前需用户确认；超时自动强杀。' +
      '【长任务】预估耗时超过约 30 秒的任务：用 async=true 后台执行（立即返回 jobId），再用 poll_job jobId=… waitSeconds=… 轮询进度与结果，不要一次性前台等待。',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行' },
        timeoutSeconds: { type: 'integer', description: '超时秒数，默认 30；长任务请按预估耗时调大（如 300/600）' },
        async: { type: 'boolean', description: 'true = 后台执行立即返回 jobId（用于长任务），用 poll_job 轮询；默认 false 前台等待' },
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
      }
      // 普通构建/查询命令属于低敏感操作，直接执行，不需要询问用户

      const root = context.projectRoot();

      // 后台执行：长任务立即返回 jobId，用 poll_job 轮询
      if (args.async === true) {
        const bgTimeout = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? Math.max(10, Math.floor(args.timeoutSeconds)) : 1800;
        const started = startBackgroundJob(root, tokens, normalized, command, bgTimeout);
        if (!started.jobId) return AgentToolResult.error('后台启动失败：' + (started.error || ''));
        context.audit('execute_shell async=true jobId=' + started.jobId + ' command=' + command + ' timeout=' + bgTimeout);
        return AgentToolResult.ok(
          '已在后台启动命令（jobId=' + started.jobId + '，超时 ' + bgTimeout + ' 秒）。用 poll_job jobId="' + started.jobId + '" waitSeconds=5 轮询进度，任务完成后再继续后续步骤。',
          { jobId: started.jobId, async: true, command, status: 'running', timeoutSeconds: bgTimeout }
        );
      }

      return new Promise((resolve) => {
        let output = '';
        let child;
        try {
          const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
          const spec = spawnSpec(normalized, tokens);
          child = spawn(spec.file, spec.args, { cwd: root, shell: false, windowsHide: true, env });
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

  // ---- poll_job：轮询 execute_shell async=true 启动的后台任务 ----
  registry.register(
    'poll_job',
    '轮询后台任务进度与结果（execute_shell async=true 启动）。返回当前状态（running/done/error/timeout）、已输出内容与退出码；任务结束后自动清理。',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'execute_shell async=true 返回的 jobId' },
        waitSeconds: { type: 'integer', description: '可选：先阻塞等待 N 秒再返回（0~60），避免频繁空轮询' },
      },
      required: ['jobId'],
    },
    async (context, args) => {
      const jobId = String(args.jobId || '').trim();
      if (!jobId) return AgentToolResult.error('缺少 jobId');
      sweepJobs();
      let job = BACKGROUND_JOBS.get(jobId);
      if (!job) return AgentToolResult.error('后台任务不存在或已清理：' + jobId);
      const wait = typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) ? Math.max(0, Math.min(60, Math.floor(args.waitSeconds))) : 0;
      if (wait > 0 && job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        sweepJobs();
        job = BACKGROUND_JOBS.get(jobId);
        if (!job) return AgentToolResult.error('后台任务已结束并被清理：' + jobId);
      }
      context.audit('poll_job jobId=' + jobId + ' status=' + job.status + ' elapsedMs=' + (Date.now() - job.startedAt));
      if (job.status === 'running') {
        return AgentToolResult.ok(
          '后台任务仍在运行（elapsed=' + Math.round((Date.now() - job.startedAt) / 1000) + 's，已输出 ' + job.output.length + ' 字符）。可继续 poll_job 或带 waitSeconds 等待。\n' + job.output.slice(-1500),
          { jobId, status: 'running', startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt, output: job.output.slice(-4000) }
        );
      }
      BACKGROUND_JOBS.delete(jobId);
      if (job.status === 'error') {
        return AgentToolResult.error('后台任务执行失败：' + (job.error || '') + '\n' + job.output.trim());
      }
      const done = job.status === 'done';
      const statusText = done ? '退出码 ' + job.exitCode : '超时强制终止';
      return AgentToolResult.ok(
        '后台任务完成：' + statusText + '\n' + job.output.trim(),
        { jobId, status: job.status, exitCode: job.exitCode, output: job.output.slice(0, 4000) }
      );
    }
  );
}

module.exports = { register, BACKGROUND_JOBS };
