/**
 * execute_shell：在项目根目录执行跨平台白名单命令（mvn/mvnw/git/java/javac/go/python/node/npm/nuget/cmd/powershell 等）。
 * 危险命令（删除/清理/强改/提交推送等）执行前必须用户确认（HIGH 级）；普通构建/查询命令直接放行并记录。超时强杀。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { safeEnvironment } = require('../../envPolicy.cjs');
const sandbox = require('../../sandbox.cjs');
const shellGuard = require('../shellGuard.cjs');

const ALLOWED = new Set([
  'mvn', 'mvnw', 'mvnw.cmd', 'git', 'java', 'javac', 'gradle', 'gradlew', 'gradlew.bat',
  'go', 'python', 'python3', 'py', 'node', 'npm', 'npx', 'nuget', 'cmd', 'powershell', 'pwsh',
]);

/**
 * 程序名归一化（#8）：白名单校验与「是否高危」必须**共用同一个结果**。
 * 旧实现里白名单用归一化后的 basename、高危判据却用 `tokens[0]` 原文，于是同一程序两种写法判定不一致
 * （`node -e …` 要确认，`/usr/bin/node -e …` 直接放行）。在隔离后端缺失（bwrap / sandbox-exec 不可用）
 * 的降级路径上，HIGH 确认是任意代码执行的**唯一**闸门 —— 这里的不一致等于给
 * 「不可信项目 → 任意代码」开了一条静默通道。去后缀是因为 Windows 上同一个入口会写成
 * node.exe / gradlew.bat / mvnw.cmd。
 */
function normalizeProgram(token) {
  const raw = String(token || '').trim().replace(/\\/g, '/');
  const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

/**
 * 需要 HIGH 确认的程序入口：跑脚本 / 构建 / 包管理 = 任意代码执行面。
 * 名单口径与 ALLOWED 的 normalizeProgram 保持一致，不再出现「换个写法就免确认」；
 * gradle / gradlew / nuget 此前只在白名单里、不在高危名单里 —— 白名单通过即等于任意代码，
 * 所以这里按「白名单入口一律高危」补齐（`git status` 这类只读子命令仍由下面的子命令判据放行）。
 */
const SENSITIVE_PROGRAMS = new Set([
  'powershell', 'pwsh', 'cmd', 'node', 'python', 'python3', 'py', 'npm', 'npx', 'java', 'javac',
  'mvn', 'mvnw', 'gradle', 'gradlew', 'go', 'nuget', 'dotnet', 'pip', 'pip3', 'pnpm', 'yarn',
]);

/**
 * 后台任务注册表：execute_shell async=true 启动的长任务，跨 Agent 轮次存活，
 * 由 poll_job 轮询进度/取结果。任务结束后在 poll 时清理；超过 1 小时的陈旧任务自动回收。
 */
const BACKGROUND_JOBS = new Map(); // jobId -> { projectRoot, command, startedAt, status, output, exitCode, error, child }
let jobSeq = 0;
const JOB_TTL_MS = 60 * 60 * 1000;
const DEFAULT_OUTPUT_CHARS = 12000;
/**
 * 收集侧硬上限（#19）：`outputPage` 的 size 只限制**返回的那一页**，收集侧无界累积则主进程内存
 * 随命令输出线性增长（`npm test` / 大 `git log -p` / 死循环 Write-Output 都能顶到 OOM，并阻塞所有
 * 并发 run）。超限后停止累积正文、只保留尾部窗口（失败原因几乎总在最后几行）并如实记录丢弃字符数 ——
 * 分页协议不变，只是可读范围被上限钉住，且「被丢弃」这件事不会被静默吞掉。
 */
const MAX_COLLECT_CHARS = 8 * 1024 * 1024;
const COLLECT_TAIL_CHARS = 4000;

/** 有界输出收集器：正文（到上限）+ 尾部环形窗口 + 丢弃计数 */
function makeOutputCollector() {
  return { output: '', tail: '', droppedChars: 0 };
}

/** 累积一段输出；超出上限的部分只进尾部窗口 */
function pushCollected(state, chunk) {
  const text = String(chunk == null ? '' : chunk);
  if (!text) return;
  const room = Math.max(0, MAX_COLLECT_CHARS - state.output.length);
  if (room > 0) state.output += text.length <= room ? text : text.slice(0, room);
  if (text.length > room) {
    state.droppedChars += text.length - room;
    state.tail = (state.tail + text.slice(room)).slice(-COLLECT_TAIL_CHARS);
  }
}

/** 收集器的完整文本（含截断标注）：分页、落盘与返回结果都读它，保证截断可见 */
function collectedText(state) {
  if (!state.droppedChars) return state.output;
  return (
    state.output +
    '\n…（输出超过 ' + MAX_COLLECT_CHARS + ' 字符收集上限，中间约 ' + state.droppedChars +
    ' 字符已丢弃；以下为最后 ' + state.tail.length + ' 字符）\n' + state.tail
  );
}

/**
 * 前台执行的 spawn 选项（#20）：POSIX 上必须 `detached` —— `killProcessTree` 首选
 * `process.kill(-pid)` 整组终止，而前台不带 detached 时子进程不是进程组长，负 pid 直接 ESRCH，
 * 退回只杀直接子进程（`npm test` → jest worker 这类再 fork 的子孙会残留，用户以为停了、
 * 构建仍在继续写工作区）。Windows 走 `taskkill /t` 已有整树语义，detached 反而会另开控制台窗口，
 * 所以显式 `false`（与省略等价，但让「两种平台语义都想过」在代码里看得见）。
 */
function foregroundSpawnOptions(root, env, policy, context) {
  return { cwd: root, env, policy, context, detached: process.platform !== 'win32' };
}

/** 隔离策略拒绝执行时的统一错误描述：fail-closed 的拒绝必须让人看得懂，不能被当成普通失败重试。 */
function describeSpawnError(error) {
  const message = String((error && error.message) || error);
  if (error && error.code === 'SANDBOX_UNAVAILABLE') return '执行被隔离策略拒绝（fail-closed）：' + message;
  return message;
}

function sweepJobs() {
  const now = Date.now();
  for (const [jobId, job] of BACKGROUND_JOBS) {
    if (job.status === 'running' && now - job.startedAt > JOB_TTL_MS) {
      sandbox.killSandboxed(job.child, true);
      job.status = 'timeout';
      job.output += '\n…（后台任务超时，已强制终止）';
    }
    if (job.status !== 'running' && now - job.startedAt > 10 * 60 * 1000) {
      BACKGROUND_JOBS.delete(jobId);
    }
  }
}

/** 后台启动一个白名单命令，立即返回 jobId。 */
function startBackgroundJob(root, tokens, normalized, command, timeoutSeconds, signal, context) {
  sweepJobs();
  if (signal && signal.aborted) return { jobId: null, error: '已取消执行' };
  const jobId = 'job-' + Date.now().toString(36) + '-' + (++jobSeq).toString(36);
  const env = safeEnvironment({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  let child;
  try {
    const spec = spawnSpec(normalized, tokens);
    // 经执行隔离层启动（Windows Job Object / Linux bwrap / macOS sandbox-exec）；
    // 策略关闭或无后端时自动退回原生 spawn，并在审计中留痕。
    child = sandbox.guardedSpawn(spec, {
      cwd: root,
      env,
      detached: process.platform !== 'win32',
      policy: sandbox.currentPolicy(context),
      context,
    });
  } catch (e) {
    return { jobId: null, error: describeSpawnError(e) };
  }
  const job = { jobId, projectRoot: root, command, startedAt: Date.now(), status: 'running', output: '', tail: '', droppedChars: 0, exitCode: null, error: null, child };
  BACKGROUND_JOBS.set(jobId, job);
  const onAbort = () => {
    if (job.status !== 'running') return;
    job.status = 'cancelled';
    job.output += '\n…（任务已取消）';
    sandbox.killSandboxed(child);
  };
  signal && signal.addEventListener('abort', onAbort, { once: true });
  // #19：后台输出同样有界 —— 它常驻内存至多 1 小时，无界累积会把「一个长任务」变成常驻内存泄漏
  child.stdout.on('data', (d) => { pushCollected(job, decodeOutput(d)); });
  child.stderr.on('data', (d) => { pushCollected(job, decodeOutput(d)); });
  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    sandbox.killSandboxed(child, true);
    job.status = 'timeout';
    job.output += '\n…（后台任务超时，已强制终止）';
  }, timeoutSeconds * 1000);
  child.on('error', (e) => {
    clearTimeout(timer);
    signal && signal.removeEventListener('abort', onAbort);
    job.status = 'error';
    job.error = String((e && e.message) || e);
  });
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    signal && signal.removeEventListener('abort', onAbort);
    if (job.status === 'running') job.status = 'done';
    job.exitCode = exitCode;
  });
  return { jobId };
}

function storeCompletedOutput(root, command, output, exitCode) {
  sweepJobs();
  const jobId = 'job-' + Date.now().toString(36) + '-' + (++jobSeq).toString(36);
  BACKGROUND_JOBS.set(jobId, {
    jobId,
    projectRoot: root,
    command,
    startedAt: Date.now(),
    status: 'done',
    output,
    exitCode,
    error: null,
    child: null,
  });
  return jobId;
}

function outputPage(output, offset, maxChars, tail) {
  const text = String(output || '');
  const size = Math.max(1000, Math.min(100000, Math.floor(Number(maxChars) || DEFAULT_OUTPUT_CHARS)));
  const start = tail ? Math.max(0, text.length - size) : Math.max(0, Math.min(text.length, Math.floor(Number(offset) || 0)));
  const chunk = text.slice(start, start + size);
  return {
    output: chunk,
    offset: start,
    nextOffset: start + chunk.length,
    totalChars: text.length,
    hasMore: start + chunk.length < text.length,
  };
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

function isSensitiveCommand(tokens, normalizedBase) {
  const flags = tokens.map((t) => t.toLowerCase());
  // #8：优先用归一化结果（由调用方用 normalizeProgram 算好并**同时**用于白名单），
  // 缺省才退回 tokens[0] 原文，保持「不传第二个参数 = 旧行为」的可对照性。
  const base = normalizedBase || flags[0] || '';
  if (SENSITIVE_PROGRAMS.has(base)) {
    return true;
  }
  for (const f of flags) {
    if (['rm', 'del', 'rmdir', 'rd', 'clean', 'distclean', 'reset', 'hard', 'push', 'publish', '-f', '--force', '--hard'].includes(f)) {
      return true;
    }
  }
  if (base === 'powershell' || base === 'pwsh' || base === 'cmd') {
    const script = tokens.slice(1).join(' ');
    if (/\b(remove-item|set-content|add-content|move-item|copy-item|clear-content|format-volume|stop-process|invoke-expression|start-process)\b/i.test(script)) return true;
    if (/\b(git\s+(reset|clean|push|rebase|checkout))\b/i.test(script)) return true;
  }
  if (base.includes('git')) {
    for (const f of flags) {
      if (['reset', 'clean', 'push', 'rebase', 'checkout', '--hard', '-f'].includes(f)) return true;
    }
  }
  return false;
}

function isDestructiveCommand(tokens) {
  const script = tokens.join(' ');
  if (/\b(remove-item|set-content|add-content|move-item|copy-item|clear-content|format-volume|stop-process|invoke-expression|start-process)\b/i.test(script)) return true;
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
        outputOffset: { type: 'integer', description: '同步命令输出起始游标，默认 0' },
        maxOutputChars: { type: 'integer', description: '单次返回的最大输出字符数，默认 12000；超出时返回 jobId 并用 poll_job 分页' },
      },
      required: ['command'],
    },
    async (context, args) => {
      const command = String(args.command || '').trim();
      if (!command) return AgentToolResult.error('缺少 command');
      const tokens = splitCommand(command);
      if (tokens.length === 0) return AgentToolResult.error('空命令');
      // #8：白名单与「是否高危」共用这一个归一化结果（见 normalizeProgram）
      const normalized = normalizeProgram(tokens[0]);
      if (!ALLOWED.has(normalized)) return AgentToolResult.error('命令不在白名单：' + tokens[0]);
      const timeoutSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? Math.max(1, Math.floor(args.timeoutSeconds)) : 30;

      const root = context.projectRoot();
      const policy = sandbox.currentPolicy(context);
      // 命令静态审计：Windows 后端（windows-job）**不隔离文件系统**，writeRoots 只对
      // Linux bwrap / macOS sandbox-exec 生效。越界写必须在能力层拒绝 —— 不能指望用户
      // 从「执行命令」这句确认文案里看出它要写到工作区外面（2026-09-15 实测复现）。
      const guard = shellGuard.analyzeShellCommand(command, {
        projectRoot: root,
        writeRoots: policy && Array.isArray(policy.writeRoots) && policy.writeRoots.length ? policy.writeRoots : undefined,
      });
      if (guard.outsideWrites.length) {
        const backend = (policy && policy.capabilities && policy.capabilities.backend) || 'none';
        return AgentToolResult.error(
          '拒绝执行：命令要写入工作区之外的路径 ' + guard.outsideWrites.join(', ') +
            '（当前隔离后端 ' + backend + ' 不隔离文件系统，越界写没有内核兜底）。' +
            '请把产物写到项目目录内；确需写外部目录时用 sandbox.allow_write 显式放开。',
          { code: 'PATH_OUT_OF_ROOT', tool: 'execute_shell', command, paths: guard.outsideWrites },
        );
      }
      if (guard.unresolvedWrites.length && policy && policy.mode === 'strict') {
        return AgentToolResult.error(
          '拒绝执行（strict 隔离模式）：写目标含变量或通配，无法静态判定是否越界：' + guard.unresolvedWrites.join(', '),
          { code: 'PATH_OUT_OF_ROOT', tool: 'execute_shell', command, paths: guard.unresolvedWrites },
        );
      }
      if (policy && policy.network === 'deny' && guard.network.length) {
        return AgentToolResult.error(
          '拒绝执行：当前隔离策略已切断网络（sandbox.network=deny），而这条命令疑似需要联网（' + guard.network.join('、') + '）。',
          { code: 'PERMISSION_DENIED', tool: 'execute_shell', command, network: guard.network, userActionRequired: false },
        );
      }

      const sensitive = isSensitiveCommand(tokens, normalized);
      if (sensitive) {
        const what = '在项目目录执行命令：' + command;
        const detail = '这是一条' + (isDestructiveCommand(tokens) ? '具有破坏性' : '可能影响系统/仓库状态') + '的命令，执行后可能不可撤销。超时 ' + timeoutSeconds + ' 秒。' +
          (guard.reasons.length ? '静态审计提示：' + guard.reasons.join('；') + '。' : '');
        const ok = await context.confirm(ConfirmationLevel.HIGH, what, detail);
        if (!ok) return AgentToolResult.error('已取消执行');
      }
      // 普通构建/查询命令属于低敏感操作，直接执行，不需要询问用户

      // 后台执行：长任务立即返回 jobId，用 poll_job 轮询
      if (args.async === true) {
        const bgTimeout = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds) ? Math.max(10, Math.floor(args.timeoutSeconds)) : 1800;
        const started = startBackgroundJob(root, tokens, normalized, command, bgTimeout, context.signal && context.signal(), context);
        if (!started.jobId) return AgentToolResult.error('后台启动失败：' + (started.error || ''));
        context.audit('execute_shell async=true jobId=' + started.jobId + ' command=' + command + ' timeout=' + bgTimeout);
        return AgentToolResult.ok(
          '已在后台启动命令（jobId=' + started.jobId + '，超时 ' + bgTimeout + ' 秒）。用 poll_job jobId="' + started.jobId + '" waitSeconds=5 轮询进度，任务完成后再继续后续步骤。',
          { jobId: started.jobId, async: true, command, status: 'running', timeoutSeconds: bgTimeout }
        );
      }

      return new Promise((resolve) => {
        const collected = makeOutputCollector();
        let child;
        let cancelled = false;
        try {
          const env = safeEnvironment({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
          const spec = spawnSpec(normalized, tokens);
          child = sandbox.guardedSpawn(spec, foregroundSpawnOptions(root, env, sandbox.currentPolicy(context), context));
        } catch (e) {
          resolve(AgentToolResult.error('执行失败：' + describeSpawnError(e)));
          return;
        }
        // #19：收集侧有界（见 MAX_COLLECT_CHARS）—— 分页只限制返回的那一页，不是这里
        child.stdout.on('data', (d) => {
          pushCollected(collected, decodeOutput(d));
        });
        child.stderr.on('data', (d) => {
          pushCollected(collected, decodeOutput(d));
        });
        const onAbort = () => {
          cancelled = true;
          sandbox.killSandboxed(child);
        };
        const signal = context.signal && context.signal();
        signal && signal.addEventListener('abort', onAbort, { once: true });
        if (signal && signal.aborted) onAbort();
        const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
          try {
            sandbox.killSandboxed(child, true);
          } catch {}
          cleanup();
          const output = collectedText(collected) + '\n…（执行超时，已强制终止）';
          context.audit('execute_shell ' + command + ' exit=TIMEOUT');
          // 超时强杀不是成功：ok=true 会让模型把「被杀掉的命令」当作已完成（实测后台 git 超时仍报成功）
          resolve(AgentToolResult.error('执行超时（' + timeoutSeconds + ' 秒），已强制终止\n' + output.trim(), {
            code: 'TIMEOUT',
            exitCode: -1,
            command,
            timedOut: true,
            output: output.slice(0, 4000),
          }));
        }, timeoutSeconds * 1000);
        child.on('error', (e) => {
          clearTimeout(timer);
          cleanup();
          resolve(AgentToolResult.error('执行失败：' + ((e && e.message) || e)));
        });
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          cleanup();
          if (cancelled) {
            context.audit('execute_shell ' + command + ' exit=CANCELLED');
            resolve(AgentToolResult.error('执行已取消', { exitCode: -1, command, cancelled: true, output: collectedText(collected).slice(0, 4000) }));
            return;
          }
          context.audit('execute_shell ' + command + ' exit=' + exitCode);
          const output = collectedText(collected);
          const page = outputPage(output, args.outputOffset, args.maxOutputChars, false);
          const paged = page.hasMore;
          const jobId = paged ? storeCompletedOutput(root, command, output, exitCode) : null;
          const suffix = paged
            ? '\n输出过长，已返回第 ' + page.offset + '-' + page.nextOffset + '/' + page.totalChars + ' 字符；请使用 poll_job jobId="' + jobId + '" offset=' + page.nextOffset + ' 继续读取。'
            : '';
          const truncNote = collected.droppedChars
            ? '\n…（输出超出 ' + MAX_COLLECT_CHARS + ' 字符收集上限，中间约 ' + collected.droppedChars + ' 字符未被保留）'
            : '';
          resolve(AgentToolResult.ok('退出码 ' + exitCode + truncNote + '\n' + page.output.trim() + suffix, {
            exitCode,
            command,
            output: page.output,
            outputOffset: page.offset,
            nextOffset: page.nextOffset,
            totalOutputChars: page.totalChars,
            hasMore: page.hasMore,
            jobId,
            outputTruncated: collected.droppedChars > 0,
            droppedOutputChars: collected.droppedChars,
          }));
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
        offset: { type: 'integer', description: '输出起始游标，默认 0；使用上次结果的 nextOffset 继续读取' },
        maxChars: { type: 'integer', description: '本次最多返回多少字符，默认 12000，最大 100000' },
        tail: { type: 'boolean', description: '是否只返回当前输出末尾；默认 false，分页读取请保持 false' },
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
        await new Promise((resolve) => {
          const signal = context.signal && context.signal();
          let timer;
          const finish = () => {
            clearTimeout(timer);
            signal && signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            finish();
          };
          timer = setTimeout(finish, wait * 1000);
          signal && signal.addEventListener('abort', onAbort, { once: true });
        });
        if (context.signal && context.signal() && context.signal().aborted) return AgentToolResult.error('轮询已取消', { jobId, status: 'cancelled' });
        sweepJobs();
        job = BACKGROUND_JOBS.get(jobId);
        if (!job) return AgentToolResult.error('后台任务已结束并被清理：' + jobId);
      }
      context.audit('poll_job jobId=' + jobId + ' status=' + job.status + ' elapsedMs=' + (Date.now() - job.startedAt));
      if (job.status === 'running') {
        const live = collectedText(job);
        const page = outputPage(live, args.offset, args.maxChars, args.tail === true);
        return AgentToolResult.ok(
          '后台任务仍在运行（elapsed=' + Math.round((Date.now() - job.startedAt) / 1000) + 's，已输出 ' + live.length + ' 字符）。可继续 poll_job 或带 waitSeconds 等待。\n' + live.slice(-1500),
          { jobId, status: 'running', startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt, ...page }
        );
      }
      if (job.status === 'error') {
        BACKGROUND_JOBS.delete(jobId);
        return AgentToolResult.error('后台任务执行失败：' + (job.error || '') + '\n' + collectedText(job).trim());
      }
      if (job.status === 'cancelled') {
        BACKGROUND_JOBS.delete(jobId);
        return AgentToolResult.error('后台任务已取消：' + jobId, { jobId, status: 'cancelled', exitCode: job.exitCode, output: collectedText(job) });
      }
      const done = job.status === 'done';
      const page = outputPage(collectedText(job), args.offset, args.maxChars, args.tail === true);
      if (!page.hasMore) BACKGROUND_JOBS.delete(jobId);
      // 后台任务超时被强杀同样不是成功（与前台一致：超时必须让模型知道任务没做完）
      const head = '后台任务' + (done ? '完成：退出码 ' + job.exitCode : '超时被强制终止') + '\n';
      const body = page.output.trim() + (page.hasMore ? '\n输出未读完，请使用 offset=' + page.nextOffset + ' 继续读取。' : '');
      return done
        ? AgentToolResult.ok(head + body, { jobId, status: job.status, exitCode: job.exitCode, ...page })
        : AgentToolResult.error(head + body, { code: 'TIMEOUT', jobId, status: job.status, exitCode: job.exitCode, timedOut: true, ...page });
    }
  );
}

// 导出收集器与前台 spawn 选项：用例要断言「输出有界」「POSIX 前台 detached」，
// 直接用生产同一份实现（用例自己重写一遍上限逻辑就等于没有锁住生产行为）。
module.exports = {
  register,
  BACKGROUND_JOBS,
  foregroundSpawnOptions,
  makeOutputCollector,
  pushCollected,
  collectedText,
  MAX_COLLECT_CHARS,
  COLLECT_TAIL_CHARS,
};
