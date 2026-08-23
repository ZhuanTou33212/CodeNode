import { useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { liveWrapNodes } from './flow';

/**
 * 容器边框自适应（用户窗口 / 范围节点，参考 Blender 框）：
 * - 锚定：容器位置不动，仅边框（宽高）自适应缩放
 * - 实时跟随（30ms 防抖）
 * - 拖动中：只增不减（包裹成员 + 正在拖入的候选）
 * - 松开后：可收可缩（向右/下）
 */
export function useContainerAutoFit(id: string, nodes: Node[], minW: number, minH: number, pad: number): void {
  const draggingIds = useGraphStore((s) => s.draggingIds);
  const dragging = draggingIds.length > 0;

  useEffect(() => {
    const timer = setTimeout(() => {
      const st = useGraphStore.getState();
      const node = st.nodes.find((n) => n.id === id);
      if (!node) return;
      const wrap = liveWrapNodes(node, st.nodes);
      if (wrap.length === 0) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const c of wrap) {
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
      const needW = Math.round(maxX + pad - node.position.x);
      const needH = Math.round(maxY + pad - node.position.y);
      const width = dragging ? Math.max(currentW, needW) : Math.max(minW, needW);
      const height = dragging ? Math.max(currentH, needH) : Math.max(minH, needH);
      if (Math.abs(width - currentW) > 2 || Math.abs(height - currentH) > 2) {
        st.updateNodeData(id, { width, height });
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [nodes, id, dragging, minW, minH, pad]);
}
