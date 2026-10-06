'use strict';

// These contracts describe the actual data payloads produced by the built-in
// executors. Dynamic user values (scalar values / Dify outputs / graph changes)
// deliberately remain JSON values; the surrounding result and evidence fields
// are typed and required. Register at each implementation's entry point so direct
// registrations, the desktop toolkit and subagent registries share the contract.
const str = { type: 'string' };
const nonempty = { type: 'string', minLength: 1 };
const bool = { type: 'boolean' };
const num = { type: 'number' };
const nat = { type: 'integer', minimum: 0 };
const integer = { type: 'integer' };
const nil = { type: 'null' };
const nullable = (schema) => ({ anyOf: [schema, nil] });
const list = (items) => ({ type: 'array', items });
const strings = list(str);
/** @returns {any} */
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties });
const dict = (values) => ({ type: 'object', additionalProperties: values });
const choice = (...schemas) => ({ anyOf: schemas });
const value = { description: 'User/workflow-defined JSON value; the containing record is validated.' };
const partialFailures = list(object({ unit: str, code: nullable(str) }, ['unit']));
const reviewFile = object({ beforeExists: bool, beforeSha256: nullable(str), afterSha256: nonempty,
  removedLines: nat, addedLines: nat, diff: str, truncated: bool });
const graphChange = choice(
  object({ kind: { enum: ['added', 'removed'] }, nodeId: nonempty, label: str, type: str }),
  object({ kind: { const: 'changed' }, nodeId: nonempty, field: nonempty, before: str, after: str }),
  object({ kind: { enum: ['edge_added', 'edge_removed'] }, edge: nonempty }),
);
const reviewCanvas = object({ changes: list(graphChange), total: nat, truncated: bool });
const page = { output: str, offset: nat, nextOffset: nat, totalChars: nat, hasMore: bool };
const quality = object({ level: { enum: ['none', 'low', 'medium', 'high'] }, answerable: bool, reason: str,
  basis: str, evidenceVerified: bool, topCoverage: num, coveredQueries: nat, queryCount: nat }, ['level', 'answerable', 'reason'], true);
const source = object({ citation: nonempty, path: nonempty, kind: nonempty,
  key: nonempty, exact: bool, score: num, coverage: num, excerpt: str,
  startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
  fusionScore: num, exactPhrase: bool, vectorOnly: bool, vectorScore: num, rerankScore: num,
  graphOnly: bool, graphRelation: nullable(str), symbol: nullable(str), matchedQueries: strings, matchedTerms: strings,
}, ['citation', 'path', 'kind']);
source.allOf = [{ if: { properties: { kind: { const: 'scalar' } } },
  then: { required: ['key', 'exact', 'score', 'coverage', 'excerpt'] }, else: { required: ['startLine', 'endLine'] } }];
const memoryEntry = object({ id: str, content: str, scope: { enum: ['project', 'user'] }, kind: str, key: str,
  canonicalKey: str, value: str, tags: strings, source: str, sourceRef: str, sourceMessageId: str,
  confirmedAt: str, status: { enum: ['active', 'superseded', 'retracted'] }, version: nat,
  supersedesId: str, supersededBy: str, is_active: bool, validFrom: str, validTo: nullable(str), createdAt: str, updatedAt: str,
}, ['content'], true); // Legacy memory entries predate IDs and versions.
const taskStatus = { enum: ['queued', 'running', 'cancelling', 'done', 'failed', 'blocked', 'error', 'cancelled', 'timed_out', 'timeout', 'needs_review', 'expired'] };
const reviewStatus = object({ status: nonempty, reason: str, evidence: strings, basis: str, confirmedAt: str,
  reviewedAt: str, reviewedBy: nonempty, confirmedSummary: nonempty, note: str,
  retractedAt: str, retractedBy: nonempty,
  source: object({ runId: nonempty, taskId: nonempty, msgId: nonempty, snapshotHash: nullable(str),
    snapshotRevision: nullable(num), reviewedSnapshotHash: nullable(str), validationBasis: { enum: ['all', 'canvas', 'filesystem', 'manual'] },
    resultDigest: nonempty, verificationVerdict: { enum: ['valid', 'stale', 'invalid', 'unverifiable'] },
  }, ['runId', 'taskId', 'msgId', 'snapshotHash', 'snapshotRevision'], true),
  resultProducedAt: str, candidateAt: str }, ['status'], true);
reviewStatus.allOf = [
  { if: { properties: { status: { const: 'confirmed' } } }, then: {
    required: ['confirmedSummary', 'note', 'reviewedAt', 'reviewedBy', 'source'],
    properties: { source: { required: ['reviewedSnapshotHash', 'validationBasis', 'resultDigest', 'verificationVerdict'] } },
  } },
  { if: { properties: { status: { const: 'retracted' } } }, then: { required: ['note', 'retractedAt', 'retractedBy', 'source'] } },
];
const usage = object({ prompt_tokens: nat, completion_tokens: nat, total_tokens: nat,
  input_tokens: nat, output_tokens: nat, reasoning_tokens: nat }, [], true);
const evidenceFile = object({ path: nonempty, exists: bool, bytes: nat, sha256: nullable(str) }, ['path', 'exists'], true);
const evidenceSource = object({ path: nonempty, sha256: nullable(str), versioned: bool,
  ranges: list(object({ startLine: integer, endLine: integer, sha256: nullable(str) }, ['startLine', 'endLine'], true)),
  citations: strings }, ['path'], true);
const evidenceCommand = object({ cmd: str, command: str, exitCode: nullable(integer), ok: bool,
  jobId: nullable(str), status: str }, [], true);
const envelope = object({
  v: { const: 1 }, msgId: nonempty, kind: { enum: ['result', 'error'] }, trust: { enum: ['verified', 'derived', 'untrusted'] },
  from: object({ runId: nonempty, taskId: nonempty, role: nonempty }),
  to: object({ taskId: nonempty }, ['taskId'], true),
  snapshot: object({ source: str, hash: nullable(str), revision: nullable(num) }, ['source', 'hash', 'revision']),
  payload: object({ objective: str, status: taskStatus, summary: str, summaryChars: nat, toolCallCount: nat,
    acceptanceJudgement: { const: 'manual' }, error: str }, ['objective', 'status', 'summary'], true),
  lossy: object({ isLossy: bool, droppedChars: nat, reason: str, originalRef: str, contractViolations: strings }, ['isLossy']),
  evidence: object({ files: list(evidenceFile), sources: list(evidenceSource), commands: list(evidenceCommand), warnings: strings }, ['files']),
  refs: list(object({ path: nonempty }, ['path'], true)),
}, ['v', 'msgId', 'from', 'to', 'snapshot', 'kind', 'payload', 'trust', 'lossy'], true);
const verification = object({ verdict: { enum: ['valid', 'stale', 'invalid', 'unverifiable'] }, checkedAt: num, reasons: strings,
  snapshot: nullable(object({ expected: nullable(str), actual: nullable(str), matches: bool }, [], true)),
  files: list(object({ path: str, ok: bool }, ['path', 'ok'], true)),
  sources: list(object({ path: str, ok: bool }, ['path'], true)),
}, ['verdict', 'reasons'], true);
const taskWorktree = object({ path: nonempty, relativePath: str, branch: str, base: str,
  name: str, changed: strings, commits: nat,
  sourceSnapshot: object({ ok: bool, sourceHead: str, pendingDigest: str, pending: strings }, ['ok'], true) }, ['path'], true);
const taskView = object({
  executionId: nullable(str), taskId: nonempty, runId: str, role: nonempty, objective: str, acceptanceCriteria: strings,
  stageNodeId: str, status: taskStatus, summary: str, summaryChars: nat, summaryStorageDroppedChars: nat,
  error: nullable(str), grounding: nullable(object({ answerable: bool, valid: bool }, [], true)), usage: nullable(usage),
  stageWarning: nullable(str), envelope: nullable(envelope), review: nullable(reviewStatus), dependsOnTaskIds: strings,
  artifactRoot: nullable(str), verifiesTaskId: nullable(str), verificationCandidateDigest: nullable(str),
  worktree: nullable(taskWorktree), startedAt: nullable(str), finishedAt: nullable(str), queuedAt: nullable(str), deadline: nullable(str),
  executionSettled: bool, requiresReview: bool, cancelReason: nullable(str), outcomeReason: nullable(str), version: nat,
  verification,
}, ['taskId', 'role', 'status', 'summary', 'acceptanceCriteria', 'executionSettled', 'requiresReview']);
const mergeCounts = object({ resources: nat, agreed: nat, superseded: nat, arbitrated: nat, conflicts: nat,
  duplicatesRemoved: nat, rejectedDecisions: nat });
const mergeResource = object({ resourceKey: nonempty, status: { enum: ['agreed', 'superseded', 'arbitrated', 'conflict'] },
  value, contributions: list(object({ actor: str, value, source: nullable(str) }, ['actor', 'value'], true)),
}, ['resourceKey', 'status'], true);
const mergeConflict = object({ resourceKey: nonempty, kind: nonempty,
  candidates: list(object({ actor: nonempty, role: str, value, kind: nonempty, finishedAt: nullable(str), source: nullable(str) })),
  reason: nonempty });
const merged = object({ v: { const: 1 }, digest: nonempty, counts: mergeCounts, resources: list(mergeResource),
  conflicts: list(mergeConflict), rejectedDecisions: list(object({ resourceKey: str, winnerTaskId: str, reason: str })),
  requiresArbitration: bool, sharedContentStatus: { const: 'candidate' } }, ['digest', 'counts', 'conflicts'], true);
const graphStats = { nodeCount: nat, edgeCount: nat, tasks: nat, stages: nat, tools: nat, files: nat, objects: nat, scopes: nat, canvases: nat };
const graphNode = object({ id: nonempty, type: str, label: str, status: str, x: num, y: num,
  objectName: str, parentId: str, childIds: strings }, ['id', 'type', 'label', 'status', 'x', 'y']);
const planItem = object({ id: nonempty, step: nonempty, acceptanceCriteria: nonempty,
  status: { enum: ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'] },
  evidenceCallIds: strings, dependsOn: strings, ownerTaskId: str, reason: str }, ['id', 'step', 'acceptanceCriteria', 'status'], true);
const fileVersion = object({ sha256: nonempty, ranges: dict(nonempty) });
const workbenchModel = object({ ...graphStats, view: str, nodes: list(graphNode),
  edges: list(object({ id: nonempty, source: nonempty, sourceHandle: str, target: nonempty, targetHandle: str })) }, [...Object.keys(graphStats), 'view']);
workbenchModel.allOf = [{ if: { properties: { view: { const: 'full' } } }, then: { required: ['nodes', 'edges'] } }];

const schemas = {
  write_file: object({ path: nonempty, bytes: nat, sha256: nullable(str), review: nullable(reviewFile), reviewUnavailable: nullable(str) }),
  edit_file: object({ path: nonempty, replaced: { type: 'integer', minimum: 1 }, sha256: nullable(str), review: reviewFile }),
  read_file: object({ path: nonempty, language: str, binary: { const: false }, lineCount: { type: 'integer', minimum: 1 },
    matched: str, sourceSha256: str, sourceRangeSha256: str, extractedTruncated: bool, truncated: bool,
    offset: nat, charOffset: nat, startLine: nat, endLine: nat, nextOffset: nullable(nat), nextCharOffset: nullable(nat),
  }, ['path', 'language', 'binary', 'lineCount']),
  find_files: object({ count: nat, offset: nat, nextOffset: nullable(nat), files: strings }, ['count', 'offset', 'files']),
  search_files: object({ count: nat, offset: nat, nextOffset: nullable(nat), matches: strings,
    sourceVersions: dict(choice(str, fileVersion)) }, ['count', 'offset']),
  list_directory: object({ count: nat, offset: nat, path: str }),
  execute_shell: choice(
    object({ jobId: nonempty, async: { const: true }, command: nonempty, status: { const: 'running' }, timeoutSeconds: num }),
    object({ exitCode: integer, command: nonempty, output: str, outputOffset: nat, nextOffset: nat,
      totalOutputChars: nat, hasMore: bool, jobId: nullable(str), outputTruncated: bool, droppedOutputChars: nat }),
  ),
  poll_job: choice(
    object({ jobId: nonempty, status: { const: 'running' }, startedAt: num, elapsedMs: nat, ...page }),
    object({ jobId: nonempty, status: { const: 'done' }, exitCode: nullable(integer), ...page }),
  ),
  ask_user: object({ answer: str }),
  fetch_url: object({ url: nonempty, chars: nat, bytes: nat, truncated: bool }),
  save_project: object({ filePath: nonempty }),
  code_review: object({ findings: list(object({ severity: str, message: nonempty, line: nullable(integer) })), total: nat, source: str }),
  project_info: object({ buildSystem: nonempty, mainCandidates: strings, modules: strings, jdks: strings,
    languages: dict(nat), fileCount: nat, root: nonempty, workerMode: nonempty, cancelled: { const: false }, scanned: nat }),
  scan_project: object({ root: nonempty, workerMode: nonempty, workerFallback: nullable(str),
    sourceFiles: nat, assetFiles: nat, fileCount: nat, languageSummary: dict(nat), tree: strings, appliedToWorkbench: bool,
  }, ['root', 'workerMode', 'sourceFiles', 'assetFiles', 'fileCount', 'languageSummary', 'tree']),
  analyze_project: object({ root: nonempty, workerMode: nonempty, buildSystem: nonempty,
    mainCandidates: strings, modules: strings, jdks: strings, sourceFileCount: nat, assetFileCount: nat,
    languageSummary: dict(nat), files: list(object({ relativePath: str, name: str, language: str, ext: str, lineCount: nat })), analyzedFileCount: nat,
    fileAnalysis: list(object({ path: str, language: str, imports: strings, classes: strings, functions: strings, variables: strings, lineCount: nat })),
  }, ['root', 'workerMode', 'buildSystem', 'mainCandidates', 'modules', 'jdks', 'sourceFileCount', 'assetFileCount', 'languageSummary', 'files', 'analyzedFileCount']),
  get_workbench_model: workbenchModel,
  workbench_edit: object({ created: strings, affected: strings, errors: strings, applied: bool, review: reviewCanvas, partialFailures }, ['created', 'affected', 'applied', 'review']),
  bulk_edit: choice(
    object({ action: { enum: ['create_nodes', 'create_assets'] }, nodeIds: strings, count: nat }),
    object({ action: { const: 'create_files' }, written: strings, count: nat, errors: strings, partialFailures }, ['action', 'written', 'count']),
    object({ action: { const: 'delete_nodes' }, deleted: strings, count: nat, errors: strings, partialFailures }, ['action', 'deleted', 'count']),
  ),
  ui_control: object({ action: nonempty, applied: { const: true } }),
  write_analysis_md: object({ nodeId: nonempty, name: str, relativePath: str, chars: nat, preview: str }),
  query_scalars: object({ key: nullable(str), prefix: nullable(str), query: nullable(str), count: nat,
    items: list(object({ key: nonempty, kind: str, value, ts: num, exact: bool, score: nullable(num) })) }),
  retrieve_context: object({ query: str, mode: nonempty, queries: strings, keys: strings, sources: list(source), quality,
    routing: object({ source: str, decision: str }, ['source', 'decision'], true),
    index: object({ indexedFiles: nat, chunks: nat, skippedFiles: nat, changedFiles: nat, removedFiles: nat,
      invalidatedFiles: nat, truncated: bool, candidateChunks: nat, fusedCandidates: nat, retrievalDurationMs: num,
      graph: object({ expanded: nat, hops: nat }, [], true),
      rerank: object({ enabled: bool, applied: bool, candidates: nat, error: str }, ['enabled', 'applied', 'candidates']),
      vector: object({ provider: str, backend: str, error: str }, ['provider'], true),
    }, ['indexedFiles', 'chunks'], true),
  }, ['query', 'mode', 'sources', 'quality']),
  remember: object({ id: nonempty, scope: { enum: ['project', 'user'] }, duplicate: bool, version: { type: 'integer', minimum: 1 },
    replacedIds: strings, total: nat, evicted: nat, evictedIds: list(nullable(str)) }),
  recall: object({ entries: list(memoryEntry), matched: bool, scope: { enum: ['project', 'user', 'all'] }, terms: strings }, ['entries', 'matched']),
  read_skill: choice(object({}), object({ name: nonempty, instructions: str, truncated: bool, chars: nat }, ['name', 'instructions', 'truncated'])),
  view_image: object({ image: object({ path: nonempty, mime: { enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
    bytes: nat, dataUrl: nonempty, note: nullable(str) }) }),
  web_search: object({ query: nonempty, backend: { enum: ['searxng', 'custom'] }, count: nat,
    results: list(object({ title: str, url: str, snippet: str })) }),
  dify_call: object({ kind: { enum: ['workflow', 'chat'] }, inputKeys: strings, inputs: dict(value), query: str,
    output: value, elapsedMs: nat, status: str, taskId: nullable(str), runId: nullable(str), conversationId: nullable(str), error: nullable(str),
  }, ['kind', 'inputKeys', 'inputs', 'output', 'elapsedMs', 'status', 'taskId', 'runId', 'conversationId', 'error']),
  discover_tools: choice(
    object({ enabled: strings, hidden: strings, matched: { const: 0 }, groups: str }, ['enabled', 'hidden', 'matched']),
    object({ enabled: strings, exposed: strings, matched: nat, hiddenRemaining: strings }),
  ),
  update_plan: object({ total: nat, completed: nat, inProgress: nat, blocked: nat, cancelled: nat, pending: nat,
    items: list(planItem), persisted: bool, runFilePersisted: bool, sessionFilePersisted: bool, eventPersisted: bool,
    file: nullable(str), sessionFile: nullable(str) }),
  worktree: choice(
    object({ worktrees: list(object({ name: str, path: nonempty, branch: str, changed: nat, commits: nat, base: str })), root: nonempty }),
    object({ path: nonempty, relativePath: str, branch: nonempty, base: nonempty }),
    object({ ok: { const: true }, name: str, path: nonempty, branch: str, targetBranch: str, targetHead: str, sourceHead: str,
      pending: strings, pendingDigest: str, files: strings, commits: nat }),
    object({ ok: { const: true }, branch: str, targetBranch: str, head: nonempty, sourceHead: str, previousTargetHead: str, files: strings, sourcePath: nonempty }),
    object({ path: nonempty, branch: str, discardedChanges: nat }),
  ),
  delegate_task: taskView,
  get_subagent_task: taskView,
  cancel_subagent_task: object({ taskId: nonempty, role: nonempty, status: { const: 'cancelling' }, executionSettled: { const: false }, worktree: nullable(taskWorktree) }),
  review_subagent_result: object({ taskId: nonempty, review: reviewStatus }),
  delegate_tasks: object({ batchOutcome: { const: 'success' }, successfulTaskIds: strings, failedTaskIds: { type: 'array', maxItems: 0 },
    results: list(taskView), merged, candidateTaskIds: strings, failedCount: { const: 0 } }),
  merge_subagent_results: object({ merged, taskIds: strings, candidateTaskIds: strings, sharedContentStatus: { const: 'candidate' },
    sources: list(object({ taskId: nonempty, msgId: nonempty, snapshotHash: nullable(str) })),
    rejected: list(object({ taskId: str, reason: str })), stale: list(object({ taskId: str, reason: str })) }),
};

schemas.get_workbench_model.allOf = [
  { if: { properties: { view: { not: { const: 'counts' } } } }, then: { required: ['nodes'] } },
  { if: { properties: { view: { const: 'full' } } }, then: { required: ['edges'] } },
];

function declareOutputContracts(registry, names) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(schemas, name)) throw new Error('Missing built-in output contract: ' + name);
    if (!registry.declareContract(name, { outputSchema: schemas[name] })) throw new Error('Cannot attach output contract: ' + name);
  }
}

module.exports = { schemas, declareOutputContracts };
