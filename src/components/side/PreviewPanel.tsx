import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function fmtTime(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 标签页 3：文件预览（原左侧「项目管理」栏下半部分的独立预览区）。
 * 只读展示选中文件内容；编辑仍需到「编辑」标签的编辑器里进行。
 */
export default function PreviewPanel({ onBack }: { onBack: () => void }) {
  const selected = useProjectStore((s) => s.selected);
  const dirty = useProjectStore((s) => s.dirty);
  const setToast = useUiStore((s) => s.setToast);
  const openDock = useUiStore((s) => s.openDock);

  if (!selected) {
    return (
      <div className="sp-pane">
        <div className="pm-preview-empty">
          尚未选择文件
          <div className="sp-empty-hint">在「项目」标签里点选一个文件，即可在这里查看内容。</div>
          <button className="inspector-btn sp-inline-btn" onClick={onBack}>
            去项目树
          </button>
        </div>
      </div>
    );
  }

  const lines = selected.content ? selected.content.split(/\r?\n/).length : 0;
  const name = selected.relPath.split('/').filter(Boolean).pop() || selected.relPath;
  const time = fmtTime(selected.mtimeMs);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(selected.relPath);
      setToast('已复制相对路径');
    } catch {
      setToast('复制失败（剪贴板不可用）');
    }
  };

  return (
    <div className="sp-pane sp-pane-preview">
      <div className="sp-subhead sp-subhead-col">
        <div className="sp-path" title={selected.relPath}>
          <span className="sp-path-name">{name}</span>
          {dirty && <span className="sp-dirty" title="编辑器中有未保存修改">未保存</span>}
        </div>
        <div className="sp-path-sub">{selected.relPath}</div>
        <div className="fp-actions">
          <button onClick={() => openDock('editor')} title="在底部编辑器中打开">
            编辑
          </button>
          <button onClick={() => void copyPath()} title="复制相对路径">
            复制路径
          </button>
          <button onClick={onBack} title="回到项目树">
            项目树
          </button>
        </div>
      </div>

      <div className="fp-meta">
        <span>{fmtSize(selected.content.length)}</span>
        <span>{lines} 行</span>
        <span>{selected.content.length.toLocaleString()} 字符</span>
        {time && <span>{time}</span>}
      </div>

      {selected.truncated && <div className="pm-preview-note">内容过长，已截断（上限 1MB）</div>}

      <pre className="pm-preview-content fp-content">{selected.content}</pre>
    </div>
  );
}
