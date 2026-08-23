import { useState } from 'react';
import { useProjectStore, type FileNode } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { openProject } from '../lib/projectActions';

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

function TreeRow({
  node,
  depth,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  onOpen: (p: string) => void;
}) {
  const [expanded, setExpanded] = useState(node.type === 'dir' && depth < 2);

  if (node.type === 'dir') {
    return (
      <>
        <div
          className="pm-row pm-dir"
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => setExpanded((v) => !v)}
          title={node.relPath}
        >
          <span className={`pm-caret ${expanded ? 'open' : ''}`} />
          <span className="pm-name">{node.name}</span>
          <span className="pm-count">{node.children?.length ?? 0}</span>
        </div>
        {expanded &&
          node.children?.map((c) => <TreeRow key={c.relPath} node={c} depth={depth + 1} onOpen={onOpen} />)}
      </>
    );
  }

  return (
    <div
      className={`pm-row pm-file ${node.relPath.endsWith('.cnode') ? 'pm-file-cnode' : ''}`}
      style={{ paddingLeft: 20 + depth * 14 }}
      onClick={() => onOpen(node.relPath)}
      title={node.relPath}
    >
      <span className="pm-file-marker" />
      <span className="pm-name">{node.name}</span>
      <span className="pm-size">{fmtSize(node.size)}</span>
    </div>
  );
}

export default function ProjectManager() {
  const leftOpen = useUiStore((s) => s.leftOpen);
  const leftWidth = useUiStore((s) => s.leftWidth);
  const toggleLeft = useUiStore((s) => s.toggleLeft);
  const setLeftWidth = useUiStore((s) => s.setLeftWidth);

  const root = useProjectStore((s) => s.root);
  const projectFile = useProjectStore((s) => s.projectFile);
  const tree = useProjectStore((s) => s.tree);
  const loading = useProjectStore((s) => s.loading);
  const selected = useProjectStore((s) => s.selected);
  const error = useProjectStore((s) => s.error);
  const refresh = useProjectStore((s) => s.refresh);
  const openFile = useProjectStore((s) => s.openFile);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => setLeftWidth(startW + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!leftOpen) {
    return (
      <aside className="project-collapsed">
        <button className="pm-collapse-btn" title="展开项目管理器" onClick={toggleLeft}>
          »
        </button>
      </aside>
    );
  }

  const rootName = root ? root.split(/[\\/]/).filter(Boolean).pop() : null;
  const fileName = projectFile ? projectFile.split(/[\\/]/).filter(Boolean).pop() : null;

  return (
    <aside className="project-manager" style={{ width: leftWidth }}>
      <header className="pm-header">
        <div className="pm-header-top">
          <span className="panel-title">项目管理</span>
          <div className="pm-actions">
            <button onClick={() => void openProject()} title="选择项目目录">
              {root ? '切换' : '打开项目'}
            </button>
            {root && (
              <button onClick={refresh} title="刷新">
                刷新
              </button>
            )}
            <button onClick={toggleLeft} title="收起面板">
              «
            </button>
          </div>
        </div>
        <div className="pm-root" title={root || ''}>
          {fileName ? `${fileName}` : rootName ? `${rootName}` : '未打开项目'}
        </div>
      </header>

      <div className="pm-body">
        <div className="pm-tree">
          {!root && <div className="pm-empty">点击「打开项目」选择目录</div>}
          {root && loading && <div className="pm-empty">加载中…</div>}
          {root && !loading && tree.length === 0 && (
            <div className="pm-empty">{error || '目录为空或无文件'}</div>
          )}
          {root &&
            !loading &&
            tree.map((n) => <TreeRow key={n.relPath} node={n} depth={0} onOpen={openFile} />)}
        </div>

        <div className="pm-preview">
          {selected ? (
            <>
              <div className="pm-preview-title" title={selected.relPath}>
                {selected.relPath}
              </div>
              {selected.truncated && (
                <div className="pm-preview-note">内容过长，已截断（上限 1MB）</div>
              )}
              <pre className="pm-preview-content">{selected.content}</pre>
            </>
          ) : (
            <div className="pm-preview-empty">点击文件查看内容</div>
          )}
        </div>
      </div>

      <div className="pm-resize" onMouseDown={startResize} title="拖动调整宽度" />
    </aside>
  );
}
