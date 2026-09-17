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
}

interface ProjectPayloadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    sessions?: unknown[];
  };
  checkpoints?: unknown[];
}

interface ProjectLoadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    sessions?: unknown[];
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
  type: 'confirm' | 'ask' | 'ui' | 'cancel';
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
  contextWindow: number;
  priceInput: number;
  priceInputHit: number;
  priceOutput: number;
  supportsEffort: boolean;
  /** 是否支持图片输入（多模态） */
  vision?: boolean;
  enabled?: boolean;
}

interface CodenodeApi {
  saveGraph: (payload: ProjectPayloadDto) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  openGraph: () => Promise<{ ok: boolean; filePath?: string; data?: ProjectLoadDto; error?: string }>;
  chooseProject: () => Promise<{ ok: boolean; root?: string }>;
  createProject: () => Promise<{ ok: boolean; filePath?: string; root?: string }>;
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
  listExtensions: (root: string | null) => Promise<{ ok: boolean; extensions?: ProjectExtensionDto[]; error?: string }>;
  saveProject: (target: string, payload: ProjectPayloadDto) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  loadProject: (target: string) => Promise<{ ok: boolean; filePath?: string; data?: ProjectLoadDto; error?: string }>;
  agentConfig: (
    root: string | null
  ) => Promise<{
    configured: boolean;
    model: string;
    soul: { name: string; greeting: string; style: string; raw: string };
    toolsEnabled: boolean;
    ragEnabled: boolean;
    models?: ModelSpecDto[];
    activeModelId?: string | null;
  }>;
  modelsList: () => Promise<{ models: ModelSpecDto[]; activeId: string | null }>;
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
    startedAt: string | null;
    finishedAt: string | null;
    eventCount: number;
  }>>;
  agentResumePlan: (root: string | null, runId: string) => Promise<{
    ok: boolean;
    mode?: 'complete' | 'auto' | 'review' | 'unknown';
    requiresReview?: boolean;
    runId?: string;
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
  }>;
  agentMetrics: (root: string | null) => Promise<{
    ok: boolean;
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
  agentChat: (payload: {
    projectRoot: string | null;
    resumeRunId?: string;
    resumeForce?: boolean;
    prompt: string;
    history?: { role: string; content: string }[];
    /** 图片附件（多模态）：仅当所选模型 vision=true 时允许 */
    attachments?: { mime: string; dataUrl: string; name?: string; bytes?: number }[];
    canvasSummary?: string;
    nodeId?: string | null;
    requestId?: string;
    modelId?: string;
    model?: string;
    reasoningEffort?: string;
    document?: { root?: unknown };
    projectFile?: string;
    /** /compact（照 Codex 的手动压缩命令）：无视窗口阈值，立刻做一次上下文压缩 */
    forceCompact?: boolean;
  }) => Promise<{
    ok: boolean;
    aborted?: boolean;
    reply?: string;
    reasoning?: string;
    toolCalls?: ToolRecordDto[];
    usage?: unknown;
    grounding?: {
      status: 'not_required' | 'valid' | 'missing' | 'invalid';
      valid: boolean;
      required: boolean;
      allowed: string[];
      used: string[];
      invalid: string[];
    };
    error?: string;
    /** 交付形态：'length_truncated' = 回答触到长度上限被截断（不是完整答案） */
    stopReason?: string | null;
    /** 流式中断后整轮重发的次数（网络/代理中途掉线时 > 0） */
    streamRestarts?: number;
    document?: { root?: unknown };
    cost?: Record<string, unknown>;
    alerts?: AlertDto[];
    resumedFrom?: string;
    needsReview?: boolean;
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
