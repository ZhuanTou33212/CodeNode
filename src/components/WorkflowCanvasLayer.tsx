import { useEffect, useRef, useState } from 'react';
import { useStore, type Edge, type Node } from '@xyflow/react';
import { useUiStore } from '../store/uiStore';
import { getVectorStore } from '../vector/vectorStore';
import type { VecObject } from '../vector/types';

type Point = { x: number; y: number };
type NodeData = { label?: string; status?: string; accent?: string; prompt?: string; goal?: string; subtitle?: string; filePath?: string; imagePath?: string; dataUrl?: string; width?: number; height?: number; fill?: string; opacity?: number; collapsed?: boolean; objectName?: string };

const TYPE_MARK: Record<string, string> = { start: '▶', end: '■', task: '◆', stage: '▦', tool: '⚙', file: 'F', image: '▣', scope: '▣', object: '◇', vector: '▧' };
const STATUS_LABEL: Record<string, string> = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', blocked: '阻塞' };

function size(node: Node): { width: number; height: number } {
  const data = node.data as NodeData;
  return {
    width: Number(node.measured?.width) || Number(data.width) || (node.type === 'scope' ? 320 : node.type === 'vector' ? 1040 : node.type === 'image' ? 320 : 176),
    height: Number(node.measured?.height) || Number(data.height) || (node.type === 'scope' ? 220 : node.type === 'vector' ? 640 : node.type === 'image' ? 224 : 100),
  };
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function text(ctx: CanvasRenderingContext2D, value: unknown, x: number, y: number, maxWidth: number): void {
  const label = String(value || '');
  if (!label) return;
  if (ctx.measureText(label).width <= maxWidth) { ctx.fillText(label, x, y); return; }
  let end = label.length;
  while (end > 1 && ctx.measureText(label.slice(0, end) + '…').width > maxWidth) end--;
  ctx.fillText(label.slice(0, end) + '…', x, y);
}

function edgePath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  if (points.length < 2) return;
  const a = points[0];
  const b = points[points.length - 1];
  ctx.moveTo(a.x, a.y);
  if (points.length === 2) {
    const direction = b.x >= a.x ? 1 : -1;
    const bend = Math.max(32, Math.min(180, Math.abs(b.x - a.x) * .5));
    ctx.bezierCurveTo(a.x + bend * direction, a.y, b.x - bend * direction, b.y, b.x, b.y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  ctx.lineTo(b.x, b.y);
}

function vectorPreview(ctx: CanvasRenderingContext2D, nodeId: string, x: number, y: number, width: number, height: number): void {
  const objects = getVectorStore(nodeId).getState().objects.filter((item) => item.visible);
  const frame = { x: x + 10, y: y + 36, width: width - 20, height: Math.max(20, height - 72) };
  ctx.save();
  ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.width, frame.height); ctx.clip();
  if (!objects.length) {
    ctx.fillStyle = '#64748b'; ctx.font = '12px sans-serif'; ctx.fillText('空白绘图 · 点击节点编辑', frame.x + 12, frame.y + 24);
    ctx.restore(); return;
  }
  const bounds = objects.reduce((result, item) => ({
    x0: Math.min(result.x0, item.x), y0: Math.min(result.y0, item.y),
    x1: Math.max(result.x1, item.x + item.width), y1: Math.max(result.y1, item.y + item.height),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const { x0, y0, x1, y1 } = bounds;
  const scale = Math.min((frame.width - 36) / Math.max(1, x1 - x0), (frame.height - 36) / Math.max(1, y1 - y0), 2);
  ctx.translate(frame.x + (frame.width - (x1 - x0) * scale) / 2, frame.y + (frame.height - (y1 - y0) * scale) / 2);
  ctx.scale(scale, scale); ctx.translate(-x0, -y0);
  for (const item of objects) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, item.opacity / 100));
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    ctx.rotate(item.rotation * Math.PI / 180);
    ctx.translate(-item.width / 2, -item.height / 2);
    ctx.fillStyle = item.fill === 'none' ? 'transparent' : item.fill;
    ctx.strokeStyle = item.stroke === 'none' ? 'transparent' : item.stroke;
    ctx.lineWidth = item.strokeWidth || 1;
    ctx.setLineDash(item.strokeStyle === 'dashed' ? [8, 5] : item.strokeStyle === 'dotted' ? [2, 4] : []);
    drawVectorObject(ctx, item);
    ctx.restore();
  }
  ctx.restore();
}

function drawVectorObject(ctx: CanvasRenderingContext2D, item: VecObject): void {
  ctx.beginPath();
  if (item.type === 'ellipse') ctx.ellipse(item.width / 2, item.height / 2, Math.max(1, item.width / 2), Math.max(1, item.height / 2), 0, 0, Math.PI * 2);
  else if (item.type === 'arrow') { ctx.moveTo(0, item.height / 2); ctx.lineTo(item.width, item.height / 2); ctx.moveTo(item.width - 14, item.height / 2 - 9); ctx.lineTo(item.width, item.height / 2); ctx.lineTo(item.width - 14, item.height / 2 + 9); }
  else if (item.type === 'bezier' && item.anchors?.length) {
    const anchors = item.anchors;
    ctx.moveTo(anchors[0].x, anchors[0].y);
    for (let i = 1; i < anchors.length; i++) {
      const previous = anchors[i - 1]; const current = anchors[i];
      ctx.bezierCurveTo(previous.hOut?.x ?? previous.x, previous.hOut?.y ?? previous.y, current.hIn?.x ?? current.x, current.hIn?.y ?? current.y, current.x, current.y);
    }
    if (item.closed) ctx.closePath();
  } else if (item.type !== 'text') ctx.roundRect(0, 0, item.width, item.height, item.type === 'rounded' ? item.radius : 0);
  if (item.fill !== 'none' && item.type !== 'arrow' && item.type !== 'text') ctx.fill();
  if (item.stroke !== 'none' && item.type !== 'text') ctx.stroke();
  if (item.text) {
    ctx.fillStyle = item.textColor || '#f8fafc';
    ctx.font = `${item.fontWeight || 400} ${item.fontSize || 16}px ${item.fontFamily || 'sans-serif'}`;
    ctx.textAlign = item.textAlign || 'left';
    const textX = item.textAlign === 'center' ? item.width / 2 : item.textAlign === 'right' ? item.width : 0;
    ctx.fillText(item.text.split('\n')[0], textX, item.type === 'text' ? (item.fontSize || 16) : item.height / 2 + (item.fontSize || 16) / 3, item.width);
    ctx.textAlign = 'left';
  }
}

export default function WorkflowCanvasLayer({ nodes, edges, hoveredEdgeId, cutLine }: { nodes: Node[]; edges: Edge[]; hoveredEdgeId: string | null; cutLine: Point[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bounds, setBounds] = useState({ width: 1, height: 1 });
  const transform = useStore((state) => state.transform);
  const theme = useUiStore((state) => state.theme);
  const hoverScopeId = useUiStore((state) => state.hoverScopeId);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [vectorRevision, setVectorRevision] = useState(0);
  const [animationTick, setAnimationTick] = useState(0);
  const vectorIds = nodes.filter((node) => node.type === 'vector').map((node) => node.id).join('|');
  const animating = nodes.some((node) => (node.data as NodeData).status === 'running') || edges.some((edge) => edge.animated);

  useEffect(() => {
    if (!animating || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setAnimationTick((tick) => tick + 1), 80);
    return () => window.clearInterval(timer);
  }, [animating]);

  useEffect(() => {
    const unsubscribe = vectorIds.split('|').filter(Boolean).map((id) => getVectorStore(id).subscribe(() => setVectorRevision((revision) => revision + 1)));
    return () => unsubscribe.forEach((stop) => stop());
  }, [vectorIds]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas?.parentElement) return;
    const observer = new ResizeObserver(() => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    });
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || bounds.width < 1 || bounds.height < 1) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, bounds.width, bounds.height);
    const style = getComputedStyle(canvas);
    const dot = token(style, '--canvas-dot', '#64748b');
    const surface = token(style, '--glass-surface', '#ffffff');
    const foreground = token(style, '--glass-text', '#172033');
    const muted = token(style, '--glass-muted', '#64748b');
    const border = token(style, '--glass-border', '#94a3b8');
    const edgeColor = token(style, '--edge-color', '#778292');
    const statuses: Record<string, string> = {
      running: token(style, '--stage-running', '#f59e0b'),
      done: token(style, '--stage-done', '#22c55e'),
      failed: token(style, '--stage-failed', '#ef4444'),
      blocked: token(style, '--stage-blocked', '#8b5cf6'),
    };
    const [tx, ty, zoom] = transform;
    const gap = 22 * zoom;
    if (gap >= 12) {
      ctx.fillStyle = dot;
      ctx.globalAlpha = .38;
      const x0 = ((tx % gap) + gap) % gap;
      const y0 = ((ty % gap) + gap) % gap;
      for (let x = x0; x < bounds.width; x += gap) for (let y = y0; y < bounds.height; y += gap) {
        ctx.beginPath(); ctx.arc(x, y, Math.max(.55, Math.min(1.1, zoom)), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(zoom, zoom);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      const sourceSize = size(source);
      const targetSize = size(target);
      const waypoints = ((edge.data as { waypoints?: Point[] } | undefined)?.waypoints) || [];
      const points = [
        { x: source.position.x + sourceSize.width, y: source.position.y + sourceSize.height / 2 },
        ...waypoints,
        { x: target.position.x, y: target.position.y + targetSize.height / 2 },
      ];
      ctx.beginPath(); edgePath(ctx, points);
      ctx.strokeStyle = String(edge.style?.stroke || ((edge.selected || hoveredEdgeId === edge.id) ? token(style, '--glass-accent', '#66d9ff') : edgeColor));
      ctx.globalAlpha = Number(edge.style?.strokeOpacity ?? 1);
      ctx.lineWidth = Number(edge.style?.strokeWidth || ((edge.selected || hoveredEdgeId === edge.id) ? 3 : 2));
      if (edge.animated) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -animationTick * 2; }
      ctx.lineCap = 'round'; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const point of waypoints) { ctx.beginPath(); ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = surface; ctx.fill(); ctx.strokeStyle = edgeColor; ctx.lineWidth = 1; ctx.stroke(); }
    }
    for (const node of [...nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))) {
      const data = node.data as NodeData;
      const { width, height } = size(node);
      const { x, y } = node.position;
      if ((x + width) * zoom + tx < -40 || x * zoom + tx > bounds.width + 40 || (y + height) * zoom + ty < -40 || y * zoom + ty > bounds.height + 40) continue;
      // Rich editors remain live DOM surfaces while selected; Canvas paints their inactive preview.
      if (node.selected && ['vector', 'image', 'scope', 'object'].includes(node.type || '')) continue;
      const accent = data.accent || '#3b82f6';
      const statusColor = statuses[data.status || ''] || accent;
      const isScope = node.type === 'scope';
      ctx.save();
      ctx.fillStyle = isScope ? `${data.fill || '#3b2f6b'}${Math.round((data.opacity ?? .16) * 255).toString(16).padStart(2, '0')}` : surface;
      ctx.strokeStyle = node.selected ? token(style, '--glass-accent', accent) : hoverScopeId === node.id ? accent : data.status && statuses[data.status] ? statusColor : accent;
      ctx.lineWidth = node.selected ? 2.5 : 1.4;
      if (data.status === 'running') { ctx.shadowColor = statusColor; ctx.shadowBlur = 8 + 5 * Math.sin(animationTick * .28); }
      if (isScope) ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.roundRect(x, y, width, height, isScope ? 11 : 8); ctx.fill(); ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;
      if (isScope) {
        ctx.fillStyle = foreground; ctx.font = '600 13px sans-serif'; text(ctx, `${data.collapsed ? '▸' : '▾'} ${data.label || '范围'}`, x + 12, y + 24, width - 24);
        ctx.fillStyle = muted; ctx.font = '11px sans-serif'; text(ctx, data.collapsed ? '已折叠' : '范围节点', x + 12, y + 43, width - 24);
      } else {
        ctx.fillStyle = accent; ctx.font = '600 14px sans-serif'; text(ctx, TYPE_MARK[node.type || ''] || '◇', x + 12, y + 23, 18);
        ctx.fillStyle = foreground; ctx.font = '600 13px sans-serif'; text(ctx, data.label || node.id, x + 33, y + 23, width - 45);
        const detail = data.goal || data.prompt || data.filePath || data.imagePath || data.objectName || data.subtitle || (node.type === 'vector' ? '点击节点编辑矢量画布' : '');
        ctx.fillStyle = muted; ctx.font = '11px sans-serif'; text(ctx, detail, x + 12, y + Math.min(47, height - 28), width - 24);
        if (node.type === 'image' && data.dataUrl) {
          let image = images.current.get(data.dataUrl);
          if (!image) {
            image = new Image(); image.src = data.dataUrl; image.onload = () => setBounds((previous) => ({ ...previous }));
            images.current.set(data.dataUrl, image);
          }
          if (image.complete && image.naturalWidth) {
            const box = { x: x + 12, y: y + 54, width: width - 24, height: Math.max(16, height - 80) };
            const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
            ctx.drawImage(image, box.x + (box.width - image.naturalWidth * scale) / 2, box.y + (box.height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
          }
        }
        if (node.type === 'vector') vectorPreview(ctx, node.id, x, y, width, height);
        ctx.strokeStyle = border; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(x, y + height - 27); ctx.lineTo(x + width, y + height - 27); ctx.stroke();
        ctx.fillStyle = statusColor; ctx.beginPath(); ctx.arc(x + 13, y + height - 14, 3, 0, Math.PI * 2); ctx.fill();
        ctx.font = '10px sans-serif'; text(ctx, STATUS_LABEL[data.status || 'pending'] || data.status || '待执行', x + 22, y + height - 10, width - 32);
        if (node.type !== 'start') { ctx.beginPath(); ctx.arc(x, y + height / 2, 4, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
        if (node.type !== 'end') { ctx.beginPath(); ctx.arc(x + width, y + height / 2, 4, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
      }
      ctx.restore();
    }
    ctx.restore();
    if (cutLine.length > 1) {
      ctx.beginPath(); ctx.moveTo(cutLine[0].x, cutLine[0].y);
      for (const point of cutLine.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [nodes, edges, bounds, transform, theme, hoverScopeId, hoveredEdgeId, cutLine, vectorRevision, animationTick]);

  return <canvas ref={ref} className="workflow-canvas-layer" aria-hidden="true" />;
}
