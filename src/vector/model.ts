/** 矢量设计工作室 —— 模型辅助：预设、路径构建、几何工具 */
import type { Anchor, LogicOp, ProjectFile, VecGroup, VecObject, VecShapeKind } from './types';
import { LOGIC_OP_META, PAPER_H, PAPER_W } from './types';

export const uid = (prefix = 'vobj') =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const round1 = (v: number) => Math.round(v * 10) / 10;

export const SHAPE_TITLES: Record<VecShapeKind, string> = {
  bezier: '贝塞尔图形',
  rectangle: '矩形',
  rounded: '圆角矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  text: '文本框',
};

export const SHAPE_GLYPHS: Record<VecShapeKind, string> = {
  bezier: '⌁',
  rectangle: '□',
  rounded: '▢',
  ellipse: '◯',
  arrow: '➜',
  text: 'T',
};

export const OP_LABEL: Record<LogicOp, string> = Object.fromEntries(
  LOGIC_OP_META.map((m) => [m.op, m.label])
) as Record<LogicOp, string>;

export const OP_SYMBOL: Record<LogicOp, string> = Object.fromEntries(
  LOGIC_OP_META.map((m) => [m.op, m.symbol])
) as Record<LogicOp, string>;

const PALETTE: Record<VecShapeKind, { fill: string; stroke: string; textColor: string }> = {
  bezier: { fill: '#9a8cff', stroke: '#c9c1ff', textColor: '#f5f2ff' },
  rectangle: { fill: '#5b8def', stroke: '#b3cdff', textColor: '#f2f6ff' },
  rounded: { fill: '#ef789f', stroke: '#ffc3d6', textColor: '#fff3f6' },
  ellipse: { fill: '#37b6c4', stroke: '#a4eef2', textColor: '#eefcff' },
  arrow: { fill: 'none', stroke: '#f3a45b', textColor: '#f3a45b' },
  text: { fill: 'none', stroke: 'none', textColor: '#d7dce4' },
};

const DEFAULT_FONTS = ['Inter', 'Segoe UI', 'Microsoft YaHei', 'system-ui'];

/** 初始演示贝塞尔花瓣形锚点（本地坐标，w=260 h=190） */
export function demoAnchors(): Anchor[] {
  return [
    { x: 30, y: 132, smooth: true, hOut: { x: 96, y: 22 }, hIn: { x: -36, y: 64 } },
    { x: 128, y: 24, smooth: true, hOut: { x: 72, y: 22 }, hIn: { x: -72, y: -22 } },
    { x: 230, y: 92, smooth: true, hOut: { x: 24, y: 66 }, hIn: { x: -66, y: -18 } },
    { x: 162, y: 176, smooth: true, hOut: { x: -58, y: 26 }, hIn: { x: 40, y: -64 } },
  ];
}

/** 创建一个工具预设图形（点击/拖拽创建均从这里生成基础几何） */
export function buildPreset(type: VecShapeKind, name?: string): VecObject {
  const p = PALETTE[type];
  const base: VecObject = {
    id: uid(type),
    type,
    name: name || SHAPE_TITLES[type],
    x: 0,
    y: 0,
    width: 190,
    height: 120,
    rotation: 0,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: type === 'text' ? 0 : 2,
    strokeStyle: 'solid',
    opacity: type === 'text' ? 100 : 88,
    radius: type === 'rounded' ? 22 : type === 'rectangle' ? 0 : 0,
    shadow: false,
    text: type === 'text' ? '输入文字' : '',
    fontFamily: DEFAULT_FONTS[0],
    fontSize: type === 'text' ? 16 : 15,
    fontWeight: 500,
    textColor: p.textColor,
    textAlign: type === 'text' ? 'left' : 'center',
    lineHeight: 1.4,
    arrowStyle: 'filled',
    closed: type === 'bezier',
    visible: true,
    locked: false,
    groupId: null,
  };
  if (type === 'arrow') {
    base.width = 220;
    base.height = 64;
    base.strokeWidth = 3;
  } else if (type === 'text') {
    base.width = 240;
    base.height = 64;
  } else if (type === 'ellipse') {
    base.width = 190;
    base.height = 140;
  } else if (type === 'bezier') {
    base.width = 260;
    base.height = 200;
    base.anchors = demoAnchors();
  }
  return base;
}

/** 贝塞尔路径 → SVG d。闭合时自动连接末点到首点。 */
export function bezierPathD(anchors: Anchor[], closed: boolean): string {
  const pts = anchors;
  if (pts.length === 0) return '';
  const pt = (i: number) => pts[((i % pts.length) + pts.length) % pts.length];
  let d = `M ${round1(pts[0].x)} ${round1(pts[0].y)}`;
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i += 1) {
    const cur = pt(i);
    const next = pt(i + 1);
    const hOut = cur.hOut ?? cur;
    const hIn = next.hIn ?? next;
    if ((cur.hOut || next.hIn) && !(hOut.x === cur.x && hOut.y === cur.y)) {
      d += ` C ${round1(hOut.x)} ${round1(hOut.y)}, ${round1(hIn.x)} ${round1(hIn.y)}, ${round1(next.x)} ${round1(next.y)}`;
    } else {
      d += ` L ${round1(next.x)} ${round1(next.y)}`;
    }
  }
  if (closed && pts.length > 2) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    const hOut = last.hOut ?? last;
    const hIn = first.hIn ?? first;
    if ((last.hOut || first.hIn) && !(hOut.x === last.x && hOut.y === last.y)) {
      d += ` C ${round1(hOut.x)} ${round1(hOut.y)}, ${round1(hIn.x)} ${round1(hIn.y)}, ${round1(first.x)} ${round1(first.y)}`;
    }
    d += ' Z';
  }
  return d;
}

/** 本地坐标 → 世界坐标（含对象平移与旋转） */
export function localToWorld(o: VecObject, p: { x: number; y: number }) {
  const rad = (o.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = o.width / 2;
  const cy = o.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: o.x + cx + dx * cos - dy * sin,
    y: o.y + cy + dx * sin + dy * cos,
  };
}

/** 世界坐标 → 本地坐标 */
export function worldToLocal(o: VecObject, p: { x: number; y: number }) {
  const rad = (-o.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - o.x - o.width / 2;
  const dy = p.y - o.y - o.height / 2;
  return {
    x: o.width / 2 + dx * cos - dy * sin,
    y: o.height / 2 + dx * sin + dy * cos,
  };
}

/** 对象世界包围盒（含旋转，仅用于粗命中与框选） */
export function worldBoundsOf(o: VecObject): { x0: number; y0: number; x1: number; y1: number } {
  const corners = [
    { x: 0, y: 0 },
    { x: o.width, y: 0 },
    { x: o.width, y: o.height },
    { x: 0, y: o.height },
  ].map((c) => localToWorld(o, c));
  return {
    x0: Math.min(...corners.map((c) => c.x)),
    y0: Math.min(...corners.map((c) => c.y)),
    x1: Math.max(...corners.map((c) => c.x)),
    y1: Math.max(...corners.map((c) => c.y)),
  };
}

/** 点是否在对象内部（矩形/圆角/椭圆用本地坐标判定；贝塞尔做锚点多边形粗判定） */
export function hitTest(o: VecObject, world: { x: number; y: number }): boolean {
  const p = worldToLocal(o, world);
  if (o.type === 'ellipse') {
    const rx = Math.max(8, o.width / 2);
    const ry = Math.max(8, o.height / 2);
    const nx = (p.x - o.width / 2) / rx;
    const ny = (p.y - o.height / 2) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (o.type === 'bezier') {
    if (!o.anchors?.length) return false;
    // 点与多边形：射线法
    let inside = false;
    const pts = o.anchors;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-9) + a.x) inside = !inside;
    }
    return inside;
  }
  const pad = 0;
  return (
    p.x >= -pad && p.x <= o.width + pad && p.y >= -pad && p.y <= o.height + pad
  );
}

export function hitAnchor(o: VecObject, world: { x: number; y: number }, radius = 9): number {
  if (!o.anchors) return -1;
  for (let i = 0; i < o.anchors.length; i += 1) {
    const p = localToWorld(o, o.anchors[i]);
    if (Math.hypot(p.x - world.x, p.y - world.y) <= radius) return i;
  }
  return -1;
}

/** 命中手柄：返回 {anchorIndex, side} */
export function hitHandle(o: VecObject, world: { x: number; y: number }, radius = 7): { index: number; side: 'hIn' | 'hOut' } | null {
  if (!o.anchors) return null;
  for (let i = 0; i < o.anchors.length; i += 1) {
    const a = o.anchors[i];
    if (!a.hIn && !a.hOut) continue;
    if (a.hIn) {
      const p = localToWorld(o, a.hIn);
      if (Math.hypot(p.x - world.x, p.y - world.y) <= radius) return { index: i, side: 'hIn' };
    }
    if (a.hOut) {
      const p = localToWorld(o, a.hOut);
      if (Math.hypot(p.x - world.x, p.y - world.y) <= radius) return { index: i, side: 'hOut' };
    }
  }
  return null;
}

/** 平滑化/角点化一个锚点。smooth=true 时生成/镜像手柄。 */
export function setAnchorSmooth(o: VecObject, index: number, smooth: boolean): Anchor[] {
  const anchors = clone(o.anchors || []);
  const a = anchors[index];
  if (!a) return anchors;
  const prev = anchors[(index - 1 + anchors.length) % anchors.length];
  const next = anchors[(index + 1) % anchors.length];
  const len = (p: Anchor) => Math.hypot(p.x - a.x, p.y - a.y);
  const norm = (dx: number, dy: number) => {
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  if (smooth) {
    const dirIn = norm(prev.x - a.x, prev.y - a.y);
    const dirOut = norm(next.x - a.x, next.y - a.y);
    const d = Math.min(0.32 * len(prev), 0.32 * len(next), 70);
    a.hIn = { x: a.x + dirIn.x * d, y: a.y + dirIn.y * d };
    a.hOut = { x: a.x + dirOut.x * d, y: a.y + dirOut.y * d };
    a.smooth = true;
  } else {
    a.smooth = false;
    // 保留手柄但解除联动
  }
  return anchors;
}

/** 拖动锚点时联动手柄（保持手柄与锚点的相对偏移），smooth 时镜像对侧手柄长度 */
export function moveAnchor(anchors: Anchor[], index: number, dx: number, dy: number): Anchor[] {
  const next = clone(anchors);
  const a = next[index];
  if (!a) return next;
  const prevH = a.hIn ? { x: a.hIn.x - a.x, y: a.hIn.y - a.y } : null;
  const prevO = a.hOut ? { x: a.hOut.x - a.x, y: a.hOut.y - a.y } : null;
  a.x += dx;
  a.y += dy;
  if (a.hIn) {
    a.hIn.x = a.x + (prevH?.x ?? 0);
    a.hIn.y = a.y + (prevH?.y ?? 0);
  }
  if (a.hOut) {
    a.hOut.x = a.x + (prevO?.x ?? 0);
    a.hOut.y = a.y + (prevO?.y ?? 0);
  }
  return next;
}

/** 在 polyline 近似上取最近段并插入锚点（世界坐标输入 → 本地） */
export function insertAnchorAt(o: VecObject, local: { x: number; y: number }): Anchor[] {
  const anchors = clone(o.anchors || []);
  if (anchors.length < 2) return anchors;
  let bestT = -1;
  let bestSeg = -1;
  let bestD = Infinity;
  const n = o.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < n; i += 1) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((local.x - a.x) * dx + (local.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(px - local.x, py - local.y);
    if (d < bestD) {
      bestD = d;
      bestT = t;
      bestSeg = i;
    }
  }
  if (bestSeg < 0) return anchors;
  const a = anchors[bestSeg];
  const b = anchors[(bestSeg + 1) % anchors.length];
  const lerp = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
    x: p.x + (q.x - p.x) * bestT,
    y: p.y + (q.y - p.y) * bestT,
  });
  const mid: Anchor = {
    ...lerp(a, b),
    smooth: Boolean(a.smooth && b.smooth),
  };
  if (a.hOut && b.hIn) {
    const hOut = lerp(a.hOut, b.hIn);
    mid.hIn = lerp(a.hOut, hOut);
    mid.hOut = lerp(hOut, b.hIn);
    // 修正首尾锚点直连段的手柄归属
    if (mid.smooth) {
      const dOut = Math.hypot(mid.hOut.x - mid.x, mid.hOut.y - mid.y) || 1;
      const nIn = { x: mid.x - mid.hIn.x, y: mid.y - mid.hIn.y };
      const l = Math.hypot(nIn.x, nIn.y) || 1;
      mid.hIn = { x: mid.x + (nIn.x / l) * dOut, y: mid.y + (nIn.y / l) * dOut };
    }
  }
  const insertAt = o.closed && bestSeg === anchors.length - 1 ? anchors.length : bestSeg + 1;
  anchors.splice(insertAt, 0, mid);
  return anchors;
}

/** 求逻辑表达式文字 */
export function expressionText(ids: string[], nameOf: (id: string) => string, op: LogicOp): string {
  if (!ids.length) return '—';
  if (op === 'complement' && ids.length > 0) {
    return `${nameOf(ids[0])}ᶜ`;
  }
  const sym = OP_SYMBOL[op];
  const max = op === 'xor' ? 2 : Infinity;
  return ids.slice(0, max).map(nameOf).join(` ${sym} `);
}

/** 将给定 id 列表对应的对象按从底到顶的原始顺序返回 */
export function sortedObjects(objects: VecObject[], ids: string[]): VecObject[] {
  const map = new Map(objects.map((o) => [o.id, o]));
  return ids.map((id) => map.get(id)).filter((o): o is VecObject => Boolean(o));
}

/** 纸张包围盒内的整块区域（用于框选/辅助线） */
export const paperRect = { x: 0, y: 0, width: PAPER_W, height: PAPER_H };

export function validateProject(raw: unknown): ProjectFile | null {
  try {
    const p = raw as ProjectFile;
    if (!p || p.kind !== 'codenode-vector-project' || !Array.isArray(p.objects)) return null;
    const fixed = p.objects.filter(
      (o) => o && typeof o.x === 'number' && typeof o.y === 'number' && typeof o.width === 'number' && typeof o.height === 'number'
    );
    if (!fixed.length) return null;
    p.objects = fixed;
    p.groups = Array.isArray(p.groups) ? p.groups : [];
    p.zoom = typeof p.zoom === 'number' && p.zoom > 0 ? p.zoom : 0.9;
    p.pan = p.pan && typeof p.pan.x === 'number' ? p.pan : { x: 0, y: 0 };
    p.mode = p.mode === 'logic' ? 'logic' : 'design';
    p.guides = p.guides && Array.isArray(p.guides.v) ? p.guides : { v: [], h: [] };
    return p;
  } catch {
    return null;
  }
}

/** 组装演示工程（第一次进入或点“示例”时使用） */
export function buildDemoProject() {
  const a = buildPreset('bezier', 'Alpha / 贝塞尔');
  a.x = 168; a.y = 132; a.rotation = -4; a.opacity = 62; a.text = 'Alpha';
  const b = buildPreset('ellipse', 'Beta / 椭圆');
  b.x = 366; b.y = 226; b.width = 268; b.height = 172; b.rotation = 6; b.opacity = 58; b.text = 'Beta';
  const c = buildPreset('rounded', 'Gamma / 圆角矩形');
  c.x = 646; c.y = 148; c.width = 218; c.height = 142; c.rotation = 0; c.opacity = 58; c.radius = 24; c.text = 'Gamma';
  const arrow = buildPreset('arrow', '流程连接 / 箭头');
  arrow.x = 596; arrow.y = 418; arrow.stroke = '#f3a45b'; arrow.textColor = '#f3a45b';
  const note = buildPreset('text', '设计说明 / 文本');
  note.x = 128; note.y = 452; note.width = 352; note.height = 74; note.fontSize = 15;
  note.text = '选择图形参与集合分析 · 拖动锚点与控制柄编辑贝塞尔';
  note.textColor = '#98a2b3';
  const objects = [a, b, c, arrow, note];
  return {
    objects,
    groups: [] as VecGroup[],
    zoom: 0.9,
    pan: { x: 0, y: 0 },
    guides: { v: [440], h: [352] },
  };
}
