/** 矢量设计工作室 —— 集合逻辑区域分析（基于离屏像素掩码，实时跟随画布） */
import type { LogicAnalysis, LogicOp, VecObject } from './types';
import { LOGIC_HIGHLIGHT, PAPER_H, PAPER_W } from './types';
import { bezierPathD } from './model';

/** 掩码采样分辨率 = 纸面尺寸 × SCALE */
export const SCALE = 0.5;
export const MW = Math.round(PAPER_W * SCALE);
export const MH = Math.round(PAPER_H * SCALE);

export const SET_COLORS = ['#8fc4ff', '#6fe3c2', '#e59bf6', '#ffb86b', '#ff7c7c'];

const SET_TYPES = new Set(['bezier', 'rectangle', 'rounded', 'ellipse']);

/** 将单个对象绘制为白色掩码（测试/调试可直接调用） */
export function paintMask(ctx: CanvasRenderingContext2D, o: VecObject) {
  // 恒等变换下整幅清除（避免缩放态下 clearRect 只清部分区域导致脏残留）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, MW, MH);
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
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
  const raw = ctx.getImageData(0, 0, MW, MH).data;
  // 压缩为红通道 0/1 掩码（避免 RGBA 字节流错位与 4× 膨胀）
  const out = new Uint8Array(MW * MH);
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
    resultArea: 0,
    expression: '—',
  };
  const chosen = picksIn.filter((o) => SET_TYPES.has(o.type) && o.visible).slice(0, 4);
  if (chosen.length === 0) return empty;

  const canvas = document.createElement('canvas');
  canvas.width = MW;
  canvas.height = MH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return empty;

  const n = chosen.length;
  const masks: Uint8Array[] = chosen.map((o) => paintMask(ctx, o));

  // 逐像素求每个集合的成员位
  const bits = new Uint8Array(MW * MH);
  const areaCounts = new Map<number, number>();
  for (let i = 0; i < bits.length; i += 1) {
    let m = 0;
    for (let k = 0; k < n; k += 1) if (masks[k][i]) m |= 1 << k;
    bits[i] = m;
    if (m) areaCounts.set(m, (areaCounts.get(m) || 0) + 1);
  }

  const px2 = 1 / (SCALE * SCALE);
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
    resultArea: Math.round(count * px2),
    expression: '',
  };
}
