interface ProjectGraphDto {
  revision?: number;
  nodes?: unknown[];
  edges?: unknown[];
}

interface ProjectWorkspaceDto {
  viewport?: { x: number; y: number; zoom: number };
}

interface ProjectManifestDto {
  format?: string;
  formatVersion?: string;
  documentId?: string;
  name?: string;
  createdAt?: string;
  modifiedAt?: string;
  template?: { kind: 'workflow'; tools: string[]; models: string[]; paths: string[]; sourceProject?: string };
}

interface ProjectPayloadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    sessions?: unknown[];
    messages?: unknown[];
    memoryConversationId?: string;
    memoryTaskEpoch?: number;
  };
  checkpoints?: unknown[];
}

interface ProjectLoadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    sessions?: unknown[];
    messages?: unknown[];
    memoryConversationId?: string;
    memoryTaskEpoch?: number;
  };
  checkpoints?: unknown[];
  warnings?: string[];
}

interface ProjectFileDto {
  relPath: string;
  size: number;
}

interface ProjectSearchMatchDto {
  path: string;
  line: number;
  text: string;
}

interface ProjectExtensionDto {
  name: string;
  kind: string;
  description?: string;
  enabled?: boolean;
  source?: string;
  contract?: { explicit: boolean; outputSchema: boolean; readOnly: boolean; timeoutMs: number | null };
}

interface AgentToolSpecDto {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface ToolRecordDto {
  name: string;
  args?: unknown;
  ok?: boolean;
  result?: string;
}

interface ToolRequestDto {
  id: string;
  type: 'confirm' | 'ask' | 'ui' | 'cancel' | 'editor_read';
  path?: string;
  level?: string;
  what?: string;
  detail?: string;
  question?: string;
  options?: string[];
  action?: string;
  args?: Record<string, unknown>;
}

interface ModelSpecDto {
  id: string;
  label: string;
  model: string;
  apiBase?: string;
  apiKey?: string;
  apiKeySet?: boolean;
  apiKeyPreview?: string;
  apiKeyError?: boolean;
  contextWindow: number;
  priceInput: number;
  priceInputHit: number;
  priceOutput: number;
  supportsEffort: boolean;
  effortLevels?: string[];
  defaultEffort?: string;
  /** 是否支持图片输入（多模态） */
  vision?: boolean;
  enabled?: boolean;
}

interface WorkflowStateDto {
  revision: number;
  graphDigest: string;
  completed: string[];
  skipped: string[];
  selectedInputs: Record<string, { id: string; output: string }[]>;
  outputs: Record<string, string>;
  attempts: Record<string, number>;
  reviews: Record<string, string>;
  inputs: Record<string, string>;
  pending: Array<{ id: string; nodeId: string; label: string; active: boolean }>;
  hasHistory: boolean;
  complete: boolean;
  order: string[];
}

interface WorkflowGraphDto {
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; sourceHandle?: string; targetHandle?: string; data?: unknown }>;
}

interface CodenodeApi {
  workflowState: (root: string, workflowId: string, request: {
    action: 'read' | 'prepare' | 'settle' | 'restart'; graph: WorkflowGraphDto;
    expectedRevision?: number; nodeId?: string; reviewedAttemptIds?: string[];
    attemptId?: string; ok?: boolean; output?: string;
  }) => Promise<{ ok: boolean; error?: string; needsReview?: boolean; attemptId?: string; state?: WorkflowStateDto }>;
  workflowExecute: (root: string, workflowId: string, request: {
    graph: WorkflowGraphDto; nodeId: string; expectedRevision: number; legacyRecovery?: boolean;
  }) => Promise<{ ok: boolean; executionOk?: boolean; output?: string; error?: string; needsReview?: boolean; state?: WorkflowStateDto }>;
  saveGraph: (payload: ProjectPayloadDto) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  openGraph: () => Promise<{ ok: boolean; filePath?: string; data?: ProjectLoadDto; error?: string }>;
  chooseProject: () => Promise<{ ok: boolean; root?: string }>;
  createProject: () => Promise<{ ok: boolean; filePath?: string; root?: string; error?: string }>;
  listProject: (root: string) => Promise<{ ok: boolean; files?: ProjectFileDto[]; error?: string }>;
  readProjectFile: (
    root: string,
    relPath: string,
    options?: { binary?: boolean }
  ) => Promise<{ ok: boolean; content?: string; dataUrl?: string; bytes?: number; truncated?: boolean; mtimeMs?: number; error?: string }>;
  writeProjectFile: (
    root: string,
    relPath: string,
    content: string,
    backup?: boolean,
    expectedMtimeMs?: number
  ) => Promise<{ ok: boolean; bytes?: number; mtimeMs?: number; conflict?: boolean; currentContent?: string; currentMtimeMs?: number; error?: string }>;
  searchProject: (
    root: string,
    query: string,
    maxResults?: number
  ) => Promise<{ ok: boolean; matches?: ProjectSearchMatchDto[]; error?: string }>;
  runProjectCommand: (
    root: string,
    command: string,
    timeoutSeconds?: number
  ) => Promise<{ ok: boolean; output?: string; exitCode?: number | null; timedOut?: boolean; error?: string }>;
  startProjectCommand: (
    root: string,
    command: string,
    timeoutSeconds?: number
  ) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  stopProjectCommand: (sessionId: string) => Promise<{ ok: boolean }>;
  sendProjectCommandInput: (sessionId: string, input: string) => Promise<{ ok: boolean }>;
  onProjectCommandEvent: (cb: (data: { sessionId?: string; kind: 'output' | 'done' | 'error'; text?: string; exitCode?: number | null; timedOut?: boolean; error?: string }) => void) => () => void;
  addExtensions: (root: string, input: unknown) => Promise<{ok:boolean;error?:string;added?:{name:string;kind:string;toolCount:number}[];file?:string}>;
  listExtensions: (root: string | null) => Promise<{ ok: boolean; extensions?: ProjectExtensionDto[]; error?: string }>;
  saveProject: (target: string, payload: ProjectPayloadDto) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  loadProject: (target: string) => Promise<{ ok: boolean; filePath?: string; data?: ProjectLoadDto; error?: string }>;
  agentConfig: (
    root: string | null, sessionId?: string | null, conversationId?: string | null
  ) => Promise<{
    configured: boolean;
    backend?: { availability?: Partial<Record<import('./types').AgentBackendSettings['backend'],{installed:boolean;reason?:string}>>; profiles?: Partial<Record<import('./types').AgentBackendSettings['backend'],import('./types').AgentBackendSettings>>; sessionSettings?: import('./types').AgentBackendSettings; settings: import('./types').AgentBackendSettings; machine: import('./types').AgentBackendSettings; project: import('./types').AgentBackendSettings | null; scope: 'machine' | 'project' };
    model: string;
    soul: { name: string; greeting: string; style: string; raw: string };
    toolsEnabled: boolean;
    autoExecuteTools?: boolean;
    scheduling?: import('./types').SchedulingSettings;
    costSettings?: import('./types').CostSettings;
    subagentRoles?: { name: string; label: string }[];
    ragEnabled: boolean;
    editing?: import('./types').EditingSettings;
    rag?: { enabled: boolean; strictValidation: boolean; provider: string; model: string; base: string; dim: number; dimensions: string; backend: string; milvusAddress?:string;milvusCollection?:string;hasMilvusToken?:boolean;hasKey: boolean; rerankEnabled: boolean; rerankExternal: boolean; bm25K1: number; bm25B: number; vectorWeight: number };
    models?: ModelSpecDto[];
    activeModelId?: string | null;
  }>;
  ragCheck: (root: string | null, settings: { enabled?: boolean; strictValidation?: boolean; provider: string; model: string; base: string; dim: number; dimensions: string; backend: string; milvusAddress?:string;milvusCollection?:string;milvusToken?:string;key?: string; bm25K1: number; bm25B: number; vectorWeight: number }) => Promise<{ ok: boolean; error?: string; dimension?: number; mode?: string }>;
  ragSave: (root: string | null, settings: { enabled?: boolean; strictValidation?: boolean; provider: string; model: string; base: string; dim: number; dimensions: string; backend: string; milvusAddress?:string;milvusCollection?:string;milvusToken?:string;key?: string; bm25K1: number; bm25B: number; vectorWeight: number }) => Promise<{ ok: boolean; error?: string; rebuildRequired?: boolean }>;
  editingSave: (root: string, settings: import('./types').EditingSettings) => Promise<{ ok: boolean; error?: string; settings?: import('./types').EditingSettings }>;
  executionSave: (root: string, settings: { autoExecuteTools: boolean }) => Promise<{ ok: boolean; error?: string; settings?: { autoExecuteTools: boolean } }>;
  backendSave: (root: string | null, scope: 'machine' | 'project', settings: import('./types').AgentBackendSettings | null,options?:{conversationId?:string}) => Promise<{ ok: boolean; error?: string; settings?: import('./types').AgentBackendSettings; scope?: 'machine' | 'project' }>;
  backendControl: (root: string | null, settings: import('./types').AgentBackendSettings, method: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; value?: any }>;
  backendStatus: (root: string | null, settings?: import('./types').AgentBackendSettings) => Promise<{ ok: boolean; error?: string; checkedSettings?: import('./types').AgentBackendSettings; capabilities?: { backend: string; available: boolean; authenticated?: boolean | null; protocolVersion?: string; protocol?: string; version?: string; resume?:boolean; hardBudget?: boolean; customTools?: boolean; error?: string; proxySource?: string; commandSandbox?: { readiness: string; lastSetupError: { code: string; message: string } | null; verified: boolean } | null } }>;
  goalList: (root:string|null)=>Promise<{ok:boolean;error?:string;value?:{revision:number;goals:any[];decisions:any[];admissions:any[];settlements:any[];recoveredAdmissions?:{count:number;recovered:any[]}}}>;
  goalCreate: (root:string|null,input:{title:string;objective?:string;scope?:string;exclusions?:string;criteria?:string[];maxTokens?:number;maxCostUsd?:number})=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalUpdate: (root:string|null,goalId:string,patch:Record<string,unknown>)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalAutoAdvanceClaim: (root:string|null,goalId:string,taskId:string)=>Promise<{ok:boolean;error?:string;value?:{goalId:string;taskId:string;title:string;objective:string;claimId:string;requestId:string;waitObservationId:string;usedRuns:number;maxRuns:number}}>;
  goalAutoAdvanceRelease: (root:string|null,goalId:string,taskId:string,claimId:string,reason?:string)=>Promise<{ok:boolean;error?:string;value?:boolean}>;
  goalTaskCreate: (root:string|null,goalId:string,input:{title:string;objective?:string;dependsOn?:string[];readScope?:string[];writeScope?:string[];criteriaIds?:string[];decisionIds?:string[]})=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalTaskUpdate: (root:string|null,goalId:string,taskId:string,patch:Record<string,unknown>)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalRunReview: (root:string|null,goalId:string,taskId:string,runId:string)=>Promise<{ok:boolean;error?:string;value?:{runId:string;status:string;state?:string|null;backend:string;startedAt?:string|null;finishedAt?:string|null;stopReason?:string|null;changesAvailable:boolean;changesComplete:boolean;changeScope:string;totalFiles:number;truncated:boolean;files:Array<{path:string;kind:string;before:string|null;after:string|null}>;projectFingerprint:string;projectSnapshotComplete:boolean}}>;
  goalRunReviewConfirm: (root:string|null,goalId:string,taskId:string,runId:string,projectFingerprint:string)=>Promise<{ok:boolean;error?:string;value?:{runId:string;projectFingerprint:string;projectSnapshotComplete:boolean;reviewedAt:string}}>;
  goalDecisionCreate: (root:string|null,goalId:string,input:{question:string;options:string[];taskIds?:string[]})=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalDecisionResolve: (root:string|null,decisionId:string,value:string,reason?:string)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalVerify: (root:string|null,goalId:string,taskId:string|null,criterionId:string|null,command:string)=>Promise<{ok:boolean;error?:string;status?:string;runId?:string;output?:string;exitCode?:number;evidence?:any;filesChangedDuringCheck?:boolean}>;
  goalAudit: (root:string|null,goalId:string)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalCanRun: (root:string|null,goalId:string,taskId?:string)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalContextAdd: (root:string|null,goalId:string,kind:'rules'|'taskMaterial'|'confirmedExperience',input:{content:string;source?:string;confirmed?:boolean})=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalExperienceConfirm: (root:string|null,goalId:string,itemId:string)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalContextForRole: (root:string|null,goalId:string,taskId:string|null,role:string)=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalWaitObserve: (root:string|null,goalId:string,taskId:string,observation:{id:string;source?:string;status?:string;matched:boolean;revision?:string})=>Promise<{ok:boolean;error?:string;value?:any}>;
  goalWaitCheck: (root:string|null,goalId:string,taskId:string)=>Promise<{ok:boolean;error?:string;nextCheckAt?:string;value?:any}>;
  schedulingSave: (settings: import('./types').SchedulingSettings) => Promise<{ ok: boolean; error?: string; settings?: import('./types').SchedulingSettings }>;
  costSettingsSave: (root: string, settings: import('./types').CostSettings) => Promise<{ ok: boolean; error?: string; settings?: import('./types').CostSettings }>;
  modelsList: () => Promise<{ models: ModelSpecDto[]; activeId: string | null; modelAliases?: Record<string,string> }>;
  modelsDiscover: (provider: string, apiKey: string, options?: { apiBase?: string; modelId?: string }) => Promise<{ ok: boolean; ticket?: string; models?: ModelSpecDto[]; apiKeyPreview?: string; error?: string }>;
  modelsConnect: (ticket: string, selectedId: string) => Promise<{ ok: boolean; error?: string }>;
  modelsSave: (model: ModelSpecDto) => Promise<{ ok: boolean; models?: ModelSpecDto[]; activeId?: string | null; error?: string }>;
  modelsDelete: (id: string) => Promise<{ ok: boolean; models?: ModelSpecDto[]; activeId?: string | null; error?: string }>;
  modelsActive: (id: string) => Promise<{ ok: boolean; activeId?: string | null; error?: string }>;
  agentGreeting: (
    root: string | null
  ) => Promise<{ greeting: string; name: string; configured: boolean }>;
  agentTools: (
    root: string | null
  ) => Promise<{ enabled: boolean; tools: AgentToolSpecDto[] }>;
  agentRuns: (root: string | null) => Promise<Array<{
    runId: string | null;
    status: string;
    /** 终态细分：LIMIT_REACHED（跑到上限）与 FAILED 都写 status='error'，靠它区分 */
    state?: string | null;
    outcome?: { state: string; kind: string; reason: string | null; limitKind: string | null } | null;
    limitKind?: string | null;
    stopReason?: string | null;
    stateHistoryValid?: boolean | null;
    stateHistoryIssues?: { index: number; type: string; [key: string]: unknown }[];
    startedAt: string | null;
    finishedAt: string | null;
    eventCount: number;
  }>>;
  agentFeedback: (root: string, payload: { verdict: 'accept' | 'reject' | 'retry' | 'report'; content: string; input?: string; correction?: string; sessionId?: string; runId?: string; role?: string; tools?: unknown[] }) => Promise<{ ok: boolean; duplicate?: boolean; error?: string }>;
  agentFeedbackExport: (root: string, options?: { includeReviewed?: boolean }) => Promise<{ ok: boolean; count?: number; dataset?: unknown[]; error?: string }>;
  agentFeedbackReview: (root: string, id: string, expectedOutput: string, reviewer?: string) => Promise<{ ok: boolean; error?: string }>;
  agentResumePlan: (root: string | null, runId: string) => Promise<{
    ok: boolean;
    mode?: 'complete' | 'auto' | 'review' | 'unknown';
    requiresReview?: boolean;
    runId?: string;
    state?: string | null;
    stateHistoryValid?: boolean | null;
    stateHistoryIssues?: { index: number; type: string; [key: string]: unknown }[];
    limitKind?: string | null;
    stopReason?: string | null;
    prompt?: string;
    model?: string | null;
    nodeId?: string | null;
    reason?: string;
    warning?: string;
    error?: string;
    pendingSteps?: { tool: string; effect: string; idemKey: string | null }[];
    completedSteps?: { tool: string; idemKey: string | null; at: string | null }[];
    skippedByLedger?: { tool: string; idemKey: string | null; reason: string }[];
    unknownEffects?: { tool: string; effect: string }[];
    checkpointCount?: number;
  messageCheckpointCount?: number;
  }>;
  agentReadPlan: (root: string | null, sessionId: string) => Promise<{
    ok: boolean;
    error?: string;
    plan: { sessionId?: string; runId?: string; updatedAt?: string; items: { id?: string; step: string; acceptanceCriteria?: string; status: string; evidenceCallIds?: string[]; reason?: string; dependsOn?: string[]; ownerTaskId?: string }[] } | null;
  }>;
  agentMetrics: (root: string | null) => Promise<{
    ok: boolean;
    taskCosts?: import('./types').TaskCosts;
    cost?: {
      run: CostCountersDto;
      today: CostCountersDto;
      kinds?: Record<string, CostCountersDto>;
      queue?: { active: number; waiting: number; maxWaitMs: number } | null;
    };
    firedAlerts?: AlertDto[];
    alertHistory?: AlertDto[];
    queue?: { active: number; waiting: number; limit: number; maxWaitMs: number };
    sandbox?: {
      backend: string;
      isolation: Record<string, boolean>;
      detail: string;
      mode: string;
      network: string;
      degraded: string[];
      description: string;
    };
    runs?: unknown[];
  }>;
  /** §4.2：Run 级文件回滚 —— 只读计划（逐项 restore/delete/skip + 原因 + 冲突标记）。 */
  rollbackPlan: (
    root: string | null,
    runId: string,
  ) => Promise<{
    ok: boolean;
    error?: string;
    runId: string;
    items: {
      path: string;
      tools: string[];
      action: 'restore' | 'delete' | 'skip';
      restorable: boolean;
      reason?: string;
      conflict: boolean;
      bytes?: number | null;
    }[];
    summary: { restore: number; delete: number; skip: number; conflict: number };
  }>;
  /** §4.2：执行回滚（force=true 才会覆盖「本 Run 之后被外部改过」的文件）。 */
  rollbackApply: (
    root: string | null,
    runId: string,
    options?: { force?: boolean },
  ) => Promise<{
    ok: boolean;
    runId: string;
    applied: { path: string; action: string; verified?: boolean }[];
    refused: { path: string; reason: string }[];
    skipped: { path: string; reason: string }[];
    summary: { applied: number; refused: number; skipped: number; conflicts: number };
    error?: string;
  }>;
  /** §4.2：子代理任务视图（跨 run 可查；重启后仍在）。 */
  subagentViews: (
    root: string | null,
    options?: { maxRuns?: number; maxTasksPerRun?: number },
  ) => Promise<{
    ok: boolean;
    error?: string;
    runs: {
      runId: string;
      updatedAt: string | null;
      ok: boolean;
      error: string | null;
      tasks: {
        taskId: string;
        attempt?: number;
        attempts?: { attempt: number; executionId: string; status: string; startedAt: string | null; finishedAt: string | null; summary: string; error: string | null; compensation?: { ok: boolean; applied?: string[]; error?: string } | null }[];
        role: string | null;
        objective: string;
        status: string | null;
        summary: string;
        error: string | null;
        startedAt: string | null;
        finishedAt: string | null;
      }[];
    }[];
  }>;
  /** §4.2：运行中插话（steering）—— 成功才会进请求体；已结束的 run 会被明确拒绝。 */
  steerAgent: (
    requestId: string,
    text: string,
  ) => Promise<{ accepted: boolean; reason?: string; pending?: number; error?: string }>;
  /** S8：按 run 回放统一事件流（时间线 + 摘要）。 */
  replayEvents: (
    root: string | null,
    options?: { runId?: string | null; kinds?: string[] | null; limit?: number },
  ) => Promise<{
    ok: boolean;
    error?: string;
    file: string | null;
    total: number;
    runs: { runId: string; count: number; first: string | null; last: string | null; kinds: string[] }[];
    events: {
      v?: number;
      ts?: string;
      kind: string;
      runId?: string | null;
      turnId?: string | null;
      toolCallId?: string | null;
      attemptId?: string | null;
      [key: string]: unknown;
    }[];
    summary: {
      total: number;
      runs: string[];
      span: { first: string | null; last: string | null };
      kinds: Record<string, number>;
      tools: Record<string, { calls: number; failures: number }>;
      toolCalls: number;
      toolFailures: number;
      failureCodes: Record<string, number>;
      approvals: { issued: number; denied: number; rejected: number; consumed: number };
      costUsd: number;
      tokens: number;
    } | null;
  }>;
  onAgentAlert: (cb: (alert: AlertDto) => void) => () => void;
  agentResumeStart: (root: string | null, runId: string, replacementRunId: string) => Promise<{
    ok: boolean;
    error?: string;
    replacementRunId?: string;
  }>;
  agentTimeTravel: (root: string, sourceRunId: string, branchRunId: string, checkpointIndex?: number) => Promise<{
    ok: boolean; runId?: string; parentRunId?: string; checkpointIndex?: number; requiresReview?: boolean; messageCount?: number; error?: string;
  }>;
  agentChat: (payload: {
    projectRoot: string | null;
    goalId?: string;
    taskId?: string;
    resumeRunId?: string;
    resumeForce?: boolean;
    sessionId?: string;
    memoryConversationId?: string;
    memoryTaskEpoch?: number;
    prompt: string;
    history?: { role: string; content: string }[];
    /** 图片附件（多模态）：仅当所选模型 vision=true 时允许 */
    attachments?: { mime: string; dataUrl: string; name?: string; bytes?: number }[];
    acpContent?: import('./types').AgentAcpContent[];
    canvasSummary?: string;
    nodeId?: string | null;
    requestId?: string;
    autoAdvanceClaimId?: string;
    modelId?: string;
    model?: string;
    reasoningEffort?: string;
    document?: { root?: unknown };
    projectFile?: string;
    /** /compact（照 Codex 的手动压缩命令）：无视窗口阈值，立刻做一次上下文压缩 */
    forceCompact?: boolean;
    /**
     * #7：本条请求自己的中止信号。并发下「停止」必须能精确到某一条请求，
     * 而不是靠一个会被覆盖的全局 requestId。
     */
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    aborted?: boolean;
    reply?: string;
    reasoning?: string;
    toolCalls?: ToolRecordDto[];
    backend?: import('./types').AgentBackendSettings['backend'];
    costUnknown?: boolean;
    usage?: unknown;
    grounding?: {
      semantic?: { status: string; supported: boolean | null; safeForDelivery?: boolean };
      status: 'not_required' | 'valid' | 'missing' | 'invalid';
      valid: boolean;
      required: boolean;
      allowed: string[];
      used: string[];
      invalid: string[];
    };
    error?: string;
    state?: string | null;
    outcome?: { state: string; kind: string; reason: string | null; limitKind: string | null };
    /** 交付形态：'length_truncated' = 回答触到长度上限被截断（不是完整答案） */
    stopReason?: string | null;
    limitKind?: string;
    /** 流式中断后整轮重发的次数（网络/代理中途掉线时 > 0） */
    streamRestarts?: number;
    document?: { root?: unknown };
    cost?: Record<string, unknown>;
    alerts?: AlertDto[];
    resumedFrom?: string;
    needsReview?: boolean;
    /**
     * #21：`needsReview` 时后端**已经**把续跑计划回传了（`electron/ipc/agent.cjs:218-220`
     * 返回 `{ok:false, needsReview:true, plan}`）。修复前类型里没有这个字段，前端连读都读不到，
     * 于是 `reason` / `warning` / `unknownEffects` / `pendingSteps` 被整条丢弃 ——
     * 要求用户「人工复核」却不告诉他复核什么。
     */
    plan?: {
      ok?: boolean;
      runId?: string;
      mode?: 'complete' | 'auto' | 'review' | 'unknown' | string;
      reason?: string | null;
      warning?: string | null;
      error?: string | null;
      requiresReview?: boolean;
      prompt?: string;
      /** 结果未知的外部副作用（工具名 + effect），续跑时系统不会自动重放 */
      unknownEffects?: { tool?: string; effect?: string }[];
      /** 仍待执行的步骤 */
      pendingSteps?: { tool?: string; effect?: string; idemKey?: string | null }[];
      completedSteps?: { tool?: string; idemKey?: string | null; at?: string | null }[];
      /** 幂等账本判定「已提交、续跑时跳过」的写操作 */
      skippedByLedger?: { tool?: string; idemKey?: string | null; reason?: string }[];
    } | null;
    /** 达到迭代/工具调用上限时的结构化收尾（第 2 项）：已完成/失败/涉及文件/是否可续跑 */
    wrapUp?: {
      stopReason?: string;
      executed?: { name: string; ok: number; failed: number }[];
      failed?: { tool: string; code: string; message: string }[];
      touchedFiles?: string[];
      resumable?: boolean;
    };
    /** 上限中止（status 仍是 error，靠它区分「跑不完」与「真的出错」） */
    limitReached?: boolean;
    /** 上下文预算裁剪：被裁掉的工具结果条数与释放的字符数（第 1 项） */
    contextTrims?: number;
    contextTrimmedChars?: number;
    /** 上下文压缩（照 Codex CLI）：本次运行压了几次；摘要与「给模型的信封」供界面折叠旧消息 */
    compacted?: number;
    /** 供应商报超窗后「降级窗口 + 压一次 + 重发」救回来的次数（0 = 没发生） */
    overflowRecoveries?: number;
    contextSummary?: string;
    contextSummaryEnvelope?: string;
  }>;
  stopAgent: (requestId: string) => Promise<{ ok: boolean }>;
  onAgentDelta: (cb: (data: {
    document?: import('./types').SessionDoc;
    content?: any;
    info?: any;
    terminalId?: string;
    output?: string;
    truncated?: boolean;
    exitStatus?: any;
    diff?: string;
    changes?: import('./types').SessionMsg['backendChanges'];
    codeVerification?: import('./types').CodeVerificationReport;
    requestId?: string;
    kind?: string;
    text?: string;
    toolCalls?: unknown;
    toolResult?: unknown;
    error?: string;
    saved?: { filePath?: string };
    fileChange?: { path?: string; kind?: string; detail?: string };
  }) => void) => () => void;
  onToolRequest: (cb: (data: ToolRequestDto) => void) => () => void;
  respondToolRequest: (id: string, result: unknown) => void;
}

interface CostCountersDto {
  requests: number;
  errors: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
  estimated: number;
  latencyMs: number;
}

interface AlertDto {
  ts?: string;
  id: string;
  severity: 'warn' | 'critical' | string;
  message: string;
  value?: number;
  threshold?: number;
}

interface Window {
  codenode?: CodenodeApi;
}
