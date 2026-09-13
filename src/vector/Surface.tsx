/**
 * 矢量画布引擎 —— 可嵌入的绘制表面（纸面 / 图形 / 选中框 / 手势）。
 *
 * 原本是「矢量设计工作室」的主组件；重构后不再单独占一栏，
 * 而是由画布节点（VectorNode）嵌入到 Agent 画布上，每个节点一份独立文档 store。
 * 全部指针手势统一在 svg 的 pointer 事件中按命中目标分类分发。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVector, type VectorStore } from './vectorStore';
import { computeLogicAnalysisForSets } from './region';
import type { LogicAnalysis, VecObject, VecShapeKind } from './types';
import { GRID_STEP, LOGIC_OP_META, PAPER_H, PAPER_ORIGIN, PAPER_W } from './types';
import {
  bezierPathD,
  clamp,
  hitTest,
  insertAnchorAt,
  localToWorld,
  round1,
  setAnchorSmooth,
  worldBoundsOf,
  worldToLocal,
} from './model';
import './vector.css';

type Point = { x: number; y: number };

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; last: Point; moved: boolean }
  | { kind: 'move'; down: Point; moved: boolean; orig: { id: string; x: number; y: number }[] }
  | { kind: 'marquee'; from: Point }
  | { kind: 'resize-single'; edge: string; objId: string; downWorld: Point }
  | { kind: 'resize-many'; edge: string; downWorld: Point; origin: Point }
  | { kind: 'rotate'; pivot: Point; startAngle: number; startRot: number }
  | { kind: 'anchor'; objId: string; index: number; down: Point; moved: boolean }
  | { kind: 'handle'; objId: string; index: number; side: 'hIn' | 'hOut'; down: Point; moved: boolean }
  | { kind: 'create'; shape: VecShapeKind; from: Point }
  | { kind: 'pen'; down: Point; moved: boolean }
  | { kind: 'guide'; axis: 'v' | 'h'; from: number };

const MIN_SIZE = 24;

/* ==================== 主画布 ==================== */

const EDGE_DELTAS: Record<string, Point> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

export type VectorSurfaceProps = {
  analysis: LogicAnalysis;
  registerFit?: (fn: () => void) => void;
  /**
   * 宿主视口缩放（React Flow 的 zoom）。
   * 节点整体被 CSS transform 缩放时，屏幕像素与 SVG 本地像素不再 1:1，
   * 所有「client 坐标 ↔ 世界坐标」的换算都要先除掉这个比例。
   */
  stageScale?: number;
  /** 紧凑排版（节点内嵌时隐藏标尺外的大留白） */
  compact?: boolean;
};

/**
 * 可嵌入的矢量绘制表面：纸张 / 网格 / 参考线 / 图形 / 选中框 / 手势 / 逻辑高亮。
 * 由画布节点（VectorNode）嵌到 Agent 画布上，不再单独占一个工作区。
 */
export function VectorSurface(props: VectorSurfaceProps) {
  const stageScale = props.stageScale && props.stageScale > 0 ? props.stageScale : 1;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const spaceRef = useRef(false);
  const penLastActionRef = useRef(0);
  const penSuppressRef = useRef(false);
  const [box, setBox] = useState({ w: 1000, h: 600 });
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null);
  const [creating, setCreating] = useState<{ shape: VecShapeKind; from: Point; to: Point } | null>(null);
  const [penCursor, setPenCursor] = useState<Point | null>(null);
  const [guideGhost, setGuideGhost] = useState<{ axis: 'v' | 'h'; pos: number } | null>(null);

  const store = useVector();
  const objects = useVector((s) => s.objects);
  const zoom = useVector((s) => s.zoom);
  const pan = useVector((s) => s.pan);
  const tool = useVector((s) => s.tool);
  const mode = useVector((s) => s.mode);
  const selectedIds = useVector((s) => s.selectedIds);
  const penPts = useVector((s) => s.penPts);
  const snapOn = useVector((s) => s.snapOn);
  const guidesOn = useVector((s) => s.guidesOn);
  const gridOn = useVector((s) => s.gridOn);
  const guides = useVector((s) => s.guides);
  const editingId = useVector((s) => s.editingId);
  const activeAnchor = useVector((s) => s.activeAnchor);

  /** 视口尺寸观测（画布自适应 + fit） */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // getBoundingClientRect 返回的是屏幕（已被宿主缩放的）尺寸，换算回本地 px
      setBox({ w: r.width / stageScale, h: r.height / stageScale });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageScale]);


  /** client → 世界坐标（svg 无 viewBox，用户单位即 px） */
  const toWorld = useCallback(
    (cx: number, cy: number): Point => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const lx = (cx - rect.left) / stageScale;
      const ly = (cy - rect.top) / stageScale;
      return {
        x: (lx - PAPER_ORIGIN.x - pan.x) / zoom,
        y: (ly - PAPER_ORIGIN.y - pan.y) / zoom,
      };
    },
    [pan, zoom, stageScale]
  );

  /** 适应画布 */
  const fitView = useCallback(() => {
    const st = store.getState();
    const z = clamp(Math.min((box.w - 90) / PAPER_W, (box.h - 90) / PAPER_H), 0.18, 1.6);
    st.setViewport(z, {
      x: (box.w - PAPER_W * z) / 2 - PAPER_ORIGIN.x,
      y: (box.h - PAPER_H * z) / 2 - PAPER_ORIGIN.y,
    });
  }, [box, store]);

  /** 画布尺寸变化后，沿用当前纸张坐标重新居中，避免窗口/面板变化时纸张被裁切。 */
  useEffect(() => {
    if (box.w <= 0 || box.h <= 0) return;
    const timer = window.setTimeout(() => fitView(), 160);
    return () => window.clearTimeout(timer);
  }, [box.w, box.h, fitView]);

  useEffect(() => props.registerFit?.(fitView), [fitView, props]);

  /* —— 吸附：把 delta 修正到网格 / 参考线 —— */
  const snapDelta = useCallback(
    (delta: Point, anchor: Point): Point => {
      if (!snapOn) return delta;
      const st = store.getState();
      const candidates = new Set<number>();
      for (let g = 0; g <= PAPER_W; g += GRID_STEP) candidates.add(g);
      st.guides.v.forEach((g) => candidates.add(g));
      const best = (raw: number, target: number, maxV: number) => {
        let out = 0;
        let bestD = Infinity;
        for (const c of candidates) {
          if (c < 0 || c > maxV) continue;
          const d = Math.abs(target + raw - c);
          if (d < bestD) {
            bestD = d;
            out = c - (target + raw);
          }
        }
        return bestD < 7 / (zoom * stageScale) ? out : 0;
      };
      const nx = best(delta.x, anchor.x, PAPER_W);
      const ny = best(delta.y, anchor.y, PAPER_H);
      return { x: delta.x + nx, y: delta.y + ny };
    },
    [snapOn, zoom, store, stageScale]
  );

  /* —— svg 事件入口 —— */

  const classify = (e: React.PointerEvent) => {
    const t = e.target as Element;
    const hit = <K extends string>(cmd: K) => t.closest(`[data-cmd="${cmd}"]`) as HTMLElement | null;
    const resizeEl = hit('resize-single') || hit('resize-many');
    const anchorEl = hit('anchor');
    const handleEl = hit('handle');
    const rotateEl = hit('rotate');
    const bodyEl = t.closest('[data-cmd="obj"]') as HTMLElement | null;
    return {
      resize: resizeEl ? { many: Boolean(hit('resize-many')), edge: resizeEl.dataset.edge || 'se' } : null,
      anchor: anchorEl ? { objId: anchorEl.dataset.oid || '', index: Number(anchorEl.dataset.index) } : null,
      handle: handleEl ? { objId: handleEl.dataset.oid || '', index: Number(handleEl.dataset.index), side: handleEl.dataset.side as 'hIn' | 'hOut' } : null,
      rotate: rotateEl ? {} : null,
      body: bodyEl ? { objId: bodyEl.dataset.oid || '' } : null,
    };
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if ((e.target as Element).closest?.('.vs-foreign-edit')) return;
      const st = store.getState();
      const world = toWorld(e.clientX, e.clientY);

      if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
        gestureRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY }, moved: false };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;

      const capture = () => {
        try {
          svgRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* 某些指针类型不支持捕获 */
        }
      };
      capture();

      // 钢笔工具：点击/拖动锚点流
      if (tool === 'pen') {
        const now = Date.now();
        if (!st.penPts) {
          // 刚闭合（双击结束）后的连击不应开启新草稿
          if (now - penLastActionRef.current < 420) {
            e.preventDefault();
            return;
          }
          st.penBegin(world);
          penLastActionRef.current = now;
          setPenCursor(world);
          gestureRef.current = { kind: 'pen', down: world, moved: false };
        } else {
          const pts = st.penPts;
          if (pts.length >= 3 && Math.hypot(world.x - pts[0].x, world.y - pts[0].y) < 12 / zoom) {
            st.penFinish(true);
            penLastActionRef.current = now;
            return;
          }
          const last = pts[pts.length - 1];
          // 双击判定：靠近末点且与上次点击间隔 < 380ms → 抑制本次加点（交给双击闭合）
          const nearLast = Math.hypot(world.x - last.x, world.y - last.y) < 16 / zoom;
          penSuppressRef.current = nearLast && now - penLastActionRef.current < 380;
          gestureRef.current = { kind: 'pen', down: world, moved: false };
          setPenCursor(world);
        }
        e.preventDefault();
        return;
      }

      if (tool !== 'select' && tool !== 'hand') {
        // 图形绘制：点击或拖拽
        st.beginGesture();
        const shapeKind = tool as VecShapeKind;
        gestureRef.current = { kind: 'create', shape: shapeKind, from: world };
        setCreating({ shape: shapeKind, from: world, to: world });
        e.preventDefault();
        return;
      }

      // —— select / hand 命中分析 ——
      const c = classify(e);
      const objId = c.body?.objId || c.anchor?.objId || c.handle?.objId;
      const obj = objId ? st.objects.find((o) => o.id === objId) : undefined;

      if (c.anchor && obj) {
        st.beginGesture();
        st.selectOne(obj.id);
        st.setActiveAnchor({ id: obj.id, index: c.anchor.index });
        gestureRef.current = { kind: 'anchor', objId: obj.id, index: c.anchor.index, down: world, moved: false };
        e.preventDefault();
        return;
      }
      if (c.handle && obj) {
        st.beginGesture();
        st.selectOne(obj.id);
        st.setActiveAnchor({ id: obj.id, index: c.handle.index });
        gestureRef.current = { kind: 'handle', objId: obj.id, index: c.handle.index, side: c.handle.side, down: world, moved: false };
        e.preventDefault();
        return;
      }
      if (c.resize) {
        if (st.selectedIds.length === 1 && !c.resize.many) {
          st.beginGesture();
          gestureRef.current = { kind: 'resize-single', edge: c.resize.edge, objId: st.selectedIds[0], downWorld: world };
        } else if (st.selectedIds.length > 1 || c.resize.many) {
          st.beginGesture();
          const sel = st.selectedIds.length ? st.selectedIds : (objId ? [objId] : []);
          if (sel.length) st.selectIds(sel);
          gestureRef.current = { kind: 'resize-many', edge: c.resize.edge, downWorld: world, origin: world };
        }
        e.preventDefault();
        return;
      }
      if (c.rotate) {
        const sel = st.selectedIds;
        if (!sel.length) return;
        const b = unionBounds(st.objects, sel);
        const pivot = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        st.beginGesture();
        gestureRef.current = {
          kind: 'rotate',
          pivot,
          startAngle: (Math.atan2(world.y - pivot.y, world.x - pivot.x) * 180) / Math.PI,
          startRot: st.objects.find((o) => o.id === sel[sel.length - 1])?.rotation || 0,
        };
        e.preventDefault();
        return;
      }
      if (obj) {
        if (obj.locked) {
          if (!e.shiftKey) st.selectOne(obj.id);
          return;
        }
        if (e.shiftKey) st.selectOne(obj.id, { shift: true });
        else if (!st.selectedIds.includes(obj.id)) st.selectOne(obj.id);
        st.beginGesture();
        const live = store.getState();
        const orig = live.objects
          .filter((o) => live.selectedIds.includes(o.id) && !o.locked)
          .map((o) => ({ id: o.id, x: o.x, y: o.y }));
        gestureRef.current = { kind: 'move', down: world, moved: false, orig };
        e.preventDefault();
        return;
      }

      // 空白处
      if (tool === 'hand') {
        gestureRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY }, moved: false };
        return;
      }
      st.beginGesture();
      gestureRef.current = { kind: 'marquee', from: world };
      setMarquee({ from: world, to: world });
    },
    [store, toWorld, tool, zoom]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const world = toWorld(e.clientX, e.clientY);
      store.getState().setPointer(world);
      const st = store.getState();
      if (tool === 'pen') setPenCursor(world);
      const g = gestureRef.current;
      if (g.kind === 'none') return;

      if (g.kind === 'pan') {
        const dx = (e.clientX - g.last.x) / stageScale;
        const dy = (e.clientY - g.last.y) / stageScale;
        if (Math.hypot(dx, dy) > 1) g.moved = true;
        st.setViewport(st.zoom, { x: st.pan.x + dx, y: st.pan.y + dy });
        gestureRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY }, moved: g.moved };
        return;
      }
      if (g.kind === 'move') {
        if (Math.hypot(world.x - g.down.x, world.y - g.down.y) > 3 / zoom) g.moved = true;
        if (!g.moved || !g.orig.length) return;
        let dx = world.x - g.down.x;
        let dy = world.y - g.down.y;
        if (!e.shiftKey) {
          const leader = g.orig[g.orig.length - 1];
          if (leader) {
            const snap = snapDelta({ x: dx, y: dy }, { x: leader.x, y: leader.y });
            dx = snap.x;
            dy = snap.y;
          }
        }
        const byId = new Map(g.orig.map((o) => [o.id, o]));
        const next = st.objects.map((o) => {
          const start = byId.get(o.id);
          if (!start || o.locked) return o;
          return { ...o, x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
        });
        st.applyLive(next);
        return;
      }
      if (g.kind === 'marquee') {
        setMarquee({ from: g.from, to: world });
        return;
      }
      if (g.kind === 'create') {
        setCreating({ shape: g.shape, from: g.from, to: world });
        return;
      }
      if (g.kind === 'resize-single') {
        const obj = st.objects.find((o) => o.id === g.objId);
        if (!obj || obj.locked) return;
        const next = resizeSingleLive(st.objects, obj.id, g.edge, obj, world, g.downWorld, e.shiftKey);
        st.applyLive(next);
        return;
      }
      if (g.kind === 'resize-many') {
        const sel = st.selectedIds;
        if (!sel.length) return;
        const next = resizeManyLive(st.objects, sel, g.edge, world, g.origin, e.shiftKey);
        if (next) st.applyLive(next);
        return;
      }
      if (g.kind === 'rotate') {
        const sel = st.selectedIds;
        if (!sel.length) return;
        let angle = (Math.atan2(world.y - g.pivot.y, world.x - g.pivot.x) * 180) / Math.PI - g.startAngle;
        if (e.shiftKey) angle = Math.round(angle / 15) * 15;
        const next = st.objects.map((o) =>
          sel.includes(o.id) && !o.locked ? { ...o, rotation: Math.round((g.startRot + angle) * 10) / 10 } : o
        );
        st.applyLive(next);
        return;
      }
      if (g.kind === 'anchor') {
        if (Math.hypot(world.x - g.down.x, world.y - g.down.y) > 3 / zoom) g.moved = true;
        if (!g.moved) return;
        const obj = st.objects.find((o) => o.id === g.objId);
        if (!obj || !obj.anchors) return;
        const anchors = [...obj.anchors];
        const a = anchors[g.index];
        if (!a) return;
        const local = worldToLocal(obj, world);
        const dx = local.x - a.x;
        const dy = local.y - a.y;
        const hInOff = a.hIn ? { x: a.hIn.x - a.x, y: a.hIn.y - a.y } : null;
        const hOutOff = a.hOut ? { x: a.hOut.x - a.x, y: a.hOut.y - a.y } : null;
        a.x = Math.round(local.x);
        a.y = Math.round(local.y);
        if (a.hIn) {
          a.hIn.x = a.x + (hInOff?.x ?? 0);
          a.hIn.y = a.y + (hInOff?.y ?? 0);
        }
        if (a.hOut) {
          a.hOut.x = a.x + (hOutOff?.x ?? 0);
          a.hOut.y = a.y + (hOutOff?.y ?? 0);
        }
        void dx;
        void dy;
        st.applyLive(st.objects.map((o) => (o.id === obj.id ? { ...o, anchors } : o)));
        return;
      }
      if (g.kind === 'handle') {
        if (Math.hypot(world.x - g.down.x, world.y - g.down.y) > 3 / zoom) g.moved = true;
        const obj = st.objects.find((o) => o.id === g.objId);
        if (!obj || !obj.anchors) return;
        const local = worldToLocal(obj, world);
        const anchors = [...obj.anchors];
        const a = anchors[g.index];
        if (!a) return;
        const target = { x: Math.round(local.x), y: Math.round(local.y) };
        a[g.side] = { ...target };
        if (a.smooth) {
          const opposite = g.side === 'hOut' ? 'hIn' : 'hOut';
          const len = Math.hypot(target.x - a.x, target.y - a.y) || 1;
          if (a[opposite]) {
            const nx = a.x - (target.x - a.x);
            const ny = a.y - (target.y - a.y);
            const nl = Math.hypot(nx - a.x, ny - a.y) || 1;
            a[opposite] = { x: a.x + ((nx - a.x) / nl) * len, y: a.y + ((ny - a.y) / nl) * len };
          }
        }
        st.applyLive(st.objects.map((o) => (o.id === obj.id ? { ...o, anchors } : o)));
        return;
      }
      if (g.kind === 'pen') {
        if (e.buttons === 0) return;
        if (Math.hypot(world.x - g.down.x, world.y - g.down.y) > 4 / zoom) g.moved = true;
        if (g.moved) st.penUpdateLast(world, true);
        return;
      }
      if (g.kind === 'guide') {
        const pos = g.axis === 'v' ? world.x : world.y;
        setGuideGhost({ axis: g.axis, pos });
        return;
      }
    },
    [snapDelta, store, toWorld, zoom, tool]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const st = store.getState();
      const world = toWorld(e.clientX, e.clientY);
      const g = gestureRef.current;

      if (g.kind === 'move') st.endGesture();
      else if (g.kind === 'pan') st.endGesture();
      else if (g.kind === 'resize-single') st.endGesture('已调整大小');
      else if (g.kind === 'resize-many') st.endGesture('已统一缩放');
      else if (g.kind === 'rotate') st.endGesture('已旋转');
      else if (g.kind === 'anchor' || g.kind === 'handle') st.endGesture();
      else if (g.kind === 'marquee') {
        const x0 = Math.min(g.from.x, world.x);
        const y0 = Math.min(g.from.y, world.y);
        const x1 = Math.max(g.from.x, world.x);
        const y1 = Math.max(g.from.y, world.y);
        const tiny = Math.abs(x1 - x0) < 3 / zoom && Math.abs(y1 - y0) < 3 / zoom;
        if (tiny) {
          if (!e.shiftKey) st.clearSelection();
        } else {
          const picked = st.objects
            .filter((o) => o.visible && !o.locked)
            .filter((o) => {
              const b = worldBoundsOf(o);
              return b.x0 <= x1 && b.x1 >= x0 && b.y0 <= y1 && b.y1 >= y0;
            })
            .map((o) => o.id);
          if (e.shiftKey) st.selectIds([...new Set([...st.selectedIds, ...picked])]);
          else st.selectIds(picked);
          st.setActiveAnchor(null);
        }
        setMarquee(null);
      } else if (g.kind === 'create') {
        const from = g.from;
        const w = Math.abs(world.x - from.x);
        const h = Math.abs(world.y - from.y);
        const cx = (from.x + world.x) / 2;
        const cy = (from.y + world.y) / 2;
        const small = Math.max(w, h) < 6 / zoom;
        if (small) {
          st.addFromPreset(g.shape, world);
        } else {
          st.addFromPreset(g.shape, { x: cx, y: cy }, { w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) });
          if (g.shape === 'arrow' && world.x < from.x) {
            const added = st.objects[st.objects.length - 1];
            if (added) st.updateOne(added.id, { rotation: 180 });
          }
        }
        if (g.shape === 'text') {
          const added = st.objects[st.objects.length - 1];
          if (added) {
            st.beginGesture();
            st.setEditing(added.id);
          }
        }
        setCreating(null);
      } else if (g.kind === 'pen') {
        const pts = st.penPts;
        if (pts && pts.length) {
          if (!g.moved) {
            if (penSuppressRef.current) {
              penSuppressRef.current = false;
              // 双击第二击：若已 ≥3 点则闭合，否则仅作废该击
              if (pts.length >= 3) {
                st.penFinish(true);
                penLastActionRef.current = Date.now();
              }
            } else {
              const last = pts[pts.length - 1];
              if (Math.hypot(world.x - last.x, world.y - last.y) >= 10 / zoom) {
                st.penAddPoint(world);
                penLastActionRef.current = Date.now();
              }
            }
          } else {
            penLastActionRef.current = Date.now();
          }
        }
        setPenCursor(null);
      } else if (g.kind === 'guide') {
        const pos = g.axis === 'v' ? world.x : world.y;
        if (Math.abs(pos - g.from) > 2 / zoom) st.addGuide(g.axis, Math.round(pos));
        setGuideGhost(null);
      }
      gestureRef.current = { kind: 'none' };
    },
    [store, toWorld]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const st = store.getState();
      const world = toWorld(e.clientX, e.clientY);
      const t = e.target as Element;

      // 锚点双击：切换 平滑/角点
      const anchorEl = t.closest('[data-cmd="anchor"]') as HTMLElement | null;
      if (anchorEl) {
        const oid = anchorEl.dataset.oid || '';
        const index = Number(anchorEl.dataset.index);
        const obj = st.objects.find((o) => o.id === oid);
        if (obj && obj.type === 'bezier' && obj.anchors?.[index]) {
          const smooth = !obj.anchors[index].smooth;
          st.updateOne(oid, { anchors: setAnchorSmooth(obj, index, smooth) }, smooth ? '锚点已平滑化' : '锚点已转为角点');
          st.selectOne(oid);
          st.setActiveAnchor({ id: oid, index });
        }
        return;
      }
      if (t.closest('[data-cmd="chrome"], [data-cmd="rotate"], [data-cmd="resize-single"], [data-cmd="resize-many"], [data-cmd="handle"]')) return;

      // 钢笔工具（无草稿时）：双击已有贝塞尔路径 = 在该处插入锚点
      if (tool === 'pen' && !st.penPts && Date.now() - penLastActionRef.current > 420) {
        const bez = [...st.objects].reverse().find((o) => o.visible && o.type === 'bezier' && o.anchors && hitTest(o, world));
        if (bez) {
          const local = worldToLocal(bez, world);
          st.updateOne(bez.id, { anchors: insertAnchorAt(bez, local) }, '已插入锚点');
          st.selectOne(bez.id);
        }
        return;
      }

      // 双击图形：进入文字编辑
      const obj = [...st.objects].reverse().find((o) => o.visible && !o.locked && hitTest(o, world));
      if (obj) {
        if (obj.type === 'bezier' && !obj.text) return;
        st.beginGesture();
        st.selectOne(obj.id);
        st.setEditing(obj.id);
      }
    },
    [store, toWorld, tool]
  );

  // 滚轮缩放（光标锚定）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = store.getState();
      const rect = svg.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = clamp(st.zoom * factor, 0.2, 4);
      const k = next / st.zoom;
      const ox = PAPER_ORIGIN.x + st.pan.x;
      const oy = PAPER_ORIGIN.y + st.pan.y;
      const mx = (e.clientX - rect.left) / stageScale;
      const my = (e.clientY - rect.top) / stageScale;
      st.setViewport(next, { x: (ox + (mx - ox) * k) - PAPER_ORIGIN.x, y: (oy + (my - oy) * k) - PAPER_ORIGIN.y });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [store, stageScale]);

  // 空格平移
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.code === 'Space' && !typing) spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const panned = gestureRef.current.kind === 'pan' || spaceRef.current;
  const cursorClass =
    panned ? 'vs-cursor-grab' :
    tool === 'hand' ? 'vs-cursor-grab' :
    tool === 'pen' ? 'vs-cursor-pen' :
    tool === 'select' ? '' :
    'vs-cursor-cross';

  const selSingle = selectedIds.length === 1 ? objects.find((o) => o.id === selectedIds[0]) : undefined;
  const multiSel = selectedIds.length > 1;
  const unionBox = multiSel ? unionBounds(objects, selectedIds) : undefined;
  const hoverClose =
    penPts && penPts.length >= 3 && penCursor
      ? Math.hypot(penCursor.x - penPts[0].x, penCursor.y - penPts[0].y) < 12 / zoom
      : false;
  const penCloseR = 12 / zoom;

  return (
    <main className={`vs-stage${props.compact ? ' vs-stage-compact' : ''}`}>
      {props.compact ? null : (
        <div className="vs-stagebar">
          <span className="vs-crumbs">
            Project / <b>{mode === 'logic' ? '逻辑分析' : '图像设计'}</b>
            <i className="vs-mode-badge">{mode === 'logic' ? '◌ 集合逻辑' : '✦ 图形编辑'}</i>
          </span>
          <span className="vs-hint">
            {tool === 'pen'
              ? '单击添加锚点 · 拖动末点拉出控制柄 · 单击首点或 Enter/双击 闭合 · 右键结束开放路径'
              : '滚轮缩放（光标锚定）· 空格/中键拖动平移 · 双击图形直接编辑文字 · 从标尺拖出参考线'}
          </span>
        </div>
      )}

      <div className="vs-canvas" ref={wrapRef}>
        <div className="vs-ruler vs-ruler-top" onPointerDown={(e) => { if (guidesOn) gestureRef.current = { kind: 'guide', axis: 'v', from: toWorld(e.clientX, e.clientY).x }; }}>
          <RulerTicks axis="v" />
        </div>
        <div className="vs-ruler vs-ruler-left" onPointerDown={(e) => { if (guidesOn) gestureRef.current = { kind: 'guide', axis: 'h', from: toWorld(e.clientX, e.clientY).y }; }}>
          <RulerTicks axis="h" />
        </div>
        <div className="vs-ruler-corner" />

        <svg
          ref={svgRef}
          className={`vs-svg ${cursorClass}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => store.getState().setPointer(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            if (tool === 'pen' && store.getState().penPts) {
              e.preventDefault();
              store.getState().penFinish(false);
            }
          }}
        >
          <defs>
            <pattern id="vs-grid-minor" width={GRID_STEP} height={GRID_STEP} patternUnits="userSpaceOnUse">
              <path d={`M ${GRID_STEP} 0 L 0 0 0 ${GRID_STEP}`} fill="none" stroke="currentColor" strokeOpacity="0.06" strokeWidth="1" />
            </pattern>
            <pattern id="vs-grid-major" width={100} height={100} patternUnits="userSpaceOnUse">
              <rect width="100" height="100" fill="url(#vs-grid-minor)" />
              <path d="M 100 0 L 0 0 0 100" fill="none" stroke="currentColor" strokeOpacity="0.13" strokeWidth="1" />
            </pattern>
            <filter id="vs-paper-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="18" stdDeviation="26" floodColor="#000" floodOpacity="0.32" />
            </filter>
          </defs>

          <g className="vs-world" transform={`translate(${PAPER_ORIGIN.x + pan.x} ${PAPER_ORIGIN.y + pan.y}) scale(${zoom})`}>
            <rect className="vs-paper" x={0} y={0} width={PAPER_W} height={PAPER_H} rx={2} filter="url(#vs-paper-shadow)" />
            {gridOn ? <rect className="vs-grid-layer" x={0} y={0} width={PAPER_W} height={PAPER_H} fill="url(#vs-grid-major)" /> : null}
            {mode === 'logic' && guidesOn ? <rect className="vs-logic-paper" x={0} y={0} width={PAPER_W} height={PAPER_H} /> : null}

            {/* 参考线（置于对象之下） */}
            {guidesOn
              ? [...guides.v.map((x) => ({ axis: 'v' as const, pos: x })), ...guides.h.map((y) => ({ axis: 'h' as const, pos: y }))].map((gd, i) => (
                  <line
                    key={`${gd.axis}-${gd.pos}-${i}`}
                    className="vs-guide"
                    x1={gd.axis === 'v' ? gd.pos : 0}
                    y1={gd.axis === 'h' ? gd.pos : 0}
                    x2={gd.axis === 'v' ? gd.pos : PAPER_W}
                    y2={gd.axis === 'h' ? gd.pos : PAPER_H}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const st = store.getState();
                      st.beginGesture();
                      const w = toWorld(e.clientX, e.clientY);
                      gestureRef.current = { kind: 'guide', axis: gd.axis, from: gd.axis === 'v' ? w.x : w.y };
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      store.getState().removeGuide(gd.axis, gd.pos);
                    }}
                  />
                ))
              : null}

            {/* 逻辑结果高亮 */}
            {mode === 'logic' && props.analysis.resultUrl ? (
              <image
                href={props.analysis.resultUrl}
                x={0}
                y={0}
                width={PAPER_W}
                height={PAPER_H}
                pointerEvents="none"
                preserveAspectRatio="none"
                className="vs-logic-highlight"
              />
            ) : null}

            {/* 图形 */}
            {objects.map((o) => (
              <ShapeLayer key={o.id} obj={o} />
            ))}

            {/* 选中 Chrome（单个） */}
            {selSingle && !selSingle.locked ? (
              <SingleChrome obj={selSingle} activeAnchor={activeAnchor} />
            ) : selSingle && selSingle.locked ? (
              <g transform={singleLocalTransform(selSingle, zoom, pan)} className="vs-chrome vs-chrome-locked">
                <rect className="vs-select-box-locked" x={-5 / zoom} y={-5 / zoom} width={selSingle.width + 10 / zoom} height={selSingle.height + 10 / zoom} rx={3 / zoom} />
              </g>
            ) : null}
            {multiSel && unionBox ? (
              <MultiChrome box={unionBox} />
            ) : null}

            {/* 钢笔草稿 */}
            {penPts && penPts.length ? (
              <g className="vs-pen-draft">
                {penPts.slice(0, -1).map((p, i) => {
                  const q = penPts[i + 1];
                  const hp = (p as { h?: Point }).h;
                  return hp && q ? (
                    <path key={i} d={`M ${p.x} ${p.y} C ${hp.x} ${hp.y}, ${q.x} ${q.y}, ${q.x} ${q.y}`} fill="none" />
                  ) : (
                    <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
                  );
                })}
                {penCursor ? (
                  <>
                    {(() => {
                      const last = penPts[penPts.length - 1];
                      const hp = last.h;
                      if (hp) {
                        return (
                          <path
                            key="rubber-c"
                            className="vs-pen-rubber"
                            d={`M ${last.x} ${last.y} C ${hp.x} ${hp.y}, ${penCursor.x} ${penCursor.y}, ${penCursor.x} ${penCursor.y}`}
                            fill="none"
                          />
                        );
                      }
                      return (
                        <line key="rubber" className="vs-pen-rubber" x1={last.x} y1={last.y} x2={penCursor.x} y2={penCursor.y} />
                      );
                    })()}
                    {hoverClose ? <circle className="vs-pen-close" cx={penPts[0].x} cy={penPts[0].y} r={penCloseR} /> : null}
                  </>
                ) : null}
                {penPts.map((p, i) => (
                  <g key={i}>
                    {p.h ? (
                      <>
                        <line className="vs-pen-handle-line" x1={p.x} y1={p.y} x2={p.h.x} y2={p.h.y} />
                        <circle className="vs-pen-handle-dot" cx={p.h.x} cy={p.h.y} r={3.5} />
                      </>
                    ) : null}
                    <circle className={i === 0 ? 'vs-pen-first' : 'vs-pen-dot'} cx={p.x} cy={p.y} r={i === 0 ? 5 : 4} />
                  </g>
                ))}
                {penPts.slice(0, -1).map((p, i) => {
                  const q = penPts[i + 1];
                  const hp = p.h;
                  return hp && q ? (
                    <path key={`c${i}`} d={`M ${p.x} ${p.y} C ${hp.x} ${hp.y}, ${q.x} ${q.y}, ${q.x} ${q.y}`} fill="none" />
                  ) : (
                    <line key={`l${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
                  );
                })}
              </g>
            ) : null}

            {/* 创建预览 */}
            {creating ? (
              <rect
                className="vs-create-preview"
                x={Math.min(creating.from.x, creating.to.x)}
                y={Math.min(creating.from.y, creating.to.y)}
                width={Math.abs(creating.to.x - creating.from.x)}
                height={Math.abs(creating.to.y - creating.from.y)}
              />
            ) : null}
            {/* 框选 */}
            {marquee ? (
              <rect
                className="vs-marquee"
                x={Math.min(marquee.from.x, marquee.to.x)}
                y={Math.min(marquee.from.y, marquee.to.y)}
                width={Math.abs(marquee.to.x - marquee.from.x)}
                height={Math.abs(marquee.to.y - marquee.from.y)}
              />
            ) : null}
            {/* 参考线幽灵 */}
            {guideGhost ? (
              <line
                className="vs-guide-ghost"
                x1={guideGhost.axis === 'v' ? guideGhost.pos : 0}
                y1={guideGhost.axis === 'h' ? guideGhost.pos : 0}
                x2={guideGhost.axis === 'v' ? guideGhost.pos : PAPER_W}
                y2={guideGhost.axis === 'h' ? guideGhost.pos : PAPER_H}
                pointerEvents="none"
              />
            ) : null}
          </g>
        </svg>

        {mode === 'logic' ? (
          <div className="vs-logic-legend">
            <i />
            {(() => {
              const meta = LOGIC_OP_META.find((m) => m.op === store.getState().logicOp);
              return `高亮：${meta?.symbol ?? ''} ${meta?.label ?? ''}`;
            })()}
            {props.analysis.ready ? <b>{props.analysis.resultArea.toLocaleString()} px²</b> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}

/** 单个对象的本地变换串 */
function singleLocalTransform(o: VecObject, _zoom: number, _pan: Point): string {
  return `translate(${o.x} ${o.y}) rotate(${o.rotation} ${o.width / 2} ${o.height / 2})`;
}

function unionBounds(objects: VecObject[], ids: string[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  objects.forEach((o) => {
    if (!ids.includes(o.id)) return;
    const b = worldBoundsOf(o);
    xs.push(b.x0, b.x1);
    ys.push(b.y0, b.y1);
  });
  if (!xs.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 单对象缩放：锚定对边，支持等比 */
function resizeSingleLive(
  objects: VecObject[],
  id: string,
  edge: string,
  origin: VecObject,
  world: Point,
  down: Point,
  keepAspect: boolean
): VecObject[] {
  return objects.map((o) => {
    if (o.id !== id || o.locked) return o;
    const local = worldToLocal(o, world);
    const downLocal = worldToLocal(o, down);
    const hasW = edge.includes('w');
    const hasE = edge.includes('e');
    const hasN = edge.includes('n');
    const hasS = edge.includes('s');
    const aspect = o.width / Math.max(1, o.height);

    let newX = 0;
    let newY = 0;
    let newW = o.width;
    let newH = o.height;
    if (hasW || hasE) {
      let raw = hasW ? o.width - local.x : local.x;
      const rawStart = hasW ? o.width - downLocal.x : downLocal.x;
      if (keepAspect && (hasW || hasE) && (hasN || hasS)) {
        const dir = hasW ? -1 : 1;
        const rawH = hasN ? o.height - local.y : local.y;
        const k = Math.abs(raw) > Math.abs(rawH) ? Math.abs(raw) / (aspect * Math.max(1, o.height)) : Math.abs(rawH) / o.height;
        void rawStart;
        void dir;
        newW = o.width * (hasN || hasS ? k : 1);
        newH = o.height * k;
      } else {
        newW = Math.max(MIN_SIZE, raw);
      }
      if (hasW) newX = o.x + (o.width - newW);
      if (Math.abs(rawStart) < 2) newW = o.width;
      newX = o.x + (hasW ? o.width - newW : 0);
    }
    if (hasN || hasS) {
      let raw = hasN ? o.height - local.y : local.y;
      if (!(keepAspect && (hasW || hasE))) {
        newH = Math.max(MIN_SIZE, raw);
      } else {
        newH = o.height;
        raw = newH;
      }
      if (hasN) newY = o.y + (o.height - newH);
      void raw;
      newY = o.y + (hasN ? o.height - newH : 0);
    }
    // 等比模式下统一用上面算出的 newW 推导 newH
    if (keepAspect && (hasW || hasE) && (hasN || hasS)) {
      const k = newW / o.width;
      newH = o.height * k;
      if (hasN) newY = o.y + (o.height - newH);
    }
    const patch: Partial<VecObject> = {
      x: Math.round(newX),
      y: Math.round(newY),
      width: Math.round(newW),
      height: Math.round(newH),
    };
    if (o.type === 'bezier' && o.anchors) {
      const sx = newW / o.width;
      const sy = newH / o.height;
      patch.anchors = o.anchors.map((a) => ({
        ...a,
        x: Math.round(a.x * sx),
        y: Math.round(a.y * sy),
        hIn: a.hIn ? { x: Math.round(a.hIn.x * sx), y: Math.round(a.hIn.y * sy) } : undefined,
        hOut: a.hOut ? { x: Math.round(a.hOut.x * sx), y: Math.round(a.hOut.y * sy) } : undefined,
      }));
    }
    return { ...o, ...patch };
  });
}

/** 多选缩放：无旋转时非等比（各轴独立），含旋转对象时自动等比，避免形状畸变 */
function resizeManyLive(
  objects: VecObject[],
  ids: string[],
  edge: string,
  world: Point,
  origin: Point,
  keepAspect: boolean
): VecObject[] | null {
  const box = unionBounds(objects, ids);
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  if (bw < 4 || bh < 4) return null;
  const pivot: Point = {
    x: edge.includes('w') ? box.x1 : box.x0,
    y: edge.includes('n') ? box.y1 : box.y0,
  };
  const rotatedAny = objects.some((o) => ids.includes(o.id) && Math.abs(o.rotation) > 0.05);
  const uniform = keepAspect || rotatedAny;
  const dx = world.x - pivot.x;
  const dy = world.y - pivot.y;
  const sxRaw = edge.includes('w') || edge.includes('e') ? (edge.includes('w') ? -dx / bw : dx / bw) : 1;
  const syRaw = edge.includes('n') || edge.includes('s') ? (edge.includes('n') ? -dy / bh : dy / bh) : 1;
  void origin;
  if (uniform) {
    const k = Math.max(Math.abs(sxRaw), Math.abs(syRaw)) || 0.01;
    const sign = (sxRaw >= 0 && syRaw >= 0) ? 1 : -1;
    return objects.map((o) => (ids.includes(o.id) && !o.locked ? scaleObjectAbout(o, pivot, clamp(sign * k, 0.02, 40), clamp(sign * k, 0.02, 40)) : o));
  }
  const sx = clamp(sxRaw, 0.02, 40);
  const sy = clamp(syRaw, 0.02, 40);
  return objects.map((o) => (ids.includes(o.id) && !o.locked ? scaleObjectAbout(o, pivot, sx, sy) : o));
}

/** 对象绕世界锚点等比/非等比缩放（旋转对象自动按局部轴换算，保持形状） */
export function scaleObjectAbout(o: VecObject, pivot: Point, sx: number, sy: number): VecObject {
  const uniform = Math.abs(sx - sy) < 1e-6;
  if (uniform) {
    const s = sx;
    const rad = (o.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const map = (p: Point): Point => {
      // 世界坐标
      const wx = o.x + (p.x - o.x) * 1;
      void wx;
      const local = p;
      const lx = local.x - o.x;
      const ly = local.y - o.y;
      const worldX = o.x + lx * cos - ly * sin;
      const worldY = o.y + lx * sin + ly * cos;
      void worldX;
      void worldY;
      return { x: local.x, y: local.y };
    };
    void map;
    // 直接按局部轴等比：锚点世界位置 → 缩放 → 反解新局部坐标
    const next: VecObject = {
      ...o,
      x: pivot.x + (o.x - pivot.x) * s,
      y: pivot.y + (o.y - pivot.y) * s,
      width: Math.max(MIN_SIZE, o.width * s),
      height: Math.max(MIN_SIZE, o.height * s),
    };
    if (o.type === 'bezier' && o.anchors) {
      next.anchors = o.anchors.map((a) => {
        const pts = [a, a.hIn, a.hOut].filter(Boolean) as Point[];
        const mapped = pts.map((p) => {
          const w = localToWorld(o, p);
          const w2 = { x: pivot.x + (w.x - pivot.x) * s, y: pivot.y + (w.y - pivot.y) * s };
          return worldToLocal(next, w2);
        });
        const out: typeof a = { ...a };
        out.x = Math.round(mapped[0].x);
        out.y = Math.round(mapped[0].y);
        if (a.hIn) {
          out.hIn = { x: Math.round(mapped[1].x), y: Math.round(mapped[1].y) };
        }
        if (a.hOut) {
          out.hOut = { x: Math.round(mapped[2].x), y: Math.round(mapped[2].y) };
        }
        return out;
      });
    }
    return next;
  }
  // 非等比：仅对无旋转对象（调用方已保证）
  const next: VecObject = {
    ...o,
    x: pivot.x + (o.x - pivot.x) * sx,
    y: pivot.y + (o.y - pivot.y) * sy,
    width: Math.max(MIN_SIZE, o.width * sx),
    height: Math.max(MIN_SIZE, o.height * sy),
  };
  if (o.type === 'bezier' && o.anchors) {
    next.anchors = o.anchors.map((a) => ({
      ...a,
      x: Math.round(a.x * sx),
      y: Math.round(a.y * sy),
      hIn: a.hIn ? { x: Math.round(a.hIn.x * sx), y: Math.round(a.hIn.y * sy) } : undefined,
      hOut: a.hOut ? { x: Math.round(a.hOut.x * sx), y: Math.round(a.hOut.y * sy) } : undefined,
    }));
  }
  return next;
}

/* ==================== 图形渲染层 ==================== */

const LINE_TYPES = new Set(['bezier', 'arrow', 'text']);

function ShapeLayer({ obj: o }: { obj: VecObject }) {
  const selected = useVector((s) => s.selectedIds.includes(o.id));
  const editing = useVector((s) => s.editingId === o.id);
  if (!o.visible) return null;

  const fill = o.fill === 'none' ? 'transparent' : o.fill;
  const stroke = o.stroke === 'none' ? 'none' : o.stroke;
  const dash = o.strokeStyle === 'dashed' ? '12 7' : o.strokeStyle === 'dotted' ? '2 8' : undefined;
  const isBezier = o.type === 'bezier';
  const transform = `translate(${o.x} ${o.y}) rotate(${o.rotation} ${o.width / 2} ${o.height / 2})`;
  const commonStroke = {
    stroke,
    strokeWidth: o.strokeWidth,
    strokeDasharray: dash,
    vectorEffect: 'non-scaling-stroke' as const,
  };

  return (
    <g
      className={`vs-obj ${selected ? 'vs-obj-selected' : ''} ${o.locked ? 'vs-obj-locked' : ''}`}
      data-cmd="obj"
      data-oid={o.id}
      opacity={o.opacity / 100}
      transform={transform}
    >
      {o.type === 'rectangle' || o.type === 'rounded' ? (
        <rect
          x={0}
          y={0}
          width={o.width}
          height={o.height}
          rx={Math.min(o.radius || 0, o.width / 2, o.height / 2)}
          fill={fill}
          {...commonStroke}
          strokeLinejoin="round"
        />
      ) : o.type === 'ellipse' ? (
        <ellipse
          cx={o.width / 2}
          cy={o.height / 2}
          rx={Math.max(8, o.width / 2)}
          ry={Math.max(8, o.height / 2)}
          fill={fill}
          {...commonStroke}
        />
      ) : o.type === 'arrow' ? (
        <g>
          <ArrowShape o={o} />
          <rect x={0} y={0} width={o.width} height={o.height} fill="transparent" />
        </g>
      ) : isBezier ? (
        <g>
          <path
            d={bezierPathD(o.anchors || [], o.closed)}
            fill={fill}
            {...commonStroke}
            strokeLinejoin="round"
          />
          {o.anchors && o.anchors.length < 3 && o.closed ? (
            <path d={bezierPathD(o.anchors || [], false)} fill="none" stroke="#f66" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          ) : null}
          {/* 开放路径命中辅助 */}
          {!o.closed && (o.anchors?.length || 0) > 0 ? (
            <path
              d={bezierPathD(o.anchors || [], false)}
              fill="none"
              stroke="transparent"
              strokeWidth={Math.max(12, o.strokeWidth + 10)}
              style={{ pointerEvents: 'stroke' }}
            />
          ) : null}
        </g>
      ) : o.type === 'text' ? (
        <rect x={0} y={0} width={o.width} height={o.height} fill="transparent" />
      ) : null}

      {o.type !== 'arrow' && o.text !== '' && !editing ? <TextLabel o={o} /> : null}
      {editing && !LINE_TYPES.has(o.type) ? null : null}
      {editing ? <InlineTextEditor o={o} /> : null}
    </g>
  );
}

function ArrowShape({ o }: { o: VecObject }) {
  const stroke = o.stroke === 'none' ? 'none' : o.stroke;
  const w = Math.max(24, o.width);
  const h = Math.max(16, o.height);
  const y = h / 2;
  const m = Math.min(16, w * 0.24);
  const headLen = Math.min(h, 22);
  if (o.arrowStyle === 'open' || o.arrowStyle === 'barbed') {
    const second = o.arrowStyle === 'barbed';
    return (
      <g fill="none" stroke={stroke} strokeWidth={Math.max(1.5, o.strokeWidth)} strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        <line x1={4} y1={y} x2={Math.max(4, w - m)} y2={y} />
        <path d={`M ${w - m} ${Math.max(2, y - headLen / 2)} L ${w - 3} ${y} L ${w - m} ${Math.min(h - 2, y + headLen / 2)}`} />
        {second ? <path d={`M ${w * 0.55} ${Math.max(2, y - headLen / 2)} L ${w * 0.55 - m + 6} ${y} L ${w * 0.55} ${Math.min(h - 2, y + headLen / 2)}`} strokeOpacity="0.7" /> : null}
      </g>
    );
  }
  return (
    <g vectorEffect="non-scaling-stroke">
      <line x1={4} y1={y} x2={Math.max(4, w - m)} y2={y} stroke={stroke} strokeWidth={Math.max(2, o.strokeWidth)} />
      <path
        d={`M ${w - m} ${Math.max(2, y - headLen / 2)} L ${w - 2} ${y} L ${w - m} ${Math.min(h - 2, y + headLen / 2)} Z`}
        fill={stroke}
      />
    </g>
  );
}

function TextLabel({ o }: { o: VecObject }) {
  const lines = String(o.text || '').split('\n');
  const anchorX = o.textAlign === 'left' ? 2 : o.textAlign === 'right' ? o.width - 2 : o.width / 2;
  const anchor = o.textAlign === 'left' ? 'start' : o.textAlign === 'right' ? 'end' : 'middle';
  const lh = (o.fontSize || 14) * (o.lineHeight || 1.4);
  const padY = o.type === 'text' ? o.fontSize : 0;
  const startY =
    o.type === 'text'
      ? padY
      : o.height / 2 - ((lines.length - 1) * lh) / 2 + (o.fontSize || 14) * 0.36;
  return (
    <text
      className="vs-text-label"
      x={anchorX}
      y={startY}
      textAnchor={anchor}
      fill={o.textColor}
      fontFamily={o.fontFamily}
      fontSize={o.fontSize}
      fontWeight={o.fontWeight}
      pointerEvents="none"
    >
      {lines.map((line, i) => (
        <tspan key={i} x={anchorX} dy={i === 0 ? 0 : lh}>
          {line === '' ? ' ' : line}
        </tspan>
      ))}
    </text>
  );
}

/** 就地文字编辑（foreignObject 内嵌 HTML） */
function InlineTextEditor({ o }: { o: VecObject }) {
  const store = useVector();
  const isText = o.type === 'text';
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [value, setValue] = useState(String(o.text || ''));
  const [initial] = useState(String(o.text || ''));
  const commit = () => {
    const st = store.getState();
    st.setEditing(null);
    st.endGesture();
  };
  const cancel = () => {
    const st = store.getState();
    const obj = st.objects.find((x) => x.id === o.id);
    if (obj && obj.text !== initial) {
      st.undo();
    }
    st.setEditing(null);
  };
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const style: React.CSSProperties = {
    fontFamily: o.fontFamily,
    fontSize: o.fontSize,
    fontWeight: o.fontWeight,
    color: o.textColor,
    lineHeight: o.lineHeight,
    textAlign: o.textAlign,
    width: '100%',
    height: '100%',
  };
  return (
    <foreignObject x={0} y={0} width={Math.max(60, o.width)} height={Math.max(30, o.height)} className="vs-foreign-edit">
      <div {...{ xmlns: 'http://www.w3.org/1999/xhtml' } as Record<string, string>} className="vs-edit-wrap">
        {isText ? (
          <textarea
            ref={(el) => { inputRef.current = el; }}
            className="vs-edit-textarea"
            style={style}
            value={value}
            rows={Math.max(1, value.split('\n').length)}
            onChange={(e) => {
              const v = e.target.value;
              setValue(v);
              const st = store.getState();
              const obj = st.objects.find((x) => x.id === o.id);
              if (obj) {
                st.applyLive(st.objects.map((x) => (x.id === o.id ? { ...x, text: v, name: v.trim().slice(0, 12) || '文本框' } : x)));
              }
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={commit}
          />
        ) : (
          <input
            ref={(el) => { inputRef.current = el; }}
            className="vs-edit-input"
            style={style}
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              setValue(v);
              const st = store.getState();
              st.applyLive(st.objects.map((x) => (x.id === o.id ? { ...x, text: v } : x)));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
        )}
      </div>
    </foreignObject>
  );
}

/* ==================== 选中 Chrome ==================== */

function SingleChrome(props: { obj: VecObject; activeAnchor: { id: string; index: number } | null }) {
  const { obj: o, activeAnchor } = props;
  const zoom = useVector((s) => s.zoom);
  const k = (v: number) => v / zoom;
  const h = k(7);
  const edges = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
  const corners: Record<string, Point> = {
    nw: { x: 0, y: 0 },
    n: { x: o.width / 2, y: 0 },
    ne: { x: o.width, y: 0 },
    e: { x: o.width, y: o.height / 2 },
    se: { x: o.width, y: o.height },
    s: { x: o.width / 2, y: o.height },
    sw: { x: 0, y: o.height },
    w: { x: 0, y: o.height / 2 },
  };
  const transform = singleLocalTransform(o, zoom, { x: 0, y: 0 });
  return (
    <g className="vs-chrome" transform={transform} data-cmd="obj" data-oid={o.id}>
      <rect className="vs-select-box" x={-h * 1.2} y={-h * 1.2} width={o.width + h * 2.4} height={o.height + h * 2.4} rx={k(3)} />
      {edges.map((edge) => {
        const p = corners[edge];
        return (
          <rect
            key={edge}
            className="vs-handle-box"
            data-cmd="resize-single"
            data-edge={edge}
            x={p.x - h / 2}
            y={p.y - h / 2}
            width={h}
            height={h}
          />
        );
      })}
      {/* 旋转柄 */}
      <g data-cmd="rotate" className="vs-rotate-g">
        <line className="vs-rotate-arm" x1={o.width / 2} y1={-k(6)} x2={o.width / 2} y2={-k(34)} />
        <circle className="vs-rotate-dot" cx={o.width / 2} cy={-k(34)} r={k(4.5)} />
      </g>

      {/* 贝塞尔锚点与控制柄 */}
      {o.type === 'bezier' && o.anchors ? (
        <g className="vs-anchor-g">
          {o.anchors.map((a, i) => {
            const isActive = activeAnchor?.id === o.id && activeAnchor.index === i;
            return (
              <g key={i}>
                {a.hIn ? (
                  <g data-cmd="handle" data-oid={o.id} data-index={i} data-side="hIn" className="vs-handle-puck-g">
                    <line className="vs-handle-line" x1={a.x} y1={a.y} x2={a.hIn.x} y2={a.hIn.y} />
                    <circle className="vs-handle-puck" cx={a.hIn.x} cy={a.hIn.y} r={k(3.4)} />
                  </g>
                ) : null}
                {a.hOut ? (
                  <g data-cmd="handle" data-oid={o.id} data-index={i} data-side="hOut" className="vs-handle-puck-g">
                    <line className="vs-handle-line" x1={a.x} y1={a.y} x2={a.hOut.x} y2={a.hOut.y} />
                    <circle className="vs-handle-puck" cx={a.hOut.x} cy={a.hOut.y} r={k(3.4)} />
                  </g>
                ) : null}
                <g data-cmd="anchor" data-oid={o.id} data-index={i} className="vs-anchor-hit">
                  <circle className={`vs-anchor ${a.smooth ? 'smooth' : 'corner'} ${isActive ? 'active' : ''}`} cx={a.x} cy={a.y} r={k(isActive ? 6 : 4.6)} />
                </g>
              </g>
            );
          })}
        </g>
      ) : null}
    </g>
  );
}

function MultiChrome(props: { box: { x0: number; y0: number; x1: number; y1: number } }) {
  const zoom = useVector((s) => s.zoom);
  const { box } = props;
  const k = (v: number) => v / zoom;
  const h = k(7);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const w = box.x1 - box.x0;
  const ht = box.y1 - box.y0;
  const pts: Record<string, Point> = {
    nw: { x: box.x0, y: box.y0 },
    n: { x: cx, y: box.y0 },
    ne: { x: box.x1, y: box.y0 },
    e: { x: box.x1, y: cy },
    se: { x: box.x1, y: box.y1 },
    s: { x: cx, y: box.y1 },
    sw: { x: box.x0, y: box.y1 },
    w: { x: box.x0, y: cy },
  };
  const count = useVector((s) => s.selectedIds.length);
  return (
    <g className="vs-chrome vs-chrome-multi">
      <rect className="vs-select-box" x={box.x0 - h} y={box.y0 - h} width={w + h * 2} height={ht + h * 2} rx={k(2)} />
      {count > 1
        ? (['nw', 'ne', 'se', 'sw'] as const).map((edge) => {
            const p = pts[edge];
            return <rect key={edge} className="vs-handle-box" data-cmd="resize-many" data-edge={edge} x={p.x - h / 2} y={p.y - h / 2} width={h} height={h} />;
          })
        : null}
      <g data-cmd="rotate" className="vs-rotate-g">
        <line className="vs-rotate-arm" x1={cx} y1={box.y0 - k(6)} x2={cx} y2={box.y0 - k(34)} />
        <circle className="vs-rotate-dot" cx={cx} cy={box.y0 - k(34)} r={k(4.5)} />
      </g>
      <rect
        className="vs-multi-count"
        x={cx - k(26)}
        y={box.y0 - k(44)}
        width={k(52)}
        height={k(16)}
        rx={k(8)}
      />
      <text className="vs-multi-count-text" x={cx} y={box.y0 - k(32)} textAnchor="middle">{count} 项</text>
    </g>
  );
}

/* ==================== 标尺 ==================== */

function RulerTicks({ axis }: { axis: 'v' | 'h' }) {
  const zoom = useVector((s) => s.zoom);
  const pan = useVector((s) => s.pan);
  const pointer = useVector((s) => s.pointer);
  const horizontal = axis === 'v';
  const o = horizontal ? PAPER_ORIGIN.x + pan.x : PAPER_ORIGIN.y + pan.y;
  const ticks: React.ReactNode[] = [];
  const step = zoom < 0.4 ? 100 : 50;
  for (let v = 0; v <= 1500; v += step) {
    const pos = o + v * zoom;
    const major = v % 100 === 0;
    ticks.push(
      <span key={v} className={`vs-tick ${major ? 'major' : ''} ${horizontal ? '' : 'rot'}`} style={horizontal ? { left: pos } : { top: pos }}>
        {major ? <i>{v}</i> : null}
      </span>
    );
  }
  if (pointer) {
    const pos = o + pointer[horizontal ? 'x' : 'y'] * zoom;
    ticks.push(<span key="c" className="vs-ruler-cursor" style={horizontal ? { left: pos } : { top: pos }} />);
  }
  return <>{ticks}</>;
}
