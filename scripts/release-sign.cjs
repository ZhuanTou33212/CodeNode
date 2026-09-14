'use strict';

/**
 * scripts/release-sign.cjs —— 发布制品签名 / 校验 + release/manifest.json
 *
 * 做什么：
 *   1) 计算 release/ 下目标制品的 sha256 / sha512（便携版 exe、win-unpacked 主 exe）；
 *   2) 签名（可选，三种方式）：
 *        - 证书注入：CODENODE_WIN_CERT_PFX_BASE64 + CODENODE_WIN_CERT_PASSWORD
 *          （写临时 .pfx，用 PowerShell Set-AuthenticodeSignature 签名，临时文件退出时删除）；
 *        - 本机自签名开发证书：--self-signed / CODENODE_WIN_SELF_SIGNED=1
 *          （PowerShell New-SelfSignedCertificate -Type CodeSigningCert，CurrentUser 存储，无需管理员）；
 *          自签名证书默认不可信（Status=UnknownError），加 --trust-dev-cert /
 *          CODENODE_TRUST_SELF_SIGNED=1 会把开发证书导入 CurrentUser 受信任根存储，使校验返回 Valid；
 *        - --no-sign：只做哈希与校验；
 *   3) 校验：Get-AuthenticodeSignature，把 Status / 证书主题 / 指纹写进 manifest；
 *   4) 生成/更新 release/manifest.json（含 version、commit、artifact 列表 + hash、signed 状态、
 *      signedAt、证书主题、minUpgradeFrom、generatedAt）；
 *   5) fail-closed：CODENODE_REQUIRE_SIGNING=1 且制品未签名（Status != Valid）时 exit 1。
 *
 * 用法：
 *   node scripts/release-sign.cjs [--no-sign] [--self-signed] [--print] [--release-dir=<dir>]
 * 环境变量：
 *   CODENODE_REQUIRE_SIGNING=1            未签名即失败
 *   CODENODE_WIN_CERT_PFX_BASE64          base64 的 .pfx 内容
 *   CODENODE_WIN_CERT_PASSWORD            .pfx 密码
 *   CODENODE_WIN_SELF_SIGNED=1            使用本机自签名开发证书
 *   CODENODE_TIMESTAMP_URL                RFC3161 时间戳服务器（可选，默认不时间戳）
 *   CODENODE_MIN_UPGRADE_FROM             允许升级的最低版本（默认取上一版 manifest 的 version）
 *   CODENODE_RELEASE_DIR                  release 目录（默认 <repo>/release）
 *
 * 无新增 npm 依赖：只用 Node 内置模块 + 系统 PowerShell。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const DEFAULT_RELEASE_DIR = path.join(ROOT, 'release');
const MANIFEST_NAME = 'manifest.json';
const SCHEMA_VERSION = 1;

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const options = {
    noSign: false,
    selfSigned: false,
    trustDevCert: false,
    print: false,
    releaseDir: process.env.CODENODE_RELEASE_DIR || DEFAULT_RELEASE_DIR,
  };
  for (const raw of argv.slice(2)) {
    const arg = String(raw);
    if (arg === '--no-sign') options.noSign = true;
    else if (arg === '--self-signed') options.selfSigned = true;
    else if (arg === '--trust-dev-cert') options.trustDevCert = true;
    else if (arg === '--print') options.print = true;
    else if (arg.startsWith('--release-dir=')) options.releaseDir = arg.slice('--release-dir='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('未知参数：' + arg);
  }
  if (process.env.CODENODE_WIN_SELF_SIGNED === '1') options.selfSigned = true;
  if (process.env.CODENODE_TRUST_SELF_SIGNED === '1') options.trustDevCert = true;
  options.releaseDir = path.resolve(options.releaseDir);
  options.requireSigning = process.env.CODENODE_REQUIRE_SIGNING === '1';
  options.pfxBase64 = process.env.CODENODE_WIN_CERT_PFX_BASE64 || '';
  options.pfxPassword = process.env.CODENODE_WIN_CERT_PASSWORD || '';
  options.timestampUrl = process.env.CODENODE_TIMESTAMP_URL || '';
  return options;
}

function usage() {
  console.log([
    '用法：node scripts/release-sign.cjs [选项]',
    '  --no-sign              只计算哈希与校验签名状态（不签名）',
    '  --self-signed          用本机自签名开发证书签名（CurrentUser，无需管理员）',
    '  --trust-dev-cert       把自签名开发证书导入 Cert:\\CurrentUser\\Root，使校验返回 Valid（仅本地验收用）',
    '  --print                结束后打印 manifest',
    '  --release-dir=<dir>    指定 release 目录（默认 <repo>/release）',
    '',
    '环境变量：CODENODE_REQUIRE_SIGNING=1 / CODENODE_WIN_CERT_PFX_BASE64 /',
    '          CODENODE_WIN_CERT_PASSWORD / CODENODE_WIN_SELF_SIGNED=1 / CODENODE_TIMESTAMP_URL',
  ].join('\n'));
}

// ---------------- 基础工具 ----------------

function gitCommit() {
  try {
    const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out.status !== 0) return null;
    const value = String(out.stdout || '').trim();
    return value || null;
  } catch {
    return null;
  }
}

function hashFile(file) {
  const buf = fs.readFileSync(file);
  return {
    sizeBytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sha512: crypto.createHash('sha512').update(buf).digest('hex'),
  };
}

/** 收集需要签名/校验的制品：便携版 exe + win-unpacked 主 exe */
function findArtifacts(releaseDir, productName) {
  const artifacts = [];
  if (!fs.existsSync(releaseDir)) return artifacts;

  // 1) 便携版：release/CodeNode-<version>.exe（artifactName 规则），退化为 release 根目录下任意 *<version>*.exe
  let topLevel = [];
  try {
    topLevel = fs.readdirSync(releaseDir);
  } catch {
    topLevel = [];
  }
  const portable = topLevel
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .sort();
  const preferred = portable.find((name) => name.includes(pkg.version));
  if (preferred) {
    artifacts.push({ kind: 'portable', name: preferred, file: path.join(releaseDir, preferred) });
  } else if (portable.length) {
    artifacts.push({ kind: 'portable', name: portable[0], file: path.join(releaseDir, portable[0]) });
  }

  // 2) unpacked 主 exe
  const unpackedExe = path.join(releaseDir, 'win-unpacked', (productName || 'CodeNode') + '.exe');
  if (fs.existsSync(unpackedExe)) {
    artifacts.push({ kind: 'unpacked', name: path.join('win-unpacked', path.basename(unpackedExe)), file: unpackedExe });
  }

  // 3) app.asar（升级/回滚验证关心的程序文件本体，一并记录哈希）
  const asar = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar');
  if (fs.existsSync(asar)) {
    artifacts.push({ kind: 'asar', name: path.join('win-unpacked', 'resources', 'app.asar'), file: asar });
  }

  return artifacts;
}

// ---------------- PowerShell 桥 ----------------

const PS_TMP = path.join(os.tmpdir(), 'codenode-sign');

/** 统一 PowerShell 输出编码为 UTF-8，避免中文 StatusMessage 变成乱码 */
const PS_PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
].join('\n');

function runPowerShell(script, timeoutMs = 180000) {
  fs.mkdirSync(PS_TMP, { recursive: true });
  const file = path.join(PS_TMP, 'script-' + crypto.randomUUID() + '.ps1');
  fs.writeFileSync(file, PS_PRELUDE + '\n' + script, 'utf8');
  try {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      error: result.error ? String(result.error.message) : null,
    };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理失败忽略 */ }
  }
}

function powerShellAvailable() {
  if (process.platform !== 'win32') return false;
  const probe = runPowerShell("Write-Output 'ok'", 30000);
  return probe.ok && probe.stdout.includes('ok');
}

function verifySignature(file) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$sig = Get-AuthenticodeSignature -FilePath ' + JSON.stringify(file),
    '$out = @{',
    '  status = [string]$sig.Status',
    '  statusMessage = [string]$sig.StatusMessage',
    '  signerSubject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }',
    '  signerThumbprint = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { $null }',
    '  signerNotAfter = if ($sig.SignerCertificate) { $sig.SignerCertificate.NotAfter.ToString("o") } else { $null }',
    '  timeStamperSubject = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { $null }',
    '}',
    'ConvertTo-Json -Compress -InputObject $out',
  ].join('\n');
  const result = runPowerShell(script);
  if (!result.ok) {
    return { status: 'Unavailable', error: result.stderr || result.error || ('powershell exit ' + result.status) };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { status: 'Unavailable', error: '无法解析 Get-AuthenticodeSignature 输出：' + result.stdout };
  }
}

function ensureSelfSignedCert() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$subject = 'CN=CodeNode Dev Self-Signed'",
    '$cert = Get-ChildItem -Path Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(7) } | Select-Object -First 1',
    'if (-not $cert) {',
    '  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddYears(3) -KeyUsage DigitalSignature',
    '}',
    'ConvertTo-Json -Compress -InputObject @{ subject = $cert.Subject; thumbprint = $cert.Thumbprint; notAfter = $cert.NotAfter.ToString("o") }',
  ].join('\n');
  const result = runPowerShell(script);
  if (!result.ok) throw new Error('创建/读取自签名证书失败：' + (result.stderr || result.error || result.status));
  return JSON.parse(result.stdout);
}

/**
 * 仅开发/本地验收用：把自签名开发证书导入当前用户「受信任的根证书颁发机构」，
 * 这样 Get-AuthenticodeSignature 才会返回 Valid（自签名证书默认不可信 → UnknownError）。
 * 需要 --trust-dev-cert 或 CODENODE_TRUST_SELF_SIGNED=1 显式开启；只写 CurrentUser，无需管理员。
 * 移除：certutil -user -delstore Root <thumbprint>
 */
function trustDevCert(thumbprint) {
  const script = [
    '$cert = Get-ChildItem -Path Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Thumbprint -eq ' + JSON.stringify(thumbprint) + ' } | Select-Object -First 1',
    'if (-not $cert) { throw "找不到自签名证书" }',
    "$cer = Join-Path $env:TEMP ('codenode-dev-cert-' + $cert.Thumbprint + '.cer')",
    'Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null',
    'Import-Certificate -FilePath $cer -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null',
    'Remove-Item $cer -Force',
    "Write-Output 'trusted'",
  ].join('\n');
  const result = runPowerShell(script);
  if (!result.ok) throw new Error('导入受信任根证书失败（仅本地开发用）：' + (result.stderr || result.error || result.status));
  return true;
}

function signWithCertStore(file, thumbprint, timestampUrl) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$cert = Get-ChildItem -Path Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Thumbprint -eq ' + JSON.stringify(thumbprint) + ' } | Select-Object -First 1',
    'if (-not $cert) { throw "找不到代码签名证书：" + ' + JSON.stringify(thumbprint) + ' }',
    timestampUrl
      ? 'Set-AuthenticodeSignature -FilePath ' + JSON.stringify(file) + ' -Certificate $cert -HashAlgorithm SHA256 -TimestampServer ' + JSON.stringify(timestampUrl) + ' | Out-Null'
      : 'Set-AuthenticodeSignature -FilePath ' + JSON.stringify(file) + ' -Certificate $cert -HashAlgorithm SHA256 | Out-Null',
    "Write-Output 'signed'",
  ].join('\n');
  const result = runPowerShell(script);
  if (!result.ok) throw new Error('Set-AuthenticodeSignature（证书存储）失败：' + (result.stderr || result.error || result.status));
  return true;
}

function signWithPfx(file, pfxPath, password, timestampUrl) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$secure = ConvertTo-SecureString -String ' + JSON.stringify(password) + ' -Force -AsPlainText',
    '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(' + JSON.stringify(pfxPath) + ', $secure)',
    timestampUrl
      ? 'Set-AuthenticodeSignature -FilePath ' + JSON.stringify(file) + ' -Certificate $cert -HashAlgorithm SHA256 -TimestampServer ' + JSON.stringify(timestampUrl) + ' | Out-Null'
      : 'Set-AuthenticodeSignature -FilePath ' + JSON.stringify(file) + ' -Certificate $cert -HashAlgorithm SHA256 | Out-Null',
    "Write-Output 'signed'",
  ].join('\n');
  const result = runPowerShell(script);
  if (!result.ok) throw new Error('Set-AuthenticodeSignature（pfx）失败：' + (result.stderr || result.error || result.status));
  return true;
}

// ---------------- manifest ----------------

function readPreviousManifest(releaseDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(releaseDir, MANIFEST_NAME), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------- 主流程 ----------------

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    usage();
    process.exit(0);
  }

  console.log('[release-sign] 版本 ' + pkg.version + '，release 目录 ' + options.releaseDir);

  const artifacts = findArtifacts(options.releaseDir, pkg.build && pkg.build.productName);
  if (artifacts.length === 0) {
    console.error('[release-sign] 未找到任何制品：请先运行 `npm run dist:win` 生成 release/ 下的便携版 exe 与 win-unpacked。');
    process.exit(2);
  }

  const previous = readPreviousManifest(options.releaseDir);
  const expectSigning = options.requireSigning;
  const psAvailable = powerShellAvailable();
  if (!psAvailable && process.platform === 'win32') {
    console.warn('[release-sign] 警告：PowerShell 不可用，无法签名/校验 Authenticode（仅计算哈希）。');
  }

  // 判断签名模式
  let signMode = 'none';
  if (!options.noSign) {
    if (options.pfxBase64) signMode = 'pfx';
    else if (options.selfSigned) signMode = 'self-signed';
    else if (options.trustDevCert) {
      // 信任开发证书隐含使用自签名证书
      options.selfSigned = true;
      signMode = 'self-signed';
    }
  }

  // 自签名证书（一次）
  let certInfo = null;
  let pfxTemp = null;
  if (signMode === 'self-signed') {
    if (!psAvailable) throw new Error('需要 PowerShell 才能创建/使用自签名证书');
    certInfo = ensureSelfSignedCert();
    console.log('[release-sign] 自签名证书：' + certInfo.subject + ' 指纹 ' + certInfo.thumbprint);
    if (options.trustDevCert) {
      trustDevCert(certInfo.thumbprint);
      certInfo.trusted = true;
      certInfo.trustNote = '已导入 Cert:\\CurrentUser\\Root（仅本地开发验收用）';
      console.log('[release-sign] 已把开发证书加入当前用户受信任根存储（仅本地验收用；移除：certutil -user -delstore Root ' + certInfo.thumbprint + '）');
    }
  } else if (signMode === 'pfx') {
    if (!psAvailable) throw new Error('需要 PowerShell 才能使用 pfx 证书签名');
    pfxTemp = path.join(PS_TMP, 'cert-' + crypto.randomUUID() + '.pfx');
    fs.mkdirSync(PS_TMP, { recursive: true });
    fs.writeFileSync(pfxTemp, Buffer.from(options.pfxBase64, 'base64'));
    console.log('[release-sign] 使用注入的 pfx 证书（临时文件 ' + pfxTemp + '，退出时删除）');
  }

  const results = [];
  let signedAny = false;
  let signedAt = null;

  try {
    for (const artifact of artifacts) {
      const entry = {
        kind: artifact.kind,
        name: artifact.name,
        path: path.relative(ROOT, artifact.file).split(path.sep).join('/'),
      };
      Object.assign(entry, hashFile(artifact.file));

      // ---- 签名（仅 exe；asar 不签名，只记录哈希） ----
      if (signMode !== 'none' && artifact.kind !== 'asar') {
        try {
          if (signMode === 'pfx') signWithPfx(artifact.file, pfxTemp, options.pfxPassword, options.timestampUrl);
          else signWithCertStore(artifact.file, certInfo.thumbprint, options.timestampUrl);
          // 签名会改变文件字节，重新计算哈希
          Object.assign(entry, hashFile(artifact.file));
          entry.signedAt = new Date().toISOString();
          signedAny = true;
          signedAt = entry.signedAt;
        } catch (error) {
          entry.signError = String((error && error.message) || error);
          console.error('[release-sign] 签名失败（' + artifact.name + '）：' + entry.signError);
        }
      } else if (signMode !== 'none' && artifact.kind === 'asar') {
        entry.signed = false;
        entry.signNote = 'app.asar 不参与 Authenticode 签名，仅记录哈希';
      }

      // ---- 校验 ----
      if (artifact.kind !== 'asar' && psAvailable) {
        const verify = verifySignature(artifact.file);
        entry.signatureStatus = verify.status;
        entry.signatureMessage = verify.statusMessage || null;
        entry.signerSubject = verify.signerSubject || null;
        entry.signerThumbprint = verify.signerThumbprint || null;
        entry.signerNotAfter = verify.signerNotAfter || null;
        entry.timestamped = !!verify.timeStamperSubject;
        entry.signed = verify.status === 'Valid';
        entry.signaturePresent = ['NotSigned', 'Unverified', 'Unavailable', 'NotApplicable'].indexOf(verify.status) === -1;
        if (verify.error) entry.signatureError = verify.error;
      } else {
        entry.signed = false;
        entry.signatureStatus = artifact.kind === 'asar' ? 'NotApplicable' : 'Unverified';
      }

      results.push(entry);
      console.log('[release-sign] ' + entry.name + ' sha256=' + entry.sha256.slice(0, 16) + '… ' + entry.sizeBytes + 'B 签名=' + entry.signatureStatus);
    }
  } finally {
    if (pfxTemp) {
      try { fs.unlinkSync(pfxTemp); } catch { /* 忽略 */ }
    }
  }

  const allSigned = results.filter((item) => item.kind !== 'asar').every((item) => item.signed === true);
  const signableArtifacts = results.filter((item) => item.kind !== 'asar');

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    productName: (pkg.build && pkg.build.productName) || pkg.name,
    appId: (pkg.build && pkg.build.appId) || null,
    version: pkg.version,
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    signed: signableArtifacts.length > 0 ? allSigned : false,
    signMode,
    signedAt: signedAny ? signedAt : (previous && previous.signedAt) || null,
    certificate: certInfo
      ? { subject: certInfo.subject, thumbprint: certInfo.thumbprint, notAfter: certInfo.notAfter, source: 'self-signed(CurrentUser)' }
      : (results.find((item) => item.signerSubject)
        ? {
          subject: results.find((item) => item.signerSubject).signerSubject,
          thumbprint: results.find((item) => item.signerThumbprint).signerThumbprint,
          notAfter: results.find((item) => item.signerNotAfter).signerNotAfter,
          source: signMode === 'pfx' ? 'injected-pfx' : 'existing',
        }
        : null),
    minUpgradeFrom: process.env.CODENODE_MIN_UPGRADE_FROM
      || (previous && previous.version)
      || pkg.version,
    upgrade: {
      previousVersion: (previous && previous.version) || null,
      previousManifestGeneratedAt: (previous && previous.generatedAt) || null,
      // 回滚目标：上一版 manifest 记录的第一份制品
      rollbackTarget: previous && Array.isArray(previous.artifacts) && previous.artifacts[0]
        ? { version: previous.version, artifact: previous.artifacts[0].name, sha256: previous.artifacts[0].sha256 }
        : null,
    },
    artifacts: results,
    requiredSigning: expectSigning,
  };

  fs.mkdirSync(options.releaseDir, { recursive: true });
  const manifestPath = path.join(options.releaseDir, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('[release-sign] manifest 已写入 ' + manifestPath);

  if (options.print) console.log(JSON.stringify(manifest, null, 2));

  // fail-closed
  if (expectSigning && !manifest.signed) {
    console.error('[release-sign] FAIL：CODENODE_REQUIRE_SIGNING=1 但制品未通过签名校验（' +
      signableArtifacts.map((item) => item.name + '=' + item.signatureStatus).join(', ') + '）');
    process.exit(1);
  }

  console.log('[release-sign] OK：签名=' + manifest.signed + ' 模式=' + signMode + ' 制品=' + results.length);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error('[release-sign] ERROR：' + String((error && error.stack) || error));
  process.exit(3);
}
