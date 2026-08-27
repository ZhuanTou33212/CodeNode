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
}

interface ProjectLoadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    sessions?: unknown[];
  };
  warnings?: string[];
}

interface ProjectFileDto {
  relPath: string;
  size: number;
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
  type: 'confirm' | 'ask' | 'ui';
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
  contextWindow: number;
  priceInput: number;
  priceInputHit: number;
  priceOutput: number;
  supportsEffort: boolean;
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
    relPath: string
  ) => Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }>;
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
  agentChat: (payload: {
    projectRoot: string | null;
    prompt: string;
    history?: { role: string; content: string }[];
    canvasSummary?: string;
    nodeId?: string | null;
    requestId?: string;
    modelId?: string;
    model?: string;
    reasoningEffort?: string;
    document?: { root?: unknown };
    projectFile?: string;
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
    document?: { root?: unknown };
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

interface Window {
  codenode?: CodenodeApi;
}
