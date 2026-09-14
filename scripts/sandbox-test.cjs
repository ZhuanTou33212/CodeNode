/**
 * sandbox-test.cjs —— 执行隔离层的真实强制力验证（不是「会不会返回错误字符串」，而是内核是否真的拦住了）
 *
 * 覆盖：
 *   1. capabilities() 如实上报后端与隔离项
 *   2. 隔离后端能正常跑通命令（不因隔离而失效）
 *   1b. cwd / env 归一化：options 传参与 spec 传参等价（相对路径不会落到父进程目录、env 不会被忽略）
 *   3. 进程数上限：子进程继续 spawn 时被内核拒绝（Windows Job Object ACTIVE_PROCESS）
 *   4. 内存上限：超出 job 内存上限的分配被拒绝（Windows JOB_MEMORY）
 *   5. 生命周期：硬杀 broker 后，子孙进程一并消失（KILL_ON_JOB_CLOSE），不会留下孤儿
 *   6. strict + 要求文件系统隔离但平台无后端 → 直接拒绝执行（fail-closed）
 *   7. 后端不可用时 best-effort 降级 + 审计留痕
 *   8. Linux/macOS 命令行包装正确性（bwrap / sandbox-exec profile 单元校验）
 *   9. 工具层路径边界：writeRoots 之外的路径被拒绝，且能识别 ../ 与符号链接逃逸
 *  10. 若本平台存在真实文件系统隔离后端（bwrap / sandbox-exec），则实跑越界写盘并断言被拒
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sandbox = require('../electron/sandbox.cjs');
const { safeEnvironment } = require('../electron/envPolicy.cjs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-sandbox-test-'));
const projectRoot = path.join(tmpRoot, 'project');
fs.mkdirSync(projectRoot, { recursive: true });

let failures = 0;
const notes = [];

function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
  return ok;
}

function note(text) {
  notes.push(text);
  console.log('NOTE  ' + text);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitClose(child, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.killHard ? child.killHard() : child.kill(); } catch {}
      resolve({ code: null, timeout: true });
    }, timeoutMs);
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timeout: false });
    });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, timeout: false, error });
    });
  });
}

function collect(child) {
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d.toString('utf8')));
  child.stderr.on('data', (d) => (out.stderr += d.toString('utf8')));
  return out;
}

const auditEntries = [];
const context = { audit: (entry) => auditEntries.push(entry) };

function pidAlive(pid) {
  if (process.platform === 'win32') {
    const res = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', windowsHide: true });
    return new RegExp('\\b' + pid + '\\b').test(String(res.stdout || ''));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  console.log('== platform=' + process.platform + ' node=' + process.version + ' ==');
  const caps = sandbox.capabilities({ refresh: true });
  console.log('capabilities: ' + JSON.stringify(caps));
  check('capabilities 返回结构化后端信息', !!caps.backend && !!caps.isolation, 'backend=' + caps.backend);
  check('capabilities 不虚报文件系统隔离（Windows 无 OS 级 FS 隔离）',
    process.platform !== 'win32' || caps.isolation.filesystem === false,
    JSON.stringify(caps.isolation));

  const policy = sandbox.resolvePolicy(
    { mode: 'best-effort', network: 'inherit', maxProcesses: 4, maxMemoryMB: 1024 },
    { projectRoot, capabilities: caps }
  );
  console.log('policy: ' + sandbox.describe(policy));
  check('策略解析出可写根且包含项目根', policy.writeRoots.some((root) => root === path.resolve(projectRoot)));
  check('best-effort 模式不因平台能力不足 fail-closed', policy.ok === true);

  // ---- 1. 隔离后端跑通正常命令 ----
  {
    const child = sandbox.guardedSpawn(
      { file: process.execPath, args: ['-e', 'process.stdout.write("SANDBOX-RUN-OK")'], cwd: projectRoot, env: safeEnvironment({ PYTHONUTF8: '1' }) },
      { policy, context }
    );
    const out = collect(child);
    const res = await waitClose(child);
    check('隔离后端可正常执行命令（不破坏功能）', out.stdout.includes('SANDBOX-RUN-OK'), 'exit=' + res.code + ' stdout=' + JSON.stringify(out.stdout.slice(0, 80)));
  }

  // ---- 1b. cwd / env 归一化回归：options 传参与 spec 传参必须等价 ----
  // 背景：guardedSpawn 曾只读 spec.cwd / spec.env，而 execute_shell 把 cwd / env 放在 options 里，
  // 结果相对路径命令落到了父进程目录执行（Agent 评测里表现为 pkg/math.test.cjs 找不到）。
  {
    const probeDir = path.join(projectRoot, 'cwd-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'probe.txt'), 'CWD-PROBE', 'utf8');
    const script = 'const fs=require("fs");process.stdout.write("cwd="+process.cwd()+" env="+process.env.CODENODE_CWD_PROBE+" file="+fs.readFileSync("probe.txt","utf8"))';
    const child = sandbox.guardedSpawn(
      { file: process.execPath, args: ['-e', script] },
      { policy, context, cwd: probeDir, env: safeEnvironment({ CODENODE_CWD_PROBE: 'yes' }) }
    );
    const out = collect(child);
    const res = await waitClose(child);
    check('options.cwd 生效（相对路径按给定工作目录解析）',
      out.stdout.includes('file=CWD-PROBE') && out.stdout.includes('cwd-probe'),
      'exit=' + res.code + ' stdout=' + JSON.stringify(out.stdout.slice(0, 160)));
    check('options.env 生效（脱敏后的环境变量被采用，而不是继承父进程全量环境）',
      out.stdout.includes('env=yes'),
      'stdout=' + JSON.stringify(out.stdout.slice(0, 160)));
  }

  // ---- 2. 进程数上限：真实内核拒绝 ----
  if (process.platform === 'win32') {
    const limitPolicy = sandbox.resolvePolicy({ mode: 'best-effort', maxProcesses: 2, maxMemoryMB: 1024 }, { projectRoot, capabilities: caps });
    const script = `
      const { spawn } = require('child_process');
      let errors = 0, spawned = 0;
      for (let i = 0; i < 6; i++) {
        try {
          const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });
          c.on('error', () => errors++);
          spawned++;
        } catch (e) { errors++; }
      }
      setTimeout(() => process.stdout.write('RESULT spawned=' + spawned + ' errors=' + errors), 2500);
    `;
    const child = sandbox.guardedSpawn({ file: process.execPath, args: ['-e', script], cwd: projectRoot, env: safeEnvironment() }, { policy: limitPolicy, context });
    const out = collect(child);
    const res = await waitClose(child);
    const match = /RESULT spawned=(\d+) errors=(\d+)/.exec(out.stdout) || [];
    check('进程数上限被内核强制（第 N 个子进程 spawn 失败）', Number(match[2] || 0) > 0 || res.code !== 0,
      'stdout=' + JSON.stringify(out.stdout.slice(-160)) + ' exit=' + res.code);
    note('进程数上限证据: ' + (match[0] || out.stdout.slice(-120) || '(no result line)'));
  } else {
    note('跳过 Windows Job Object 进程数上限实测（当前平台 ' + process.platform + '）');
  }

  // ---- 3. 内存上限 ----
  if (process.platform === 'win32') {
    const memPolicy = sandbox.resolvePolicy({ mode: 'best-effort', maxMemoryMB: 256 }, { projectRoot, capabilities: caps });
    const script = `
      const held = [];
      let allocated = 0;
      try {
        for (let i = 0; i < 600; i++) { held.push(Buffer.alloc(4 * 1024 * 1024, 1)); allocated++; }
      } catch (e) { allocated = -1; }
      process.stdout.write('ALLOCATED=' + allocated);
    `;
    const child = sandbox.guardedSpawn({ file: process.execPath, args: ['-e', script], cwd: projectRoot, env: safeEnvironment() }, { policy: memPolicy, context });
    const out = collect(child);
    const res = await waitClose(child);
    const match = /ALLOCATED=(-?\d+)/.exec(out.stdout) || [];
    const allocated = Number(match[1] || 0);
    check('内存上限被内核强制（分配失败或进程被杀）', allocated < 0 || allocated * 4 < 600 * 4 || res.code !== 0,
      'ALLOCATED=' + allocated + 'MB(×4) exit=' + res.code);
    note('内存上限证据: ' + (match[0] || out.stdout.slice(-120) || '(no result line)') + ' env.safeEnvironment 注入');
  } else {
    note('跳过 Windows Job Object 内存上限实测（当前平台 ' + process.platform + '）');
  }

  // ---- 4. 生命周期：硬杀 broker，子孙进程必须一起消失 ----
  if (process.platform === 'win32') {
    const marker = path.join(tmpRoot, 'grandchild-marker.txt');
    try { fs.unlinkSync(marker); } catch {}
    const markerScript = "setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'alive'),2000)";
    const parentScript =
      "const { spawn } = require('child_process');\n" +
      "const g = spawn(process.execPath, ['-e', " + JSON.stringify(markerScript) + "], { stdio: 'ignore', detached: true });\n" +
      "process.stdout.write('GRANDCHILD ' + g.pid + '\\n');\n" +
      "setTimeout(() => process.stdout.write('PARENT-STILL-ALIVE\\n'), 9000);";
    const lifePolicy = sandbox.resolvePolicy({ mode: 'best-effort' }, { projectRoot, capabilities: caps });
    const child = sandbox.guardedSpawn({ file: process.execPath, args: ['-e', parentScript], cwd: projectRoot, env: safeEnvironment() }, { policy: lifePolicy, context });
    const out = collect(child);
    await wait(1500);
    const grandchildPid = Number((/GRANDCHILD (\d+)/.exec(out.stdout) || [])[1] || 0);
    check('已捕获孙进程 pid（用于验证孤儿清理）', grandchildPid > 0, 'grandchildPid=' + grandchildPid);
    // 硬杀 broker：模拟 CodeNode 主进程崩溃/被强杀
    child.killHard();
    await wait(6000);
    const markerExists = fs.existsSync(marker);
    const stillAlive = grandchildPid > 0 ? pidAlive(grandchildPid) : false;
    check('硬杀父进程后孙进程被内核终止（KILL_ON_JOB_CLOSE）', !markerExists && !stillAlive,
      'marker=' + markerExists + ' grandchildAlive=' + stillAlive);
    note('生命周期证据: broker 被硬杀后孙进程存活=' + stillAlive + '，定时写盘标记文件存在=' + markerExists);
  } else {
    note('跳过 Windows KILL_ON_JOB_CLOSE 实测（当前平台 ' + process.platform + '）');
  }

  // ---- 5. strict + 文件系统隔离要求：fail-closed ----
  {
    const strictPolicy = sandbox.resolvePolicy({ mode: 'strict', requireFilesystem: true }, { projectRoot, capabilities: caps });
    let threw = null;
    try {
      sandbox.guardedSpawn({ file: process.execPath, args: ['-e', '0'], cwd: projectRoot, env: safeEnvironment() }, { policy: strictPolicy, context });
    } catch (error) {
      threw = error;
    }
    if (caps.isolation.filesystem) {
      check('平台支持文件系统隔离时 strict 不误拒', threw == null, threw ? String(threw.message) : '');
    } else {
      check('strict 模式在平台不支持所要求隔离时拒绝执行（fail-closed）', !!threw && threw.code === 'SANDBOX_UNAVAILABLE', threw ? threw.code : 'no throw');
    }
  }

  // ---- 6. 无后端时 best-effort 降级并留审计 ----
  {
    const degradedCaps = {
      platform: 'fake',
      backend: 'none',
      isolation: { lifetime: false, processCount: false, memory: false, cpu: false, filesystem: false, network: false },
      detail: '模拟无隔离后端',
    };
    const degradedPolicy = sandbox.resolvePolicy({ mode: 'best-effort' }, { projectRoot, capabilities: degradedCaps });
    check('无后端时策略标记降级项', degradedPolicy.degraded.length > 0, degradedPolicy.degraded.join(','));
    const before = auditEntries.length;
    const child = sandbox.guardedSpawn(
      { file: process.execPath, args: ['-e', 'process.stdout.write("DEGRADED-OK")'], cwd: projectRoot, env: safeEnvironment() },
      { policy: degradedPolicy, context }
    );
    const out = collect(child);
    await waitClose(child);
    check('降级路径仍可执行（不阻塞功能）', out.stdout.includes('DEGRADED-OK'));
    check('降级写入审计（未隔离留痕）', auditEntries.length > before && auditEntries.slice(before).some((e) => /fallback/.test(e)),
      JSON.stringify(auditEntries.slice(before)));
  }

  // ---- 7. Linux / macOS 包装正确性（跨平台 CI 上会真实执行，本机做单元校验） ----
  {
    const denyPolicy = sandbox.resolvePolicy({ mode: 'best-effort', network: 'deny' }, { projectRoot, capabilities: { platform: 'linux', backend: 'bubblewrap', isolation: { lifetime: true, filesystem: true, network: true } } });
    const bwrap = sandbox.bwrapArgs(denyPolicy, { file: '/usr/bin/node', args: ['-e', '1'], cwd: projectRoot });
    check('bwrap 参数：断网 + 只读根 + 工作区可写 + 随父退出',
      bwrap.includes('--unshare-net') && bwrap.includes('--die-with-parent') && bwrap.includes('--ro-bind') && bwrap.includes('--bind'),
      bwrap.join(' ').slice(0, 200));

    const macPolicy = sandbox.resolvePolicy({ mode: 'best-effort', network: 'deny' }, { projectRoot, capabilities: { platform: 'darwin', backend: 'sandbox-exec', isolation: { lifetime: true, filesystem: true, network: true } } });
    const profile = sandbox.sandboxExecProfile(macPolicy);
    check('sandbox-exec profile：默认拒绝 + 全读 + 仅白名单可写 + 断网',
      profile.includes('(deny default)') && profile.includes('(allow file-read*)') && profile.includes('(deny network*)') && profile.includes(path.resolve(projectRoot)),
      profile.replace(/\n/g, ' ').slice(0, 240));
  }

  // ---- 8. 工具层路径边界 ----
  {
    // 注意：默认策略把系统临时目录也列为可写（构建需要），所以这里把可写根收紧到项目根，
    // 用于验证越界判定本身是有效的。
    const boundaryPolicy = { ...sandbox.resolvePolicy({ mode: 'best-effort' }, { projectRoot, capabilities: caps }), writeRoots: [path.resolve(projectRoot)] };
    const inside = path.join(projectRoot, 'sub', 'file.txt');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'x');
    check('可写根内路径被允许', sandbox.withinWriteRoots(inside, boundaryPolicy) === true);
    check('项目外路径被拒绝', sandbox.withinWriteRoots(path.join(os.homedir(), 'codenode-forbidden.txt'), boundaryPolicy) === false);
    check('…/ 逃逸路径被拒绝', sandbox.withinWriteRoots(path.join(projectRoot, '..', 'escape.txt'), boundaryPolicy) === false);
    if (process.platform !== 'win32') {
      const link = path.join(projectRoot, 'link-out');
      try {
        fs.symlinkSync(tmpRoot, link, 'dir');
        check('符号链接逃逸被拒绝（realpath 校验）', sandbox.withinWriteRoots(path.join(link, 'pwn.txt'), boundaryPolicy) === false);
      } catch (error) {
        note('符号链接测试跳过：' + error.message);
      }
    } else {
      note('符号链接逃逸测试在 Windows 上需开发者模式/管理员，已跳过（realpath 校验逻辑同平台无关）');
    }
  }

  // ---- 9. 真实文件系统隔离实测（Linux/macOS 后端存在时） ----
  if (caps.isolation.filesystem) {
    const outside = path.join(tmpRoot, 'forbidden-' + Date.now() + '.txt');
    const script = "try { require('fs').writeFileSync(" + JSON.stringify(outside) + ", 'x'); process.stdout.write('WRITE-ALLOWED'); } catch (e) { process.stdout.write('WRITE-DENIED'); }";
    const fsPolicy = sandbox.resolvePolicy({ mode: 'strict', requireFilesystem: true }, { projectRoot, capabilities: caps });
    const child = sandbox.guardedSpawn({ file: process.execPath, args: ['-e', script], cwd: projectRoot, env: safeEnvironment() }, { policy: fsPolicy, context });
    const out = collect(child);
    await waitClose(child);
    check('真实文件系统隔离：可写根之外写盘被拒', out.stdout.includes('WRITE-DENIED') && !fs.existsSync(outside),
      'stdout=' + JSON.stringify(out.stdout.slice(0, 120)) + ' stderr=' + JSON.stringify(out.stderr.slice(0, 160)));
    const insideScript = "require('fs').writeFileSync(" + JSON.stringify(path.join(projectRoot, 'allowed.txt')) + ", 'x'); process.stdout.write('WRITE-OK');";
    const child2 = sandbox.guardedSpawn({ file: process.execPath, args: ['-e', insideScript], cwd: projectRoot, env: safeEnvironment() }, { policy: fsPolicy, context });
    const out2 = collect(child2);
    await waitClose(child2);
    check('真实文件系统隔离：工作区内写盘仍可用', out2.stdout.includes('WRITE-OK'), JSON.stringify(out2.stdout.slice(0, 120)));
  } else {
    note('本平台无 OS 级文件系统隔离后端，跳越界写盘实测（Windows 走工具层 writeRoots 校验，上面已单独验证）');
  }

  // 清理
  try {
    cleanupDir(tmpRoot);
  } catch {}

  console.log('\n== 结论：' + (failures === 0 ? '全部通过' : failures + ' 项失败') + ' ==');
  for (const line of notes) console.log('  · ' + line);
  if (failures) process.exit(1);
})().catch((error) => {
  console.error('sandbox-test 异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});

function cleanupDir(dir) {
  // Node 24 的 fs.rmSync 对非 ASCII 路径按 ANSI 解释会误删，这里统一用 unlink/rmdir 递归清理
  const walk = (target) => {
    let items = [];
    try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(target, item.name);
      if (item.isDirectory()) walk(full);
      else try { fs.unlinkSync(full); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
  };
  walk(dir);
}
