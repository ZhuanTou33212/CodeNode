import { useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { newProject, openProject, openProjectFile, saveProject } from '../lib/projectActions';

export default function Toolbar() {
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const canUndo = useGraphStore((s) => s.past.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const { fitView } = useReactFlow();

  return (
    <header className="toolbar">
      <div className="app-brand">
        CodeNode<span className="app-brand-sub">Next</span>
      </div>

      <div className="toolbar-group">
        <button title="新建项目：选择目录并创建空白工作区 (Ctrl+N)" onClick={() => void newProject()}>
          新建
        </button>
        <button title="打开项目目录：载入其中的 workflow.cnode (Ctrl+O)" onClick={() => void openProject()}>
          打开
        </button>
        <button title="打开 .cnode 工程文件" onClick={() => void openProjectFile()}>
          打开文件
        </button>
        <button title="保存到项目 workflow.cnode (Ctrl+S)" onClick={() => void saveProject()}>
          保存
        </button>
      </div>

      <div className="toolbar-group">
        <button title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶ 撤销
        </button>
        <button title="重做 (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
          ↷ 重做
        </button>
      </div>

      <div className="toolbar-group">
        <button
          title="复制节点 (Ctrl+D)"
          disabled={!selectedId}
          onClick={() => selectedId && duplicateNode(selectedId)}
        >
          复制
        </button>
        <button
          title="删除选中 (Del)"
          disabled={!selectedId}
          onClick={() => selectedId && deleteNodes([selectedId])}
        >
          删除
        </button>
        <button title="聚焦全部 (Z)" onClick={() => fitView({ padding: 0.2 })}>
          聚焦
        </button>
      </div>
    </header>
  );
}
