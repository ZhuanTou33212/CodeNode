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

/** 只读工具：可安全重复执行（结果相同，不产生副作用） */
const READ_TOOLS = new Set([
  'read_file', 'list_directory', 'find_files', 'search_files', 'scan_project', 'analyze_project',
  'get_workbench_model', 'query_scalars', 'project_info', 'code_review', 'retrieve_context',
  'read_project', 'read_run', 'poll_job', 'ask_user', 'user_memory_read',
]);

/** 写工具：本地状态变更，幂等键可去重 */
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

function ledgerPath(projectRoot, scopeRunId) {
  const safe = String(scopeRunId || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'runs', safe + '.side-effects.json');
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
    this.clock = options.clock || (() => new Date().toISOString());
    this.records = new Map(); // idemKey -> record
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const record of parsed.records || []) this.records.set(record.idemKey, record);
    } catch {
      // 账本损坏：保留文件内容供人工排查，从空账本开始（宁可少去重，也不能伪造去重）
      this.loadError = '账本解析失败，已忽略旧内容';
    }
  }

  _persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const records = [...this.records.values()];
      atomicWriteFile(this.file, JSON.stringify({ scopeRunId: this.scopeRunId, updatedAt: this.clock(), records }, null, 2));
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
  begin(toolName, args, actor) {
    const effect = classify(toolName);
    const key = idempotencyKey(this.scopeRunId, toolName, args);
    const existing = this.records.get(key);
    const who = actorLabel(actor);
    if (existing && existing.phase === 'committed' && effect === 'write') {
      // 保持 committed 语义不变（只累计意图次数）：一旦降级回 pending，review()/planResume
      // 就看不到「这条写已完成」，续跑只能整轮人工复核。去重路径不会再调用 commit()，
      // 所以这里必须自己保住状态。
      existing.intents = (existing.intents || 0) + 1;
      existing.lastIntentAt = this.clock();
      existing.lastActor = who;
      this.records.set(key, existing);
      this._persist();
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
    const record = existing || { idemKey: key, tool: String(toolName), effect, argsDigest: digest(args), phase: 'pending', intents: 0 };
    record.phase = 'pending';
    record.intents = (record.intents || 0) + 1;
    record.lastIntentAt = this.clock();
    record.actor = record.actor || who;
    record.lastActor = who;
    if (!Array.isArray(record.actors)) record.actors = [];
    if (!record.actors.includes(who) && record.actors.length < 5) record.actors.push(who);
    this.records.set(key, record);
    this._persist();
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
    this.records.set(token.idemKey, record);
    this._persist();
    return record;
  }

  fail(token, error) {
    if (!token || !token.idemKey) return null;
    const record = this.records.get(token.idemKey) || { idemKey: token.idemKey, tool: token.tool, effect: token.effect };
    record.phase = 'failed';
    record.failedAt = this.clock();
    if (token.actor) record.failedBy = token.actor;
    record.error = String((error && error.message) || error || '').slice(0, 500);
    this.records.set(token.idemKey, record);
    this._persist();
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
      if (record.phase === 'committed') committed.push(item);
      else if (record.effect === 'unknown') unknown.push(item);
      else pending.push(item);
    }
    return { committed, pending, unknown };
  }

  size() {
    return this.records.size;
  }
}

/** 供 AgentToolContext.sideEffectGuard 使用的守卫对象 */
function createGuard(ledger) {
  return {
    begin: (toolName, args, actor) => ledger.begin(toolName, args, actor),
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
  ledgerPath,
  READ_TOOLS,
  WRITE_TOOLS,
  UNKNOWN_TOOLS,
};
