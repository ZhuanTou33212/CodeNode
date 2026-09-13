/**
 * 画布节点（Canvas Node）—— 把矢量画布直接嵌到 Agent 画布上。
 *
 * 设计要点：
 * - 不再单独占一栏：绘制表面由本节点内嵌；每个节点按 id 持有独立文档 store，互不干扰。
 * - 左上角切换模式：设计（图形编辑） / 逻辑（集合运算分析）。
 * - 预设配件：组件库一键生成图形，或用左侧工具在纸面上自由绘制。
 * - 保持 Blender 风格：标题栏拖拽、左 target / 右 source 端口、选中描边与主色。
 */
import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties, type MutableRefObject } from 'react';
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import type { VectorData } from '../types';
import {
  clearActiveVectorNode,
  getVectorStore,
  setActiveVectorNode,
  VectorStoreContext,
  useVector,
  type VectorStore,
} from './vectorStore';
import { computeLogicAnalysisForSets } from './region';
import type { LogicAnalysis, VecMode, VecShapeKind, VecTool } from './types';
import { PAPER_H, PAPER_W } from './types';
import { SHAPE_GLYPHS, SHAPE_TITLES, sortedObjects } from './model';
import { VectorSurface } from './Surface';
import { LayersPanel, LogicPanel, PropertiesPanel } from './Panels';
import './vector.css';
import './node.css';

/** 节点 data 形态：见 src/types.ts 的 VectorData */
export type VectorNodeData = VectorData;

const DEFAULT_W = 1040;
const DEFAULT_H = 640;
const ACCENT = '#22d3ee';

const EMPTY_ANALYSIS: LogicAnalysis = {
  ready: false,
  sets: [],
  relations: [],
  stats: [],
  resultUrl: null,
  resultArea: 0,
  expression: '—',
};

const TOOLS: { t: VecTool; g: string; k: string; label: string }[] = [
  { t: 'select', g: '↖', k: 'v', label: '选择 (V)' },
  { t: 'pen', g: '✒', k: 'p', label: '钢笔 (P)' },
  { t: 'rectangle', g: '□', k: 'r', label: '矩形 (R)' },
  { t: 'rounded', g: '▢', k: 'u', label: '圆角矩形 (U)' },
  { t: 'ellipse', g: '◯', k: 'e', label: '椭圆 (E)' },
  { t: 'arrow', g: '➔', k: 'a', label: '箭头 (A)' },
  { t: 'text', g: 'T', k: 't', label: '文本 (T)' },
  { t: 'hand', g: '✋', k: 'h', label: '平移 (H)' },
];

const PRESETS: VecShapeKind[] = ['rectangle', 'rounded', 'ellipse', 'bezier', 'arrow', 'text'];

const STATUS_COLOR: Record<string, string> = {
  pending: '#64748b',
  running: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  blocked: '#8b5cf6',
};

/* ==================== 快捷键（仅活跃节点绑定，与工作台互斥） ==================== */

function useNodeHotkeys(store: VectorStore, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.vs-foreign-edit')) return;
      const s = store.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.redo();
        return;
      }
      if (isTyping()) return;
      if (mod && key === 'd') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.duplicateSelected();
        return;
      }
      if (mod && key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.copySelection(false);
        return;
      }
      if (mod && key === 'x') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.copySelection(true);
        return;
      }
      if (mod && key === 'v') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.pasteClipboard();
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.selectAll();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const act = s.activeAnchor;
        if (act) {
          const obj = s.objects.find((o) => o.id === act.id);
          if (obj && obj.type === 'bezier' && obj.anchors && obj.anchors[act.index]) {
            const anchors = [...obj.anchors];
            anchors.splice(act.index, 1);
            if (anchors.length < 3 && obj.closed) {
              s.updateOne(obj.id, { anchors, closed: false }, undefined);
            } else if (anchors.length >= 1) {
              s.updateOne(obj.id, { anchors }, undefined);
            }
            s.setActiveAnchor(null);
            return;
          }
        }
        s.deleteSelected();
        return;
      }
      if (e.key === 'Escape') {
        if (s.penPts) s.penCancel();
        else if (s.activeAnchor) s.setActiveAnchor(null);
        else if (s.editingId) s.setEditing(null);
        else s.clearSelection();
        return;
      }
      if (e.key === 'Enter' && s.penPts) {
        e.preventDefault();
        s.penFinish(true);
        return;
      }
      if (!mod && !e.altKey) {
        const hit = TOOLS.find((t) => t.k === key);
        if (hit) {
          e.preventDefault();
          s.setTool(hit.t);
          return;
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && s.selectedIds.length) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const d: Record<string, [number, number]> = {
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
          };
          const [dx, dy] = d[e.key];
          s.nudgeSelection(dx, dy);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store, active]);
}

/* ==================== 节点 ==================== */

function VectorNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as VectorNodeData;
  const store = useMemo(() => getVectorStore(id), [id]);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const stageScale = useStore((s) => s.transform[2]) || 1;
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    store.getState().init();
  }, [store]);

  useEffect(() => {
    if (selected) setActiveVectorNode(id);
    else clearActiveVectorNode(id);
    return () => clearActiveVectorNode(id);
  }, [selected, id]);

  // 仅当选中的画布节点激活快捷键，避免与工作台全局快捷键互相抢键
  useNodeHotkeys(store, !!selected);

  const accent = d.accent || ACCENT;
  const style = {
    width: d.width || DEFAULT_W,
    height: d.height || DEFAULT_H,
    borderColor: `${accent}b8`,
    '--wf-accent': accent,
  } as CSSProperties;

  return (
    <div
      className={`wf-node wf-vector wf-node-vector ${selected ? 'is-selected' : ''}`}
      style={style}
      data-testid="vector-node"
    >
      <NodeResizer
        isVisible={selected}
        minWidth={560}
        minHeight={380}
        color={accent}
        keepAspectRatio={false}
        onResizeStart={() => {
          const st = useGraphStore.getState();
          st.commit();
          st.setResizing([id]);
        }}
        onResize={(_, params) => {
          const st = useGraphStore.getState();
          const node = st.nodes.find((n) => n.id === id);
          if (!node) return;
          if (Math.abs(params.x - node.position.x) > 0.5 || Math.abs(params.y - node.position.y) > 0.5) {
            st.moveNode(id, { x: params.x, y: params.y }, { moveChildren: false });
          }
          st.updateNodeData(id, { width: Math.round(params.width), height: Math.round(params.height) });
        }}
        onResizeEnd={() => useGraphStore.getState().setResizing([])}
      />
      <Handle type="target" position={Position.Left} className="wf-handle" />

      <VectorStoreContext.Provider value={store}>
        <VectorNodeHead id={id} data={d} store={store} accent={accent} onPersist={updateNodeData} fitRef={fitRef} />
        <VectorNodeBody store={store} stageScale={stageScale} data={d} fitRef={fitRef} />
        <VectorNodeFoot store={store} accent={accent} />
      </VectorStoreContext.Provider>

      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

/* ==================== 标题栏：左上角模式切换 ==================== */

function VectorNodeHead({
  id,
  data,
  store,
  accent,
  onPersist,
  fitRef,
}: {
  id: string;
  data: VectorNodeData;
  store: VectorStore;
  accent: string;
  onPersist: (id: string, patch: Record<string, unknown>) => void;
  fitRef: MutableRefObject<() => void>;
}) {
  const mode = useVector((s) => s.mode);
  const status = data.status || 'pending';
  const canUndo = useVector((s) => s.past.length > 0);
  const canRedo = useVector((s) => s.future.length > 0);
  const dockOpen = data.dockOpen !== false;

  const switchMode = (m: VecMode) => {
    store.getState().setMode(m);
    onPersist(id, { mode: m });
  };

  return (
    <div className="wf-vector-title" title="拖动标题栏可移动画布节点">
      {/* 左上角：模式切换 */}
      <div className="wf-vector-modes nodrag" role="tablist" aria-label="画布节点模式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'design'}
          className={`wf-vector-mode ${mode === 'design' ? 'on' : ''}`}
          title="设计模式：预设配件 + 自由绘制"
          onClick={() => switchMode('design')}
        >
          ✦ 设计
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'logic'}
          className={`wf-vector-mode ${mode === 'logic' ? 'on' : ''}`}
          title="逻辑模式：集合运算与区域分析"
          onClick={() => switchMode('logic')}
        >
          ◌ 逻辑
        </button>
      </div>

      <span className="wf-status-dot" style={{ background: STATUS_COLOR[status] }} title={status} />
      <span className="wf-node-label wf-vector-label">{data.label || '画布节点'}</span>
      {mode === 'logic' ? <i className="wf-vector-badge">集合逻辑</i> : null}

      <div className="wf-vector-actions nodrag">
        <button type="button" className="wf-vector-icon" title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={() => store.getState().undo()}>
          ↶
        </button>
        <button type="button" className="wf-vector-icon" title="重做 (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => store.getState().redo()}>
          ↷
        </button>
        <button type="button" className="wf-vector-icon" title="适应画布" onClick={() => fitRef.current?.()}>
          ⛶
        </button>
        <button
          type="button"
          className={`wf-vector-icon ${dockOpen ? 'on' : ''}`}
          title={dockOpen ? '收起属性/图层面板' : '展开属性/图层面板'}
          onClick={() => onPersist(id, { dockOpen: !dockOpen })}
          style={{ borderColor: dockOpen ? `${accent}88` : undefined }}
        >
          ▤
        </button>
      </div>
    </div>
  );
}

/* ==================== 节点主体：工具栏 + 画布 + 右栏 ==================== */

function VectorNodeBody({
  store,
  stageScale,
  data,
  fitRef,
}: {
  store: VectorStore;
  stageScale: number;
  data: VectorNodeData;
  fitRef: MutableRefObject<() => void>;
}) {
  const mode = useVector((s) => s.mode);
  const dark = useVector((s) => s.dark);
  const objects = useVector((s) => s.objects);
  const selectedIds = useVector((s) => s.selectedIds);
  const logicIds = useVector((s) => s.logicIds);
  const logicOp = useVector((s) => s.logicOp);

  const analysis = useMemo<LogicAnalysis>(() => {
    if (mode !== 'logic') return EMPTY_ANALYSIS;
    return computeLogicAnalysisForSets(sortedObjects(objects, logicIds), logicOp);
  }, [mode, objects, logicIds, logicOp]);

  const dockOpen = data.dockOpen !== false;

  return (
    <div className={`wf-vector-body vs-scope nowheel ${dark ? '' : 'vs-light'}`}>
      <VectorNodeRail store={store} />

      <div className="wf-vector-stage">
        <VectorSurface analysis={analysis} stageScale={stageScale} compact registerFit={(fn) => (fitRef.current = fn)} />
      </div>

      {dockOpen ? (
        <aside className="vs-node-dock nodrag" aria-label="画布节点面板">
          {mode === 'logic' ? <LogicPanel analysis={analysis} /> : <DesignDock store={store} />}
        </aside>
      ) : null}
    </div>
  );
}

function DesignDock({ store }: { store: VectorStore }) {
  const tab = useVector((s) => s.tab);
  const objects = useVector((s) => s.objects);
  const selectedIds = useVector((s) => s.selectedIds);
  const primary = sortedObjects(objects, selectedIds).slice(-1)[0];
  return (
    <>
      <div className="vs-right-tabs">
        <button className={tab === 'properties' ? 'active' : ''} onClick={() => store.getState().setTab('properties')}>
          属性
        </button>
        <button className={tab === 'layers' ? 'active' : ''} onClick={() => store.getState().setTab('layers')}>
          图层 {objects.length}
        </button>
      </div>
      <div className="vs-node-dock-body">
        {tab === 'layers' ? <LayersPanel /> : <PropertiesPanel primary={primary} selectedIds={selectedIds} />}
      </div>
    </>
  );
}

/* ==================== 预设配件 + 工具 ==================== */

function VectorNodeRail({ store }: { store: VectorStore }) {
  const tool = useVector((s) => s.tool);
  const gridOn = useVector((s) => s.gridOn);
  const snapOn = useVector((s) => s.snapOn);

  const addPreset = useCallback(
    (kind: VecShapeKind) => {
      const st = store.getState();
      const at = st.pointer || { x: PAPER_W / 2, y: PAPER_H / 2 };
      const x = Math.min(PAPER_W - 30, Math.max(30, at.x));
      const y = Math.min(PAPER_H - 30, Math.max(30, at.y));
      st.addFromPreset(kind, { x, y });
      st.setTool('select');
    },
    [store]
  );

  return (
    <div className="wf-vector-rail nodrag" aria-label="画布节点工具与预设配件">
      <div className="wf-vector-sec-label">工具</div>
      <div className="wf-vector-tools">
        {TOOLS.map((t) => (
          <button
            key={t.t}
            type="button"
            className={`wf-vector-tool ${tool === t.t ? 'on' : ''}`}
            title={t.label}
            onClick={() => store.getState().setTool(t.t)}
          >
            <span>{t.g}</span>
          </button>
        ))}
      </div>

      <div className="wf-vector-sec-label">配件</div>
      <div className="wf-vector-assets">
        {PRESETS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={`wf-vector-asset asset-${kind}`}
            title={`放置${SHAPE_TITLES[kind]}（在当前指针位置）`}
            onClick={() => addPreset(kind)}
          >
            <span>{SHAPE_GLYPHS[kind]}</span>
            <small>{SHAPE_TITLES[kind]}</small>
          </button>
        ))}
      </div>

      <div className="wf-vector-rail-foot">
        <button
          type="button"
          className={`wf-vector-mini ${gridOn ? 'on' : ''}`}
          title="网格"
          onClick={() => store.getState().toggleGrid()}
        >
          ⊞
        </button>
        <button
          type="button"
          className={`wf-vector-mini ${snapOn ? 'on' : ''}`}
          title="吸附（拖动时按 Shift 临时关闭）"
          onClick={() => store.getState().toggleSnap()}
        >
          ⌖
        </button>
        <button
          type="button"
          className="wf-vector-mini"
          title="载入示例工程"
          onClick={() => store.getState().resetDemo()}
        >
          ↺
        </button>
        <button
          type="button"
          className="wf-vector-mini"
          title="清空画布"
          onClick={() => store.getState().clearAll()}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

/* ==================== 底栏 ==================== */

function VectorNodeFoot({ store, accent }: { store: VectorStore; accent: string }) {
  const mode = useVector((s) => s.mode);
  const status = useVector((s) => s.status);
  const zoom = useVector((s) => s.zoom);
  const pointer = useVector((s) => s.pointer);
  const objects = useVector((s) => s.objects);
  const selectedIds = useVector((s) => s.selectedIds);
  const logicIds = useVector((s) => s.logicIds);
  const logicOp = useVector((s) => s.logicOp);

  const analysis = useMemo<LogicAnalysis>(() => {
    if (mode !== 'logic') return EMPTY_ANALYSIS;
    return computeLogicAnalysisForSets(sortedObjects(objects, logicIds), logicOp);
  }, [mode, objects, logicIds, logicOp]);

  return (
    <div className="wf-vector-foot">
      <span className="wf-vector-foot-status" style={{ color: accent }}>
        {status}
      </span>
      <span className="wf-vector-foot-spacer" />
      {mode === 'logic' ? (
        <span className="wf-vector-foot-tag">
          {analysis.ready ? `结果 ${analysis.resultArea.toLocaleString()} px²` : '选择集合开始分析'}
        </span>
      ) : (
        <span className="wf-vector-foot-tag">
          {objects.length} 图形 · 选中 {selectedIds.length}
        </span>
      )}
      <span className="wf-vector-foot-tag">{pointer ? `X ${Math.round(pointer.x)} Y ${Math.round(pointer.y)}` : `纸面 ${PAPER_W}×${PAPER_H}`}</span>
      <span className="wf-vector-foot-tag">{Math.round(zoom * 100)}%</span>
    </div>
  );
}

export default memo(VectorNode);
