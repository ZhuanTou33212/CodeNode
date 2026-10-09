export interface TrellisDiagnostic { source: string; error: string }
export interface TrellisProposal {
  id: string; kind: string; status: string; error: string | null; applied: string[];
  files: {source: string; before: string | null; beforeHash: string; after: string; afterHash: string}[];
  details: Record<string, unknown>;
}
export interface TrellisDocument { source: string; fingerprint: string; content: string; stages: string[] }
export interface TrellisTask { taskPath: string; id: string; title: string; status: string; source: string; fingerprint: string }
export interface TrellisProject { detected: boolean; tasks: TrellisTask[]; diagnostics: TrellisDiagnostic[]; readOnly: boolean; referenceVersion: string; selectedTask: string | null }
export interface TrellisContext {
  task: TrellisTask; documents: TrellisDocument[]; diagnostics: TrellisDiagnostic[]; ready: boolean; fingerprint: string; tokens: number;
  runs: { runId: string; status: string; sourcesChanged: string[]; verification: { status?: string; verified?: boolean; scope?: string; checks?: unknown[] } | null; evidenceFresh: boolean }[];
}
