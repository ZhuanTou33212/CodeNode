/**
 * 最近打开的工程（localStorage）。
 *
 * 启动了「不再自动进入最近项目」之后，门禁页需要一份最近列表让用户一键进入，
 * 这里统一维护：{ root, file?, name, openedAt }。
 *   - root：工程目录（必填）
 *   - file：该工程的 .cnode 文件路径（可选；有它就能直接加载工程内容）
 */
export type RecentProject = {
  root: string;
  file?: string;
  name: string;
  openedAt: number;
};

const KEY = 'codenode.recentProjects';
const MAX = 8;
const LEGACY_ROOT = 'codenode.lastProjectRoot';
const LEGACY_FILE = 'codenode.lastProjectFile';

function nameOf(p: string): string {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(p || '');
}

function dirOf(filePath: string): string {
  return String(filePath || '').replace(/[\\/][^\\/]*$/, '');
}

function sameProject(a: RecentProject, b: RecentProject): boolean {
  const norm = (s?: string) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  if (norm(a.file) && norm(b.file)) return norm(a.file) === norm(b.file);
  return norm(a.root) === norm(b.root);
}

export function readRecentProjects(): RecentProject[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list
          .filter((x) => x && typeof x.root === 'string' && x.root)
          .map((x) => ({
            root: String(x.root),
            file: x.file ? String(x.file) : undefined,
            name: String(x.name || nameOf(x.file || x.root)),
            openedAt: Number(x.openedAt) || 0,
          }))
          .slice(0, MAX);
      }
    }
  } catch {
    /* 解析失败当空处理 */
  }
  // 迁移旧版本的单条"上次打开"记录
  try {
    const legacyRoot = localStorage.getItem(LEGACY_ROOT);
    const legacyFile = localStorage.getItem(LEGACY_FILE);
    if (legacyRoot || legacyFile) {
      const root = legacyRoot || dirOf(legacyFile || '');
      const entry: RecentProject = {
        root,
        file: legacyFile || undefined,
        name: nameOf(legacyFile || root),
        openedAt: Date.now(),
      };
      writeRecent({ list: [entry], entry });
      return [entry];
    }
  } catch {
    /* ignore */
  }
  return [];
}

function writeRecent(payload: { list: RecentProject[]; entry?: RecentProject }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(payload.list.slice(0, MAX)));
  } catch {
    /* ignore */
  }
}

/** 记一条最近打开（同一工程会提到最前） */
export function rememberRecentProject(input: { root?: string | null; file?: string | null; name?: string }): void {
  if (typeof localStorage === 'undefined') return;
  const file = input.file || undefined;
  const root = input.root || (file ? dirOf(file) : '');
  if (!root && !file) return;
  const entry: RecentProject = {
    root: root || dirOf(file || ''),
    file,
    name: input.name || nameOf(file || root),
    openedAt: Date.now(),
  };
  const list = [entry, ...readRecentProjects().filter((x) => !sameProject(x, entry))];
  writeRecent({ list, entry });
  void window.codenode?.recentProjectsRemember?.(entry).catch(() => {});
}

/** 从主进程的 userData 恢复持久记录，并与当前来源的 localStorage 缓存合并。 */
export async function loadRecentProjects(): Promise<RecentProject[]> {
  const local = readRecentProjects();
  const api = typeof window !== 'undefined' ? window.codenode : null;
  if (!api?.recentProjectsList) return local;
  try {
    // 先把旧版本仅存在 localStorage 的记录迁移到稳定存储。
    for (const entry of [...local].reverse()) await api.recentProjectsRemember(entry);
    const result = await api.recentProjectsList();
    if (!result?.ok) return local;
    const persisted = (result.projects || []).map(entry => ({ ...entry, openedAt: Number(entry.openedAt) || 0 }));
    const merged: RecentProject[] = [];
    for (const entry of [...persisted, ...local].sort((a, b) => b.openedAt - a.openedAt)) if (!merged.some(item => sameProject(item, entry))) merged.push(entry);
    writeRecent({ list: merged });
    return merged.slice(0, MAX);
  } catch { return local; }
}

export function forgetRecentProject(target: { root?: string; file?: string }): RecentProject[] {
  const key: RecentProject = {
    root: target.root || (target.file ? dirOf(target.file) : ''),
    file: target.file,
    name: '',
    openedAt: 0,
  };
  const list = readRecentProjects().filter((x) => !sameProject(x, key));
  writeRecent({ list });
  void window.codenode?.recentProjectsForget?.(target).catch(() => {});
  return list;
}

export function clearRecentProjects(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(KEY);
    void window.codenode?.recentProjectsClear?.().catch(() => {});
  } catch {
    /* ignore */
  }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export { nameOf as projectNameOf, dirOf as projectDirOf };
