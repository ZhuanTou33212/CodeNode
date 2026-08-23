import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useChatStore } from '../store/chatStore';

const LAST_ROOT_KEY = 'codenode.lastProjectRoot';
const LAST_FILE_KEY = 'codenode.lastProjectFile';

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

function nameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function buildPayload() {
  const doc = useGraphStore.getState().getDocument();
  return {
    graph: doc.root,
    canvases: { groups: doc.groups, viewStack: doc.viewStack },
    workspace: { viewport: useUiStore.getState().viewport },
    manifest: useProjectStore.getState().doc,
  };
}

function applyLoaded(
  _root: string,
  data?: {
    graph?: { nodes?: unknown[]; edges?: unknown[] };
    canvases?: { groups?: Record<string, { nodes?: unknown[]; edges?: unknown[] }>; viewStack?: string[] };
    workspace?: { viewport?: { x: number; y: number; zoom: number } };
    manifest?: { documentId?: string; createdAt?: string; name?: string };
  }
): void {
  useProjectStore.getState().setDoc(data?.manifest || {});
  if (data?.workspace?.viewport) {
    useUiStore.getState().setPendingViewport(data.workspace.viewport);
  }
  const groups: Record<string, { nodes: unknown[]; edges: unknown[] }> = {};
  for (const [gid, g] of Object.entries(data?.canvases?.groups || {})) {
    groups[gid] = { nodes: (g.nodes as never[]) || [], edges: (g.edges as never[]) || [] };
  }
  useGraphStore.getState().loadDocument({
    root: {
      nodes: ((data?.graph?.nodes as never[]) || []) as never[],
      edges: ((data?.graph?.edges as never[]) || []) as never[],
    },
    groups: groups as never,
    viewStack: data?.canvases?.viewStack || [],
  });
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
  createDefaultAgentDialog();
  useUiStore.getState().setToast('已新建项目：' + nameOf(res.filePath));
}

function createDefaultAgentDialog(): void {
  const st = useGraphStore.getState();
  const hasAgent = st.nodes.some((n) => n.type === 'agent');
  if (hasAgent) return;
  st.addNode({
    id: 'agent-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
    type: 'agent',
    position: { x: 120, y: 120 },
    data: {
      label: 'Agent',
      name: 'CodeNode',
      content: '',
      status: 'pending',
      accent: '#22c55e',
      greeted: false,
      width: 360,
    },
  });
  useChatStore.getState().reset();
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
    const res = await api.saveProject(target, payload);
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

  const res = await api.saveGraph(payload);
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
