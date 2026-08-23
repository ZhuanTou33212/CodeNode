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
}

interface ProjectLoadDto {
  graph?: ProjectGraphDto;
  workspace?: ProjectWorkspaceDto;
  manifest?: ProjectManifestDto;
  warnings?: string[];
}

interface ProjectFileDto {
  relPath: string;
  size: number;
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
}

interface Window {
  codenode?: CodenodeApi;
}
