/**
 * sideEffects.cjs —— 副作用幂等账本
 *
 * 解决审阅缺口：「对崩溃时结果未知的写操作，必须人工确认或通过幂等查询核对，不盲目重放」。
 *
 * 机制：
 *   1. 每个工具按副作用类别分类：read（可安全重放）/ write（幂等键去重）/ unknown（外部不可知副作用，如 shell）；
 *   2. write 类工具在「执行前」登记意图（intent），「执行后」提交（commit）。崩溃在两者之间 →
 *      该步骤状态为 uncommitted，续跑时不能凭猜测重放；
 *   3. 幂等键 = sha256(幂等作用域 + 工具名 + 规范化参数)。续跑时幂等作用域沿用「原 Run 的 runId」，
 *      因此原 Run 已提交过的写操作会被识别为「已完成」，直接跳过并返回历史结果，不会产生第二次副作用；
 *   4. 账本用 atomicFile 落盘（先 fsync 再替换），崩溃不会留下半截文件；
 *   5. unknown 类副作用永远不会被自动跳过或自动重放 —— 只会进入 needs_review。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile } = require('./atomicFile.cjs');
const { redact } = require('./redaction.cjs');

/** 只读工具：可安全重复执行（结果相同，不产生副作用） */
const READ_TOOLS = new Set([
  'read_file', 'list_directory', 'find_files', 'search_files', 'scan_project', 'analyze_project',
  'get_workbench_model', 'query_scalars', 'project_info', 'code_review', 'retrieve_context',
  'read_project', 'read_run', 'poll_job', 'ask_user', 'user_memory_read',
]);

/** 写工具：本地状态变更，幂等键可去重（含 create_nodes / workbench_connect 这两个遗留未接入的名字，见 descriptor.cjs 同处注释） */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'bulk_edit', 'write_analysis_md', 'create_nodes', 'workbench_edit',
  'workbench_connect', 'save_project', 'memory_save', 'user_memory_save', 'apply_patch', 'rename_file',
]);

/** 外部副作用（不可完全观测）：永不自动重放，只做人工核对 */
const UNKNOWN_TOOLS = new Set([
  'execute_shell', 'run_project', 'delegate_subagent', 'subagent', 'ui_control', 'run_workflow',
]);

function classify(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return 'unknown';
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (UNKNOWN_TOOLS.has(name)) return 'unknown';
  // 未登记的工具按最保守处理：未知副作用
  return 'unknown';
}

function digest(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value == null ? {} : value);
  } catch {
    text = String(value);
  }
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
}

/**
 * 规范化序列化：对象键排序后再 JSON 化，使「语义相同、键序不同」的参数得到同一个字符串。
 * 口径必须与 agent.cjs 的 canonicalArgs（缓存键）一致：两处不一致会出现
 * 「缓存判定为重复、幂等账本判定为新操作」，续跑时重复执行同一写操作（重复副作用）。
 * @param {any} args
 * @returns {string}
 */
function canonicalArgsText(args) {
  if (typeof args === 'string') {
    try {
      return canonicalArgsText(JSON.parse(args));
    } catch {
      return args.trim();
    }
  }
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = sort(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  try {
    return JSON.stringify(sort(args == null ? {} : args));
  } catch {
    return String(args);
  }
}

function idempotencyKey(scopeRunId, toolName, args) {
  return digest(String(scopeRunId || '') + '\u0000' + String(toolName || '') + '\u0000' + canonicalArgsText(args));
}

/**
 * 目标文件的**状态指纹**：`f:<mtime 毫秒>:<size>`，不存在则 `absent`。
 * 用 mtime+size 而不是内容哈希：一次 `stat` 就够，且足以发现「两次调用之间目标被改过」——
 * 正是这种「参数没变、前置状态变了」让幂等去重变成**虚假成功**。
 * @param {any} projectRoot
 * @param {string} relPath
 * @returns {string}
 */
function fileStateDigest(projectRoot, relPath) {
  try {
    const stat = fs.statSync(path.resolve(projectRoot || '.', String(relPath)));
    return 'f:' + Math.floor(stat.mtimeMs) + ':' + stat.size;
  } catch {
    return 'absent';
  }
}

function ledgerPath(projectRoot, scopeRunId) {
  const safe = String(scopeRunId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.side-effects.json');
}

/** 前像正文的上限（超过就只记哈希，标记不可回滚 —— 宁可如实说「撤不了」，也不留半个文件） */
const BEFORE_IMAGE_CAP = 262144;

/** 前像 blob 目录（内容寻址：同一份内容只存一次，账本本体因此不会膨胀） */
function beforeImageDir(projectRoot, scopeRunId) {
  const safe = String(scopeRunId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.before-images');
}

/**
 * 抓写操作执行**之前**的文件状态（Run 级回滚的依据）。
 *
 * 语义（判据见 scripts/run-rollback-test.cjs）：
 *   - 文件当时不存在 → `{ existed:false, restorable:true, delete:true }`（回滚 = 删掉它）；
 *   - 存在且 ≤ 256KB → 正文内容寻址存 blob，`{ existed:true, restorable:true, sha256, blob }`；
 *   - 存在但过大/不可读/不是普通文件 → `restorable:false` + 原因（**不假装能回滚**）。
 * @param {any} projectRoot
 * @param {string} scopeRunId
 * @param {string} relPath
 * @returns {any}
 */
function captureBeforeImage(projectRoot, scopeRunId, relPath) {
  const target = path.resolve(projectRoot || '.', String(relPath));
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { path: relPath, existed: true, restorable: false, reason: 'not-a-file' };
    if (stat.size > BEFORE_IMAGE_CAP) {
      return { path: relPath, existed: true, restorable: false, reason: 'too-large', bytes: stat.size };
    }
    const content = fs.readFileSync(target, 'utf8');
    const sha256 = digest(content);
    const dir = beforeImageDir(projectRoot, scopeRunId);
    fs.mkdirSync(dir, { recursive: true });
    const blob = path.join(dir, sha256 + '.txt');
    if (!fs.existsSync(blob)) {
      const tmp = blob + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, blob);
    }
    return { path: relPath, existed: true, restorable: true, bytes: Buffer.byteLength(content), sha256, blob: sha256 + '.txt' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: relPath, existed: false, restorable: true };
    return {
      path: relPath,
      existed: true,
      restorable: false,
      reason: 'unreadable:' + String((error && error.code) || (error && error.message) || 'unknown'),
    };
  }
}

/**
 * 行为者标签（S9）：`supervisor`（主代理）或 `task-xxx(role)`（子代理）。
 * 只做归因展示，**不参与幂等键** —— 幂等域仍然是 run，续跑的「已提交就跳过」语义必须保持。
 * 之前父子代理与多个子代理共用同一命名空间却没有任何归因，去重时会互相背锅（文案还说成
 * 「上一次中断前已提交」，与实际不符）。
 * @param {{taskId?: string, role?: string}} [actor]
 * @returns {string}
 */
function actorLabel(actor) {
  const a = actor || {};
  const taskId = String(a.taskId || '').trim();
  const role = String(a.role || '').trim();
  if (!taskId) return role && role !== 'supervisor' ? '(role:' + role + ')' : 'supervisor';
  return taskId + (role ? '(' + role + ')' : '');
}

class SideEffectLedger {
  /**
   * @param {object} options { projectRoot, scopeRunId, file, clock }
   *   scopeRunId：幂等作用域。续跑时务必传「原 Run 的 runId」，否则去重失效（会重复产生副作用）。
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || null;
    this.scopeRunId = String(options.scopeRunId || 'unscoped');
    this.file = options.file || (this.projectRoot ? ledgerPath(this.projectRoot, this.scopeRunId) : null);
    /** @type {Map<string, any>} 按**路径**存的写前像（Run 级回滚用；见 begin/captureBeforeImage） */
    this.beforeImages = new Map();
    this.clock = options.clock || (() => new Date().toISOString());
    this.records = new Map(); // idemKey -> record
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const record of parsed.records || []) this.records.set(record.idemKey, record);
      // 前像是**按路径**存的（不是按记录）：同一路径被写多次时，回滚要回到「Run 开始前」那一份，
      // 而记录是按 (工具,参数) 分键的 —— 存进记录里会被后续不同参数的写各存一份、互相覆盖。
      for (const [relPath, image] of Object.entries(parsed.beforeImages || {})) {
        this.beforeImages.set(relPath, image);
      }
    } catch {
      // 账本损坏：保留文件内容供人工排查，从空账本开始（宁可少去重，也不能伪造去重）
      this.loadError = '账本解析失败，已忽略旧内容';
    }
  }

  /**
   * 落盘。`effect` 为 `'read'` 时**直接跳过**（见下）。
   *
   * 为什么需要（#13）：`begin()`/`commit()`/`fail()` 对**每个**工具调用都会调这里，而它每次都把
   * 整本账本 JSON 化 + `fsync` + rename —— 单次 Run 累计 n 次全量重写，写出的字节数约 **O(n²)**，
   * 且全在 Electron 主进程的**同步**路径上（100 次调用就是数百毫秒到秒级的可感知卡顿，
   * UI 与所有并发 run 一起被挡住）。
   * 只读工具既不产生副作用、也不参与续跑去重（`begin` 的跳过分支要求 `effect === 'write'`），
   * 它们的记录**没有崩溃恢复价值**：留在内存里供 review()/planResume 视图使用即可，
   * 不必为此付一次 fsync。写与「结果未知」的副作用照旧同步落盘（那才是崩溃恢复要用的）。
   * @param {'read'|'write'|'unknown'|undefined} effect
   */
  _persist(effect) {
    if (!this.file) return;
    if (effect === 'read') return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const records = [...this.records.values()];
      const beforeImages = Object.fromEntries(this.beforeImages);
      atomicWriteFile(this.file, JSON.stringify({ scopeRunId: this.scopeRunId, updatedAt: this.clock(), records, beforeImages }, null, 2));
      // S8：账本变化也投递一条事件 —— 只报事实（条数 + 最新一条的相位），不搬整份账本进事件流
      const latest = records.length ? records[records.length - 1] : null;
      if (this.projectRoot) {
        require('./eventBus.cjs').bridge(this.projectRoot, 'side_effect', {
          runId: this.scopeRunId,
          records: records.length,
          latest: latest ? { tool: latest.tool || null, phase: latest.phase || latest.status || null } : null,
        });
      }
    } catch (error) {
      this.persistError = String((error && error.message) || error);
    }
  }

  committedKey(scopeRunId, toolName, args) {
    return this.records.has(idempotencyKey(scopeRunId || this.scopeRunId, toolName, args))
      ? idempotencyKey(scopeRunId || this.scopeRunId, toolName, args)
      : null;
  }

  /**
   * 执行前登记意图；若同一幂等键已提交，返回 skip（续跑时不重复副作用）。
   * @param {string} toolName
   * @param {any} args
   * @param {{taskId?: string, role?: string}} [actor] 行为者（S9）：主代理或子代理任务。
   *   只影响归因记录与文案，幂等作用域不变。
   */
  begin(toolName, args, actor, options = {}) {
    const effect = classify(toolName);
    const key = idempotencyKey(this.scopeRunId, toolName, args);
    const existing = this.records.get(key);
    const who = actorLabel(actor);
    // 目标文件的**当前**状态指纹（只有带 path 的写操作才有）。
    // 幂等键刻意**不含**它（改动键会让已落盘的账本对不上，续跑去重直接失效）；
    // 它只用来回答一个问题：「现在跳过，还与当初提交时的世界一致吗？」
    const statePath = args && typeof args.path === 'string' && args.path ? String(args.path) : '';
    const currentDigest = statePath ? fileStateDigest(this.projectRoot, statePath) : '';
    if (existing && existing.phase === 'committed' && effect === 'write') {
      // 目标不可核对（参数里没有 path）而工具又声明「重复执行安全」→ 宁可真的再做一次。
      // save_project 正是这一类：参数为空（键恒同），但画布/文件早就变了，
      // 跳过它只会让用户看到「已保存」而磁盘停在旧版本。
      const cannotVerify = !statePath && options.idempotent === true;
      // 提交后记下的状态与现在不一致 → 期间被别人改过 → 跳过不安全（会覆盖/丢失那次改动）。
      const targetChanged = !!statePath && !!existing.postStateDigest && currentDigest !== existing.postStateDigest;
      if (!cannotVerify && !targetChanged) {
        // 保持 committed 语义不变（只累计意图次数）：一旦降级回 pending，review()/planResume
        // 就看不到「这条写已完成」，续跑只能整轮人工复核。去重路径不会再调用 commit()，
        // 所以这里必须自己保住状态。
        existing.intents = (existing.intents || 0) + 1;
        existing.lastIntentAt = this.clock();
        existing.lastActor = who;
        this.records.set(key, existing);
        this._persist(effect);
        const prior = existing.actor || 'unknown';
        return {
          skip: true,
          effect,
          idemKey: key,
          actor: who,
          prior,
          priorRecord: existing,
          reason:
            '该写操作在本次运行中已提交（幂等去重）—— 提交者 ' + prior + '，本次不再重复执行（请求方：' + who + '）',
        };
      }
    }
    const record = existing || { idemKey: key, tool: String(toolName), effect, argsDigest: digest(args), phase: 'pending', intents: 0 };
    if (statePath) record.statePath = statePath;
    record.phase = 'pending';
    record.intents = (record.intents || 0) + 1;
    record.lastIntentAt = this.clock();
    if (!record.firstIntentAt) record.firstIntentAt = record.lastIntentAt;
    // Run 级回滚的依据：写操作**第一次触碰该路径之前**抓一次前像，按**路径**保存 ——
    // 回滚要回到「本次 Run 开始前」，而不是「上一次写之前」。判据见 scripts/run-rollback-test.cjs。
    if (effect === 'write' && statePath && !this.beforeImages.has(statePath)) {
      this.beforeImages.set(statePath, captureBeforeImage(this.projectRoot, this.scopeRunId, statePath));
    }
    record.actor = record.actor || who;
    record.lastActor = who;
    if (!Array.isArray(record.actors)) record.actors = [];
    if (!record.actors.includes(who) && record.actors.length < 5) record.actors.push(who);
    this.records.set(key, record);
    this._persist(effect);
    return { skip: false, effect, idemKey: key, tool: String(toolName), actor: who, record };
  }

  commit(token, info = {}) {
    if (!token || !token.idemKey) return null;
    const record = this.records.get(token.idemKey) || { idemKey: token.idemKey, tool: token.tool, effect: token.effect };
    record.phase = 'committed';
    record.committedAt = this.clock();
    record.ok = info.ok !== false;
    record.digest = digest(info.resultDigest != null ? info.resultDigest : info.result || '');
    if (token.actor) record.committedBy = token.actor;
    if (info.reversible === true) record.reversible = true;
    // 记下「这次写**之后**目标长什么样」：续跑时拿它与当前状态比对，一致才敢跳过。
    // 必须取提交后的状态（写操作本身就会改变提交前的状态，拿前者比对必然不等）。
    if (record.statePath) record.postStateDigest = fileStateDigest(this.projectRoot, record.statePath);
    this.records.set(token.idemKey, record);
    this._persist(record.effect);
    return record;
  }

  fail(token, error) {
    if (!token || !token.idemKey) return null;
    const record = this.records.get(token.idemKey) || { idemKey: token.idemKey, tool: token.tool, effect: token.effect };
    record.phase = 'failed';
    record.failedAt = this.clock();
    if (token.actor) record.failedBy = token.actor;
    // 脱敏（#15）：错误原文可能带凭据（命令回显 token、URL 里带 key 等）。
    // `.codenode/runs/<run>.side-effects.json` 是要长期留存的，而 runStore 那条路径已经脱敏 ——
    // 这里漏掉就会让「日志已统一脱敏」的判断失真。统计字段（时长/退出码）不受影响。
    record.error = redact(String((error && error.message) || error || '')).slice(0, 500);
    this.records.set(token.idemKey, record);
    this._persist(record.effect);
    return record;
  }

  /** 续跑时的核对视图：哪些副作用已提交 / 哪些做了但结果未知（含行为者归因）。 */
  review() {
    const committed = [];
    const pending = [];
    const unknown = [];
    for (const record of this.records.values()) {
      const item = {
        tool: record.tool,
        effect: record.effect,
        idemKey: record.idemKey,
        phase: record.phase,
        at: record.committedAt || record.lastIntentAt || null,
        actor: record.actor || null,
        lastActor: record.lastActor || null,
      };
      // 先按 effect 分类：unknown（外部副作用，结果不可知）**永远**不算「已提交的写」。
      // 否则 planResume 会把它塞进 skippable（文案写「续跑时跳过」），而执行期 begin() 的去重
      // 只对 effect==='write' 生效 —— 结果就是「文案说跳过了、实际又跑了一遍」，
      // 对 git push / npm publish 这类不可逆外部副作用就是重复执行。
      // 注意：unknown 项仍带 phase 字段，消费者可区分「已提交的 unknown」与「未提交的 unknown」。
      if (record.effect === 'unknown') unknown.push(item);
      else if (record.phase === 'committed') committed.push(item);
      else pending.push(item);
    }
    return { committed, pending, unknown };
  }

  /**
   * 供「Run 级回滚」使用：列出本次 Run 里**带 path 的写操作**及其前像，按**首次意图时间**排序。
   * 只读记录（effect!=='write'）与没有 path 的写（如 save_project）不参与回滚。
   * @returns {Array<any>}
   */
  recordsForRollback() {
    const out = [];
    for (const record of this.records.values()) {
      if (record.effect !== 'write' || !record.statePath) continue;
      out.push({
        path: record.statePath,
        tool: record.tool,
        phase: record.phase,
        actor: record.actor || null,
        firstIntentAt: record.firstIntentAt || record.lastIntentAt || record.committedAt || null,
        postStateDigest: record.postStateDigest || null,
        // 前像按路径取（同一路径的多次写共用**最早**那一份）
        beforeImage: this.beforeImages.get(record.statePath) || null,
      });
    }
    return out.sort((a, b) => String(a.firstIntentAt || '').localeCompare(String(b.firstIntentAt || '')));
  }

  size() {
    return this.records.size;
  }
}

/** 供 AgentToolContext.sideEffectGuard 使用的守卫对象 */
function createGuard(ledger) {
  return {
    begin: (toolName, args, actor, options) => ledger.begin(toolName, args, actor, options),
    commit: (token, info) => ledger.commit(token, info),
    fail: (token, error) => ledger.fail(token, error),
    ledger,
  };
}

module.exports = {
  SideEffectLedger,
  createGuard,
  classify,
  digest,
  idempotencyKey,
  canonicalArgsText,
  fileStateDigest,
  ledgerPath,
  captureBeforeImage,
  beforeImageDir,
  BEFORE_IMAGE_CAP,
  READ_TOOLS,
  WRITE_TOOLS,
  UNKNOWN_TOOLS,
};
