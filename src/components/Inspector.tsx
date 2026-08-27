import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import { flattenFilePaths } from '../lib/flow';
import type { FileData, ScopeData } from '../types';

function FlowList({ title, items }: { title: string; items: { kind: string; label: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="inspector-field">
      <label>{title}（{items.length} 项）</label>
      <ul className="flow-list">
        {items.map((it, i) => (
          <li key={i}>
            <span className="flow-kind">{it.kind}</span>
            <span className="flow-label">{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Inspector() {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const flow = useGraphStore((s) => (s.selectedId ? s.flow[s.selectedId] : undefined));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const runFlow = useGraphStore((s) => s.runFlow);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setToast = useUiStore((s) => s.setToast);
  const projectRoot = useProjectStore((s) => s.root);
  const tree = useProjectStore((s) => s.tree);

  // 进入编辑前记录一次快照，使“编辑节点”成为一次可撤销的节点操作
  const beginEdit = () => useGraphStore.getState().commit();

  const header = (
    <div className="inspector-header">
      <span className="panel-title">检查器</span>
      <button className="icon-btn" title="收起检查器" onClick={toggleInspector}>
        »
      </button>
    </div>
  );

  if (!node) {
    return (
      <aside className="inspector">
        {header}
        <div className="inspector-empty">未选中节点</div>
      </aside>
    );
  }

  const d = node.data as Record<string, unknown> & FileData & ScopeData;
  const status = String(d.status || 'pending');
  const isFile = node.type === 'file';
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

  return (
    <aside className="inspector">
      {header}
      <div className="inspector-field">
        <label>ID</label>
        <input value={node.id} readOnly />
      </div>
      <div className="inspector-field">
        <label>类型</label>
        <input value={String(node.type)} readOnly />
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
            <label>说明</label>
            <textarea value={String(d.goal || '')} rows={3} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { goal: e.target.value })} />
          </div>
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
              <select value={String(d.filePath || '')} onFocus={beginEdit} onChange={(e) => updateNodeData(node.id, { filePath: e.target.value })}>
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
              <pre className="inspector-pre">{d.content.slice(0, 600)}{d.content.length > 600 ? '…' : ''}</pre>
            </div>
          )}
        </>
      )}

      <FlowList title="数据流 · 输入" items={flow?.input || []} />
      <FlowList title="数据流 · 输出" items={flow?.output || []} />
    </aside>
  );
}