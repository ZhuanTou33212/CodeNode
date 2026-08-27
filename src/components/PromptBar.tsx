import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { useUsageStore, type ReasoningEffort } from '../store/usageStore';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtMoney(n: number): string {
  return n >= 0.01 ? '$' + n.toFixed(3) : '$' + n.toFixed(4);
}

/** 单个小饼图：上下文已使用比例 */
function ContextDonut({ ratio, size = 24 }: { ratio: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, ratio));
  const color = pct > 0.85 ? '#ef4444' : pct > 0.65 ? '#f59e0b' : '#22c55e';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pb-donut">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${pct * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export default function PromptBar() {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const sending = useChatStore((s) => s.sending);
  const streaming = useSessionStore((s) => s.streaming);
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const models = useUsageStore((s) => s.models);
  const modelId = useUsageStore((s) => s.modelId);
  const effort = useUsageStore((s) => s.effort);
  const budget = useUsageStore((s) => s.budget);
  const summary = useUsageStore((s) => s.summary);
  const lastUsage = useUsageStore((s) => s.lastUsage);
  const setModel = useUsageStore((s) => s.setModel);
  const setEffort = useUsageStore((s) => s.setEffort);
  const setBudget = useUsageStore((s) => s.setBudget);
  const loadModels = useUsageStore((s) => s.loadModels);
  const busy = sending || streaming;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const model = models.find((m) => m.id === modelId) || models[0] || null;
  const ctxUsed = lastUsage ? lastUsage.promptTokens : 0;
  const contextRatio = model ? ctxUsed / model.contextWindow : 0;
  const budgetRatio = budget > 0 ? summary.cost / budget : 0;

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    const res = await useChatStore.getState().send(prompt);
    const msgs = useSessionStore.getState().messages;
    const last = msgs[msgs.length - 1];
    const aborted = last && last.role === 'assistant' && last.status === 'stopped';
    if (!res.reply && !res.tools.length && !aborted) {
      useUiStore.getState().setToast('Agent 未返回内容，请重试');
    }
  };

  const stop = () => {
    useChatStore.getState().stop();
  };

  const pickModel = (id: string) => {
    setModel(id);
    setMenuOpen(false);
  };

  return (
    <div className="prompt-bar">
      <div className="prompt-bar-inner">
        <div className="prompt-bar-controls">
          <span className="prompt-bar-tag">{active ? active.label : '画布'}</span>

          <div className="pb-model" ref={menuRef}>
            <button className="pb-model-btn" onClick={() => setMenuOpen((v) => !v)} title="选择模型">
              <span className="pb-model-label">{model ? model.label : '未配置模型'}</span>
              <span className="pb-model-caret">▲</span>
            </button>
            {menuOpen && (
              <div className="pb-model-menu">
                <div className="pb-model-menu-title">选择模型</div>
                {models.map((m) => (
                  <div
                    key={m.id}
                    className={'pb-model-item' + (m.id === modelId ? ' active' : '')}
                    onClick={() => pickModel(m.id)}
                  >
                    <span className="pb-model-item-label">{m.label}</span>
                    <span className="pb-model-item-sub">{m.model}</span>
                  </div>
                ))}
                <div className="pb-model-sep" />
                <div
                  className="pb-model-item manage"
                  onClick={() => {
                    setMenuOpen(false);
                    useUiStore.getState().openModelManager();
                  }}
                >
                  <span className="pb-model-item-label">管理模型</span>
                  <span className="pb-model-item-sub">接入 / API Key / URL</span>
                </div>
              </div>
            )}
          </div>

          {model && model.supportsEffort && (
            <select
              className="pb-select"
              value={effort}
              title="推理强度"
              onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
            >
              <option value="low">推理 · 低</option>
              <option value="medium">推理 · 中</option>
              <option value="high">推理 · 高</option>
            </select>
          )}

          <div className="pb-spacer" />

          <div className="pb-usage" title="悬停查看用量 / 成本 / 预算">
            <ContextDonut ratio={contextRatio} />
            <div className="pb-usage-pop">
              <div className="pb-usage-pop-title">
                {model ? model.label : '未配置模型'}
                <span className="pb-usage-pop-sub">
                  {model ? '上下文 ' + fmtTokens(model.contextWindow) : ''}
                </span>
              </div>

              <div className="pb-metric-row">
                <span>上下文</span>
                <span>
                  {fmtTokens(ctxUsed)} / {model ? fmtTokens(model.contextWindow) : '-'} ·{' '}
                  {Math.round(contextRatio * 100)}%
                </span>
              </div>
              <div className="pb-metric-row">
                <span>Token</span>
                <span>
                  入 {fmtTokens(summary.promptTokens)} · 出 {fmtTokens(summary.completionTokens)}
                </span>
              </div>

              <div className="pb-usage-pop-sep" />

              <div className="pb-metric-row">
                <span>成本</span>
                <span>{fmtMoney(summary.cost)}</span>
              </div>
              <div className="pb-metric-row">
                <span>预算</span>
                <input
                  className="pb-budget-input"
                  type="number"
                  min="0.01"
                  step="0.5"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </div>
              <div className="pb-budget-bar">
                <div className="pb-budget-fill" style={{ width: Math.min(100, budgetRatio * 100) + '%' }} />
              </div>

              {model && (
                <>
                  <div className="pb-usage-pop-sep" />
                  <div className="pb-metric-row">
                    <span>输入价</span>
                    <span>${model.priceInput}/M</span>
                  </div>
                  <div className="pb-metric-row">
                    <span>缓存价</span>
                    <span>${model.priceInputHit}/M</span>
                  </div>
                  <div className="pb-metric-row">
                    <span>输出价</span>
                    <span>${model.priceOutput}/M</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {busy && (
            <button className="pb-stop" onClick={stop} title="停止思考">
              停止
            </button>
          )}
        </div>

        <div className="prompt-bar-row">
          <textarea
            ref={taRef}
            className="prompt-bar-input"
            value={text}
            rows={1}
            placeholder="输入 prompt…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => {
              setText(e.target.value);
              const el = taRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = Math.min(120, el.scrollHeight) + 'px';
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="prompt-bar-btn" onClick={() => void send()} disabled={busy || !text.trim()}>
            {busy ? '思考中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
