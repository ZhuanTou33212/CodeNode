'use strict';

/**
 * CodeNode 发布自检模块（无窗口 / 无 UI / 无 DOM）
 *
 * 用途：发布验收。主进程收到 `--codenode-selftest` 时调用 runSelfTest()，
 *       把一段 JSON 打到 stdout 后立即退出，全程不创建 BrowserWindow。
 *
 * 约束（架构级要求）：
 *   - CommonJS；只依赖 Node 内置模块（fs / path / child_process）与仓库内非 UI 模块
 *     （agent / modelStore / runStore / memory / cnode）；
 *   - 绝不 require('electron')、绝不触碰任何 DOM / React / preload；
 *   - userDataDir 与 projectRoot 由调用方注入（升级/回滚验证需要隔离目录，
 *     避免污染用户真实数据）。
 *
 * 支持的命令行参数（主进程与 scripts/release-lifecycle-test.cjs 共用）：
 *   --codenode-selftest                          启用自检（由 main.cjs 判定）
 *   --codenode-selftest-seed                     在隔离目录写入一份确定性的“用户数据”种子
 *   --codenode-user-data-dir=<dir>               覆盖 userData 目录
 *   --codenode-selftest-project=<dir>            指定被检查的项目根目录
 *   --codenode-selftest-marker=<text>            种子标记，用于验证升级/回滚后数据未丢失
 *   --codenode-selftest-expect-version=<semver>  期望的程序版本，不匹配则 ok=false
 *
 * 环境变量等价物：CODENODE_USER_DATA_DIR / CODENODE_SELFTEST_PROJECT /
 *   CODENODE_SELFTEST_MARKER / CODENODE_SELFTEST_EXPECT_VERSION
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SELFTEST_FLAG = '--codenode-selftest';
const SEED_FLAG = '--codenode-selftest-seed';
const USER_DATA_FLAG = '--codenode-user-data-dir';
const PROJECT_FLAG = '--codenode-selftest-project';
const MARKER_FLAG = '--codenode-selftest-marker';
const EXPECT_VERSION_FLAG = '--codenode-selftest-expect-version';
const OUT_FLAG = '--codenode-selftest-out';
/** stdout 中的定界标记：调用方（脚本/CI）用它从混杂日志里切出 JSON */
const STDOUT_BEGIN = '__CODENODE_SELFTEST_JSON_BEGIN__';
const STDOUT_END = '__CODENODE_SELFTEST_JSON_END__';
const MARKER_MODEL_ID = 'selftest-marker';
const MARKER_MEMORY_ID = 'mem-selftest-marker';
const MARKER_PROJECT_FILE = 'selftest-project.cnode';

const pkg = require(path.join(REPO_ROOT, 'package.json'));
const agent = require('./agent.cjs');
const modelStore = require('./modelStore.cjs');
const runStore = require('./runStore.cjs');
const memoryStore = require('./memory.cjs');
const cnode = require('./cnode.cjs');

// ---------------- 参数解析 ----------------

function hasFlag(argv, name) {
  return Array.isArray(argv) && argv.some((arg) => arg === name || String(arg).startsWith(name + '='));
}

function flagValue(argv, name) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    const text = String(arg);
    if (text === name) return '';
    if (text.startsWith(name + '=')) return text.slice(name.length + 1);
  }
  return null;
}

function pickValue(argv, flag, envName) {
  const fromFlag = flagValue(argv, flag);
  if (fromFlag != null && fromFlag !== '') return path.resolve(fromFlag);
  const fromEnv = process.env[envName];
  if (fromEnv) return path.resolve(fromEnv);
  return null;
}

// ---------------- 基础工具 ----------------

function gitCommit(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = String(out).trim();
    return value || null;
  } catch {
    return null;
  }
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function countFiles(dir, suffix) {
  try {
    return fs.readdirSync(dir).filter((name) => !suffix || name.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

function bytesOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 某一类数据里是否还能找到种子标记（升级/回滚“数据未丢”的核心证据） */
function containsMarker(text, marker) {
  return typeof text === 'string' && text.includes(marker);
}

// ---------------- 种子写入（走真实存储代码路径） ----------------

/**
 * 在隔离目录里写入一份确定性的用户数据：
 *   1) userData/models.json —— 模型接入配置（真实 modelStore 路径 + 真实密钥存储逻辑）
 *   2) <project>/.codenode/runs/<runId>.jsonl —— Run 记录（真实 runStore 路径）
 *   3) <project>/.codenode/memory.json —— 项目长期记忆（真实 memory 路径）
 *   4) <project>/selftest-project.cnode —— 工程文件（真实 cnode 编码器）
 */
function seedData(dirs, marker) {
  const cfg = agent.loadConfig(dirs.projectRoot);
  const created = {};

  // 1) 模型配置
  const existing = modelStore.readModels(dirs.userDataDir);
  const models = existing && Array.isArray(existing.models) ? existing.models.slice() : modelStore.seedModels(cfg);
  const markerModel = {
    id: MARKER_MODEL_ID,
    label: 'SELFTEST-MARKER:' + marker,
    model: MARKER_MODEL_ID,
    apiBase: 'https://example.invalid',
    apiKey: '',
    contextWindow: 8192,
    enabled: true,
  };
  const merged = models.filter((m) => m && m.id !== MARKER_MODEL_ID).concat([markerModel]);
  const activeId = (existing && existing.activeId) || (merged[0] && merged[0].id) || MARKER_MODEL_ID;
  modelStore.writeModels(dirs.userDataDir, merged, activeId);
  created.modelsFile = path.join(dirs.userDataDir, 'models.json');

  // 2) Run 记录
  const runId = 'selftest-' + marker;
  runStore.startRun(dirs.projectRoot, runId, { prompt: 'SELFTEST-MARKER:' + marker, model: MARKER_MODEL_ID });
  runStore.appendEvent(dirs.projectRoot, runId, 'tool_result', {
    tools: [{ name: 'selftest', ok: true }],
    marker,
  });
  runStore.finishRun(dirs.projectRoot, runId, 'completed', { toolCount: 1, marker });
  created.runId = runId;

  // 3) 项目长期记忆
  const memory = memoryStore.readMemory(dirs.projectRoot);
  const entries = memory.entries.filter((e) => e && e.id !== MARKER_MEMORY_ID);
  entries.push({
    id: MARKER_MEMORY_ID,
    key: 'selftest',
    content: 'SELFTEST-MARKER:' + marker,
    tags: ['selftest'],
    createdAt: new Date().toISOString(),
  });
  memoryStore.writeMemory(dirs.projectRoot, entries);
  created.memoryFile = path.join(dirs.projectRoot, '.codenode', 'memory.json');

  // 4) 工程文件（.cnode 使用真实编码器）
  const projectFile = path.join(dirs.projectRoot, MARKER_PROJECT_FILE);
  const graph = {
    revision: 1,
    nodes: [{ id: 'selftest-node', type: 'task', position: { x: 0, y: 0 }, data: { label: 'SELFTEST-MARKER:' + marker } }],
    edges: [],
  };
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, cnode.encodeCnode({
    manifest: { name: 'selftest-' + marker },
    graph,
    workspace: { viewport: { x: 0, y: 0, zoom: 1 } },
  }));
  created.projectFile = projectFile;

  return created;
}

// ---------------- 数据采集 ----------------

function collectData(dirs, marker) {
  const modelsFile = path.join(dirs.userDataDir, 'models.json');
  const runsDir = path.join(dirs.projectRoot, '.codenode', 'runs');
  const memoryFile = path.join(dirs.projectRoot, '.codenode', 'memory.json');
  const projectCfgFile = path.join(dirs.projectRoot, '.codenode', 'agent.properties');
  const projectFile = path.join(dirs.projectRoot, MARKER_PROJECT_FILE);

  // 模型配置：纯读取，不产生副作用
  let modelsStore = null;
  let modelsError = null;
  try {
    modelsStore = modelStore.readModels(dirs.userDataDir);
  } catch (error) {
    modelsError = String((error && error.message) || error);
  }

  // Run 记录
  let runs = [];
  try {
    runs = runStore.listRuns(dirs.projectRoot, 20);
  } catch {
    runs = [];
  }

  // 项目长期记忆
  const memory = memoryStore.readMemory(dirs.projectRoot);

  // 工程文件（.cnode）
  let cnodeFiles = [];
  try {
    cnodeFiles = fs.readdirSync(dirs.projectRoot).filter((name) => name.toLowerCase().endsWith('.cnode'));
  } catch {
    cnodeFiles = [];
  }

  // 工程文件解码校验（真实的 .cnode 解码器）
  let projectFileCheck = { path: projectFile, exists: exists(projectFile), decodeOk: null, markerHit: false };
  if (projectFileCheck.exists) {
    try {
      const decoded = cnode.decodeCnode(fs.readFileSync(projectFile));
      projectFileCheck.decodeOk = !!decoded.ok;
      projectFileCheck.markerHit = containsMarker(JSON.stringify({ manifest: decoded.manifest, graph: decoded.graph }), marker);
      projectFileCheck.warnings = decoded.warnings || [];
    } catch (error) {
      projectFileCheck.decodeOk = false;
      projectFileCheck.error = String((error && error.message) || error);
    }
  }

  // 种子标记是否仍存在于各类数据中
  const markerHits = {
    modelsFile: containsMarker(readTextSafe(modelsFile), marker),
    runRecord: containsMarker(readTextSafe(path.join(runsDir, 'selftest-' + marker + '.jsonl')), marker),
    memory: containsMarker(readTextSafe(memoryFile), marker),
    projectFile: !!projectFileCheck.markerHit,
  };

  return {
    paths: {
      userDataDir: dirs.userDataDir,
      projectRoot: dirs.projectRoot,
      modelsFile,
      runsDir,
      memoryFile,
      projectConfig: projectCfgFile,
      projectFile,
    },
    modelsConfig: {
      exists: !!modelsStore,
      path: modelsFile,
      sizeBytes: bytesOf(modelsFile),
      count: modelsStore && Array.isArray(modelsStore.models) ? modelsStore.models.length : 0,
      activeId: modelsStore ? modelsStore.activeId || null : null,
      ids: modelsStore && Array.isArray(modelsStore.models) ? modelsStore.models.map((m) => m && m.id).filter(Boolean) : [],
      apiKeySetCount: modelsStore && Array.isArray(modelsStore.models)
        ? modelsStore.models.filter((m) => m && m.apiKey).length
        : 0,
      error: modelsError,
    },
    runRecords: {
      dir: runsDir,
      fileCount: countFiles(runsDir, '.jsonl'),
      count: runs.length,
      latest: runs[0] || null,
    },
    memory: {
      path: memoryFile,
      exists: exists(memoryFile),
      sizeBytes: bytesOf(memoryFile),
      count: Array.isArray(memory.entries) ? memory.entries.length : 0,
    },
    projectFiles: {
      count: cnodeFiles.length,
      names: cnodeFiles.slice(0, 20),
      selftestFile: projectFileCheck,
    },
    projectConfig: {
      path: projectCfgFile,
      exists: exists(projectCfgFile),
    },
    markerHits,
  };
}

function summarizeConfig(projectRoot) {
  const cfg = agent.loadConfig(projectRoot);
  return {
    source: exists(path.join(projectRoot, '.codenode', 'agent.properties'))
      ? 'config/agent.properties + <project>/.codenode/agent.properties'
      : 'config/agent.properties',
    model: cfg.model,
    apiBase: cfg.apiBase,
    apiKeySet: !!cfg.apiKey,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    // S13：接的是哪一档协议（openai / anthropic / gemini + 端点风格），排障第一眼要看这个
    protocol: cfg.protocol,
    endpoint: cfg.endpoint,
    auth: cfg.auth,
    toolsEnabled: !!(cfg.tools && cfg.tools.toolsEnabled),
    ragEnabled: !!(cfg.rag && cfg.rag.enabled),
    limits: cfg.limits || null,
  };
}

// ---------------- 主入口 ----------------

/**
 * 运行一次自检，返回可 JSON 序列化的结果对象（同步执行，便于主进程立即退出）。
 * @param {object} [options]
 * @param {string} [options.userDataDir]  userData 目录（默认取命令行 / 环境变量 / 仓库内隔离目录）
 * @param {string} [options.projectRoot]  项目根目录
 * @param {boolean} [options.seed]        是否写入种子数据
 * @param {string} [options.marker]       种子标记
 * @param {string} [options.expectVersion] 期望版本
 * @param {string[]} [options.argv]       命令行参数（默认 process.argv）
 */
function runSelfTest(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const startedAt = new Date().toISOString();
  const warnings = [];

  const userDataDir = path.resolve(
    options.userDataDir || pickValue(argv, USER_DATA_FLAG, 'CODENODE_USER_DATA_DIR') || path.join(REPO_ROOT, '.codenode-selftest', 'userData'),
  );
  const projectRoot = path.resolve(
    options.projectRoot || pickValue(argv, PROJECT_FLAG, 'CODENODE_SELFTEST_PROJECT') || REPO_ROOT,
  );
  const marker = String(
    options.marker
      || flagValue(argv, MARKER_FLAG)
      || process.env.CODENODE_SELFTEST_MARKER
      || 'selftest-default',
  );
  const seed = options.seed != null ? !!options.seed : hasFlag(argv, SEED_FLAG);
  const expectVersion = options.expectVersion
    || flagValue(argv, EXPECT_VERSION_FLAG)
    || process.env.CODENODE_SELFTEST_EXPECT_VERSION
    || null;

  const dirs = { userDataDir, projectRoot };
  const result = {
    ok: false,
    kind: 'codenode-selftest',
    mode: seed ? 'seed+verify' : 'verify',
    version: pkg.version,
    productName: pkg.build && pkg.build.productName ? pkg.build.productName : pkg.name,
    appId: pkg.build ? pkg.build.appId || null : null,
    commit: gitCommit(REPO_ROOT),
    startedAt,
    finishedAt: null,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || null,
    node: process.versions.node,
    appPath: REPO_ROOT,
    userDataDir,
    projectRoot,
    marker,
    markerProvided: !!(options.marker || flagValue(argv, MARKER_FLAG) || process.env.CODENODE_SELFTEST_MARKER),
    expectVersion: expectVersion || null,
    seed: null,
    data: null,
    config: null,
    checks: {},
    warnings,
  };

  try {
    if (!exists(projectRoot)) throw new Error('项目根目录不存在：' + projectRoot);
    if (!exists(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    if (seed) {
      result.seed = seedData(dirs, marker);
    }

    result.data = collectData(dirs, marker);
    result.config = summarizeConfig(projectRoot);

    // ---- 判定 ----
    const checks = result.checks;
    checks.projectRootExists = exists(projectRoot);
    checks.userDataDirWritable = true;
    checks.modelsConfigReadable = result.data.modelsConfig.exists;
    checks.markerIntact = result.data.markerHits.modelsFile
      && result.data.markerHits.runRecord
      && result.data.markerHits.memory
      && result.data.markerHits.projectFile;
    checks.versionMatch = expectVersion ? pkg.version === expectVersion : true;

    if (!checks.modelsConfigReadable) warnings.push('未找到 models.json（首次运行时应用会自动初始化，或本次为纯 verify 模式）');
    if (result.markerProvided && !checks.markerIntact) warnings.push('种子标记在部分数据中丢失，升级/回滚可能损坏用户数据');
    if (expectVersion && !checks.versionMatch) warnings.push('程序版本与期望不一致：实际 ' + pkg.version + '，期望 ' + expectVersion);

    result.ok = checks.projectRootExists
      && checks.versionMatch
      && (result.markerProvided ? checks.markerIntact : true);
  } catch (error) {
    result.error = String((error && error.stack) || error);
    result.ok = false;
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * 把自检结果打到 stdout（带定界标记），可选同时落盘到文件，返回退出码。
 * 主进程只调用这一个函数，保持 `--codenode-selftest` 分支最小化。
 */
function emitResult(result, argv = process.argv) {
  const text = JSON.stringify(result, null, 2);
  const block = STDOUT_BEGIN + '\n' + text + '\n' + STDOUT_END + '\n';
  try {
    // 用 fd 1 同步写，避免 app.exit() 立即退出导致管道内容被截断
    fs.writeSync(1, block);
  } catch {
    try {
      process.stdout.write(block);
    } catch { /* 无 stdout（GUI 附加控制台缺失）时忽略 */ }
  }
  const out = flagValue(argv, OUT_FLAG) || process.env.CODENODE_SELFTEST_OUT;
  if (out) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), text + '\n', 'utf8');
    } catch { /* 落盘失败不影响退出码 */ }
  }
  return result && result.ok ? 0 : 1;
}

module.exports = {
  runSelfTest,
  emitResult,
  seedData,
  collectData,
  hasFlag,
  flagValue,
  SELFTEST_FLAG,
  SEED_FLAG,
  USER_DATA_FLAG,
  PROJECT_FLAG,
  MARKER_FLAG,
  EXPECT_VERSION_FLAG,
  MARKER_MODEL_ID,
  MARKER_MEMORY_ID,
  MARKER_PROJECT_FILE,
};
