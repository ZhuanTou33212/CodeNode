import { useEffect, useRef, useState } from 'react';
import TrellisTaskPanel from '../TrellisTaskPanel';
import { useProjectStore } from '../../store/projectStore';
import { projectNameOf } from '../../lib/recentProjects';
import { useGraphStore } from '../../store/graphStore';
import { saveProject } from '../../lib/projectActions';
import { useChatStore } from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import { useUsageStore, type ReasoningEffort } from '../../store/usageStore';
import { useSending } from '../../lib/useSending';
import { formatResumePlanNotice, summarizeResumePlan } from '../../lib/resumePlan';
import { reportError } from '../../lib/reportError';
import type { AgentAttachment } from '../../types';
import backendConfig from '../../../config/agent.backends.json';
import {useBackendSwitchStore} from '../../store/backendSwitchStore';
import { ALLOWED_IMAGE_MIME, MAX_IMAGES_PER_MESSAGE, fileToAttachment, fmtBytes, imagesFromDataTransfer } from '../../lib/imageAttach';
import { MessageViewMemo } from './MessageList';
import { PlanCard } from '../PlanCard';
import ResumePlanNotice from './ResumePlanNotice';
import HoverPopover from './HoverPopover';
import ModelPicker from './ModelPicker';

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
            <span>{fmtMoney(summary.cost)}{summary.costUnknown ? ' + 未知外部费用' : ''}</span>
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
  const selectedNode = useGraphStore(s => s.nodes.find(n => n.id === s.selectedId && ['task','stage','tool'].includes(n.type || '')));
  const inputText = selectedNode ? String(selectedNode.data.prompt || '') : text;
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const pendingDraft = useSessionStore(s => s.newConversationPending);
  const projectRoot = useProjectStore(s => s.root);
  const activeSessionId = useSessionStore(s=>s.activeId);
  const conversationId=useSessionStore(s=>s.memoryConversationId);
  const [externalBackend, setExternalBackend] = useState('builtin');
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.codenode?.agentConfig(projectRoot,activeSessionId,conversationId).then(config => {
        if (alive) { const settings = config.backend?.sessionSettings || config.backend?.settings; setExternalBackend(settings?.backend || 'builtin'); }
      }).catch(() => { if (alive) setExternalBackend('builtin'); });
    };
    refresh(); window.addEventListener('codenode-backend-settings', refresh);
    return () => { alive = false; window.removeEventListener('codenode-backend-settings', refresh); };
  }, [projectRoot,activeSessionId,conversationId]);
  const draftRevision = useSessionStore(s => s.draftRevision);
  useEffect(() => { setText(''); setAttachments([]); if (draftRevision) window.setTimeout(() => taRef.current?.focus(), 0); }, [draftRevision]);
  const [modelSearch, setModelSearch] = useState('');
  useEffect(() => {
    const closePicker = (event: Event) => {
      document.querySelectorAll<HTMLDetailsElement>('.pp-model-picker[open]').forEach(picker => {
        if (event instanceof KeyboardEvent ? event.key === 'Escape' : !picker.contains(event.target as Node)) picker.open = false;
      });
    };
    document.addEventListener('pointerdown', closePicker); document.addEventListener('keydown', closePicker);
    return () => { document.removeEventListener('pointerdown', closePicker); document.removeEventListener('keydown', closePicker); };
  }, []);
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
  const backendSwitching=useBackendSwitchStore(s=>s.switching);
  const busy = sending || streaming || backendSwitching;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
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
  const isAcp = backendConfig.acpBackends.includes(externalBackend);
  const canVision = !selectedNode && (isAcp || externalBackend === 'builtin' && model?.vision === true);

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
      if (isAcp && !f.type.startsWith('image/')) {
        if (f.size > backendConfig.acpLimits.contentBytes / 2) { useUiStore.getState().setToast('附件超过 ACP 内容上限'); continue; }
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(f); });
        next.push({ name: f.name, mime: f.type || 'application/octet-stream', bytes: f.size, dataUrl }); continue;
      }
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
    if (composing.current) return;
    if (selectedNode && !busy) { await saveProject(); return; }
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
    <>
      {!selectedNode && <TrellisTaskPanel />}
      {pendingDraft && !selectedNode && <div className="composer-project-context">新对话 · {projectNameOf(projectRoot || '当前项目')}</div>}
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
      {selectedNode && <div className="node-prompt-context"><span>阶段 · {String(selectedNode.data.label || selectedNode.id)}</span><button aria-label="返回对话" onClick={() => useGraphStore.getState().setSelectedIds([])}>×</button></div>}
      {!selectedNode && attachments.length > 0 && (
        <div className="pp-attach-list">
          {attachments.map((a, i) => (
            <div className="pp-attach" key={i} title={`${a.name || '图片'}（${fmtBytes(a.bytes || 0)}）`}>
              {a.mime.startsWith('image/') ? <img src={a.dataUrl} alt={a.name || '附件'} /> : <span>{a.name || '附件'}</span>}
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
        value={inputText}
        rows={1}
        disabled={busy}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onFocus={() => { if (selectedNode) useGraphStore.getState().commit(); }}
        placeholder={
          selectedNode ? '输入此阶段的任务…' : canVision
            ? '描述任务，或粘贴图片…'
            : '描述你想完成的任务…'
        }
        onChange={(e) => {
          if (selectedNode) useGraphStore.getState().updateNodeData(selectedNode.id, { prompt: e.target.value }); else setText(e.target.value);
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
          if (e.nativeEvent.isComposing || composing.current || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />

      {/* 控件行：模型 / 推理强度 / 发送（紧凑一行，保证输入框常驻面板底部） */}
      <div className="pp-controls">
        {externalBackend === 'builtin' && <ModelPicker busy={busy} />}

        <input
          ref={fileRef}
          type="file"
          accept={isAcp ? [...ALLOWED_IMAGE_MIME, 'audio/*', 'text/*', 'application/pdf'].join(',') : ALLOWED_IMAGE_MIME.join(',')}
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
          disabled={!!selectedNode}
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
          ＋
        </button>

        {busy ? (
          <>
          <button className="pp-send pp-stop" onClick={() => useChatStore.getState().stop()} aria-label="停止生成" title="停止生成">■</button>
          <div className="pp-steer" title="运行中插话：这句话会在下一轮送进模型，不中断当前运行">
            <input
              className="pp-steer-input"
              value={steerText}
              placeholder="插话纠偏…（如：别改 utils，只改 api 层）"
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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

          </div>
          </>
        ) : (
          <button
            className="pp-send"
            onClick={() => void send()}
            disabled={(!selectedNode && !text.trim() && !attachments.length) || busy}
            title={selectedNode ? '保存阶段 Prompt (Enter)' : '发送 (Enter)'}
          >
            {selectedNode ? '保存' : '↑'}
          </button>
        )}
      </div>
    </div>
    </>
  );
}

/** 主工作区对话：记录滚动，输入框固定在底部。 */
export default function AgentPanel() {
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const active = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null));

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const countRef = useRef(messages.length);
  const automaticTop = useRef<number | null>(null);
  const scrollBottom = () => { const element = bodyRef.current; if (element) { element.scrollTop = element.scrollHeight; automaticTop.current = element.scrollTop; } };
  // 新消息 / 流式增量时保持贴底
  useEffect(() => {
    const el = bodyRef.current;
    if (messages.length > countRef.current && messages.some((message, index) => index >= countRef.current && message.role === 'user')) followRef.current = true;
    countRef.current = messages.length;
    if (el && followRef.current) scrollBottom();
  }, [messages, streaming]);
  useEffect(() => {
    const element = bodyRef.current;
    const latest = element?.lastElementChild;
    if (!element || !latest || typeof ResizeObserver === 'undefined') return;
    const scroll = () => {
      if (automaticTop.current !== null && Math.abs(element.scrollTop - automaticTop.current) < 1) return;
      automaticTop.current = null;
      followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    const observer = new ResizeObserver(() => { if (followRef.current) scrollBottom(); });
    observer.observe(latest); element.addEventListener('scroll', scroll);
    return () => { observer.disconnect(); element.removeEventListener('scroll', scroll); };
  }, [messages.length, active?.id]);
  useEffect(() => { followRef.current = true; scrollBottom(); }, [active?.id]);

  return (
    <div className="sp-pane sp-pane-agent">
      <div className="ap-head">
        <div className="ap-head-top">
          <span className="ap-session" title={active ? active.id : ''}>
            <span className={`cs-dot ${streaming ? 'cs-dot-running' : ''}`} />
            {active ? active.label : '未选择会话'}
          </span>
          <span className={`chat-win-status ${streaming ? 'st-running' : 'st-done'}`}>
            {streaming ? '思考中…' : '就绪'}
          </span>
        </div>
        <div className="ap-head-meta">
          <UsageMeter />
        </div>
      </div>

      {/* 计划卡：任务清单来自主进程的 kind:'plan' 增量（update_plan 工具）。
          没有计划时它自己返回 null —— 不占位、不留空壳。 */}
      {streaming && <div className="agent-run-status" role="status">正在回复…</div>}
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

        {messages.map((m, i) => (
          <MessageViewMemo key={`${active?.id || 'session'}:${i}`} msg={m} isLatest={i === messages.length - 1} />
        ))}
      </div>

      <ResumePlanNotice />
      <PromptComposer />
    </div>
  );
}
