/** 画布节点 —— 右栏面板：属性 / 图层 / 逻辑分析 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVector, type VectorStore } from './vectorStore';
import type { LogicAnalysis, VecArrowStyle, VecGroup, VecHAlign, VecObject, VecStrokeStyle } from './types';
import { LOGIC_OP_META, PAPER_H, PAPER_W } from './types';
import {
  clamp,
  insertAnchorAt,
  OP_SYMBOL,
  round1,
  SHAPE_GLYPHS,
  SHAPE_TITLES,
  setAnchorSmooth,
  sortedObjects,
} from './model';
import { SCALE } from './region';

const FONTS = ['Inter', 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Georgia', 'Consolas', 'system-ui'];

const HUE = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  return m ? `#${m[1].toLowerCase()}` : '#000000';
};

/* ================= 通用小控件 ================= */

function Field({ label, children, wide }: { label: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`vs-field ${wide ? 'vs-field-wide' : ''}`}>
      <span className="vs-field-label">{label}</span>
      {children}
    </label>
  );
}

function NumField(props: {
  label: React.ReactNode;
  value: number;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const { label, value, suffix, min = -99999, max = 99999, step = 1, disabled } = props;
  return (
    <Field label={label}>
      <div className="vs-num-wrap">
        <input
          type="number"
          className="vs-input vs-input-num"
          value={round1(value)}
          disabled={disabled}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) props.onChange(clamp(v, min, max));
          }}
        />
        {suffix ? <small>{suffix}</small> : null}
      </div>
    </Field>
  );
}

function ColorField(props: {
  label: React.ReactNode;
  value: string;
  noneLabel?: string;
  onNone?: () => void;
  onChange: (v: string) => void;
}) {
  const isNone = props.value === 'none';
  const color = isNone ? '#888888' : HUE(props.value);
  return (
    <Field label={props.label}>
      <div className="vs-color-wrap">
        <span className="vs-color-swatch" style={{ background: isNone ? 'repeating-conic-gradient(#555 0 25%, #2a2a2a 0 50%) 0 0 / 8px 8px' : color }}>
          <input
            type="color"
            value={isNone ? '#888888' : color}
            disabled={isNone}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </span>
        <input
          className="vs-input vs-input-hex"
          value={isNone ? 'none' : color}
          disabled={isNone}
          onChange={(e) => {
            let v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v) && v.length === 7) props.onChange(v);
          }}
          onBlur={(e) => {
            const v = e.target.value;
            if (/^#?[0-9a-fA-F]{6}$/.test(v)) props.onChange(v.startsWith('#') ? v : `#${v}`);
          }}
        />
        {props.onNone ? (
          <button className="vs-mini-btn" title={props.noneLabel || '设为无'} onClick={props.onNone}>
            ∅
          </button>
        ) : null}
      </div>
    </Field>
  );
}

function SelectField(props: { label: React.ReactNode; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Field label={props.label}>
      <select className="vs-input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
    </Field>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="vs-section">
      <div className="vs-section-title">
        <span>{title}</span>
        {right}
      </div>
      <div className="vs-section-body">{children}</div>
    </section>
  );
}

/* ================= 属性面板 ================= */

export function PropertiesPanel(props: { primary?: VecObject; selectedIds: string[] }) {
  const { primary: p, selectedIds } = props;
  const store = useVector();
  const activeAnchor = useVector((s) => s.activeAnchor);
  const multi = selectedIds.length > 1;
  const single = selectedIds.length === 1 && Boolean(p);

  if (!single) {
    if (!multi) {
      return (
        <div className="vs-empty-panel">
          <div className="vs-empty-icon">✦</div>
          <b>未选择对象</b>
          <span>在画布上选择一个图形<br />或双击图形直接编辑文字</span>
          <div className="vs-shortcut-tip"><kbd>V</kbd> 选择 <kbd>P</kbd> 钢笔 <kbd>R</kbd> 矩形 <kbd>T</kbd> 文本</div>
        </div>
      );
    }
    const up = (patch: Partial<VecObject>, msg?: string) => store.getState().updateSelection(patch, msg);
    return (
      <div className="vs-props">
        <div className="vs-inspector-head">
          <span className="vs-multi-badge">已选 {selectedIds.length} 项</span>
          <b>统一编辑</b>
        </div>
        <Section title="外观">
          <div className="vs-row2">
            <ColorField label="填充" value={p?.fill ?? '#000000'} onChange={(v) => up({ fill: v }, '已设置填充')} onNone={() => up({ fill: 'none' })} />
            <ColorField label="描边" value={p?.stroke ?? '#000000'} onChange={(v) => up({ stroke: v })} onNone={() => up({ stroke: 'none' })} />
          </div>
          <div className="vs-row2">
            <NumField label="描边" value={p?.strokeWidth ?? 2} suffix="px" min={0} onChange={(v) => up({ strokeWidth: v })} />
            <Field label="线型">
              <select className="vs-input" value={p?.strokeStyle ?? 'solid'} onChange={(e) => up({ strokeStyle: e.target.value as VecStrokeStyle })}>
                <option value="solid">实线</option>
                <option value="dashed">虚线</option>
                <option value="dotted">点线</option>
              </select>
            </Field>
          </div>
          <Field label="不透明度">
            <input
              type="range"
              className="vs-range"
              min={0}
              max={100}
              value={p?.opacity ?? 100}
              onChange={(e) => up({ opacity: Number(e.target.value) })}
            />
            <b className="vs-range-val">{p?.opacity ?? 100}%</b>
          </Field>
        </Section>
        <div className="vs-row2 vs-actions-row">
          <button className="vs-btn" onClick={() => store.getState().duplicateSelected()}>复制</button>
          <button className="vs-btn" onClick={() => store.getState().groupSelected()}>分组</button>
          <button className="vs-btn" onClick={() => store.getState().deleteSelected()}>删除</button>
        </div>
      </div>
    );
  }

  const o = p!;
  const up = (patch: Partial<VecObject>, msg?: string) => store.getState().updateSelection(patch, msg);
  const one = (patch: Partial<VecObject>, msg?: string) => store.getState().updateOne(o.id, patch, msg);
  const canGeometry = !o.locked;

  const deleteAnchor = () => {
    if (!activeAnchor || activeAnchor.id !== o.id) return;
    const anchors = [...(o.anchors || [])];
    if (!anchors.length || activeAnchor.index >= anchors.length) return;
    anchors.splice(activeAnchor.index, 1);
    const closedAfter = anchors.length >= 3;
    one({ anchors, closed: o.closed ? closedAfter : false }, '已删除锚点');
    store.getState().setActiveAnchor(null);
  };

  return (
    <div className="vs-props">
      <div className="vs-inspector-head">
        <span className={`vs-type-dot vs-dot-${o.type}`}>{SHAPE_GLYPHS[o.type]}</span>
        <b>{SHAPE_TITLES[o.type]}</b>
        {o.locked ? <span className="vs-lock-chip">锁</span> : null}
        <i>{o.id.slice(-5)}</i>
      </div>

      <Section title="变换">
        <div className="vs-row2">
          <NumField label="X" value={o.x} suffix="px" disabled={!canGeometry} onChange={(v) => up({ x: Math.round(v) })} />
          <NumField label="Y" value={o.y} suffix="px" disabled={!canGeometry} onChange={(v) => up({ y: Math.round(v) })} />
        </div>
        <div className="vs-row2">
          <NumField label="宽 W" value={o.width} suffix="px" min={MIN_SIZE_FIELD} disabled={!canGeometry} onChange={(v) => up({ width: Math.round(v) })} />
          <NumField label="高 H" value={o.height} suffix="px" min={MIN_SIZE_FIELD} disabled={!canGeometry} onChange={(v) => up({ height: Math.round(v) })} />
        </div>
        <div className="vs-row2">
          <NumField label="旋转" value={o.rotation} suffix="°" min={-720} max={720} disabled={!canGeometry} onChange={(v) => up({ rotation: v })} />
          <div className="vs-rotate-btns">
            <button className="vs-mini-btn" title="逆时针 15°" onClick={() => store.getState().rotateSelected(-15)}>↺15</button>
            <button className="vs-mini-btn" title="顺时针 15°" onClick={() => store.getState().rotateSelected(15)}>↻15</button>
          </div>
        </div>
      </Section>

      <Section title="外观">
        <div className="vs-row2">
          <ColorField
            label="填充"
            value={o.fill}
            onChange={(v) => one({ fill: v }, '已更新填充')}
            onNone={() => one({ fill: 'none' }, '填充已设为透明')}
          />
          <ColorField label="描边" value={o.stroke} onChange={(v) => one({ stroke: v })} onNone={() => one({ stroke: 'none' }, '描边已取消')} />
        </div>
        <div className="vs-row2">
          <NumField label="描边宽度" value={o.strokeWidth} suffix="px" min={0} onChange={(v) => one({ strokeWidth: v })} />
          <Field label="描边样式">
            <select className="vs-input" value={o.strokeStyle} onChange={(e) => one({ strokeStyle: e.target.value as VecStrokeStyle })}>
              <option value="solid">实线</option>
              <option value="dashed">虚线</option>
              <option value="dotted">点线</option>
            </select>
          </Field>
        </div>
        <Field label="不透明度">
          <div className="vs-slider-line">
            <input type="range" className="vs-range" min={0} max={100} value={o.opacity} onChange={(e) => one({ opacity: Number(e.target.value) })} />
            <b className="vs-range-val">{o.opacity}%</b>
          </div>
        </Field>
        <div className="vs-row2">
          {(o.type === 'rectangle' || o.type === 'rounded') ? (
            <>
              <NumField label="圆角半径" value={o.radius} suffix="px" min={0} max={Math.min(o.width, o.height) / 2} onChange={(v) => one({ radius: Math.round(v) })} />
              <div className="vs-mini-col">
                <button className="vs-mini-btn" onClick={() => {
                  if (o.type === 'rectangle') one({ type: 'rounded', radius: Math.min(24, o.height / 2) }, '已转为圆角矩形');
                  else one({ type: 'rectangle', radius: 0 }, '已转为直角矩形');
                }}>
                  {o.type === 'rectangle' ? '转圆角' : '转直角'}
                </button>
              </div>
            </>
          ) : null}
        </div>
        <label className="vs-check-row">
          <input type="checkbox" checked={o.shadow} onChange={(e) => one({ shadow: e.target.checked }, e.target.checked ? '已开启阴影' : '已关闭阴影')} />
          <span>投影阴影</span>
        </label>
      </Section>

      {o.type !== 'arrow' ? (
        <Section title="文本" right={<span className="vs-section-chip">{selectedIds.length > 1 ? '多选' : '直接输入'}</span>}>
          <Field label="内容" wide>
            <textarea
              className="vs-input vs-input-textarea"
              rows={2}
              value={o.text}
              placeholder={o.type === 'text' ? '输入文本…' : '在图形上显示的文字'}
              onChange={(e) => one({ text: e.target.value, ...(o.text === '' && e.target.value ? { name: e.target.value.slice(0, 12) } : {}) }, undefined)}
            />
          </Field>
          <div className="vs-row2">
            <Field label="字体">
              <select className="vs-input" value={o.fontFamily} onChange={(e) => one({ fontFamily: e.target.value })}>
                {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <NumField label="字号" value={o.fontSize} suffix="px" min={6} max={200} onChange={(v) => one({ fontSize: Math.round(v) })} />
          </div>
          <div className="vs-row2">
            <Field label="字重">
              <select className="vs-input" value={o.fontWeight} onChange={(e) => one({ fontWeight: Number(e.target.value) })}>
                <option value={400}>常规 400</option>
                <option value={500}>中等 500</option>
                <option value={600}>半粗 600</option>
                <option value={700}>粗体 700</option>
              </select>
            </Field>
            <ColorField label="颜色" value={o.textColor} onChange={(v) => one({ textColor: v })} />
          </div>
          <div className="vs-row2 vs-align-row">
            <Field label="对齐">
              <div className="vs-align-btns">
                {(['left', 'center', 'right'] as VecHAlign[]).map((al) => (
                  <button key={al} className={`vs-mini-btn ${o.textAlign === al ? 'on' : ''}`} onClick={() => one({ textAlign: al })}>
                    {al === 'left' ? '左' : al === 'center' ? '中' : '右'}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="行高">
              <input
                type="number"
                className="vs-input vs-input-num"
                step={0.1}
                min={0.8}
                max={3}
                value={o.lineHeight}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) one({ lineHeight: clamp(v, 0.8, 3) });
                }}
              />
            </Field>
          </div>
        </Section>
      ) : null}

      {o.type === 'bezier' ? (
        <Section title="路径">
          <div className="vs-path-state">
            <span className="vs-path-icon">⌁</span>
            <div>
              <b>{o.closed ? '闭合路径' : '开放路径'}</b>
              <small>
                {o.anchors?.length || 0} 个锚点
                {activeAnchor && activeAnchor.id === o.id ? ` · 锚点 ${activeAnchor.index + 1} 已选中` : ''}
              </small>
            </div>
            <button className="vs-mini-btn" disabled={!canGeometry} onClick={() => one({ closed: !o.closed }, o.closed ? '路径已重新打开' : '路径已闭合')}>
              {o.closed ? '打开' : '闭合'}
            </button>
          </div>
          <div className="vs-path-hint">双击路径段插入锚点 · 拖动锚点/控制柄编辑 · 双击锚点切换平滑</div>
          <div className="vs-path-actions">
            <button className="vs-btn" disabled={!canGeometry} onClick={() => {
              const anchors = [...(o.anchors || [])];
              if (!anchors.length) return;
              let bestI = -1;
              let bestD = -1;
              for (let i = 0; i < anchors.length; i += 1) {
                const a = anchors[i];
                const b = anchors[(i + 1) % anchors.length];
                const d = Math.hypot(b.x - a.x, b.y - a.y);
                if (d > bestD) {
                  bestD = d;
                  bestI = i;
                }
              }
              const mid = {
                x: (anchors[bestI].x + anchors[(bestI + 1) % anchors.length].x) / 2,
                y: (anchors[bestI].y + anchors[(bestI + 1) % anchors.length].y) / 2,
              };
              one({ anchors: insertAnchorAt(o, mid) }, '已插入锚点');
            }}>
              插入锚点
            </button>
            <button
              className="vs-btn"
              disabled={!canGeometry || !(activeAnchor && activeAnchor.id === o.id)}
              onClick={deleteAnchor}
            >
              删除锚点
            </button>
            <button
              className="vs-btn"
              disabled={!canGeometry}
              title={activeAnchor && activeAnchor.id === o.id && o.anchors ? (o.anchors[activeAnchor.index]?.smooth ? '转为独立角点' : '转为平滑曲线点') : '平滑化所有锚点'}
              onClick={() => {
                if (activeAnchor && activeAnchor.id === o.id && o.anchors && o.anchors[activeAnchor.index]) {
                  const idx = activeAnchor.index;
                  const smooth = !o.anchors[idx].smooth;
                  one({ anchors: setAnchorSmooth(o, idx, smooth) }, smooth ? '锚点已平滑化' : '锚点已转为角点');
                } else {
                  let anchors = [...(o.anchors || [])];
                  anchors = anchors.map((_, i) => setAnchorSmooth({ ...o, anchors }, i, true)[i]);
                  one({ anchors }, '全部锚点已平滑化');
                }
              }}
            >
              {activeAnchor && activeAnchor.id === o.id && o.anchors?.[activeAnchor.index]?.smooth ? '转角点' : '平滑'}
            </button>
          </div>
        </Section>
      ) : null}

      {o.type === 'arrow' ? (
        <Section title="箭头">
          <SelectField
            label="箭头样式"
            value={o.arrowStyle}
            onChange={(v) => one({ arrowStyle: v as VecArrowStyle })}
            options={[['filled', '实心箭头'], ['open', '开放箭头'], ['barbed', '双叉箭头']]}
          />
          <div className="vs-row2">
            <button className="vs-btn" onClick={() => one({ rotation: o.rotation - 90 }, '已旋转 -90°')}>⟲ 逆时针 90°</button>
            <button className="vs-btn" onClick={() => one({ rotation: o.rotation + 90 }, '已旋转 +90°')}>⟳ 顺时针 90°</button>
            <button className="vs-btn" title="水平翻转（旋转 180°）" onClick={() => one({ rotation: o.rotation + 180 })}>↔ 翻转</button>
          </div>
        </Section>
      ) : null}

      <Section title="层级">
        <div className="vs-layer-btns">
          <button className="vs-btn" onClick={() => layerMove(store, 'top')}>置顶</button>
          <button className="vs-btn" onClick={() => layerMove(store, 'up')}>上移一层</button>
          <button className="vs-btn" onClick={() => layerMove(store, 'down')}>下移一层</button>
          <button className="vs-btn" onClick={() => layerMove(store, 'bottom')}>置底</button>
        </div>
      </Section>

      <div className="vs-props-footer">
        <button className="vs-btn" onClick={() => store.getState().copySelection(false)}>复制</button>
        <button className="vs-btn" onClick={() => store.getState().duplicateSelected()}>快速复制</button>
        <button className="vs-btn vs-btn-danger" onClick={() => store.getState().deleteSelected()}>删除 ⌫</button>
      </div>
    </div>
  );
}

const MIN_SIZE_FIELD = 24;

/* ================= 图层面板 ================= */

type LayerRowItem = { key: string; kind: 'obj' | 'group'; id: string; groupId: string | null; depth: number };

function buildRows(objects: VecObject[], groups: VecGroup[]): LayerRowItem[] {
  const rows: LayerRowItem[] = [];
  const groupOf = (id: string) => objects.find((o) => o.id === id)?.groupId || null;
  const emitted = new Set<string>();
  const byId = new Map(groups.map((g) => [g.id, g]));
  // 顶 → 底遍历
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const o = objects[i];
    const gid = o.groupId;
    if (gid) {
      const g = byId.get(gid);
      if (!g || g.memberIds.length === 0) continue;
      if (!emitted.has(gid)) {
        emitted.add(gid);
        rows.push({ key: `g:${gid}`, kind: 'group', id: gid, groupId: null, depth: 0 });
        if (g.collapsed) {
          // 折叠：跳过该组剩余成员（成员连续）
          const memberSet = new Set(g.memberIds);
          while (i > 0 && memberSet.has(objects[i - 1].groupId as string)) i -= 1;
          continue;
        }
      }
      rows.push({ key: `o:${o.id}`, kind: 'obj', id: o.id, groupId: gid, depth: 1 });
    } else {
      rows.push({ key: `o:${o.id}`, kind: 'obj', id: o.id, groupId: null, depth: 0 });
    }
  }
  void groupOf;
  return rows;
}

export function LayersPanel() {
  const store = useVector();
  const objects = useVector((s) => s.objects);
  const groups = useVector((s) => s.groups);
  const selectedIds = useVector((s) => s.selectedIds);
  const [renaming, setRenaming] = useState<{ id: string; isGroup: boolean } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragRef = useRef<{ key: string; allowed: Set<string> } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const rows = useMemo(() => buildRows(objects, groups), [objects, groups]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const objById = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects]);

  const isGroupAllSelected = (gid: string) => {
    const g = groupById.get(gid);
    return g ? g.memberIds.every((m) => selectedIds.includes(m)) && g.memberIds.length > 0 : false;
  };

  const clickRow = (item: LayerRowItem, shift: boolean) => {
    const s = store.getState();
    if (item.kind === 'group') {
      const g = groupById.get(item.id);
      if (!g || !g.memberIds.length) return;
      const all = g.memberIds.every((m) => selectedIds.includes(m));
      if (shift) {
        if (all) s.selectIds(selectedIds.filter((x) => !g.memberIds.includes(x)));
        else s.selectIds([...new Set([...selectedIds, ...g.memberIds])]);
      } else if (all && selectedIds.length === g.memberIds.length) {
        s.selectIds(g.memberIds);
      } else {
        s.selectIds(g.memberIds);
      }
      return;
    }
    s.selectOne(item.id, { shift });
    if (!shift) s.setActiveAnchor(null);
  };

  /** 行拖拽排序（重排到新序后整体提交） */
  const commitReorder = (key: string, targetIndex: number) => {
    const st = store.getState();
    const dragIdx = rows.findIndex((r) => r.key === key);
    if (dragIdx < 0) return;
    const allow = dragRef.current?.allowed || new Set(rows.map((r) => r.key));
    const t = rows[targetIndex];
    if (!t || !allow.has(t.key)) return;

    // 计算拖拽单位包含的块（组=整块）
    const block: string[] = [];
    if (key.startsWith('g:')) {
      const g = groupById.get(key.slice(2));
      if (!g) return;
      block.push(key, ...g.memberIds.map((m) => `o:${m}`));
    } else {
      block.push(key);
    }
    const newRows = rows.filter((r) => r.key !== key || key.startsWith('g:') ? !block.includes(r.key) : true);
    void newRows;

    // 重新插入
    const head = key.startsWith('g:') ? rows.filter((r) => r.key === key) : rows.filter((r) => r.key === key);
    const others = rows.filter((r) => !block.includes(r.key));
    let insertAt = others.findIndex((r) => r.key === t.key);
    if (insertAt < 0) return;
    const before = dragIdx < targetIndex;
    if (!before) insertAt += 1;
    const final = [...others];
    final.splice(insertAt, 0, ...head);

    // 成员在组内重排：对 member 单位的拖拽，需要组内成员列表内调整
    if (!key.startsWith('g:')) {
      const item = rows[dragIdx];
      if (item.kind === 'obj' && item.groupId) {
        const g = groupById.get(item.groupId);
        if (!g) return;
        const members = g.memberIds.map((m) => `o:${m}`);
        const fromIdx = members.indexOf(key);
        const tIdx = members.indexOf(t.key);
        if (fromIdx < 0 || tIdx < 0 || t.key.startsWith('g:')) return;
        const nm = [...members];
        nm.splice(fromIdx, 1);
        nm.splice(tIdx + (fromIdx < tIdx ? 0 : 1), 0, key);
        // 顶层对象顺序中的组块需按新成员序重排
        const rootOrder = st.objects.map((o) => o.id);
        const blockIds = nm.map((m) => m.slice(2));
        const othersIds = rootOrder.filter((id) => !blockIds.includes(id));
        const minIdx = Math.min(...rootOrder.map((id, i) => (blockIds.includes(id) ? i : Infinity)));
        othersIds.splice(minIdx, 0, ...blockIds);
        st.reorderObjects(othersIds, '已调整图层顺序');
        return;
      }
    }

    const order = final.filter((r) => r.kind === 'obj').map((r) => r.id);
    // 组头块内的成员按现 objects 顺序整体搬运（final 已含头标记，丢弃）
    const finalIds: string[] = [];
    for (let i = final.length - 1; i >= 0; i -= 1) {
      const r = final[i];
      if (r.kind === 'obj') finalIds.push(r.id);
      else {
        const g = groupById.get(r.id);
        if (g) {
          const members = st.objects.filter((o) => g.memberIds.includes(o.id)).map((o) => o.id);
          finalIds.push(...members);
        }
      }
    }
    void order;
    st.reorderObjects(finalIds, '已调整图层顺序');
  };

  useEffect(() => {
    if (!dragKey) return;
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest?.('[data-row-key]') as HTMLElement | null;
      const list = el?.closest?.('.vs-layer-list') as HTMLElement | null;
      if (row && list && dragRef.current?.allowed.has(row.dataset.rowKey || '')) {
        const rect = row.getBoundingClientRect();
        const idx = [...list.querySelectorAll('[data-row-key]')].findIndex((r) => r === row);
        setHoverIndex(idx);
      } else {
        setHoverIndex(null);
      }
    };
    const up = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest?.('[data-row-key]') as HTMLElement | null;
      const list = el?.closest?.('.vs-layer-list') as HTMLElement | null;
      if (row && list) {
        const idx = [...list.querySelectorAll('[data-row-key]')].findIndex((r) => r === row);
        commitReorder(dragKey, idx);
      }
      dragRef.current = null;
      setDragKey(null);
      setHoverIndex(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKey, rows]);

  const rowDown = (item: LayerRowItem, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    clickRow(item, e.shiftKey);
    // 准备拖拽（允许目标集合）
    const allowed = new Set<string>();
    if (item.kind === 'group') {
      rows.forEach((r) => {
        if (r.kind === 'group' || r.groupId === null) allowed.add(r.key);
      });
    } else if (item.groupId) {
      rows.forEach((r) => {
        if (r.groupId === item.groupId) allowed.add(r.key);
      });
    } else {
      rows.forEach((r) => {
        if (r.groupId === null) allowed.add(r.key);
      });
    }
    dragRef.current = { key: item.key, allowed };
    setDragKey(item.key);
  };

  const visibleCount = objects.filter((o) => o.visible).length;

  return (
    <div className="vs-layers">
      <div className="vs-layers-toolbar">
        <span>图层 <i>{objects.length}</i></span>
        <div>
          <button
            className="vs-mini-btn"
            title="将选中图形编组 (≥2)"
            disabled={selectedIds.length < 2}
            onClick={() => store.getState().groupSelected()}
          >
            ⇥ 分组
          </button>
          <button
            className="vs-mini-btn"
            title="取消选中图形的分组"
            disabled={!groups.some((g) => g.memberIds.some((m) => selectedIds.includes(m)))}
            onClick={() => store.getState().ungroupSelected()}
          >
            解组
          </button>
        </div>
      </div>

      <div className="vs-layer-list">
        {rows.length === 0 ? (
          <div className="vs-layers-empty">画布还是空的<br />用左侧工具在画布上创建图形</div>
        ) : (
          rows.map((item, idx) => {
            const obj = item.kind === 'obj' ? objById.get(item.id) : null;
            const group = item.kind === 'group' ? groupById.get(item.id) : null;
            const selected = item.kind === 'obj'
              ? selectedIds.includes(item.id)
              : isGroupAllSelected(item.id);
            const visible = item.kind === 'obj' ? obj?.visible !== false : group?.visible !== false;
            const locked = item.kind === 'obj' ? obj?.locked : group?.locked;
            const name = item.kind === 'obj' ? obj?.name || '未命名' : group?.name || '图层组';
            const glyph = item.kind === 'obj' && obj ? SHAPE_GLYPHS[obj.type] : '◈';
            return (
              <div
                key={item.key}
                data-row-key={item.key}
                className={`vs-layer-row ${selected ? 'selected' : ''} ${dragKey === item.key ? 'dragging' : ''} ${hoverIndex === idx && dragKey ? 'drop-target' : ''}`}
                style={{ paddingLeft: 8 + item.depth * 16 }}
                onPointerDown={(e) => rowDown(item, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenaming({ id: item.id, isGroup: item.kind === 'group' });
                }}
              >
                {item.kind === 'group' ? (
                  <button
                    className="vs-layer-caret"
                    title={group?.collapsed ? '展开组' : '折叠组'}
                    onClick={(e) => {
                      e.stopPropagation();
                      store.getState().setGroupExpanded(item.id, !group?.collapsed);
                    }}
                  >
                    {group?.collapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <span className="vs-layer-caret vs-layer-caret-none" />
                )}
                <button
                  className="vs-layer-eye"
                  title={visible ? '隐藏图层' : '显示图层'}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.getState().toggleVisible([item.id]);
                  }}
                >
                  {visible ? '👁' : '—'}
                </button>
                <span className={`vs-layer-thumb ${item.kind === 'group' ? 'is-group' : ''}`}>{glyph}</span>
                {renaming && renaming.id === item.id ? (
                  <input
                    className="vs-layer-rename"
                    autoFocus
                    defaultValue={name}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v) store.getState().renameLayer(item.id, v);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <span className="vs-layer-name" title="双击重命名">
                    {item.kind === 'group' ? <b>{name}</b> : name}
                  </span>
                )}
                <button
                  className="vs-layer-lock"
                  title={locked ? '解锁' : '锁定'}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.getState().toggleLocked([item.id]);
                  }}
                >
                  {locked ? '🔒' : '○'}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="vs-layers-footer">
        <span>
          <i className="vs-footer-dot" /> {visibleCount} / {objects.length} 可见
        </span>
        <div>
          <button className="vs-mini-btn" title="选中图层置底" onClick={() => layerMove(store, 'bottom')}>⇊</button>
          <button className="vs-mini-btn" title="选中图层置顶" onClick={() => layerMove(store, 'top')}>⇈</button>
        </div>
      </div>
      <div className="vs-layers-hint">按住图层行拖动可排序 · 双击名称重命名</div>
    </div>
  );
}

/** 层级移动：支持多选块、组边界（组内移动 / 整组在根层移动） */
function layerMove(store: VectorStore, dir: 'top' | 'bottom' | 'up' | 'down') {
  const st = store.getState();
  const all = st.objects;
  const sel = st.selectedIds.filter((id) => {
    const o = all.find((x) => x.id === id);
    return o && !o.locked;
  });
  if (!sel.length) return;
  const gidOf = new Map(all.map((o) => [o.id, o.groupId]));
  const groupsOfSel = new Set(sel.map((id) => gidOf.get(id)).filter(Boolean) as string[]);
  let pool: string[] | null = null; // null = 根层全部对象
  if (groupsOfSel.size === 1) {
    const g = st.groups.find((x) => x.id === [...groupsOfSel][0]);
    if (g && g.memberIds.length > 0 && g.memberIds.every((m) => sel.includes(m))) {
      pool = null; // 选中=整组 → 根层移动
    } else {
      pool = g ? g.memberIds : null; // 组内移动
    }
  }
  const inPool = pool ?? all.map((o) => o.id);
  const block = sel.filter((id) => inPool.includes(id));
  if (!block.length) return;
  const rest = inPool.filter((id) => !block.includes(id));
  let resultPool: string[];
  if (dir === 'top') {
    resultPool = [...rest, ...block];
  } else if (dir === 'bottom') {
    resultPool = [...block, ...rest];
  } else {
    resultPool = [...inPool];
    const idxs = block.map((id) => inPool.indexOf(id)).sort((a, b) => a - b);
    const minI = idxs[0];
    const maxI = idxs[idxs.length - 1];
    const blockSet = new Set(block);
    if (dir === 'up') {
      // 上移一层：与块上方的元素（index 更大）交换
      const target = maxI + 1;
      if (target >= resultPool.length || blockSet.has(inPool[target])) return;
      const moving = resultPool.splice(target, 1)[0];
      resultPool.splice(minI, 0, moving);
    } else {
      // 下移一层：与块下方的元素（index 更小）交换
      const target = minI - 1;
      if (target < 0 || blockSet.has(inPool[target])) return;
      const moving = resultPool.splice(target, 1)[0];
      resultPool.splice(maxI, 0, moving);
    }
  }
  const msg = dir === 'top' ? '已置顶' : dir === 'bottom' ? '已置底' : dir === 'up' ? '已上移一层' : '已下移一层';
  if (pool === null) {
    st.reorderObjects(resultPool, msg);
    return;
  }
  // 组内移动：替换组所在连续区段
  const poolSet = new Set(inPool);
  const restAll = all.map((o) => o.id).filter((id) => !poolSet.has(id));
  const minIdx = Math.min(...all.map((o, i) => (poolSet.has(o.id) ? i : Infinity)));
  restAll.splice(minIdx, 0, ...resultPool);
  st.reorderObjects(restAll, msg);
}

/* ================= 逻辑分析面板 ================= */

export function LogicPanel(props: { analysis: LogicAnalysis }) {
  const store = useVector();
  const objects = useVector((s) => s.objects);
  const logicIds = useVector((s) => s.logicIds);
  const logicOp = useVector((s) => s.logicOp);
  const { analysis } = props;

  const candidates = useMemo(
    () => objects.filter((o) => o.visible && ['bezier', 'rectangle', 'rounded', 'ellipse'].includes(o.type)),
    [objects]
  );
  const setNames = useMemo(() => {
    const m = new Map<string, string>();
    candidates.forEach((o) => m.set(o.id, o.name.split(' / ')[0] || o.name));
    return m;
  }, [candidates]);

  const expr = useMemo(() => {
    if (!logicIds.length) return '—';
    if (logicOp === 'complement') return `${setNames.get(logicIds[0]) || 'A'}ᶜ`;
    const sym = OP_SYMBOL[logicOp];
    return logicIds
      .slice(0, logicOp === 'xor' ? 2 : 4)
      .map((id) => setNames.get(id) || '集合')
      .join(` ${sym} `);
  }, [logicIds, logicOp, setNames]);

  const totalArea = analysis.stats.reduce((sum, s) => sum + s.area, 0);

  return (
    <div className="vs-logic">
      <div className="vs-logic-head">
        <div>
          <span className="vs-eyebrow">LOGIC ENGINE</span>
          <h3>集合逻辑分析</h3>
        </div>
        <span className="vs-live-badge"><i /> 实时</span>
      </div>
      <p className="vs-logic-intro">
        闭合贝塞尔与图形视为集合，移动 / 编辑时自动重算关系与结果区域。
      </p>

      <section className="vs-logic-section">
        <div className="vs-logic-section-title">
          <span>参与集合</span>
          <i>{logicIds.length} / {candidates.length}</i>
        </div>
        {candidates.length === 0 ? (
          <div className="vs-logic-note">画布上还没有闭合图形（矩形 / 圆角 / 椭圆 / 贝塞尔）。</div>
        ) : (
          <div className="vs-set-list">
            {candidates.map((o, index) => {
              const on = logicIds.includes(o.id);
              const order = logicIds.indexOf(o.id);
              const color = analysis.sets.find((s) => s.id === o.id)?.color || '#888';
              return (
                <button key={o.id} className={`vs-set-row ${on ? 'on' : ''}`} onClick={() => store.getState().toggleLogicId(o.id)}>
                  <span className={`vs-set-check ${on ? 'checked' : ''}`}>{on ? '✓' : ''}</span>
                  {on ? <span className="vs-set-order" style={{ background: color }}>{String.fromCharCode(65 + (order % 26))}</span> : null}
                  <span className="vs-set-name">{o.name.split(' / ')[0] || o.name}</span>
                  <span className="vs-set-type">{SHAPE_GLYPHS[o.type as keyof typeof SHAPE_GLYPHS] || '⌁'}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="vs-logic-section">
        <div className="vs-logic-section-title"><span>运算类型</span></div>
        <div className="vs-op-grid">
          {LOGIC_OP_META.map((m) => (
            <button
              key={m.op}
              className={`vs-op ${logicOp === m.op ? 'active' : ''}`}
              title={m.desc}
              onClick={() => store.getState().setLogicOp(m.op)}
            >
              <b>{m.symbol}</b>
              <small>{m.label}</small>
            </button>
          ))}
        </div>
        <div className="vs-op-desc">{LOGIC_OP_META.find((m) => m.op === logicOp)?.desc}</div>
      </section>

      <section className="vs-expr-card">
        <div className="vs-expr-label">
          <span>当前表达式</span>
          <i>自动更新</i>
        </div>
        <div className="vs-expr-value">{expr}</div>
        {analysis.ready ? (
          <div className="vs-expr-result">
            <span className="vs-result-swatch" />
            <div>
              <small>结果区域（画布高亮）</small>
              <b>{analysis.resultArea > 0 ? `${analysis.resultArea.toLocaleString()} px²` : '空集 ∅'}</b>
            </div>
          </div>
        ) : (
          <div className="vs-expr-result muted">
            <div>
              <small>结果区域</small>
              <b>等待集合参与运算</b>
            </div>
          </div>
        )}
      </section>

      {analysis.ready && analysis.stats.length > 0 ? (
        <section className="vs-logic-section">
          <div className="vs-logic-section-title"><span>区域统计</span><i>{analysis.sets.length} 个集合</i></div>
          <div className="vs-region-table">
            {analysis.stats.map((r) => (
              <div className="vs-region-row" key={r.mask}>
                <span className="vs-region-label">{r.label}</span>
                <span className="vs-region-area">{r.area.toLocaleString()}</span>
                <span className="vs-region-pct">{totalArea ? `${Math.round((r.area / totalArea) * 100)}%` : ''}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {analysis.relations.length > 0 ? (
        <section className="vs-logic-section">
          <div className="vs-logic-section-title"><span>两两关系</span></div>
          {analysis.relations.map((rel) => (
            <div className="vs-relation-row" key={`${rel.a}-${rel.b}`}>
              <span className="vs-rel-name">{(setNames.get(rel.a) || 'A')} × {(setNames.get(rel.b) || 'B')}</span>
              <span className={`vs-rel-chip vs-rel-${rel.kind}`}>{rel.kind}</span>
            </div>
          ))}
        </section>
      ) : null}

      <VennPreview analysis={analysis} names={setNames} />

      <div className="vs-logic-foot">
        <span>i</span> 画布上的黄色区域 = 运算结果，随图形编辑实时更新。
      </div>
    </div>
  );
}

/** 韦恩图预览：用集合真实面积比绘制圆，重叠示意 */
function VennPreview(props: { analysis: LogicAnalysis; names: Map<string, string> }) {
  const { analysis } = props;
  const logicOp = useVector((s) => s.logicOp);
  const sets = analysis.sets;
  const W = 300;
  const H = 170;
  if (!analysis.ready || sets.length === 0) {
    return <div className="vs-venn-empty">选择集合后生成韦恩图</div>;
  }
  const totalArea = Math.max(1, analysis.stats.reduce((sum, s) => sum + s.area, 0));
  const maxR = 58;
  const areas = new Map(sets.map((s) => [s.id, s.area]));
  const rOf = (id: string) => Math.max(14, Math.sqrt(Math.max(100, areas.get(id) || 0)) * (maxR / Math.sqrt(Math.max(100, Math.max(...[...areas.values()])))));
  const centers: Record<number, { x: number; y: number }> = {
    1: { x: W / 2, y: H / 2 + 16 },
    2: { x: W / 2 - 58, y: H / 2 + 10 }, 
  };
  void centers;
  // 两集合经典布局
  const layout: { x: number; y: number }[] = sets.length === 1
    ? [{ x: W / 2 - 30, y: H / 2 + 6 }]
    : sets.length === 2
      ? [{ x: W / 2 - 62, y: H / 2 + 8 }, { x: W / 2 + 62, y: H / 2 + 8 }]
      : [{ x: W / 2 - 64, y: H / 2 - 6 }, { x: W / 2 + 64, y: H / 2 - 6 }, { x: W / 2, y: H / 2 + 44 }];
  const opLabel = LOGIC_OP_META.find((m) => m.op === logicOp);
  return (
    <section className="vs-logic-section vs-venn-sec">
      <div className="vs-logic-section-title"><span>韦恩图预览</span><i>{sets.length} 集</i></div>
      <svg className="vs-venn" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="韦恩图预览">
        {sets.map((s, i) => {
          const r = rOf(s.id);
          const c = layout[i];
          return (
            <g key={s.id} opacity={i === 0 && sets.length > 1 ? 0.72 : 0.8}>
              <circle cx={c.x} cy={c.y} r={r} fill={s.color} fillOpacity="0.32" stroke={s.color} strokeWidth="1.6" />
              <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="middle" className="vs-venn-letter">
                {String.fromCharCode(65 + i)}
              </text>
            </g>
          );
        })}
        {sets.length > 1 ? (
          <text x={W / 2} y={H / 2 + 34} textAnchor="middle" className="vs-venn-op">
            {opLabel ? `${String.fromCharCode(65)}${opLabel.symbol}${String.fromCharCode(65 + 1)}` : ''}
          </text>
        ) : null}
      </svg>
      <div className="vs-venn-legend">
        {sets.map((s, i) => (
          <span key={s.id}><i style={{ background: s.color }} />{String.fromCharCode(65 + i)} = {props.names.get(s.id) || s.name}</span>
        ))}
      </div>
    </section>
  );
}

export { SCALE };
export type { VecObject };
