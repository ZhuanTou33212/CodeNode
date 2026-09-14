import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useSessionStore } from '../store/sessionStore';
import { useCheckpointStore, type Checkpoint } from '../store/checkpointStore';
import { readRecentProjects, rememberRecentProject } from './recentProjects';
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
    }));
  return {
    graph: active ? active.doc.root : { nodes: [], edges: [] },
    canvases: {
      sessions,
      messages: ss.messages,
    },
    workspace: { viewport: useUiStore.getState().viewport },
    manifest: useProjectStore.getState().doc,
    checkpoints: useCheckpointStore.getState().items,
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
      sessions?: unknown[];
      messages?: SessionMsg[];
    };
    workspace?: { viewport?: { x: number; y: number; zoom: number } };
    manifest?: { documentId?: string; createdAt?: string; name?: string };
    checkpoints?: unknown[];
  }
): void {
  useProjectStore.getState().setDoc(data?.manifest || {});
  useCheckpointStore.getState().setProjectRoot(_root, (data?.checkpoints || []) as Checkpoint[]);
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
      } as SessionDoc,
    }));
    ss.restoreSessions(list, messages || [], undefined);
  } else {
    // 旧版单画布：把加载到的图作为首个会话（忽略其中的组节点与组图）
    const doc: SessionDoc = {
      root: {
        nodes: ((data?.graph?.nodes as never[]) || []).filter((n) => {
          const t = (n as { type?: string } | null)?.type;
          return t !== 'group' && t !== 'group-input' && t !== 'group-output';
        }) as never[],
        edges: ((data?.graph?.edges as never[]) || []) as never[],
      },
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
            nodeCount: doc.root.nodes.length,
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
  rememberRecentProject({ root, file: res.filePath });
  await useProjectStore.getState().loadRoot(root);
  useCheckpointStore.getState().setProjectRoot(root, []);
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
  rememberRecentProject({ root: res.root });
  await useProjectStore.getState().loadRoot(res.root);
  useCheckpointStore.getState().setProjectRoot(res.root);
  const lr = await api.loadProject(res.root);
  if (lr.ok && lr.data && lr.filePath) {
    localStorage.setItem(LAST_FILE_KEY, lr.filePath);
    rememberRecentProject({ root: res.root, file: lr.filePath });
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
  rememberRecentProject({ root, file: res.filePath });
  await useProjectStore.getState().loadRoot(root);
  useCheckpointStore.getState().setProjectRoot(root);
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
      rememberRecentProject({ root: dirOf(res.filePath), file: res.filePath });
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

/**
 * 启动时恢复上次打开的工程。
 *
 * 需求变更：不再自动进入最近打开的工程，而是停在门禁页，
 * 由用户在「最近打开」列表里自己选择（见 ProjectGate）。
 * 这里只负责结束启动引导（置 booted），让门禁页接管。
 */
export async function restoreLastProject(): Promise<void> {
  try {
    if (!window.codenode) return;
    // 兼容旧版本：把单条"上次打开"迁移进最近列表（只做迁移，不自动打开）
    readRecentProjects();
  } catch (e) {
    console.error('[CodeNode] 读取最近工程失败:', e);
  } finally {
    useUiStore.getState().setBooted(true);
  }
}

/**
 * 打开一条「最近打开」记录：优先加载 .cnode 文件，只有目录时按目录打开。
 */
export async function openRecentProject(entry: { root: string; file?: string; name?: string }): Promise<void> {
  const api = window.codenode;
  if (!api) {
    useUiStore.getState().setToast('需要 Electron 环境');
    return;
  }
  const target = entry.file || entry.root;
  if (!target) return;

  const root = entry.file ? dirOf(entry.file) : entry.root;
  await useProjectStore.getState().loadRoot(root);
  const st = useProjectStore.getState();
  if (!st.root) {
    useUiStore.getState().setToast('打开失败：' + (st.error || '目录不可用'));
    return;
  }

  if (entry.file) {
    const lr = await api.loadProject(entry.file);
    if (lr.ok && lr.data) {
      useProjectStore.getState().setProjectFile(lr.filePath || entry.file);
      useCheckpointStore.getState().setProjectRoot(root);
      applyLoaded(root, lr.data);
      rememberRecentProject({ root, file: lr.filePath || entry.file });
      useUiStore.getState().setToast('已打开最近工程：' + nameOf(lr.filePath || entry.file));
      return;
    }
    useUiStore.getState().setToast('该工程文件已不可用，已按目录打开：' + (lr.error || ''));
  }

  const lr2 = await api.loadProject(root);
  if (lr2.ok && lr2.data && lr2.filePath) {
    useProjectStore.getState().setProjectFile(lr2.filePath);
    useCheckpointStore.getState().setProjectRoot(root);
    applyLoaded(root, lr2.data);
    rememberRecentProject({ root, file: lr2.filePath });
    useUiStore.getState().setToast('已打开最近工程：' + nameOf(lr2.filePath));
    return;
  }
  useGraphStore.getState().clear();
  const { raw, greeting } = await fetchSoul(root);
  useSessionStore.getState().initProject(greeting || raw, raw);
  useCheckpointStore.getState().setProjectRoot(root, []);
  rememberRecentProject({ root });
  useUiStore.getState().setToast('已打开最近工程目录（无 .cnode 工程文件）：' + root);
}
