import { useGraphStore } from '../store/graphStore';
import { useUiStore } from '../store/uiStore';
import { useToolStore, type ConfirmRequest, type AskRequest } from '../store/toolStore';

/**
 * ui_control 动作执行（渲染进程侧接线）。
 * 返回是否已执行（action 是否被支持）。
 */
export function performUiAction(action: string, args: Record<string, unknown>): boolean {
  const g = useGraphStore.getState();
  const u = useUiStore.getState();
  switch (action) {
    case 'view_all':
      useUiStore.getState().setPendingViewport({ x: 0, y: 0, zoom: 1 });
      return true;
    case 'focus': {
      const nodeId = String(args.nodeId || '');
      if (!nodeId) return false;
      const node = g.nodes.find((n) => n.id === nodeId);
      if (!node) return false;
      const { x, y } = node.position;
      useUiStore.getState().setPendingViewport({ x: -x + 300, y: -y + 200, zoom: 1 });
      g.setSelectedIds([nodeId]);
      return true;
    }
    case 'zoom': {
      const z = Number(args.zoom);
      if (!Number.isFinite(z) || z <= 0) return false;
      const clamped = Math.min(2.5, Math.max(0.25, z));
      useUiStore.getState().setPendingViewport({
        x: useUiStore.getState().viewport.x,
        y: useUiStore.getState().viewport.y,
        zoom: clamped,
      });
      return true;
    }
    case 'pan': {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      useUiStore.getState().setPendingViewport({ x, y, zoom: useUiStore.getState().viewport.zoom || 1 });
      return true;
    }
    case 'resize': {
      // 渲染进程内无法直接改窗口大小（由主进程处理），此处仅切换检查器示意
      const w = Number(args.width);
      const h = Number(args.height);
      void w;
      void h;
      u.setToast('窗口尺寸调整请通过系统窗口控制');
      return false;
    }
    case 'toggle_panel': {
      const panel = String(args.panel || 'inspector');
      if (panel === 'inspector') {
        u.toggleInspector();
        return true;
      }
      return false;
    }
    case 'new_content': {
      const x = Number(args.x);
      const y = Number(args.y);
      const name = String(args.name || '新节点');
      const pos = {
        x: Number.isFinite(x) ? x : 120,
        y: Number.isFinite(y) ? y : 120,
      };
      const id = 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
      g.addNode({
        id,
        type: 'task',
        position: pos,
        data: { label: name, status: 'pending', prompt: '', accent: '#3b82f6' },
      });
      return true;
    }
    default:
      return false;
  }
}

/**
 * 安装工具请求监听：ui 请求就地执行并回包；confirm/ask 推入 toolStore 弹窗。
 */
export function installToolListener(): () => void {
  const api = window.codenode;
  if (!api || !api.onToolRequest) return () => {};
  return api.onToolRequest((req) => {
    if (!req || !req.id) return;
    if (req.type === 'ui') {
      const applied = performUiAction(req.action || '', req.args || {});
      api.respondToolRequest(req.id, { applied });
      return;
    }
    useToolStore.getState().push(req as ConfirmRequest | AskRequest);
  });
}
