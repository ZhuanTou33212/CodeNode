import { useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { liveWrapNodes, childIdsOf } from './flow';

function boxesOverlap(a: Node, b: Node, pad: number): boolean {
  const aw = (a.measured?.width as number) || 88;
  const ah = (a.measured?.height as number) || 64;
  const bw = (b.measured?.width as number) || 88;
  const bh = (b.measured?.height as number) || 64;
  return (
    a.position.x - pad < b.position.x + bw &&
    a.position.x + aw + pad > b.position.x &&
    a.position.y - pad < b.position.y + bh &&
    a.position.y + ah + pad > b.position.y
  );
}

function centerInsideScope(scope: Node, node: Node): boolean {
  const d = scope.data as { width?: number; height?: number };
  const sw = d.width || 320;
  const sh = d.height || 220;
  const w = (node.measured?.width as number) || 88;
  const h = (node.measured?.height as number) || 64;
  const cx = node.position.x + w / 2;
  const cy = node.position.y + h / 2;
  return cx >= scope.position.x && cx <= scope.position.x + sw && cy >= scope.position.y && cy <= scope.position.y + sh;
}

/**
 * 容器边框自适应（范围节点）：
 * - 实时跟随（16ms 防抖）
 * - 显式成员 + 当前正在拖入的候选节点作为包围目标
 * - 已有成员向外拖出时不再强行扩大范围（避免“越拖越大”），松手后由状态机移出
 * - 新候选拖入时允许范围扩大以预览包裹
 * - 拖动中允许收缩，成员往内收时范围节点会跟着收小
 */
export function useContainerAutoFit(id: string, nodes: Node[], minW: number, minH: number, pad: number): void {
  const draggingIds = useGraphStore((s) => s.draggingIds);
  const resizingIds = useGraphStore((s) => s.resizingIds);
  const dragging = draggingIds.length > 0;
  const scopeDragging = draggingIds.includes(id);
  const resizing = resizingIds.includes(id);

  useEffect(() => {
    const timer = setTimeout(() => {
      const st = useGraphStore.getState();
      const node = st.nodes.find((n) => n.id === id);
      if (!node) return;
      if ((node.data as { collapsed?: boolean })?.collapsed) return;
      if (st.resizingIds.includes(id)) return;

      const wrapSet = new Map<string, Node>();
      for (const c of liveWrapNodes(node, st.nodes)) wrapSet.set(c.id, c);

      // 拖动中的节点：
      // - 已是成员：只有中心仍在 scope 内才参与自适应（用于收缩），拖出后不再追着扩大
      // - 非成员：只要接近/相交就作为候选，允许范围先预览包裹
      for (const did of draggingIds) {
        const dn = st.nodes.find((n) => n.id === did);
        if (!dn || dn.id === id) continue;
        const isMember = childIdsOf(node).includes(dn.id);
        if (isMember) {
          if (centerInsideScope(node, dn)) wrapSet.set(dn.id, dn);
        } else if (boxesOverlap(node, dn, pad * 2)) {
          wrapSet.set(dn.id, dn);
        }
      }

      if (wrapSet.size === 0) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const c of wrapSet.values()) {
        const w = (c.measured?.width as number) || 88;
        const h = (c.measured?.height as number) || 64;
        minX = Math.min(minX, c.position.x);
        minY = Math.min(minY, c.position.y);
        maxX = Math.max(maxX, c.position.x + w);
        maxY = Math.max(maxY, c.position.y + h);
      }
      const dd = node.data as { width?: number; height?: number };
      const currentW = dd.width || minW;
      const currentH = dd.height || minH;
      const currentX = node.position.x;
      const currentY = node.position.y;

      // 只有“非成员候选”从左/上越界时才移动容器做预览包裹；
      // 已有成员拖出时不移动容器，避免范围被越拖越大。
      let nextX = currentX;
      let nextY = currentY;
      if (!scopeDragging) {
        const hasNewCandidate = [...draggingIds].some((did) => {
          const dn = st.nodes.find((n) => n.id === did);
          return dn && dn.id !== id && !childIdsOf(node).includes(did);
        });
        if (hasNewCandidate) {
          if (minX < currentX - 0.5) nextX = minX - pad;
          if (minY < currentY - 0.5) nextY = minY - pad;
        }
      }

      const needW = Math.round(maxX + pad - nextX);
      const needH = Math.round(maxY + pad - nextY);
      // 拖动中也允许收缩，成员往内收时范围节点能跟着变小
      const width = Math.max(minW, needW);
      const height = Math.max(minH, needH);

      if (Math.abs(nextX - currentX) > 0.5 || Math.abs(nextY - currentY) > 0.5) {
        st.moveNode(id, { x: nextX, y: nextY });
      }
      if (Math.abs(width - currentW) > 2 || Math.abs(height - currentH) > 2) {
        st.updateNodeData(id, { width, height });
      }
    }, 16);
    return () => clearTimeout(timer);
  }, [nodes, id, dragging, scopeDragging, resizing, minW, minH, pad]);
}
