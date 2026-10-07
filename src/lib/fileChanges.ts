import type { ToolRecord } from '../types';

type Data = Record<string, unknown>;
export type FileReview = { diff: string; added?: number; removed?: number; truncated: boolean };
export type FileChange = { path: string; reviews: FileReview[] };
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const argsOf = (tool: ToolRecord): Data => {
  if (typeof tool.args !== 'string') return object(tool.args);
  try { return object(JSON.parse(tool.args)); } catch { return {}; }
};
function relativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return !path || /[\0\r\n]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') ? null : path;
}
export function summarizeFileChanges(tools: ToolRecord[], observed: string[] = []): FileChange[] {
  const files = new Map<string, FileChange>();
  const unchanged = new Set<string>();
  const add = (value: unknown, review?: Data) => {
    const path = relativePath(value);
    if (!path) return;
    if (review && typeof review.beforeSha256 === 'string' && review.beforeSha256 === review.afterSha256) { unchanged.add(path); return; }
    const file: FileChange = files.get(path) || { path, reviews: [] };
    if (review && typeof review.diff === 'string' && review.diff) {
      const preview = { diff: review.diff, added: typeof review.addedLines === 'number' ? review.addedLines : undefined,
        removed: typeof review.removedLines === 'number' ? review.removedLines : undefined, truncated: review.truncated === true };
      if (!file.reviews.some(item => item.diff === preview.diff)) file.reviews.push(preview);
    }
    files.set(path, file);
  };
  for (const tool of tools) {
    if (tool.ok !== true) continue;
    const data = object(tool.data), args = argsOf(tool);
    if (tool.name === 'write_file' || tool.name === 'edit_file') add(data.path || args.path, object(data.review));
    else if (tool.name === 'write_analysis_md') add(data.relativePath || args.relativePath);
    else if (tool.name === 'bulk_edit' && data.action === 'create_files' && Array.isArray(data.written)) data.written.forEach(path => add(path));
  }
  for (const path of observed) if (!unchanged.has(path.replace(/\\/g, '/').replace(/^\.\//, ''))) add(path);
  return [...files.values()];
}
