/**
 * sandbox.cjs —— 执行隔离层（操作系统级）
 *
 * 目标：不再只靠「命令白名单 + 事后 taskkill + 字符串路径检查」，而是把 Agent 触发的
 * 子进程放进操作系统自身的隔离设施里，做到：
 *   - 生命周期：父进程（CodeNode 主进程）消失 → 内核立即终止整棵进程树（无孤儿、无残留副作用）
 *   - 资源上限：进程数 / job 内存 / CPU 时间（内核强制，不依赖子进程配合）
 *   - 文件系统：只读挂载 + 仅工作区可写（Linux bubblewrap / macOS sandbox-exec）
 *   - 网络：可整体切断（Linux --unshare-net / macOS deny network*）
 *
 * 后端与真实能力（capabilities() 会如实上报，不掩盖差距）：
 *   win32   → windows-job：helper 进程把自身放入 Job Object，KILL_ON_JOB_CLOSE +
 *             ACTIVE_PROCESS + JOB_MEMORY + JOB_TIME。生命周期/进程数/内存/CPU = 内核强制；
 *             文件系统与网络 = 本平台无等价无管理员方案，退回工具层路径边界（writeRoots 校验）。
 *   linux   → bubblewrap（bwrap）：只读根 + 工作区可写 + 可选断网，全部由内核 namespace 强制。
 *   darwin  → sandbox-exec：deny default + 全读 + 仅白名单目录可写 + 可选 deny network*。
 *   其它/后端缺失 → 能力为 none，strict 模式下拒绝执行（fail-closed），best-effort 模式下
 *             降级执行并写入审计（明确标注「未隔离」）。
 *
 * 三种策略模式（config/agent.properties → sandbox.mode）：
 *   off         完全关闭，走原生 spawn（等价旧行为）
 *   best-effort 默认：尽可能上隔离；后端不可用时降级 + 审计，不阻塞功能
 *   strict      要求隔离：后端不支持所声明的隔离项时直接拒绝执行（fail-closed）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HELPER_VERSION = '1';
const DEFAULT_BROKER_RESERVE_MB = 160;

let cachedCapabilities = null;
let cachedHelper = null;
let defaultPolicy = null;

function truthy(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(text)) return false;
  return fallback;
}

function toInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function splitPaths(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return list.map((item) => String(item || '').trim()).filter(Boolean);
}

/** 沙箱缓存目录：helper 可执行文件与 spec 文件都在这里（node/electron 均可使用） */
function cacheDir(override) {
  return override || process.env.CODENODE_SANDBOX_CACHE || path.join(os.homedir(), '.codenode', 'sandbox');
}

// ---------------------------------------------------------------------------
// Windows：winjob.exe（Job Object 代理）
// ---------------------------------------------------------------------------

function helperSourcePath() {
  return path.join(__dirname, 'sandbox', 'winjob.cs');
}

function cscCandidates() {
  const roots = [
    process.env.WINDIR || 'C:\\Windows',
    'C:\\Windows',
  ];
  const out = [];
  for (const root of roots) {
    for (const framework of ['Framework64', 'Framework']) {
      out.push(path.join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'));
    }
  }
  return out;
}

/**
 * 确保 winjob.exe 可用：优先环境变量指定的预编译产物，其次缓存目录中的旧产物（按源码哈希命名），
 * 最后用 .NET Framework 自带的 csc.exe 现场编译（Win10/11 默认存在，无需安装 SDK，无需联网）。
 */
function ensureWinJobHelper(options = {}) {
  const override = options.helperPath || process.env.CODENODE_SANDBOX_HELPER;
  if (override && fs.existsSync(override)) return { ok: true, path: override, source: 'env' };

  const source = helperSourcePath();
  if (!fs.existsSync(source)) return { ok: false, reason: 'helper source missing: ' + source };

  let hash = '';
  try {
    hash = require('crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
  } catch (error) {
    return { ok: false, reason: 'helper source unreadable: ' + error.message };
  }
  const dir = cacheDir(options.cacheDir);
  const target = path.join(dir, 'winjob-' + hash + '.exe');
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    const probe = spawnSync(target, ['--probe'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status === 0 && String(probe.stdout || '').includes('windows-job')) {
      return { ok: true, path: target, source: 'cache', hash };
    }
  }

  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  if (!csc) return { ok: false, reason: 'csc.exe (.NET Framework) not found' };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: 'cannot create cache dir ' + dir + ': ' + error.message };
  }
  const outFile = path.join(dir, 'winjob-' + hash + '.' + process.pid + '.exe');
  const reference = path.join(path.dirname(csc), 'System.Web.Extensions.dll');
  const args = ['/nologo', '/target:exe', '/optimize+', '/out:' + outFile];
  if (fs.existsSync(reference)) args.push('/r:' + reference);
  args.push(source);
  const built = spawnSync(csc, args, { encoding: 'utf8', timeout: 120000 });
  if (built.status !== 0 || !fs.existsSync(outFile)) {
    return {
      ok: false,
      reason: 'csc compile failed: ' + String((built.stderr || built.stdout || '').slice(0, 400)),
    };
  }
  const probe = spawnSync(outFile, ['--probe'], { encoding: 'utf8', timeout: 15000 });
  if (probe.status !== 0 || !String(probe.stdout || '').includes('windows-job')) {
    try { fs.unlinkSync(outFile); } catch {}
    return { ok: false, reason: 'helper probe failed: ' + String((probe.stderr || probe.stdout || '').slice(0, 200)) };
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(outFile, target);
  } catch {
    return { ok: true, path: outFile, source: 'compiled', hash };
  }
  return { ok: true, path: target, source: 'compiled', hash };
}

function winJobCapabilities(options = {}) {
  const helper = ensureWinJobHelper(options);
  if (!helper.ok) {
    return {
      platform: 'win32',
      backend: 'none',
      isolation: { lifetime: false, processCount: false, memory: false, cpu: false, filesystem: false, network: false },
      detail: 'Windows Job Object helper 不可用：' + helper.reason,
      helperPath: null,
    };
  }
  return {
    platform: 'win32',
    backend: 'windows-job',
    isolation: { lifetime: true, processCount: true, memory: true, cpu: true, filesystem: false, network: false },
    detail: 'Windows Job Object（内核强制：进程树生命周期/进程数/内存/CPU；文件系统与网络需管理员或 AppContainer，本平台走工具层边界校验）',
    helperPath: helper.path,
    helperSource: helper.source,
  };
}

// ---------------------------------------------------------------------------
// Linux / macOS
// ---------------------------------------------------------------------------

function bwrapCapabilities() {
  const probe = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0) {
    return {
      platform: 'linux',
      backend: 'none',
      isolation: { lifetime: false, processCount: false, memory: false, cpu: false, filesystem: false, network: false },
      detail: 'bubblewrap(bwrap) 未安装：安装 bubblewrap 后 strict 模式可用（apt install bubblewrap）',
    };
  }
  return {
    platform: 'linux',
    backend: 'bubblewrap',
    isolation: { lifetime: true, processCount: false, memory: false, cpu: false, filesystem: true, network: true },
    detail: 'bubblewrap namespace 隔离（' + String(probe.stdout || '').trim() + '）：只读根 + 工作区可写 + 可断网 + --die-with-parent',
  };
}

function sandboxExecCapabilities() {
  const probe = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (probe.status !== 0 && probe.error) {
    return {
      platform: 'darwin',
      backend: 'none',
      isolation: { lifetime: false, processCount: false, memory: false, cpu: false, filesystem: false, network: false },
      detail: 'sandbox-exec 不可用：' + String(probe.error.message || probe.error),
    };
  }
  return {
    platform: 'darwin',
    backend: 'sandbox-exec',
    isolation: { lifetime: true, processCount: false, memory: false, cpu: false, filesystem: true, network: true },
    detail: 'macOS sandbox-exec profile（deny default + 全读 + 仅白名单目录可写 + 可断网）',
  };
}

function capabilities(options = {}) {
  if (cachedCapabilities && !options.refresh) return cachedCapabilities;
  let result;
  if (process.platform === 'win32') result = winJobCapabilities(options);
  else if (process.platform === 'linux') result = bwrapCapabilities();
  else if (process.platform === 'darwin') result = sandboxExecCapabilities();
  else {
    result = {
      platform: process.platform,
      backend: 'none',
      isolation: { lifetime: false, processCount: false, memory: false, cpu: false, filesystem: false, network: false },
      detail: '未实现该平台的隔离后端',
    };
  }
  cachedCapabilities = result;
  return result;
}

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

/**
 * 由 config/agent.properties 生成隔离策略。
 * key：
 *   sandbox.mode=off|best-effort|strict（默认 best-effort）
 *   sandbox.network=inherit|deny（默认 inherit）
 *   sandbox.max_processes / sandbox.max_memory_mb / sandbox.cpu_seconds（0=不限制）
 *   sandbox.allow_write=额外可写目录（分号/逗号分隔，相对路径按项目根解析）
 *   sandbox.require_filesystem=1 时，strict 模式要求真实文件系统隔离（Windows 会因此拒绝执行）
 */
function resolvePolicy(rawConfig, options = {}) {
  const cfg = rawConfig || {};
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : null;
  const caps = options.capabilities || capabilities(options);
  const mode = String(cfg.mode || cfg['sandbox.mode'] || 'best-effort').trim().toLowerCase();
  const network = String(cfg.network || cfg['sandbox.network'] || 'inherit').trim().toLowerCase() === 'deny' ? 'deny' : 'inherit';
  const requireFilesystem = truthy(options.requireFilesystem != null ? options.requireFilesystem : cfg.requireFilesystem, false);
  const writeRoots = [];
  const push = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!writeRoots.some((item) => item.toLowerCase() === resolved.toLowerCase())) writeRoots.push(resolved);
  };
  push(projectRoot);
  for (const extra of splitPaths(cfg.allowWrite || cfg['sandbox.allow_write'] || options.allowWrite)) {
    push(path.isAbsolute(extra) ? extra : projectRoot ? path.join(projectRoot, extra) : extra);
  }
  push(os.tmpdir());
  if (options.userDataDir) push(options.userDataDir);

  const requested = { filesystem: requireFilesystem, network: network === 'deny' };
  const degraded = [];
  if (mode !== 'off') {
    if (!caps.isolation.lifetime && caps.backend === 'none') degraded.push('lifetime');
    if (requested.filesystem && !caps.isolation.filesystem) degraded.push('filesystem');
    if (requested.network && !caps.isolation.network) degraded.push('network');
  }
  const unsatisfied = [];
  if (mode === 'strict') {
    if (caps.backend === 'none') unsatisfied.push('backend');
    if (requested.filesystem && !caps.isolation.filesystem) unsatisfied.push('filesystem');
    if (requested.network && !caps.isolation.network) unsatisfied.push('network');
  }
  return {
    mode: ['off', 'best-effort', 'strict'].includes(mode) ? mode : 'best-effort',
    network,
    requireFilesystem,
    writeRoots,
    maxProcesses: toInt(cfg.maxProcesses || cfg['sandbox.max_processes'], 0, 0, 4096),
    maxMemoryMB: toInt(cfg.maxMemoryMB || cfg['sandbox.max_memory_mb'], 0, 0, 1024 * 1024),
    cpuSeconds: toInt(cfg.cpuSeconds || cfg['sandbox.cpu_seconds'], 0, 0, 86400),
    brokerReserveMB: toInt(cfg.brokerReserveMB || cfg['sandbox.broker_reserve_mb'], DEFAULT_BROKER_RESERVE_MB, 32, 4096),
    capabilities: caps,
    degraded,
    unsatisfied,
    ok: unsatisfied.length === 0,
  };
}

function setDefaultPolicy(policy) {
  defaultPolicy = policy || null;
  return defaultPolicy;
}

function currentPolicy(context) {
  if (context && typeof context.sandbox === 'function') {
    const injected = context.sandbox();
    if (injected) return injected;
  }
  return defaultPolicy;
}

/** 人类可读的边界说明：用于 UI 提示、审计与文档，避免「声称隔离但实际没有」。 */
function describe(policy) {
  if (!policy) return '未启用执行隔离（sandbox.mode=off）';
  const caps = policy.capabilities || {};
  const parts = [];
  parts.push('模式=' + policy.mode);
  parts.push('后端=' + (caps.backend || 'none'));
  if (caps.isolation) {
    const on = Object.entries(caps.isolation).filter(([, v]) => v).map(([k]) => k);
    const off = Object.entries(caps.isolation).filter(([, v]) => !v).map(([k]) => k);
    if (on.length) parts.push('已隔离:' + on.join('/'));
    if (off.length) parts.push('未隔离:' + off.join('/'));
  }
  if (policy.network === 'deny') parts.push('网络=切断');
  if (policy.writeRoots && policy.writeRoots.length) parts.push('可写根=' + policy.writeRoots.length + ' 个');
  if (policy.degraded && policy.degraded.length) parts.push('降级项=' + policy.degraded.join('/'));
  return parts.join('，');
}

// ---------------------------------------------------------------------------
// 命令行包装（Linux/macOS）
// ---------------------------------------------------------------------------

function sandboxExecProfile(policy) {
  const roots = (policy.writeRoots || []).map((root) => String(root).replace(/"/g, '\\"'));
  const allowWrite = roots.map((root) => '(subpath "' + root + '")').join(' ');
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow signal)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") ' + allowWrite + ')',
  ];
  if (policy.network === 'deny') lines.push('(deny network*)');
  return lines.join('\n');
}

function bwrapArgs(policy, spec) {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--new-session'];
  if (policy.network === 'deny') args.push('--unshare-net');
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  for (const root of policy.writeRoots || []) {
    if (!fs.existsSync(root)) continue;
    args.push('--bind', root, root);
  }
  args.push('--chdir', spec.cwd || policy.writeRoots[0] || '/', '--', spec.file);
  for (const arg of spec.args || []) args.push(String(arg));
  return args;
}

/**
 * 把一条命令包装成「经沙箱运行」的命令行。返回 null 表示本策略下无需/无法包装（调用方用原生 spawn）。
 * strict 模式下后端不支持所要求的隔离项时抛 SANDBOX_UNAVAILABLE。
 */
function wrapCommand(policy, spec) {
  if (!policy || policy.mode === 'off') return null;
  const caps = policy.capabilities || {};
  if (policy.mode === 'strict' && policy.unsatisfied && policy.unsatisfied.length) {
    throw Object.assign(
      new Error('隔离策略为 strict，但当前平台无法满足：' + policy.unsatisfied.join('、') + '（' + (caps.detail || '') + '）'),
      { code: 'SANDBOX_UNAVAILABLE' }
    );
  }
  if (caps.backend === 'bubblewrap') return { file: 'bwrap', args: bwrapArgs(policy, spec), backend: 'bubblewrap' };
  if (caps.backend === 'sandbox-exec') {
    return {
      file: 'sandbox-exec',
      args: ['-p', sandboxExecProfile(policy), spec.file, ...(spec.args || []).map(String)],
      backend: 'sandbox-exec',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 执行：SandboxChild 兼容 Node ChildProcess 的常用表面
// ---------------------------------------------------------------------------

const { EventEmitter } = require('events');

class SandboxChild extends EventEmitter {
  constructor({ broker, backend, policy, file, args }) {
    super();
    this.broker = broker;
    this.backend = backend;
    this.policy = policy;
    this.command = file;
    this.args = args || [];
    this.pid = broker.pid;
    this.childPid = null;
    this.killed = false;
    this.exitCode = null;
    /** windows-job 后端用到的 spec 文件路径（close 后清理） @type {string|null} */
    this.specFile = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.attached = true;
    this._rest = '';
    broker.stdout.on('data', (chunk) => this._onBrokerData(chunk));
    broker.stderr.on('data', (chunk) => this.stderr.emit('data', chunk));
    broker.on('error', (error) => {
      this.killed = true;
      this.emit('error', error);
      this.emit('close', -1);
    });
    broker.on('close', (code) => {
      if (this._closed) return;
      this._closed = true;
      this.exitCode = this.exitCode == null ? code : this.exitCode;
      this.emit('close', this.exitCode);
    });
  }

  _onBrokerData(chunk) {
    this._rest += chunk.toString('utf8');
    const lines = this._rest.split('\n');
    this._rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.ev === 'started') {
        this.childPid = event.pid;
        this.emit('spawn', event.pid);
      } else if (event.ev === 'out') {
        const buffer = Buffer.from(event.b64 || '', 'base64');
        (event.stream === 'stderr' ? this.stderr : this.stdout).emit('data', buffer);
      } else if (event.ev === 'exit') {
        this.exitCode = event.code;
      } else if (event.ev === 'error') {
        this.errorMessage = event.message;
      }
    }
  }

  /** 终止整棵树：关闭 broker stdin（触发内核 job 终止），必要时直接杀 broker */
  kill(signal) {
    if (this.killed) return false;
    this.killed = true;
    try {
      this.broker.stdin.end();
    } catch {}
    try {
      this.broker.kill(signal && signal !== 'SIGKILL' ? signal : undefined);
    } catch {}
    return true;
  }

  /** 强制终止（SIGKILL 语义）：直接硬杀 broker，job 的 KILL_ON_JOB_CLOSE 会清理子孙 */
  killHard() {
    this.killed = true;
    try {
      this.broker.stdin.end();
    } catch {}
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.broker.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        this.broker.kill('SIGKILL');
      }
    } catch {}
    return true;
  }
}

function plainSpawn(file, args, options) {
  return spawn(file, args, options);
}

/**
 * 受隔离策略约束地启动一条命令。
 * 返回 SandboxChild（隔离生效）或原生 ChildProcess（未隔离 / 策略关闭）。
 */
function guardedSpawn(spec, options = {}) {
  const policy = options.policy || currentPolicy(options.context);
  // cwd / env 允许写在 spec 里，也允许作为 options 传入（两种调用写法在仓库里都存在），此处统一归一化。
  // 不归一化的后果：cwd 丢失 → 命令落在父进程目录执行（相对路径解析错位）；
  // env 丢失 → safeEnvironment 的脱敏结果被忽略，子进程继承父进程全部环境变量。
  const cwd = options.cwd !== undefined ? options.cwd : spec.cwd;
  const env = options.env !== undefined ? options.env : spec.env;
  const baseOptions = {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: options.detached === true && (!policy || policy.mode === 'off' || (policy.capabilities || {}).backend !== 'windows-job'),
  };
  if (!policy || policy.mode === 'off') return plainSpawn(spec.file, spec.args, baseOptions);

  const context = options.context;
  const caps = policy.capabilities || {};
  // strict = fail-closed：策略声明必须满足的隔离项无法满足时，拒绝执行而不是静默降级
  if (policy.mode === 'strict' && policy.unsatisfied && policy.unsatisfied.length) {
    throw Object.assign(
      new Error('隔离策略为 strict，但当前平台无法满足：' + policy.unsatisfied.join('、') + '（' + (caps.detail || '') + '）'),
      { code: 'SANDBOX_UNAVAILABLE' }
    );
  }
  if (caps.backend === 'windows-job') {
    const helper = ensureWinJobHelper(options);
    if (!helper.ok) {
      if (policy.mode === 'strict') {
        throw Object.assign(new Error('隔离策略为 strict，但 Windows Job Object helper 不可用：' + helper.reason), {
          code: 'SANDBOX_UNAVAILABLE',
        });
      }
      audit(context, 'sandbox-fallback:job-helper-unavailable ' + helper.reason);
      return plainSpawn(spec.file, spec.args, { ...baseOptions, detached: options.detached === true });
    }
    const dir = cacheDir(options.cacheDir);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const specFile = path.join(dir, 'run-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.json');
    const payload = {
      file: spec.file,
      args: (spec.args || []).map(String),
      cwd: cwd || process.cwd(),
      env: env || {},
      limits: {
        maxProcesses: policy.maxProcesses || 0,
        maxMemoryMB: policy.maxMemoryMB || 0,
        cpuSeconds: policy.cpuSeconds || 0,
        brokerReserveMB: policy.brokerReserveMB || DEFAULT_BROKER_RESERVE_MB,
      },
    };
    try {
      fs.writeFileSync(specFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      if (policy.mode === 'strict') {
        throw Object.assign(new Error('隔离策略为 strict，但无法写入 spec 文件：' + error.message), {
          code: 'SANDBOX_UNAVAILABLE',
        });
      }
      audit(context, 'sandbox-fallback:spec-write-failed ' + error.message);
      return plainSpawn(spec.file, spec.args, { ...baseOptions, detached: options.detached === true });
    }
    const broker = plainSpawn(helper.path, ['-spec', specFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const sandboxChild = new SandboxChild({ broker, backend: 'windows-job', policy, file: spec.file, args: spec.args });
    sandboxChild.specFile = specFile;
    sandboxChild.on('close', () => {
      try { fs.unlinkSync(specFile); } catch {}
    });
    audit(context, 'sandbox:windows-job processes=' + (policy.maxProcesses || '∞') + ' memoryMB=' + (policy.maxMemoryMB || '∞'));
    return sandboxChild;
  }

  const wrapped = wrapCommand(policy, { ...spec, cwd, env });
  if (!wrapped) {
    audit(context, 'sandbox-fallback:no-backend ' + (caps.detail || ''));
    return plainSpawn(spec.file, spec.args, { ...baseOptions, detached: options.detached === true });
  }
  if (wrapped.backend === 'bubblewrap') {
    audit(context, 'sandbox:bubblewrap net=' + policy.network + ' writeRoots=' + (policy.writeRoots || []).length);
  } else if (wrapped.backend === 'sandbox-exec') {
    audit(context, 'sandbox:sandbox-exec net=' + policy.network + ' writeRoots=' + (policy.writeRoots || []).length);
  }
  return plainSpawn(wrapped.file, wrapped.args, { ...baseOptions, detached: options.detached === true });
}

/**
 * MCP / 项目命令面板 / 任何需要双向 stdio 的子进程：
 * Windows Job 代理会接管 stdin（既用于父进程存活探测，也用于终止信号），
 * 无法承载 JSON-RPC 或交互式输入，因此这里只在具备「不干扰 stdio」的包装后端
 * （Linux bwrap / macOS sandbox-exec）时上隔离，其它平台退回原生 spawn
 * 并在审计里如实标注「该路径未做 OS 级隔离」——不假装隔离。
 */
function guardedInteractiveSpawn(spec, options = {}) {
  return guardedMcpSpawn(spec, options);
}

function guardedMcpSpawn(spec, options = {}) {
  const policy = options.policy || currentPolicy(options.context);
  // 同 guardedSpawn：cwd / env 两种调用写法都支持（MCP 与项目命令面板从 options 传）
  const cwd = options.cwd !== undefined ? options.cwd : spec.cwd;
  const env = options.env !== undefined ? options.env : spec.env;
  const baseOptions = { cwd, env, shell: false, windowsHide: true };
  if (!policy || policy.mode === 'off') return plainSpawn(spec.file, spec.args, baseOptions);
  const caps = policy.capabilities || {};
  if (policy.mode === 'strict' && policy.unsatisfied && policy.unsatisfied.length) {
    throw Object.assign(
      new Error('隔离策略为 strict，但 MCP 所需的隔离项无法满足：' + policy.unsatisfied.join('、') + '（' + (caps.detail || '') + '）'),
      { code: 'SANDBOX_UNAVAILABLE' }
    );
  }
  let wrapped = null;
  try {
    wrapped = caps.backend === 'windows-job' ? null : wrapCommand(policy, { ...spec, cwd, env });
  } catch (error) {
    if (policy.mode === 'strict') throw error;
    audit(options.context, 'sandbox-mcp-fallback:' + error.message);
    return plainSpawn(spec.file, spec.args, baseOptions);
  }
  if (!wrapped) {
    audit(options.context, 'sandbox-mcp-skip:后端 ' + (caps.backend || 'none') + ' 无法承载双向 stdio，MCP 子进程仅做进程树清理');
    return plainSpawn(spec.file, spec.args, baseOptions);
  }
  audit(options.context, 'sandbox-mcp:' + wrapped.backend + ' net=' + policy.network);
  return plainSpawn(wrapped.file, wrapped.args, baseOptions);
}

function audit(context, entry) {
  if (context && typeof context.audit === 'function') {
    try { context.audit('[sandbox] ' + entry); } catch {}
  }
}

/**
 * 统一终止：隔离执行时优先走沙箱自身的终止语义（关 broker stdin + 硬杀 → 内核清理整棵树），
 * 否则退回既有的 killProcessTree。返回是否发起了终止。
 */
function killSandboxed(child, force = false) {
  if (!child) return false;
  if (typeof child.killHard === 'function') return force ? child.killHard() : child.kill();
  try {
    return require('./processTree.cjs').killProcessTree(child, force);
  } catch {
    try {
      return child.kill(force ? 'SIGKILL' : undefined) !== false;
    } catch {
      return false;
    }
  }
}

/** 工具层路径边界：真实路径解析 + 前缀校验 + 拒绝符号链接越界（Windows 上替代文件系统隔离） */
function withinWriteRoots(candidate, policy) {
  if (!policy) return true;
  const roots = policy.writeRoots || [];
  if (!roots.length) return true;
  let resolved;
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
  } catch {
    try {
      resolved = path.resolve(candidate);
    } catch {
      return false;
    }
  }
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return roots.some((root) => {
    let rootReal = root;
    try {
      rootReal = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
    } catch {}
    const target = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
    return normalized === target || normalized.startsWith(target + path.sep);
  });
}

module.exports = {
  HELPER_VERSION,
  capabilities,
  resolvePolicy,
  setDefaultPolicy,
  currentPolicy,
  describe,
  wrapCommand,
  guardedSpawn,
  guardedMcpSpawn,
  guardedInteractiveSpawn,
  killSandboxed,
  withinWriteRoots,
  sandboxExecProfile,
  bwrapArgs,
  ensureWinJobHelper,
  cacheDir,
  SandboxChild,
};
