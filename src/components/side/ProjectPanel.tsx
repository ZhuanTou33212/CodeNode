import { memo, useCallback, useMemo, useState } from 'react';
import { useProjectStore, type FileNode } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';
import { openProject } from '../../lib/projectActions';

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.reduce<FileNode[]>((acc, node) => {
    if (node.type === 'file') {
      if (node.relPath.toLowerCase().includes(q)) acc.push(node);
    } else {
      const children = filterTree(node.children || [], query);
      if (children.length || node.name.toLowerCase().includes(q)) acc.push({ ...node, children });
    }
    return acc;
  }, []);
}

function countFiles(nodes: FileNode[]): number {
  return nodes.reduce((n, node) => n + (node.type === 'dir' ? countFiles(node.children || []) : 1), 0);
}

function TreeRow({
  node,
  depth,
  onOpen,
  selectedPath,
  dirty,
}: {
  node: FileNode;
  depth: number;
  onOpen: (p: string) => void;
  selectedPath: string | null;
  dirty: boolean;
}) {
  const [expanded, setExpanded] = useState(node.type === 'dir' && depth < 2);

  if (node.type === 'dir') {
    return (
      <>
        <div
          className="pm-row pm-dir"
          style={{ paddingLeft: 6 + depth * 13 }}
          onClick={() => setExpanded((v) => !v)}
          title={node.relPath}
        >
          <span className={`pm-caret ${expanded ? 'open' : ''}`} />
          <span className="pm-name">{node.name}</span>
          <span className="pm-count">{node.children?.length ?? 0}</span>
        </div>
        {expanded &&
          node.children?.map((c) => (
            <TreeRow
              key={c.relPath}
              node={c}
              depth={depth + 1}
              onOpen={onOpen}
              selectedPath={selectedPath}
              dirty={dirty}
            />
          ))}
      </>
    );
  }

  const isSelected = selectedPath === node.relPath;
  return (
    <div
      className={`pm-row pm-file ${node.relPath.endsWith('.cnode') ? 'pm-file-cnode' : ''} ${isSelected ? 'is-selected' : ''}`}
      style={{ paddingLeft: 19 + depth * 13 }}
      onClick={() => onOpen(node.relPath)}
      title={node.relPath}
    >
      <span className="pm-file-marker" />
      <span className="pm-name">{node.name}</span>
      {isSelected && dirty && (
        <span className="pm-dirty" title="有未保存修改">
          ●
        </span>
      )}
      <span className="pm-size">{fmtSize(node.size)}</span>
    </div>
  );
}

const TreeRowMemo = memo(TreeRow);

/**
 * 标签页 2：项目树（原左侧「项目管理」栏的上半部分）。
 * 点击文件 → 切到「预览」标签显示内容，并同步载入编辑器的草稿。
 */
export default function ProjectPanel({ onOpen }: { onOpen: (relPath: string) => void }) {
  const root = useProjectStore((s) => s.root);
  const projectFile = useProjectStore((s) => s.projectFile);
  const tree = useProjectStore((s) => s.tree);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const selected = useProjectStore((s) => s.selected);
  const dirty = useProjectStore((s) => s.dirty);
  const refresh = useProjectStore((s) => s.refresh);
  const fileFilter = useProjectStore((s) => s.fileFilter);
  const setFileFilter = useProjectStore((s) => s.setFileFilter);
  const openFile = useProjectStore((s) => s.openFile);
  const setSideOpen = useUiStore((s) => s.setSideOpen);

  const visible = useMemo(() => filterTree(tree, fileFilter), [tree, fileFilter]);
  const fileCount = useMemo(() => countFiles(tree), [tree]);
  const rootName = root ? root.split(/[\\/]/).filter(Boolean).pop() : null;
  const fileName = projectFile ? projectFile.split(/[\\/]/).filter(Boolean).pop() : null;

  const handleOpen = useCallback(
    (relPath: string) => {
      void openFile(relPath);
      onOpen(relPath);
    },
    [openFile, onOpen],
  );

  return (
    <div className="sp-pane sp-pane-tree">
      <div className="sp-subhead">
        <div className="sp-path" title={root || ''}>
          <span className="sp-path-name">{fileName || rootName || '未打开项目'}</span>
          {root && <span className="sp-path-meta">{fileCount} 文件</span>}
        </div>
        <div className="pm-actions">
          <button onClick={() => void openProject()} title="选择项目目录">
            {root ? '切换' : '打开'}
          </button>
          {root && (
            <button onClick={() => void refresh()} title="刷新文件树" disabled={loading}>
              刷新
            </button>
          )}
          <button onClick={() => setSideOpen(false)} title="收起侧栏 (Ctrl+B)">
            »
          </button>
        </div>
      </div>

      <div className="pm-search">
        <span aria-hidden>⌕</span>
        <input
          value={fileFilter}
          onChange={(e) => setFileFilter(e.target.value)}
          placeholder="过滤文件…"
          spellCheck={false}
        />
        {fileFilter && (
          <button className="pm-search-clear" title="清除过滤" onClick={() => setFileFilter('')}>
            ×
          </button>
        )}
      </div>

      <div className="pm-tree">
        {!root && <div className="pm-empty">点击「打开」选择项目目录</div>}
        {root && loading && <div className="pm-empty">加载中…</div>}
        {root && !loading && tree.length === 0 && <div className="pm-empty">{error || '目录为空或无文件'}</div>}
        {root && !loading && tree.length > 0 && visible.length === 0 && <div className="pm-empty">没有匹配的文件</div>}
        {root &&
          !loading &&
          visible.map((n) => (
            <TreeRowMemo
              key={n.relPath}
              node={n}
              depth={0}
              onOpen={handleOpen}
              selectedPath={selected?.relPath ?? null}
              dirty={dirty}
            />
          ))}
      </div>
    </div>
  );
}
