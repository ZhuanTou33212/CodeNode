import { useGraphStore } from '../../store/graphStore';
import { useProjectStore } from '../../store/projectStore';
import { useUiStore } from '../../store/uiStore';
import type { FileData, ImageData, ScopeData } from '../../types';
import { flattenFilePaths } from '../../lib/flow';
import FlowList from './FlowList';

/** 标签页 1：选中节点的属性检查器（原独立「检查器」浮层的全部内容） */
export default function NodePanel({ onOpenFile }: { onOpenFile: (relPath: string) => void }) {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const flow = useGraphStore((s) => (s.selectedId ? s.flow[s.selectedId] : undefined));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const runFlow = useGraphStore((s) => s.runFlow);
  const setToast = useUiStore((s) => s.setToast);
  const projectRoot = useProjectStore((s) => s.root);
  const tree = useProjectStore((s) => s.tree);

  // 进入编辑前记录一次快照，使“编辑节点”成为一次可撤销的节点操作
  const beginEdit = () => useGraphStore.getState().commit();

  if (!node) {
    return (
      <div className="sp-pane">
        <div className="inspector-empty">
          未选中节点
          <div className="sp-empty-hint">在画布上点选一个节点，这里会显示它的可编辑属性。</div>
        </div>
      </div>
    );
  }

  const d = node.data as Record<string, unknown> & FileData & ScopeData & ImageData;
  const status = String(d.status || 'pending');
  const isFile = node.type === 'file';
  const isImage = node.type === 'image';
  const isScope = node.type === 'scope';

  const handleReadFile = async () => {
    const root = projectRoot;
    if (!root || !d.filePath) {
      setToast('请先选择项目与文件');
      return;
    }
    if (!window.codenode) return;
    const res = await window.codenode.readProjectFile(root, d.filePath);
    if (res.ok) {
      updateNodeData(node.id, { content: res.content || '' });
      runFlow();
      setToast(`已读取 ${d.filePath}（${(res.content || '').length} 字符）`);
    } else {
      setToast('读取失败：' + (res.error || ''));
    }
  };

  const handleReadImage = async () => {
    const root = projectRoot;
    if (!root || !d.imagePath) {
      setToast('请先选择项目与图片路径');
      return;
    }
    if (!window.codenode) return;
    const res = await window.codenode.readProjectFile(root, d.imagePath, { binary: true });
    if (res.ok && res.dataUrl) {
      updateNodeData(node.id, { dataUrl: res.dataUrl });
      setToast(`已读取图片 ${d.imagePath}（${Math.round((res.bytes || 0) / 1024)}KB）`);
    } else {
      setToast('读取图片失败：' + (res.error || ''));
    }
  };

  return (
    <div className="sp-pane">
      <div className="sp-kv">
        <span>ID</span>
        <code title={node.id}>{node.id}</code>
      </div>
      <div className="sp-kv">
        <span>类型</span>
        <code>{String(node.type)}</code>
      </div>

      <div className="inspector-field">
        <label>名称</label>
        <input value={String(d.label || '')} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { label: e.target.value })} />
      </div>
      <div className="inspector-field">
        <label>状态</label>
        <select value={status} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { status: e.target.value })}>
          {['pending', 'running', 'done', 'failed', 'blocked'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {(node.type === 'task' || node.type === 'stage' || node.type === 'tool') && (
        <div className="inspector-field">
          <label>任务 Prompt</label>
          <textarea
            value={String(d.prompt || '')}
            rows={4}
            placeholder="该节点的执行 prompt…"
            onFocus={beginEdit}
            onChange={(e) => updateNodeData(node.id, { prompt: e.target.value })}
          />
        </div>
      )}

      {node.type === 'object' && (
        <div className="inspector-field">
          <label>对象名称</label>
          <input
            value={String(d.objectName || '')}
            placeholder="对象名称（数据对象/配置对象/实体名）"
            onFocus={beginEdit}
            onChange={(e) => updateNodeData(node.id, { objectName: e.target.value })}
          />
        </div>
      )}

      {isScope && (
        <>
          <div className="inspector-field">
            <label>宽 / 高</label>
            <div className="inspector-row">
              <input
                type="number"
                value={d.width || 320}
                min={160}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { width: Number(e.target.value) })}
              />
              <input
                type="number"
                value={d.height || 220}
                min={120}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { height: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="inspector-field">
            <label>填充颜色（hex）</label>
            <input value={d.fill || '#3b2f6b'} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { fill: e.target.value })} />
          </div>
          <div className="inspector-field">
            <label>不透明度（0–1）</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={d.opacity ?? 0.16}
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { opacity: Number(e.target.value) })}
            />
          </div>
          <div className="inspector-field">
            <label>
              <input
                type="checkbox"
                checked={Boolean(d.shrink)}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { shrink: e.target.checked })}
              />{' '}
              Shrink / 自动收缩
            </label>
          </div>
          <div className="inspector-field">
            <label>说明</label>
            <textarea value={String(d.goal || '')} rows={3} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { goal: e.target.value })} />
          </div>
        </>
      )}

      {isImage && (
        <>
          <div className="inspector-field">
            <label>项目内图片路径（相对路径）</label>
            <input
              value={String(d.imagePath || '')}
              placeholder="例如 assets/logo.png"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { imagePath: e.target.value, dataUrl: undefined })}
            />
          </div>
          {tree.length > 0 && (
            <div className="inspector-field">
              <label>从项目选择图片</label>
              <select
                value={String(d.imagePath || '')}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { imagePath: e.target.value, dataUrl: undefined })}
              >
                <option value="">— 选择 —</option>
                {flattenFilePaths(tree)
                  .filter((p) => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(p))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div className="inspector-field">
            <button className="inspector-btn" onClick={() => void handleReadImage()}>
              读取图片
            </button>
          </div>
          <div className="inspector-field">
            <label>宽 / 高（px）</label>
            <div className="inspector-row">
              <input
                type="number"
                min={120}
                value={d.width || 320}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { width: Number(e.target.value) })}
              />
              <input
                type="number"
                min={100}
                value={d.height || 224}
                onFocus={beginEdit}
                onChange={(e) => updateNodeData(node.id, { height: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="inspector-field">
            <label>说明</label>
            <textarea
              rows={2}
              value={String(d.note || '')}
              placeholder="这张图的用途 / 给 Agent 的提示…"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { note: e.target.value })}
            />
          </div>
          {d.dataUrl ? (
            <div className="inspector-field">
              <label>当前图片（{Math.round(String(d.dataUrl).length / 1024)}KB base64）</label>
              <img className="inspector-image" src={String(d.dataUrl)} alt="节点图片" />
              <button className="inspector-btn" onClick={() => updateNodeData(node.id, { dataUrl: undefined })}>
                清除图片数据
              </button>
            </div>
          ) : (
            <div className="inspector-hint">还没有图片数据：可在画布上直接把图拖进节点，或按 Ctrl+V 粘贴，或填上面的路径后点「读取图片」。</div>
          )}
        </>
      )}

      {isFile && (
        <>
          <div className="inspector-field">
            <label>项目文件（相对路径）</label>
            <input
              value={String(d.filePath || '')}
              placeholder="选择下方文件或手动输入"
              onFocus={beginEdit}
              onChange={(e) => updateNodeData(node.id, { filePath: e.target.value })}
            />
          </div>
          {tree.length > 0 && (
            <div className="inspector-field">
              <label>从项目选择文件</label>
              <select
                value={String(d.filePath || '')}
                onFocus={beginEdit}
                onChange={(e) => {
                  updateNodeData(node.id, { filePath: e.target.value });
                  if (e.target.value) onOpenFile(e.target.value);
                }}
              >
                <option value="">— 选择 —</option>
                {flattenFilePaths(tree).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="inspector-field">
            <button className="inspector-btn" onClick={() => void handleReadFile()}>
              读取文件内容
            </button>
          </div>
          {d.content && (
            <div className="inspector-field">
              <label>内容预览（{d.content.length} 字符）</label>
              <pre className="inspector-pre">
                {d.content.slice(0, 600)}
                {d.content.length > 600 ? '…' : ''}
              </pre>
            </div>
          )}
        </>
      )}

      <FlowList title="数据流 · 输入" items={flow?.input || []} />
      <FlowList title="数据流 · 输出" items={flow?.output || []} />
    </div>
  );
}
