/**
 * subagentEnvelope.cjs —— 子代理结果的**单一 JSON 信封**（多 Agent 信息完整性 P1/P2）
 *
 * 为什么要有它（问题拆解见 docs/multi-agent-info-integrity-2026-09-17.md）：
 *   原来的 `[子代理结果] taskId=… role=… status=…` 是「**带字段头的自由文本**」——
 *   严格说字段没有 schema、没有「基于哪个世界状态」、没有产物哈希、截断也不自报。
 *   主代理只能「读文本 + 猜」，这就是文档里的
 *     · A 格式/语义漂移（没有契约）
 *     · B 有损传输（截断了不标注，接收方把残文当完整证据）
 *     · C 版本错位（结论没说基于哪一版画布/文件）
 *     · E 信任放大（"已完成"这类自述没有可核验产物）
 *
 * 本模块把结果收敛成**一个**信封（机器可校验 + 人可读），并给出**硬规则**：
 *   · 缺 `snapshot.hash` / 缺必填字段 / `trust` 非法 → **拒收**（调用方返回 error 结果，
 *     而不是把一个不可采信的东西当结论递给主代理）；
 *   · 截断必须自报 `lossy`（含丢了几个字符、完整原文去哪儿取）；
 *   · `trust` **不自动给 verified** —— 独立复跑产物才能升到 verified（本模块只给 derived/untrusted）。
 *
 * 纯函数 + 文件哈希，无副作用，便于离线用例与变异校验。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 信封版本：字段含义变化时递增（接收方按版本决定怎么读） */
const ENVELOPE_VERSION = 1;
/** kind 取值 */
const KINDS = ['result', 'error'];
/** trust 取值：verified 只能由**独立复跑产物**的核验方给出，本模块不自动升 */
const TRUST_LEVELS = ['verified', 'derived', 'untrusted'];
/** 必填字段（校验按路径逐一检查，缺一项即违约） */
const REQUIRED_PATHS = [
  'v',
  'msgId',
  'from.runId',
  'from.taskId',
  'from.role',
  'to.taskId',
  'snapshot.hash',
  'kind',
  'payload',
  'trust',
  'lossy.isLossy',
];
const MAX_EVIDENCE_FILES = 24;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_COMMANDS = 20;
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bulk_edit', 'write_analysis_md']);
const SHELL_TOOLS = new Set(['execute_shell']);

/** 键排序的稳定序列化：同一份内容永远得到同一个哈希（比较哈希才有意义） */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function sha256Of(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 画布/文档 → 内容哈希（null/undefined 不算「有个快照」） */
function hashDocument(doc) {
  if (doc === null || doc === undefined) return null;
  try {
    return sha256Of(stableStringify(doc));
  } catch {
    return null;
  }
}

/**
 * 结果产出时刻的**世界状态快照**。
 * - `hash`：画布文档（`model.doc`）的键排序 SHA-256 —— 主代理拿当前画布再算一次即可判断
 *   「子代理报告之后世界有没有又变过」（版本错位检测）。
 * - `revision`：模型若暴露单调版本号则带上（当前 GraphModel 没有该计数器 → null，
 *   **不用「节点数」之类冒充版本号**；缺 revision 不构成拒收，缺 hash 才拒收）。
 */
function buildSnapshot(model) {
  const doc = model && model.doc ? model.doc : null;
  const revision = model && Number.isFinite(model.revision) ? Number(model.revision) : null;
  return { source: doc ? 'canvas' : 'none', hash: hashDocument(doc), revision };
}

/** 解析产物文件路径（相对路径按工程根解析；只认工程内的文件，避免把系统文件当产物） */
function resolveArtifactPath(projectRoot, p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot || process.cwd(), raw);
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 工程外：不作为交付证据
  }
  return abs;
}

/**
 * 收集可核验产物：**改过的文件的真实哈希** + 执行过的命令及其成败。
 * @param {{toolCalls?: Array<any>, projectRoot?: string}} [input]
 * 只给「我们真的能看到的东西」——看不到就如实 `exists:false`，不编造哈希。
 */
function collectEvidence(input = {}) {
  const { toolCalls, projectRoot } = input;
  const warnings = [];
  const files = [];
  const commands = [];
  const seenFile = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call) continue;
    let args = null;
    try {
      args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args;
    } catch {
      args = null;
    }
    if (WRITE_TOOLS.has(call.name)) {
      // 写失败 = 没写成，不进产物清单
      if (call.ok === false) continue;
      const abs = resolveArtifactPath(projectRoot, args && (args.path || args.filePath || args.file || args.target));
      if (!abs || seenFile.has(abs)) continue;
      seenFile.add(abs);
      if (files.length >= MAX_EVIDENCE_FILES) {
        warnings.push('产物文件超过 ' + MAX_EVIDENCE_FILES + ' 个，其余未纳入 evidence.files');
        continue;
      }
      const rel = projectRoot ? path.relative(path.resolve(projectRoot), abs).split(path.sep).join('/') : abs;
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) {
        // 声称改了、但文件不存在：这是**重要信号**，如实记录（不能当交付证据）
        files.push({ path: rel, exists: false, bytes: 0, sha256: null });
        warnings.push('声称变更的文件不存在：' + rel);
        continue;
      }
      if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
        files.push({ path: rel, exists: true, bytes: stat.size, sha256: null });
        warnings.push('文件超过 ' + MAX_EVIDENCE_FILE_BYTES + ' 字节，未计算哈希：' + rel);
        continue;
      }
      let hash = null;
      try {
        hash = sha256Of(fs.readFileSync(abs, 'utf8'));
      } catch {
        hash = null;
      }
      files.push({ path: rel, exists: true, bytes: stat.size, sha256: hash });
      continue;
    }
    if (SHELL_TOOLS.has(call.name) && commands.length < MAX_EVIDENCE_COMMANDS) {
      const cmd = args && (args.command || args.cmd);
      if (cmd) commands.push({ cmd: String(cmd).slice(0, 400), ok: call.ok !== false });
    }
  }
  return { files, commands, warnings };
}

/**
 * 组装信封。
 * @param {{task?: any, projectRoot?: string, model?: any, inReplyTo?: string|null, view?: any,
 *          summary?: string, error?: string, changedFiles?: string[], clipped?: {droppedChars: number}}} input
 */
function buildEnvelope(input = {}) {
  const { task, projectRoot, model, inReplyTo = null, view = {}, changedFiles = [], clipped = null } = input;
  // summary/error 未显式给出时取 task 上的值（调用方只传 task 也能拿到完整契约）
  const summary = input.summary === undefined ? String((task && task.summary) || '') : String(input.summary || '');
  const error = input.error === undefined ? String((task && task.error) || '') : String(input.error || '');
  const evidence = collectEvidence({ toolCalls: task && task.toolCalls, projectRoot });
  const status = (task && task.status) || 'error';
  const kind = status === 'done' ? 'result' : 'error';
  const bodyChars = String(summary || '').length;
  const refs = (Array.isArray(changedFiles) ? changedFiles : []).map((p) => ({ kind: 'changed_file', path: String(p) }));
  // 可选字段**空则省**（缺省即空，不写 null/[] 占体积）：必填字段见 REQUIRED_PATHS，永远在。
  // 目的是让信封进主上下文时不至于比原来的字段头文本胖太多 —— 又保留全部可校验信息。
  const envelope = {
    v: ENVELOPE_VERSION,
    msgId: 'm_' + ((task && task.taskId) || 'unknown'),
    from: {
      runId: (task && task.runId) || '',
      taskId: (task && task.taskId) || '',
      role: (task && task.role) || '',
    },
    to: { taskId: 'supervisor', role: 'supervisor' },
    // 起止时刻：合并（P5）判定「谁覆盖谁」只能靠它 —— **绝不能靠报告到达顺序**。
    // 空则省（老的信封/手工构造的信封没有它，合并会如实按「无法判定先后」处理）。
    ...((task && (task.startedAt || task.finishedAt))
      ? { at: { ...(task.startedAt ? { startedAt: task.startedAt } : {}), ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}) } }
      : {}),
    ...(inReplyTo ? { inReplyTo: String(inReplyTo) } : {}),
    snapshot: buildSnapshot(model),
    kind,
    payload: {
      objective: (task && task.objective) || '',
      status,
      summary: String(summary || ''),
      ...(kind === 'error' ? { error: String(error || (task && task.error) || '') } : {}),
      // 验收是否达成**不自动判定**（会变成编造）：交给主代理按 acceptanceCriteria 自行核对
      acceptanceJudgement: 'manual',
      toolCallCount: Array.isArray(task && task.toolCalls) ? task.toolCalls.length : 0,
      summaryChars: bodyChars,
      /**
       * #5：主循环的收尾原因必须进信封 —— 接收方据此判断「这份结果是完整结论还是半截」。
       * `stopReason='length_truncated'` 时 status 已不是 done（信封 kind='error'），
       * 但把原因本身带出来，主代理才能给出「缩小范围/分段委派」这类可执行处置，而不是只看到一句失败。
       */
      ...((task && task.stopReason) ? { stopReason: String(task.stopReason) } : {}),
      ...((task && task.finishReason) ? { finishReason: String(task.finishReason) } : {}),
      ...((task && task.stageNodeId) ? { stageNodeId: task.stageNodeId } : {}),
      ...((task && task.stageWarning) ? { stageWarning: task.stageWarning } : {}),
      ...((task && task.totalTimeoutMs) ? { totalTimeoutMs: task.totalTimeoutMs } : {}),
      ...((task && task.grounding) ? { grounding: task.grounding } : {}),
    },
    ...(refs.length ? { refs } : {}),
    evidence: {
      files: evidence.files,
      ...(evidence.commands.length ? { commands: evidence.commands } : {}),
      ...(evidence.warnings.length ? { warnings: evidence.warnings } : {}),
    },
    // 不给 verified：只有独立复跑产物的核验方能升到 verified
    trust: kind === 'result' ? 'derived' : 'untrusted',
    // 有损必须自报：截断点、丢了多少、完整原文去哪儿取
    lossy:
      clipped && clipped.droppedChars > 0
        ? {
            isLossy: true,
            droppedChars: Number(clipped.droppedChars) || 0,
            reason: 'summary-clipped',
            originalRef: 'get_subagent_task(taskId=' + ((task && task.taskId) || '') + ')',
          }
        : { isLossy: false },
  };
  const violations = validateEnvelope(envelope);
  if (violations.length) {
    // 违约的结果一律不得作为结论证据
    envelope.trust = 'untrusted';
    envelope.lossy = { ...envelope.lossy, contractViolations: violations.map((v) => v.path + ': ' + v.message) };
  }
  return { envelope, violations, view };
}

/** 按 REQUIRED_PATHS 校验；同时校验取值域与「产物是否存在」。返回违约项数组（空 = 合规）。 */
function validateEnvelope(envelope) {
  const violations = [];
  const env = envelope || {};
  const GET = (p) => p.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), env);
  for (const p of REQUIRED_PATHS) {
    const value = GET(p);
    if (value === null || value === undefined || value === '') violations.push({ path: p, message: '缺失或为空' });
  }
  if (env.v !== ENVELOPE_VERSION && !violations.some((v) => v.path === 'v')) {
    violations.push({ path: 'v', message: '版本不支持：' + env.v });
  }
  if (env.kind && !KINDS.includes(env.kind)) violations.push({ path: 'kind', message: '非法取值：' + env.kind });
  if (env.trust && !TRUST_LEVELS.includes(env.trust)) violations.push({ path: 'trust', message: '非法取值：' + env.trust });
  if (env.snapshot && env.snapshot.hash && !/^sha256:[0-9a-f]{64}$/.test(String(env.snapshot.hash))) {
    violations.push({ path: 'snapshot.hash', message: '不是 sha256:… 形式' });
  }
  const kindResult = env.kind === 'result';
  if (kindResult && !String((env.payload && env.payload.summary) || '').trim()) {
    violations.push({ path: 'payload.summary', message: 'result 却没有结论文本' });
  }
  if (env.kind === 'error' && !String((env.payload && env.payload.error) || '').trim()) {
    violations.push({ path: 'payload.error', message: 'error 却没有原因' });
  }
  return violations;
}

/**
 * **接收侧核验**（P2 尾 + P4 的地基）：把信封里的「声称」跟**当前**世界对一次账。
 *
 * 为什么必须在接收侧做：信封里的 `evidence.files[].sha256` 与 `snapshot.hash` 都是**报告那一刻**
 * 测出来的。报告之后文件可能被改、画布可能被改 —— 只看信封是看不出来的，必须重算再比。
 *
 * - 逐条重算产物哈希（路径按工程根解析）→ 不符即「产物已变」
 * - 重算当前画布哈希 → 与 `snapshot.hash` 不一致即「报告之后世界又变过」
 *
 * 判定分三档（不是只有对/错）：
 *   `valid`   产物与画布都与报告时一致 → 结论仍然可信
 *   `stale`   只有画布变了 → 结论**可能过期**，要基于最新状态重新核对（不当作造假）
 *   `invalid` 有产物对不上（被改 / 该在的不在 / 声称不存在却存在）→ **不得作为结论证据**
 *
 * @param {any} envelope
 * @param {{projectRoot?: string, model?: any}} [world]
 * @returns {{verdict: 'valid'|'stale'|'invalid', checkedAt: number, files: Array<any>, snapshot: any, reasons: string[]}}
 */
function verifyEnvelope(envelope, world = {}) {
  const { projectRoot, model } = world;
  const reasons = [];
  const files = [];
  const declaredFiles = (envelope && envelope.evidence && envelope.evidence.files) || [];
  for (const entry of declaredFiles) {
    const rel = entry && entry.path ? String(entry.path) : '';
    if (!rel) continue;
    const declared = entry.sha256 || null;
    const abs = resolveArtifactPath(projectRoot, rel);
    let exists = false;
    let bytes = 0;
    let actual = null;
    if (abs) {
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          exists = true;
          bytes = stat.size;
          if (stat.size <= MAX_EVIDENCE_FILE_BYTES) actual = sha256Of(fs.readFileSync(abs, 'utf8'));
        }
      } catch {
        exists = false;
      }
    }
    // 有哈希就比哈希；没有哈希（超大文件/不存在）就比存在性，别用「都算过」放过去
    const ok = declared ? actual === declared : exists === (entry.exists === true);
    files.push({ path: rel, declared, actual, exists, bytes, ok });
    if (!ok) {
      reasons.push(
        declared
          ? '产物内容与报告时不一致（报告后可能被改动或被删）：' + rel
          : '报告里声称「不存在」的文件现在存在了：' + rel
      );
    }
  }
  const snapshotNow = buildSnapshot(model);
  const declaredHash = (envelope && envelope.snapshot && envelope.snapshot.hash) || null;
  const snapshot = { declared: declaredHash, actual: snapshotNow.hash, revision: snapshotNow.revision, ok: !declaredHash || declaredHash === snapshotNow.hash };
  if (!snapshot.ok) reasons.push('报告之后画布（世界状态）又变过：结论可能已过期，需按最新状态重新核对');
  const verdict = files.some((f) => !f.ok) ? 'invalid' : snapshot.ok ? 'valid' : 'stale';
  return { verdict, checkedAt: Date.now(), files, snapshot, reasons };
}

/**
 * 给模型看的**单一信封文本**：只有一段引导语 + 一个 JSON 对象。
 * 引导语只做两件事：告诉接收方「这是契约」与「违约了就别采信」，不夹带第二份数据。
 */
function renderEnvelopeText(envelope, violations = []) {
  /**
   * #5：`kind:'error'` 的信封**不是**一份可交付的结论（截断/失败/取消）。
   * 此前无论 kind 都渲染「契约 v1（信封即全部结论）」—— 这句话把半截报告说成了完整交付，
   * 正是「信任放大」。错误信封只声明「这不是结论」并指向失败原因，不给合规引导语。
   */
  const isError = !!(envelope && envelope.kind === 'error');
  const head = violations.length
    ? '[子代理结果] 下列 JSON 信封有 ' + violations.length + ' 项**契约违约** → 本结果不得作为结论证据（不要引用它的结论；可让子代理按契约重做或由你直接完成）。交付仍需要原始内容时用 get_subagent_task(taskId=…)。'
    : isError
      ? '[子代理结果] 契约 v' + ENVELOPE_VERSION + ' 的 kind=error：子代理**未自然完成**（payload.stopReason=' +
        String((envelope.payload && envelope.payload.stopReason) || (envelope.payload && envelope.payload.status) || '未标注') +
        '）→ 这不是结论，**半截内容不得当完整结论使用**；失败原因见 payload.error，处置方式见工具结果末尾。'
      : '[子代理结果] 契约 v' + ENVELOPE_VERSION + '（信封即全部结论）。' +
        '核验方式：get_subagent_task(taskId=…) 会**重算**产物哈希与画布快照并返回 verification（valid/stale/invalid）——' +
        'invalid 的结果不得作为结论证据，stale 说明报告之后世界又变过、需按最新状态核对。';
  // 有损必须**显式**说出来，不能让人以为读到的是全文
  const lossyNote =
    envelope && envelope.lossy && envelope.lossy.isLossy
      ? '（注意：结论文本已截断，少 ' + envelope.lossy.droppedChars + ' 字符；完整原文用 ' + (envelope.lossy.originalRef || 'get_subagent_task') + ' 取）'
      : null;
  const lines = [head, lossyNote, violations.length ? '违约项：' + JSON.stringify(violations) : null, '```json', JSON.stringify(envelope, null, 2), '```'];
  return lines.filter(Boolean).join('\n');
}

module.exports = {
  ENVELOPE_VERSION,
  KINDS,
  TRUST_LEVELS,
  REQUIRED_PATHS,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_FILE_BYTES,
  stableStringify,
  sha256Of,
  hashDocument,
  buildSnapshot,
  collectEvidence,
  buildEnvelope,
  validateEnvelope,
  verifyEnvelope,
  renderEnvelopeText,
};
