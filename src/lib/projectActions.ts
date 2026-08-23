import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import type { Graph, SessionCanvas, SessionDoc, SessionMsg } from '../types';

const LAST_ROOT_KEY = 'codenode.lastProjectRoot';
const LAST_FILE_KEY = 'codenode.lastProjectFile';

interface SessionPayload {
  id?: string;
  label?: string;
  prompt?: string;
  status?: string;
  createdAt?: number;
  nodeCount?: number;
  summary?: string;
  root?: { nodes?: unknown[]; edges?: unknown[] };
  groups?: Record<string, { nodes?: unknown[]; edges?: unknown[] }>;
  viewStack?: string[];
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

function nameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function buildPayload() {
  const ss = useSessionStore.getState();
  ss.syncActiveGraph();
  const active = ss.current();
  const sessions = ss.order
    .map((id) => ss.sessions[id])
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      label: s.label,
      prompt: s.prompt,
      status: s.status,
      createdAt: s.createdAt,
      nodeCount: s.nodeCount,
      summary: s.summary || '',
      root: s.doc.root,
      groups: s.doc.groups,
      viewStack: s.doc.viewStack,
    }));
  return {
    graph: active ? active.doc.root : { nodes: [], edges: [] },
    canvases: {
      groups: active ? active.doc.groups : {},
      viewStack: active ? active.doc.viewStack : [],
      sessions,
      messages: ss.messages,
    },
    workspace: { viewport: useUiStore.getState().viewport },
    manifest: useProjectStore.getState().doc,
  };
}

async function fetchSoul(root: string | null): Promise<{ raw: string; greeting: string }> {
  try {
    const api = window.codenode;
    if (!api) return { raw: '', greeting: '' };
    const cfg = await api.agentConfig(root);
    const raw = cfg?.soul?.raw || '';
    const greeting = cfg?.soul?.greeting || '';
    return { raw, greeting };
  } catch {
    return { raw: '', greeting: '' };
  }
}

function applyLoaded(
  _root: string,
  data?: {
    graph?: { nodes?: unknown[]; edges?: unknown[] };
    canvases?: {
      groups?: Record<string, { nodes?: unknown[]; edges?: unknown[] }>;
      viewStack?: string[];
      sessions?: unknown[];
      messages?: SessionMsg[];
    };
    workspace?: { viewport?: { x: number; y: number; zoom: number } };
    manifest?: { documentId?: string; createdAt?: string; name?: string };
  }
): void {
  useProjectStore.getState().setDoc(data?.manifest || {});
  if (data?.workspace?.viewport) {
    useUiStore.getState().setPendingViewport(data.workspace.viewport);
  }

  const sessData = data?.canvases?.sessions as SessionPayload[] | undefined;
  const messages = data?.canvases?.messages as SessionMsg[] | undefined;
  const ss = useSessionStore.getState();

  if (sessData && sessData.length) {
    const list: SessionCanvas[] = sessData.map((sd) => ({
      id: sd.id || 'canvas-' + Math.random().toString(36).slice(2, 8),
      label: sd.label || '画布',
      prompt: sd.prompt || '',
      status: sd.status === 'active' || sd.status === 'completed' ? (sd.status as 'active' | 'completed') : 'active',
      createdAt: sd.createdAt || Date.now(),
      nodeCount: sd.nodeCount || 0,
      summary: sd.summary || '',
      doc: {
        root: { nodes: (sd.root?.nodes as never[]) || [], edges: (sd.root?.edges as never[]) || [] } as Graph,
        groups: (sd.groups as never) || {},
        viewStack: (sd.viewStack as never[]) || [],
      } as SessionDoc,
    }));
    ss.restoreSessions(list, messages || [], undefined);
  } else {
    // 旧版单画布：把加载到的图作为首个会话
    const groups: Record<string, Graph> = {};
    for (const [gid, g] of Object.entries(data?.canvases?.groups || {})) {
      groups[gid] = { nodes: (g.nodes as never[]) || [], edges: (g.edges as never[]) || [] };
    }
    const doc: SessionDoc = {
      root: {
        nodes: ((data?.graph?.nodes as never[]) || []) as never[],
        edges: ((data?.graph?.edges as never[]) || []) as never[],
      },
      groups: groups as never,
      viewStack: data?.canvases?.viewStack || [],
    };
    useSessionStore.setState({ sessions: {}, order: [], activeId: null, streaming: false, progress: null });
    void fetchSoul(_root).then(({ raw, greeting }) => {
      const ss2 = useSessionStore.getState();
      if (ss2.order.length) return;
      ss2.restoreSessions(
        [
          {
            id: 'canvas-' + Math.random().toString(36).slice(2, 8),
            label: '画布1',
            prompt: raw,
            status: 'completed',
            createdAt: Date.now(),
            nodeCount: doc.root.nodes.length + Object.values(doc.groups).reduce((n, g) => n + g.nodes.length, 0),
            doc,
          } as SessionCanvas,
        ],
        greeting ? [{ role: 'assistant', content: greeting, status: 'done' } as SessionMsg] : [],
        undefined
      );
    });
  }
}

export async function newProject(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const res = await api.createProject();
  if (!res.ok || !res.filePath) return;
  const root = res.root || dirOf(res.filePath);
  localStorage.setItem(LAST_ROOT_KEY, root);
  localStorage.setItem(LAST_FILE_KEY, res.filePath);
  await useProjectStore.getState().loadRoot(root);
  useProjectStore.getState().setProjectFile(res.filePath);
  useProjectStore.getState().setDoc({});
  useGraphStore.getState().clear();
  const { raw, greeting } = await fetchSoul(root);
  useSessionStore.getState().initProject(greeting || raw, raw);
  useUiStore.getState().setToast('已新建项目：' + nameOf(res.filePath));
}

export async function openProject(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const res = await api.chooseProject();
  if (!res.ok || !res.root) return;
  localStorage.setItem(LAST_ROOT_KEY, res.root);
  localStorage.removeItem(LAST_FILE_KEY);
  await useProjectStore.getState().loadRoot(res.root);
  const lr = await api.loadProject(res.root);
  if (lr.ok && lr.data && lr.filePath) {
    localStorage.setItem(LAST_FILE_KEY, lr.filePath);
    useProjectStore.getState().setProjectFile(lr.filePath);
    applyLoaded(res.root, lr.data);
    const warn = lr.data.warnings?.length ? '（' + lr.data.warnings.join('；') + '）' : '';
    useUiStore.getState().setToast('已打开项目：' + nameOf(lr.filePath) + warn);
  } else {
    useGraphStore.getState().clear();
    const { raw, greeting } = await fetchSoul(res.root);
    useSessionStore.getState().initProject(greeting || raw, raw);
    useUiStore.getState().setToast('已打开项目目录（无 .cnode 工程文件）：' + res.root);
  }
}

export async function openProjectFile(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const res = await api.openGraph();
  if (!res.ok || !res.filePath) return;
  if (res.error) {
    useUiStore.getState().setToast('打开失败：' + res.error);
    return;
  }
  const root = dirOf(res.filePath);
  localStorage.setItem(LAST_ROOT_KEY, root);
  localStorage.setItem(LAST_FILE_KEY, res.filePath);
  await useProjectStore.getState().loadRoot(root);
  useProjectStore.getState().setProjectFile(res.filePath);
  if (res.data) applyLoaded(root, res.data);
  const warn = res.data?.warnings?.length ? '（' + res.data.warnings.join('；') + '）' : '';
  useUiStore.getState().setToast('已打开工程文件：' + res.filePath + warn);
}

export async function saveProject(): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const projectFile = useProjectStore.getState().projectFile;
  const root = useProjectStore.getState().root;
  let payload;
  try {
    payload = buildPayload();
  } catch (e) {
    useUiStore.getState().setToast('保存失败（序列化错误）：' + String(e));
    return;
  }

  const target = projectFile || root;
  if (target) {
    let res;
    try {
      res = await api.saveProject(target, payload);
    } catch (e) {
      useUiStore.getState().setToast('保存失败（IPC 异常）：' + String(e));
      return;
    }
    if (res.ok && res.filePath) {
      useProjectStore.getState().setProjectFile(res.filePath);
      localStorage.setItem(LAST_FILE_KEY, res.filePath);
      localStorage.setItem(LAST_ROOT_KEY, dirOf(res.filePath));
      useUiStore.getState().setToast('已保存：' + res.filePath);
    } else {
      useUiStore.getState().setToast('保存失败：' + (res.error || '未知错误'));
    }
    return;
  }

  let res;
  try {
    res = await api.saveGraph(payload);
  } catch (e) {
    useUiStore.getState().setToast('保存失败（IPC 异常）：' + String(e));
    return;
  }
  if (res.ok && res.filePath) {
    localStorage.setItem(LAST_FILE_KEY, res.filePath);
    localStorage.setItem(LAST_ROOT_KEY, dirOf(res.filePath));
    useProjectStore.getState().setProjectFile(res.filePath);
    await useProjectStore.getState().loadRoot(dirOf(res.filePath));
    useUiStore.getState().setToast('已保存：' + res.filePath);
  } else {
    useUiStore.getState().setToast('已取消保存');
  }
}

export function restoreLastProject(): void {
  if (!window.codenode) return;
  const lastFile = localStorage.getItem(LAST_FILE_KEY);
  const lastRoot = localStorage.getItem(LAST_ROOT_KEY);
  const target = lastFile || lastRoot;
  if (!target) return;
  const api = window.codenode;
  const root = lastFile ? dirOf(lastFile) : lastRoot;
  void useProjectStore.getState().loadRoot(root || '');
  void api.loadProject(target).then((lr) => {
    if (lr.ok && lr.data && lr.filePath) {
      useProjectStore.getState().setProjectFile(lr.filePath);
      applyLoaded(root || '', lr.data);
    }
  });
}
