import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useUsageStore, type ReasoningEffort } from '../../store/usageStore';
import { useSending } from '../../lib/useSending';
import { formatResumePlanNotice, summarizeResumePlan } from '../../lib/resumePlan';
import { reportError } from '../../lib/reportError';
import type { AgentAttachment } from '../../types';
import { ALLOWED_IMAGE_MIME, MAX_IMAGES_PER_MESSAGE, fileToAttachment, fmtBytes, imagesFromDataTransfer } from '../../lib/imageAttach';
import { MessageViewMemo } from './MessageList';
import { PlanCard } from '../PlanCard';
import ResumePlanNotice from './ResumePlanNotice';
import HoverPopover from './HoverPopover';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtMoney(n: number): string {
  return n >= 0.01 ? '$' + n.toFixed(3) : '$' + n.toFixed(4);
}

/** 单个小饼图：上下文已使用比例 */
function ContextDonut({ ratio, size = 20 }: { ratio: number; size?: number }) {
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

/**
 * 用量仪表（饼图 + 成本/预算弹层）：挂在 Agent 面板头部的状态行里。
 * 不放输入区——侧栏窄，弹层会盖住输入框（这是之前「对话区像消失」的元凶）。
 */
function UsageMeter() {
  const models = useUsageStore((s) => s.models);
  const modelId = useUsageStore((s) => s.modelId);
  const budget = useUsageStore((s) => s.budget);
  const summary = useUsageStore((s) => s.summary);
  const lastUsage = useUsageStore((s) => s.lastUsage);
  const setBudget = useUsageStore((s) => s.setBudget);

  const model = models.find((m) => m.id === modelId) || models[0] || null;
  const ctxUsed = lastUsage ? lastUsage.promptTokens : 0;
  const contextRatio = model ? ctxUsed / model.contextWindow : 0;
  const budgetRatio = budget > 0 ? summary.cost / budget : 0;
  const ctxPct = Math.round(Math.min(1, contextRatio) * 100);

  return (
    <HoverPopover
      className="ap-usage-pop"
      anchorClassName="ap-usage-anchor"
      width={236}
      height={172}
      content={
        <>
          <div className="pb-usage-pop-title">
            {model ? model.label : '未配置模型'}
            <span className="pb-usage-pop-sub">{model ? '上下文 ' + fmtTokens(model.contextWindow) : ''}</span>
          </div>
          <div className="pb-metric-row">
            <span>上下文</span>
            <span>
              {fmtTokens(ctxUsed)} / {model ? fmtTokens(model.contextWindow) : '-'} · {ctxPct}%
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
        </>
      }
    >
      <span className="pb-usage ap-usage" title="悬停查看上下文 / Token / 成本 / 预算">
        <ContextDonut ratio={contextRatio} />
      </span>
    </HoverPopover>
  );
}

/**
 * 侧栏「Agent」标签常驻底部的输入区（原画布底部悬浮 PromptBar 的窄栏版本）。
 * 控件收成一行：模型 / 推理强度 / 发送（停止）；上下文与成本移到面板头部。
 */
function PromptComposer() {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // #7：`sending` 是派生值（inflight.size() > 0），不再是可被并发覆盖的单值全局标志
  const sending = useSending();
  const streaming = useSessionStore((s) => s.streaming);
  const models = useUsageStore((s) => s.models);
  const modelId = useUsageStore((s) => s.modelId);
  const effort = useUsageStore((s) => s.effort);
  const setModel = useUsageStore((s) => s.setModel);
  const setEffort = useUsageStore((s) => s.setEffort);
  const loadModels = useUsageStore((s) => s.loadModels);
  const busy = sending || streaming;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // §4.2：运行中插话（steering）—— 长任务跑偏时不用整停，这句话会在下一轮进请求体
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const steer = async () => {
    const value = steerText.trim();
    if (!value) return;
    setSteering(true);
    try {
      const result = await useChatStore.getState().steer(value);
      if (result?.accepted) {
        setSteerText('');
        useUiStore.getState().setToast('已插话：下一轮生效');
      } else {
        // 没插上就直说（不静默）——运行可能刚好结束
        useUiStore.getState().setToast(String(result?.error || '插话未生效'));
      }
    } catch (error) {
      reportError('插话失败', error, (message) => useUiStore.getState().setToast(message));
    } finally {
      setSteering(false);
    }
  };

  const model = models.find((m) => m.id === modelId) || models[0] || null;
  const canVision = model?.vision === true;

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!canVision) {
      useUiStore.getState().setToast(`当前模型「${model?.label || '未配置'}」未开启视觉能力，无法接收图片`);
      return;
    }
    const room = MAX_IMAGES_PER_MESSAGE - attachments.length;
    if (room <= 0) {
      useUiStore.getState().setToast(`一次最多发送 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
      return;
    }
    const picked = files.slice(0, room);
    const next: AgentAttachment[] = [];
    for (const f of picked) {
      const r = await fileToAttachment(f);
      if (!r.ok) {
        useUiStore.getState().setToast(r.error);
        continue;
      }
      next.push(r.attachment);
    }
    if (next.length) {
      setAttachments((cur) => [...cur, ...next].slice(0, MAX_IMAGES_PER_MESSAGE));
      const total = next.reduce((n, a) => n + (a.bytes || 0), 0);
      useUiStore.getState().setToast(`已附加 ${next.length} 张图片（${fmtBytes(total)}）`);
    }
  };

  const send = async () => {
    const prompt = text.trim();
    if ((!prompt && !attachments.length) || busy) return;
    const toSend = attachments;
    setText('');
    setAttachments([]);
    if (taRef.current) taRef.current.style.height = 'auto';
    const res = await useChatStore.getState().send(prompt, { attachments: toSend });
    const msgs = useSessionStore.getState().messages;
    const last = msgs[msgs.length - 1];
    const aborted = last && last.role === 'assistant' && last.status === 'stopped';
    if (!res.reply && !res.tools.length && !aborted) {
      useUiStore.getState().setToast('Agent 未返回内容，请重试');
    }
  };

  return (
    <div
      className={`pp-composer${dragOver ? ' is-dragover' : ''}`}
      onDragOver={(e) => {
        if (!canVision) return;
        const hasImage = Array.from(e.dataTransfer?.items || []).some((it) => it.kind === 'file' && String(it.type).startsWith('image/'));
        if (!hasImage) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!canVision) return;
        const files = imagesFromDataTransfer(e.dataTransfer);
        if (!files.length) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles(files);
      }}
    >
      {attachments.length > 0 && (
        <div className="pp-attach-list">
          {attachments.map((a, i) => (
            <div className="pp-attach" key={i} title={`${a.name || '图片'}（${fmtBytes(a.bytes || 0)}）`}>
              <img src={a.dataUrl} alt={a.name || '附件'} />
              <button
                className="pp-attach-del"
                title="移除这张图片"
                onClick={() => setAttachments((cur) => cur.filter((_, idx) => idx !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        className="pp-input"
        value={text}
        rows={1}
        placeholder={
          canVision
            ? '输入 prompt…（Enter 发送，Shift+Enter 换行；可粘贴 / 拖入图片）'
            : '输入 prompt…（Enter 发送，Shift+Enter 换行）'
        }
        onChange={(e) => {
          setText(e.target.value);
          const el = taRef.current;
          if (el) {
            el.style.height = 'auto';
            el.style.height = Math.min(110, el.scrollHeight) + 'px';
          }
        }}
        onPaste={(e) => {
          const files = imagesFromDataTransfer(e.clipboardData);
          if (!files.length) return;
          e.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />

      {/* 控件行：模型 / 推理强度 / 发送（紧凑一行，保证输入框常驻面板底部） */}
      <div className="pp-controls">
        <select
          className="pb-select pp-model"
          value={model ? model.id : ''}
          title={model ? `当前模型：${model.label}` : '选择模型'}
          onChange={(e) => {
            if (e.target.value === '__manage') {
              useUiStore.getState().openModelManager();
              return;
            }
            if (e.target.value) setModel(e.target.value);
          }}
        >
          {models.length === 0 && <option value="">未配置模型</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__manage">管理模型…</option>
        </select>

        {model && model.supportsEffort && (
          <select
            className="pb-select pp-effort"
            value={effort}
            title="推理强度"
            onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
          >
            <option value="low">推理低</option>
            <option value="medium">推理中</option>
            <option value="high">推理高</option>
          </select>
        )}

        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_IMAGE_MIME.join(',')}
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            void addFiles(files);
          }}
        />
        <button
          className={`pp-attach-btn${canVision ? '' : ' is-off'}`}
          title={
            canVision
              ? '添加图片（也可直接粘贴 / 拖入）'
              : `当前模型「${model?.label || '未配置'}」未开启视觉能力；请在模型管理中勾选「视觉（图片输入）」`
          }
          onClick={() => {
            if (!canVision) {
              useUiStore.getState().setToast('当前模型未开启视觉能力，无法添加图片');
              return;
            }
            fileRef.current?.click();
          }}
        >
          🖼
        </button>

        {busy ? (
          <div className="pp-steer" title="运行中插话：这句话会在下一轮送进模型，不中断当前运行">
            <input
              className="pp-steer-input"
              value={steerText}
              placeholder="插话纠偏…（如：别改 utils，只改 api 层）"
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void steer();
                }
              }}
              disabled={steering}
              data-testid="pp-steer-input"
            />
            <button className="pp-steer-send" onClick={() => void steer()} disabled={steering || !steerText.trim()} data-testid="pp-steer-send">
              插话
            </button>
            <button className="pp-send pp-stop" onClick={() => useChatStore.getState().stop()} title="停止思考">
              停止
            </button>
          </div>
        ) : (
          <button
            className="pp-send"
            onClick={() => void send()}
            disabled={(!text.trim() && !attachments.length) || busy}
            title="发送 (Enter)"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/** 标签页 0：Agent 对话（原画布左上角悬浮会话面板，现并入侧栏标签） */
export default function AgentPanel() {
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const sessionCount = useSessionStore((s) => s.order.length);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 新消息 / 流式增量时保持贴底
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  return (
    <div className="sp-pane sp-pane-agent">
      <div className="ap-head">
        <div className="ap-head-top">
          <span className="ap-session" title={active ? active.id : ''}>
            <span className={`cs-dot ${streaming ? 'cs-dot-running' : ''}`} />
            {active ? active.label : '未选择会话'}
          </span>
          <span className={`chat-win-status ${streaming ? 'st-running' : 'st-done'}`}>
            {streaming ? '思考中…' : active && active.status === 'active' ? '进行中' : '就绪'}
          </span>
          <button
            className="ap-new"
            title={`新建空白会话画布（当前 ${sessionCount} 个）`}
            onClick={() => useSessionStore.getState().newCanvas()}
          >
            ＋ 新会话
          </button>
        </div>
        <div className="ap-head-meta">
          <span className="ap-hint">对话常驻此面板；输入框固定在底部</span>
          <UsageMeter />
        </div>
      </div>

      {/* 计划卡：任务清单来自主进程的 kind:'plan' 增量（update_plan 工具）。
          没有计划时它自己返回 null —— 不占位、不留空壳。 */}
      <PlanCard />

      {/* #25(b)：流式正文 / 「思考中」 / 已停止 / 失败原因都发生在这里，必须是 live region，
          否则键盘/读屏用户完全得不到「正在生成 / 已中断」的播报。 */}
      <div
        className="ap-body"
        ref={bodyRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Agent 对话记录"
      >
        {messages.length === 0 && (
          <div className="cs-chat-empty">
            （暂无对话）
            <div className="sp-empty-hint">在下方输入 prompt 开始；Agent 的工作流步骤会出现在画布上。</div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageViewMemo key={i} msg={m} />
        ))}
      </div>

      <ResumePlanNotice />
      <PromptComposer />
    </div>
  );
}
