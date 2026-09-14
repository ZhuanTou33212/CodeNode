/** 矢量设计工作室 —— 集合逻辑区域分析（基于离屏像素掩码，实时跟随画布）
 *
 * 无限画布下不再有固定纸张：掩码范围按参与运算的图形包围盒动态推导，
 * 结果贴图也以同一包围盒映射回世界坐标（见 LogicAnalysis.bounds）。
 */
import type { LogicAnalysis, LogicOp, VecObject } from './types';
import { LOGIC_HIGHLIGHT } from './types';
import { bezierPathD, worldBoundsOf } from './model';

/** 掩码采样分辨率（世界单位 → 掩码像素） */
export const SCALE = 0.5;
/** 包围盒向外扩的世界单位，给边缘留余量，避免贴边裁切 */
const PAD = 24;
/** 掩码单边最大像素数：超大内容包围盒下自动降低采样率，避免内存爆炸 */
const MAX_SIDE = 2400;

/** 一次掩码采样的坐标系映射：世界坐标 → 掩码像素 */
export type MaskView = { x0: number; y0: number; scale: number; mw: number; mh: number };

export const SET_COLORS = ['#8fc4ff', '#6fe3c2', '#e59bf6', '#ffb86b', '#ff7c7c'];

const SET_TYPES = new Set(['bezier', 'rectangle', 'rounded', 'ellipse']);

/** 按参与运算的图形推导掩码范围与采样率 */
export function maskViewFor(objects: VecObject[]): MaskView {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of objects) {
    const b = worldBoundsOf(o);
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, scale: SCALE, mw: 1, mh: 1 };

  x0 -= PAD;
  y0 -= PAD;
  x1 += PAD;
  y1 += PAD;
  const worldW = Math.max(1, x1 - x0);
  const worldH = Math.max(1, y1 - y0);
  const scale = Math.min(SCALE, MAX_SIDE / worldW, MAX_SIDE / worldH);
  return {
    x0,
    y0,
    scale,
    mw: Math.max(1, Math.round(worldW * scale)),
    mh: Math.max(1, Math.round(worldH * scale)),
  };
}

/** 将单个对象绘制为白色掩码（测试/调试可直接调用） */
export function paintMask(ctx: CanvasRenderingContext2D, o: VecObject, view: MaskView) {
  // 恒等变换下整幅清除（避免缩放态下 clearRect 只清部分区域导致脏残留）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.mw, view.mh);
  ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
  // 世界坐标 → 掩码坐标：整体平移到包围盒原点
  ctx.translate(-view.x0, -view.y0);
  ctx.translate(o.x + o.width / 2, o.y + o.height / 2);
  ctx.rotate((o.rotation * Math.PI) / 180);
  ctx.translate(-o.width / 2, -o.height / 2);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (o.type === 'rectangle' || o.type === 'rounded') {
    const r = Math.min(o.radius || 0, o.width / 2, o.height / 2);
    if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(0, 0, o.width, o.height, r);
    else ctx.rect(0, 0, o.width, o.height);
    ctx.fill();
  } else if (o.type === 'ellipse') {
    ctx.ellipse(o.width / 2, o.height / 2, Math.max(8, o.width / 2), Math.max(8, o.height / 2), 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (o.type === 'bezier' && o.anchors && o.anchors.length >= 2 && o.closed) {
    ctx.fill(new Path2D(bezierPathD(o.anchors, true)));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const raw = ctx.getImageData(0, 0, view.mw, view.mh).data;
  // 压缩为红通道 0/1 掩码（避免 RGBA 字节流错位与 4× 膨胀）
  const out = new Uint8Array(view.mw * view.mh);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = raw[i * 4] > 16 ? 1 : 0;
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 211, 77];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function computeLogicAnalysisForSets(picksIn: VecObject[], op: LogicOp): LogicAnalysis {
  const empty: LogicAnalysis = {
    ready: false,
    sets: [],
    relations: [],
    stats: [],
    resultUrl: null,
    bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
    resultArea: 0,
    expression: '—',
  };
  const chosen = picksIn.filter((o) => SET_TYPES.has(o.type) && o.visible).slice(0, 4);
  if (chosen.length === 0) return empty;

  const view = maskViewFor(chosen);
  const MW = view.mw;
  const MH = view.mh;
  const scale = view.scale;

  const canvas = document.createElement('canvas');
  canvas.width = MW;
  canvas.height = MH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return empty;

  const n = chosen.length;
  const masks: Uint8Array[] = chosen.map((o) => paintMask(ctx, o, view));

  // 逐像素求每个集合的成员位
  const bits = new Uint8Array(MW * MH);
  const areaCounts = new Map<number, number>();
  for (let i = 0; i < bits.length; i += 1) {
    let m = 0;
    for (let k = 0; k < n; k += 1) if (masks[k][i]) m |= 1 << k;
    bits[i] = m;
    if (m) areaCounts.set(m, (areaCounts.get(m) || 0) + 1);
  }

  const px2 = 1 / (scale * scale);
  const shortName = (o: VecObject) => o.name.split(' / ')[0] || '集合';
  const setAreas = chosen.map((_, k) => {
    let c = 0;
    for (let i = 0; i < bits.length; i += 1) if (bits[i] & (1 << k)) c += 1;
    return Math.round(c * px2);
  });
  const sets = chosen.map((o, k) => ({
    id: o.id,
    name: shortName(o),
    color: o.stroke && o.stroke !== 'none' ? o.stroke : SET_COLORS[k % SET_COLORS.length],
    area: setAreas[k],
  }));

  const labelOf = (m: number) =>
    chosen.map((o, k) => (m & (1 << k) ? shortName(o) : null)).filter(Boolean).join(' ∩ ');
  const stats = [...areaCounts.entries()]
    .map(([m, c]) => ({ mask: m, label: labelOf(m), area: Math.round(c * px2) }))
    .sort((p, q) => q.area - p.area)
    .slice(0, 6);

  // 两两关系（基于真实重叠面积）
  const relations: LogicAnalysis['relations'] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let inter = 0;
      for (let p = 0; p < bits.length; p += 1) if ((bits[p] & (1 << i)) && (bits[p] & (1 << j))) inter += 1;
      const interArea = inter * px2;
      const tolerance = Math.max(setAreas[i], setAreas[j]) * 0.015;
      let kind: LogicAnalysis['relations'][number]['kind'];
      if (interArea < 4) kind = '分离';
      else if (interArea >= Math.min(setAreas[i], setAreas[j]) - tolerance) kind = setAreas[i] <= setAreas[j] ? '包含' : '被包含';
      else kind = '相交';
      relations.push({ a: chosen[i].id, b: chosen[j].id, kind });
    }
  }

  // 运算结果：着色 + 计数
  const image = ctx.getImageData(0, 0, MW, MH);
  const data = image.data;
  const [rr, gg, bb] = hexToRgb(LOGIC_HIGHLIGHT);
  let count = 0;
  for (let i = 0; i < bits.length; i += 1) {
    const m = bits[i];
    let ones = 0;
    for (let k = 0; k < n; k += 1) if (m & (1 << k)) ones += 1;
    let on = false;
    switch (op) {
      case 'union': on = ones >= 1; break;
      case 'intersection': on = ones >= n; break;
      case 'difference': on = Boolean(m & 1) && ones === 1; break;
      case 'xor': on = ones % 2 === 1; break;
      case 'complement': on = !(m & 1); break;
    }
    if (on) {
      const j = i * 4;
      data[j] = rr;
      data[j + 1] = gg;
      data[j + 2] = bb;
      data[j + 3] = 84;
      count += 1;
    }
  }
  ctx.putImageData(image, 0, 0);

  return {
    ready: true,
    sets,
    relations,
    stats,
    resultUrl: count > 0 ? canvas.toDataURL() : null,
    bounds: {
      x0: view.x0,
      y0: view.y0,
      x1: view.x0 + MW / scale,
      y1: view.y0 + MH / scale,
    },
    resultArea: Math.round(count * px2),
    expression: '',
  };
}
