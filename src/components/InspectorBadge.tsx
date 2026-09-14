import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore, type SideTab } from '../store/uiStore';

const LABELS: Record<SideTab, string> = {
  agent: 'Agent',
  node: '节点',
  project: '项目',
  preview: '预览',
};

/** 侧栏收起时的入口角标：点开即回到上次使用的标签页 */
export default function InspectorBadge() {
  const tab = useUiStore((s) => s.sideTab);
  const setSideTab = useUiStore((s) => s.setSideTab);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const hasSelection = useGraphStore((s) => !!s.selectedId);
  const hasFile = useProjectStore((s) => !!s.selected);
  const messageCount = useSessionStore((s) => s.messages.length);
  const streaming = useSessionStore((s) => s.streaming);

  const count = tab === 'node' ? nodeCount : tab === 'agent' ? messageCount : hasFile ? 1 : 0;

  return (
    <button
      className="side-badge"
      onClick={() => setSideTab(tab)}
      title="打开侧栏：Agent 对话 / 节点属性 / 项目文件 / 文件预览（Ctrl+B）"
    >
      <span className={`cs-dot ${streaming ? 'cs-dot-running' : ''}`} />
      <span className="ib-label">{LABELS[tab]}</span>
      <span className="ib-count">{count}</span>
      {(tab === 'node' ? hasSelection : hasFile || messageCount > 0) && <span className="ib-dot" />}
    </button>
  );
}
