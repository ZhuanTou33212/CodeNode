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
const MAX_EVIDENCE_SOURCES = 24;
const MAX_EVIDENCE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_EVIDENCE_COMMANDS = 20;
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bulk_edit', 'write_analysis_md']);
const SHELL_TOOLS = new Set(['execute_shell', 'poll_job']);

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

function sha256OfLines(lines, startLine, endLine) {
  if (!Array.isArray(lines)) return null;
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(endLine) || start));
  return sha256Of(lines.slice(start - 1, end).join('\n'));
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
 * 收集可核验产物：改过的文件哈希、live read/search 的文件/行范围哈希，以及执行命令的真实退出码。
 * @param {{toolCalls?: Array<any>, projectRoot?: string}} [input]
 * 只给「我们真的能看到的东西」——看不到就如实 `exists:false`，不编造哈希。
 */
function collectEvidence(input = {}) {
  const { toolCalls, projectRoot } = input;
  const warnings = [];
  const files = [];
  const sources = [];
  const commands = [];
  const seenFile = new Set();
  const sourceByPath = new Map();
  const backgroundCommandIndex = new Map();
  const addSource = (rawPath, meta = {}) => {
    const abs = resolveArtifactPath(projectRoot, rawPath);
    if (!abs) {
      warnings.push('引用来源不在工程内或路径无效，未纳入版本证据：' + String(rawPath || ''));
      return;
    }
    const rel = path.relative(path.resolve(projectRoot || process.cwd()), abs).split(path.sep).join('/');
    let source = sourceByPath.get(rel);
    if (!source) {
      if (sources.length >= MAX_EVIDENCE_SOURCES) {
        warnings.push('引用来源超过 ' + MAX_EVIDENCE_SOURCES + ' 个，其余未纳入 sources');
        return;
      }
      let stat = null;
      try { stat = fs.statSync(abs); } catch {}
      const exists = !!(stat && stat.isFile());
      const bytes = stat && stat.isFile() ? stat.size : 0;
      const hash = /^sha256:[0-9a-f]{64}$/.test(String(meta.sha256 || '')) ? meta.sha256 : null;
      if (exists && bytes > MAX_EVIDENCE_SOURCE_BYTES) {
        warnings.push('引用来源超过 ' + MAX_EVIDENCE_SOURCE_BYTES + ' 字节，只记录存在性/长度，不能自动确认版本：' + rel);
      }
      source = { path: rel, exists, bytes, sha256: hash, versioned: !!hash, wholeFile: false, ranges: [], citations: [] };
      if (exists && bytes > MAX_EVIDENCE_FILE_BYTES) {
        source.wholeFile = true;
        warnings.push('引用文件超过范围哈希阈值，使用整个文件哈希核验：' + rel);
      }
      sources.push(source);
      sourceByPath.set(rel, source);
    } else if (meta.sha256 && source.sha256 && meta.sha256 !== source.sha256) {
      source.observedConflict = true;
      source.versioned = false;
      warnings.push('同一任务读取了不同版本的来源文件，需重新读取并核对：' + rel);
    } else if (meta.sha256 && !source.sha256 && !source.observedConflict) {
      source.sha256 = meta.sha256;
      source.versioned = true;
    }
    const startLine = Number.isInteger(meta.startLine) && meta.startLine > 0 ? meta.startLine : null;
    const endLine = Number.isInteger(meta.endLine) && meta.endLine > 0 ? meta.endLine : null;
    if (meta.wholeFile === true || (!startLine && !endLine)) source.wholeFile = true;
    if (startLine || endLine) {
      const range = {
        startLine,
        endLine,
        sha256: /^sha256:[0-9a-f]{64}$/.test(String(meta.rangeSha256 || '')) ? meta.rangeSha256 : null,
      };
      if (!source.ranges.some((item) => item.startLine === range.startLine && item.endLine === range.endLine)) {
        if (source.ranges.length < 32) source.ranges.push(range);
        else {
          source.wholeFile = true;
          warnings.push('来源行范围超过 32 处，改用整个文件哈希核验：' + rel);
        }
      }
      source.versioned = !source.observedConflict && (!!source.sha256 || (source.ranges.length > 0 && source.ranges.every((item) => !!item.sha256)));
    }
    const citation = String(meta.citation || '');
    if (citation && !source.citations.includes(citation) && source.citations.length < 12) source.citations.push(citation);
  };
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call) continue;
    let args = null;
    try {
      args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : call.args;
    } catch {
      args = null;
    }
    const callData = call.data && typeof call.data === 'object' ? call.data : {};
    if (call.ok !== false && call.name === 'read_file') {
      addSource(callData.matched || callData.path || (args && args.path), {
        startLine: callData.startLine,
        endLine: callData.endLine,
        sha256: callData.sourceSha256,
        rangeSha256: callData.sourceRangeSha256,
        wholeFile: callData.truncated !== true && (Number(callData.offset) || 1) === 1 && (Number(callData.charOffset) || 0) === 0,
      });
    } else if (call.ok !== false && call.name === 'search_files') {
      for (const match of Array.isArray(callData.matches) ? callData.matches : []) {
        const parsed = /^(.*):(\d+): /.exec(String(match || ''));
        if (!parsed) continue;
        const line = Number(parsed[2]);
        const version = callData.sourceVersions && callData.sourceVersions[parsed[1]] || {};
        addSource(parsed[1], { startLine: line, endLine: line, sha256: version.sha256,
          rangeSha256: version.ranges && version.ranges[line], citation: parsed[1] + '#L' + line + '-L' + line });
      }
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
    if (SHELL_TOOLS.has(call.name)) {
      const data = callData;
      const jobId = String(data.jobId || (call.name === 'poll_job' && args && args.jobId) || '');
      const cmd = args && (args.command || args.cmd) || data.command || '';
      const exitCode = Number.isInteger(data.exitCode) ? data.exitCode : null;
      const toolOk = call.ok !== false;
      if (exitCode == null && !jobId && Object.keys(data).length === 0) {
        if (commands.length < MAX_EVIDENCE_COMMANDS && cmd) commands.push({ cmd: String(cmd).slice(0, 400), ok: toolOk });
        continue;
      }
      const status = String(data.status || (exitCode == null ? 'unknown' : 'done'));
      const passed = exitCode === 0 && toolOk && !['timeout', 'cancelled', 'error'].includes(status);
      const output = String(data.output || call.result || '');
      const commandEvidence = {
        cmd: String(cmd).slice(0, 400),
        ok: exitCode == null ? toolOk : passed,
        toolOk,
        exitCode,
        passed: exitCode == null ? null : passed,
        status,
        outputSummary: output.slice(-400),
        outputTruncated: data.outputTruncated === true || data.hasMore === true || Number(data.droppedOutputChars) > 0,
      };
      const priorIndex = call.name === 'poll_job' && jobId ? backgroundCommandIndex.get(jobId) : null;
      if (Number.isInteger(priorIndex) && commands[priorIndex]) {
        const prior = commands[priorIndex];
        commands[priorIndex] = {
          ...prior,
          ...(exitCode != null ? { ok: passed, exitCode, passed } : {}),
          toolOk: prior.toolOk && toolOk,
          status,
          outputSummary: commandEvidence.outputSummary || prior.outputSummary,
          outputTruncated: prior.outputTruncated || commandEvidence.outputTruncated,
        };
      } else if (commands.length < MAX_EVIDENCE_COMMANDS && (cmd || jobId)) {
        commands.push(commandEvidence);
        if (call.name === 'execute_shell' && jobId) backgroundCommandIndex.set(jobId, commands.length - 1);
      }
    }
  }
  return { files, ...(sources.length ? { sources } : {}), commands, warnings };
}

/**
 * 组装信封。
 * @param {{task?: any, projectRoot?: string, model?: any, inReplyTo?: string|null, view?: any,
 *          summary?: string, error?: string, changedFiles?: string[], clipped?: {droppedChars: number}|null}} input
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
  // 信封是完整审计/恢复数据；父 Agent 默认只收到短候选卡，需要时再按页取完整摘要。
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
      ...(evidence.sources && evidence.sources.length ? { sources: evidence.sources } : {}),
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
  if (env.evidence && env.evidence.sources != null && !Array.isArray(env.evidence.sources)) {
    violations.push({ path: 'evidence.sources', message: '必须是数组' });
  }
  const sourceList = Array.isArray(env.evidence && env.evidence.sources) ? env.evidence.sources : [];
  if (sourceList.length > MAX_EVIDENCE_SOURCES) {
    violations.push({ path: 'evidence.sources', message: '超过 ' + MAX_EVIDENCE_SOURCES + ' 个来源上限' });
  }
  for (const [index, source] of sourceList.entries()) {
    if (!source || !String(source.path || '').trim()) {
      violations.push({ path: 'evidence.sources[' + index + '].path', message: '缺少来源路径' });
      continue;
    }
    if (source.sha256 && !/^sha256:[0-9a-f]{64}$/.test(String(source.sha256))) {
      violations.push({ path: 'evidence.sources[' + index + '].sha256', message: '不是 sha256:… 形式' });
    }
    if (source.ranges != null && !Array.isArray(source.ranges)) {
      violations.push({ path: 'evidence.sources[' + index + '].ranges', message: '必须是数组' });
      continue;
    }
    if (Array.isArray(source.ranges) && source.ranges.length > 32) {
      violations.push({ path: 'evidence.sources[' + index + '].ranges', message: '超过 32 个范围上限' });
    }
    for (const [rangeIndex, range] of (Array.isArray(source.ranges) ? source.ranges : []).entries()) {
      if (!range || !Number.isInteger(range.startLine) || range.startLine < 1 ||
          !Number.isInteger(range.endLine) || range.endLine < range.startLine ||
          (range.sha256 && !/^sha256:[0-9a-f]{64}$/.test(String(range.sha256)))) {
        violations.push({ path: 'evidence.sources[' + index + '].ranges[' + rangeIndex + ']', message: '范围或哈希无效' });
      }
    }
  }
  return violations;
}

/**
 * **接收侧核验**（P2 尾 + P4 的地基）：把信封里的「声称」跟**当前**世界对一次账。
 *
 * 为什么必须在接收侧做：信封里的 `evidence.files/sources` 哈希与 `snapshot.hash` 都是**报告那一刻**
 * 测出来的。报告之后文件可能被改、画布可能被改 —— 只看信封是看不出来的，必须重算再比。
 *
 * - 逐条重算改动文件与读取来源的哈希（路径按工程根解析）→ 不符即「来源已变」
 * - 重算当前画布哈希 → 与 `snapshot.hash` 不一致即「报告之后世界又变过」
 *
 * 判定分三档（不是只有对/错）：
 *   `valid`   产物与画布都与报告时一致 → 结论仍然可信
 *   `stale`   只有画布变了 → 结论**可能过期**，要基于最新状态重新核对（不当作造假）
 *   `invalid` 有产物对不上（被改 / 该在的不在 / 声称不存在却存在）→ **不得作为结论证据**
 *
 * @param {any} envelope
 * @param {{projectRoot?: string, model?: any}} [world]
 * @returns {{verdict: 'valid'|'stale'|'invalid', checkedAt: number, files: Array<any>, sources: Array<any>, snapshot: any, reasons: string[]}}
 */
function verifyEnvelope(envelope, world = {}) {
  const { projectRoot, model } = world;
  const reasons = [];
  const files = [];
  const sources = [];
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
    files.push({ path: rel, declared, actual, exists, bytes, ok, versioned: !!declared });
    if (!ok) {
      reasons.push(
        declared
          ? '产物内容与报告时不一致（报告后可能被改动或被删）：' + rel
          : '报告里声称「不存在」的文件现在存在了：' + rel
      );
    }
  }
  const declaredSources = (envelope && envelope.evidence && envelope.evidence.sources) || [];
  const sourceLinesByPath = new Map();
  for (const entry of Array.isArray(declaredSources) ? declaredSources : []) {
    const rel = entry && entry.path ? String(entry.path) : '';
    if (!rel) continue;
    const declared = entry.sha256 || null;
    const expectedRanges = Array.isArray(entry.ranges) ? entry.ranges : [];
    const useRanges = entry.wholeFile !== true && expectedRanges.length > 0 && expectedRanges.every((range) => range && range.sha256);
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
          if (stat.size <= MAX_EVIDENCE_SOURCE_BYTES) {
            let lines = sourceLinesByPath.get(abs);
            if (!lines) {
              const buffer = fs.readFileSync(abs);
              actual = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
              if (useRanges) {
                lines = buffer.toString('utf8').split(/\r?\n/);
                sourceLinesByPath.set(abs, lines);
              }
            } else {
              actual = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
            }
            if (lines) sourceLinesByPath.set(abs, lines);
          }
        }
      } catch {
        exists = false;
      }
    }
    const ranges = useRanges
      ? expectedRanges.map((range) => {
          let lines = abs && sourceLinesByPath.get(abs);
          if (!lines && abs && exists && bytes <= MAX_EVIDENCE_SOURCE_BYTES) {
            try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/); sourceLinesByPath.set(abs, lines); } catch {}
          }
          const rangeActual = sha256OfLines(lines, range.startLine, range.endLine);
          return { startLine: range.startLine, endLine: range.endLine, declared: range.sha256, actual: rangeActual,
            ok: !!rangeActual && rangeActual === range.sha256 };
        })
      : [];
    const versioned = !entry.observedConflict && (useRanges || !!declared);
    const ok = !entry.observedConflict && (useRanges
      ? exists && ranges.every((range) => range.ok)
      : declared ? actual === declared : exists === (entry.exists === true) && bytes === (Number(entry.bytes) || 0));
    sources.push({ path: rel, declared, actual, exists, bytes, ok, versioned, wholeFile: entry.wholeFile === true,
      checkedBy: useRanges ? 'ranges' : declared ? 'whole_file_hash' : 'existence_and_size',
      ranges, citations: Array.isArray(entry.citations) ? entry.citations : [] });
    if (!ok) reasons.push('引用来源与报告时版本不一致或无法读取：' + rel);
  }
  const snapshotNow = buildSnapshot(model);
  const declaredHash = (envelope && envelope.snapshot && envelope.snapshot.hash) || null;
  const snapshot = { declared: declaredHash, actual: snapshotNow.hash, revision: snapshotNow.revision, ok: !declaredHash || declaredHash === snapshotNow.hash };
  if (!snapshot.ok) reasons.push('报告之后画布（世界状态）又变过：结论可能已过期，需按最新状态重新核对');
  const verdict = files.some((f) => !f.ok) || sources.some((source) => !source.ok)
    ? 'invalid' : snapshot.ok ? 'valid' : 'stale';
  return { verdict, checkedAt: Date.now(), files, sources, snapshot, reasons };
}

/**
 * UI/阶段记录用的**单一信封文本**：只有一段引导语 + 一个 JSON 对象。
 * 主循环用 modelContent 投影成短候选卡，不会把此全文与结构化 data 重复送进上下文。
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
      : '[子代理结果] 契约 v' + ENVELOPE_VERSION + '（信封是该候选交付的完整记录）。' +
        '这是**候选结果**（trust=derived），带有来源、快照和产物证据；它不会自动成为共享事实。' +
        '主代理核验后用 review_subagent_result 明确确认/撤回；下游只能通过 dependsOnTaskIds 读取确认摘要。' +
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
