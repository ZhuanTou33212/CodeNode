import { create } from 'zustand';

export type FileNode = {
  name: string;
  relPath: string;
  type: 'file' | 'dir';
  size: number;
  children?: FileNode[];
};

export type SelectedFile = {
  relPath: string;
  content: string;
  truncated: boolean;
  mtimeMs?: number;
};

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

export type DocMeta = {
  documentId?: string;
  createdAt?: string;
  name?: string;
};

interface ProjectState {
  root: string | null;
  projectFile: string | null;
  tree: FileNode[];
  loading: boolean;
  selected: SelectedFile | null;
  draft: string;
  dirty: boolean;
  fileFilter: string;
  searchMatches: SearchMatch[];
  searching: boolean;
  error: string | null;
  doc: DocMeta;

  choose: () => Promise<void>;
  refresh: () => Promise<void>;
  openFile: (relPath: string) => Promise<void>;
  updateDraft: (content: string) => void;
  saveSelected: () => Promise<boolean>;
  revertDraft: () => void;
  setFileFilter: (value: string) => void;
  searchProject: (query: string) => Promise<void>;
  loadRoot: (root: string) => Promise<void>;
  setDoc: (doc: DocMeta) => void;
  setProjectFile: (filePath: string | null) => void;
}

function buildTree(files: { relPath: string; size: number }[]): FileNode[] {
  const root: FileNode[] = [];
  const map = new Map<string, FileNode>();

  for (const f of files) {
    const parts = f.relPath.split('/');
    let cur = root;
    let curPath = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let node = map.get(curPath);
      if (!node) {
        const isFile = i === parts.length - 1;
        node = {
          name: seg,
          relPath: curPath,
          type: isFile ? 'file' : 'dir',
          size: isFile ? f.size : 0,
          children: isFile ? undefined : [],
        };
        map.set(curPath, node);
        cur.push(node);
      }
      if (node.type === 'dir' && node.children) cur = node.children;
      else break;
    }
  }

  const sortNode = (n: FileNode) => {
    if (n.children) {
      n.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      n.children.forEach(sortNode);
    }
  };
  root.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  root.forEach(sortNode);
  return root;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: null,
  projectFile: null,
  tree: [],
  loading: false,
  selected: null,
  draft: '',
  dirty: false,
  fileFilter: '',
  searchMatches: [],
  searching: false,
  error: null,
  doc: {},

  setDoc: (doc) => set({ doc }),
  setProjectFile: (filePath) => set({ projectFile: filePath }),

  choose: async () => {
    if (!window.codenode) {
      set({ error: '需要 Electron 环境' });
      return;
    }
    const res = await window.codenode.chooseProject();
    if (res.ok && res.root) await get().loadRoot(res.root);
  },

  loadRoot: async (root) => {
    set({ root, projectFile: null, loading: true, selected: null, draft: '', dirty: false, searchMatches: [], error: null });
    if (!window.codenode) {
      set({ tree: [], loading: false, error: '需要 Electron 环境' });
      return;
    }
    try {
      const res = await window.codenode.listProject(root);
      if (res.ok && res.files) {
        set({ tree: buildTree(res.files), loading: false });
      } else {
        set({ tree: [], loading: false, error: res.error || '读取失败' });
      }
    } catch (e) {
      set({ tree: [], loading: false, error: String(e) });
    }
  },

  refresh: async () => {
    const root = get().root;
    if (root) await get().loadRoot(root);
  },

  openFile: async (relPath) => {
    const root = get().root;
    if (!root || !window.codenode) return;
    if (get().dirty && get().selected?.relPath !== relPath && !window.confirm('当前文件有未保存修改，确定放弃并打开其他文件吗？')) return;
    const res = await window.codenode.readProjectFile(root, relPath);
    if (res.ok) {
      const content = res.content || '';
      set({ selected: { relPath, content, truncated: !!res.truncated, mtimeMs: res.mtimeMs }, draft: content, dirty: false, error: null });
    } else {
      set({ error: res.error || '读取失败' });
    }
  },

  updateDraft: (content) => set((s) => ({ draft: content, dirty: !!s.selected && content !== s.selected.content })),

  saveSelected: async () => {
    const { root, selected, draft } = get();
    if (!root || !selected || !window.codenode?.writeProjectFile) return false;
    const res = await window.codenode.writeProjectFile(root, selected.relPath, draft, true, selected.mtimeMs);
    if (!res.ok) {
      set({ error: res.conflict ? '文件已被外部修改，请重新打开后再保存' : res.error || '保存文件失败' });
      return false;
    }
    set({ selected: { ...selected, content: draft, truncated: false, mtimeMs: res.mtimeMs }, dirty: false, error: null });
    return true;
  },

  revertDraft: () => set((s) => ({ draft: s.selected?.content || '', dirty: false })),

  setFileFilter: (value) => set({ fileFilter: value }),

  searchProject: async (query) => {
    const root = get().root;
    if (!root || !query.trim() || !window.codenode?.searchProject) {
      set({ searchMatches: [] });
      return;
    }
    set({ searching: true });
    try {
      const res = await window.codenode.searchProject(root, query.trim(), 80);
      set({ searchMatches: res.ok ? res.matches || [] : [], searching: false, error: res.ok ? null : res.error || '搜索失败' });
    } catch (e) {
      set({ searchMatches: [], searching: false, error: String(e) });
    }
  },
}));
