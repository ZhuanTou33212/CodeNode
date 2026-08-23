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
    groups?: Record<string, ProjectGraphDto>;
    viewStack?: string[];
    sessions?: unknown[];
  };
}

interface ProjectLoadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  canvases?: {
    groups?: Record<string, ProjectGraphDto>;
    viewStack?: string[];
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
  ) => Promise<{ configured: boolean; model: string; soul: { name: string; greeting: string; style: string; raw: string }; toolsEnabled: boolean }>;
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
    document?: { root?: unknown; groups?: Record<string, unknown>; viewStack?: unknown[] };
    projectFile?: string;
  }) => Promise<{
    ok: boolean;
    reply?: string;
    reasoning?: string;
    toolCalls?: ToolRecordDto[];
    usage?: unknown;
    error?: string;
    document?: { root?: unknown; groups?: Record<string, unknown>; viewStack?: unknown[] };
  }>;
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
