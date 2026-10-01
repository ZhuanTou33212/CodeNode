import type { Graph } from '../types';
import type { FileNode } from '../store/projectStore';

export type TemplateDeps = { kind: 'workflow'; tools: string[]; models: string[]; paths: string[]; sourceProject?: string };

export function parseTemplateDeps(value: unknown): TemplateDeps | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'workflow') return null;
  const list = (item: unknown) => Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === 'string').slice(0, 100).map((entry) => entry.slice(0, 240)) : [];
  return { kind: 'workflow', tools: list(raw.tools), models: list(raw.models), paths: list(raw.paths), sourceProject: typeof raw.sourceProject === 'string' ? raw.sourceProject.slice(0, 120) : undefined };
}

function csv(value: unknown): string[] {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function prepareTemplate(graph: Graph, root: string | null): { graph: Graph; deps: TemplateDeps } {
  const tools = new Set<string>();
  const models = new Set<string>();
  const paths = new Set<string>();
  const nodes = graph.nodes.map((node) => {
    const data = (node.data || {}) as Record<string, unknown>;
    csv(data.requiredTools).forEach((item) => tools.add(item));
    if (data.requiredModel) models.add(String(data.requiredModel).trim());
    csv(data.requiredPaths).forEach((item) => paths.add(item.replace(/\\/g, '/')));
    if (node.type === 'file' && data.filePath) paths.add(String(data.filePath).replace(/\\/g, '/'));
    const { content, dataUrl, ...portable } = data;
    void content; void dataUrl;
    return { ...node, selected: false, data: { ...portable, status: 'pending' } };
  });
  return {
    graph: { nodes, edges: graph.edges },
    deps: { kind: 'workflow', tools: [...tools].sort(), models: [...models].sort(), paths: [...paths].sort(), sourceProject: root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined },
  };
}

export function missingTemplateDeps(deps: TemplateDeps, available: { tools: string[]; models: string[]; tree: FileNode[] }): string[] {
  const toolNames = new Set(available.tools);
  const modelNames = new Set(available.models);
  const files = new Set<string>();
  const walk = (items: FileNode[]) => { for (const item of items) { files.add(item.relPath.replace(/\\/g, '/')); if (item.children) walk(item.children); } };
  walk(available.tree);
  return [
    ...deps.tools.filter((item) => !toolNames.has(item)).map((item) => '工具：' + item),
    ...deps.models.filter((item) => !modelNames.has(item)).map((item) => '模型：' + item),
    ...deps.paths.filter((item) => !files.has(item)).map((item) => '路径：' + item),
  ];
}
