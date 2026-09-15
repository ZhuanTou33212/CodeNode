import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import Canvas from './components/Canvas';
import ProjectGate from './components/ProjectGate';
import SidePanel from './components/side/SidePanel';
import InspectorBadge from './components/InspectorBadge';
import AddMenu from './components/AddMenu';
import StatusBar from './components/StatusBar';
import { useGraphStore } from './store/graphStore';
import { useUiStore } from './store/uiStore';
import { useProjectStore } from './store/projectStore';
import { newProject, openProject, saveProject, restoreLastProject } from './lib/projectActions';
import { installToolListener } from './lib/toolUi';
import ToolDialog from './components/ToolDialog';
import ModelManager from './components/ModelManager';
import WorkbenchDock from './components/WorkbenchDock';
import { getActiveVectorNode } from './vector/vectorStore';

function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 焦点在画布节点（矢量画布）内部时，工作台快捷键让位给节点自身。 */
function isVectorNodeFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el?.closest?.('.vs-scope'));
}

/** 是否正在进行真正的“文字编辑”，此时 Delete/Backspace 应留给控件。
 *
 *  只按“焦点是不是 input/textarea”判断会误伤：点选节点时焦点常常落在节点内的
 *  非文本控件上（如画布节点的模式按钮 .wf-vector-mode、面板里的 range/checkbox），
 *  用户并没有在编辑文字，Delete 应该删除节点而不是被吞掉。
 *  因此这里做白名单：只认真正的文本录入控件（textarea / 文本类 input / contentEditable）。 */
const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'email', 'password', 'tel', 'number'];

function isTextEditingNow(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.includes(type);
  }
  return el.isContentEditable === true;
}

export default function App() {
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const selectedId = useGraphStore((s) => s.selectedId);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const layoutNodes = useGraphStore((s) => s.layoutNodes);
  const arrangeNodes = useGraphStore((s) => s.arrangeNodes);
  const createScopeFromSelection = useGraphStore((s) => s.createScopeFromSelection);
  const sideOpen = useUiStore((s) => s.sideOpen);
  const dockOpen = useUiStore((s) => s.dockOpen);
  const booted = useUiStore((s) => s.booted);
  const projectRoot = useProjectStore((s) => s.root);
  const { fitView } = useReactFlow();

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => useUiStore.getState().setLastMouse(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, []);

  useEffect(() => {
    void restoreLastProject();
    const uninstall = installToolListener();
    return uninstall;
  }, []);

  // 窄窗口优先保留画布与 Prompt：侧栏改为浮层，过窄时默认收起。
  useEffect(() => {
    let wasNarrow = window.innerWidth <= 860;
    if (wasNarrow && useUiStore.getState().sideOpen) useUiStore.getState().setSideOpen(false);
    const onResize = () => {
      const isNarrow = window.innerWidth <= 860;
      if (isNarrow && !wasNarrow && useUiStore.getState().sideOpen) {
        useUiStore.getState().setSideOpen(false);
      }
      wasNarrow = isNarrow;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // 启动门禁页（还没有工程）：只保留与「取得工程」有关的快捷键。
      // 其余画布快捷键一律不生效——此时既没有工程可保存，也没有 ReactFlow 实例。
      if (!useProjectStore.getState().root) {
        if (mod && e.key.toLowerCase() === 'n') {
          e.preventDefault();
          void newProject();
        } else if (mod && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          void openProject();
        }
        return;
      }

      // 删除选中节点。
      // 与画布节点的分工：焦点落在画布节点内部（.vs-scope）时让位——由画布节点自己的快捷键删图形，
      // 而不是把整个画布节点删掉；焦点不在里面（例如点的是节点标题栏）才删节点本身。
      // 这条规则的两端分别是「选中画布节点后删不掉」和「在画布节点里按 Delete 把节点整个删了」。
      // 画布节点会在指针按下时把焦点收回 .vs-scope（VectorNode.tsx 的 focusBodyOnPointerDown），
      // 所以这里判断焦点归属是可靠的。
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (!isTextEditingNow() && !isVectorNodeFocus()) {
          const st = useGraphStore.getState();
          const ids = st.selectedIds.length ? st.selectedIds : st.selectedId ? [st.selectedId] : [];
          if (ids.length) {
            e.preventDefault();
            deleteNodes(ids);
            return;
          }
        }
      }

      // 选中的是画布节点 / 焦点在矢量画布内时，快捷键交给画布节点处理
      const activeVector = getActiveVectorNode();
      if (activeVector && activeVector === selectedId) return;
      if (isVectorNodeFocus()) return;

      // 全局保存/打开/新建：即使在输入框中也生效
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProject();
        return;
      }

      if (isTypingTarget()) return;

      // Ctrl+B：开合右侧侧栏（对齐 VS Code 的习惯）
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        useUiStore.getState().toggleSide();
        return;
      }

      if (e.code === 'KeyA' && e.shiftKey && !mod) {
        e.preventDefault();
        const m = useUiStore.getState().lastMouse;
        useUiStore.getState().openAddMenu(m.x, m.y);
        return;
      }

      if (e.key === 'Home' || (!mod && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        fitView({ padding: 0.2 });
        return;
      }

      // 删除选中节点已在上方（矢量画布让位之前）统一处理
      if (e.key.toLowerCase() === 'x' && !mod) {
        e.preventDefault();
        if (selectedId) deleteNodes([selectedId]);
        return;
      }

      if (mod && e.key.toLowerCase() === 'j') {
        // Blender 风格：Ctrl+J 把选中的节点“加入”为一个新的范围节点
        e.preventDefault();
        createScopeFromSelection();
      } else if (mod && e.key.toLowerCase() === 'l') {
        // 自动排版属于画布操作，不入撤销历史（撤销只记录节点操作）
        e.preventDefault();
        layoutNodes();
      } else if (mod && e.key.toLowerCase() === 'a' && e.shiftKey) {
        e.preventDefault();
        arrangeNodes();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedId) duplicateNode(selectedId);
      }
    };
    // 用捕获阶段监听：节点内部（如矢量画布面板的按钮 / 输入控件）会在冒泡阶段
    // stopPropagation，一旦焦点落在这些元素上，冒泡阶段的工作台快捷键（含删除）
    // 就会被吞掉 —— 表现就是「选中画布节点后 Delete 没反应」。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo, duplicateNode, selectedId, deleteNodes, fitView, layoutNodes, arrangeNodes, createScopeFromSelection]);

  // 启动引导尚未结束：先显示占位，避免「门禁页 -> 工作台」之间闪一下
  if (!booted) {
    return (
      <div className="gate gate-boot">
        <div className="gate-card">
          <div className="gate-logo">CN</div>
          <h1>CodeNode</h1>
          <p className="gate-sub">正在恢复上次工程…</p>
        </div>
      </div>
    );
  }

  // 强制门禁：没有工程根目录时只渲染启动页，必须先「打开工程」或「新建工程」
  if (!projectRoot) return <ProjectGate />;

  return (
    <div className="app">
      <Toolbar />
      <div className={`app-body side-left${dockOpen ? ' has-dock' : ''}`}>
        {sideOpen ? <SidePanel /> : <InspectorBadge />}
        <Canvas />
        <AddMenu />
        <WorkbenchDock />
      </div>
      <StatusBar />
      <ToolDialog />
      <ModelManager />
    </div>
  );
}
