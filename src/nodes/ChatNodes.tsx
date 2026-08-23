import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps, type Connection } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useProjectStore } from '../store/projectStore';
import { useChatStore } from '../store/chatStore';
import { computeChildren } from '../lib/flow';
import { useContainerAutoFit } from '../lib/useContainerAutoFit';
import type { AgentChatData, UserChatData } from '../types';

const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const WIN_W = 380;

function makeAgentData(partial: Partial<AgentChatData>): AgentChatData {
  return {
    label: 'Agent',
    name: 'CodeNode',
    content: '',
    status: 'pending',
    accent: '#22c55e',
    greeted: true,
    width: WIN_W,
    ...partial,
  };
}

function makeUserData(partial: Partial<UserChatData> = {}): UserChatData {
  return {
    label: '用户',
    content: '',
    status: 'pending',
    accent: '#f59e0b',
    width: WIN_W,
    height: 240,
    ...partial,
  };
}

function AgentChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as AgentChatData;
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const addNode = useGraphStore((s) => s.addNode);
  const onConnect = useGraphStore((s) => s.onConnect);
  const root = useProjectStore((s) => s.root);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    if (d.greeted) return;
    const api = window.codenode;
    if (!api) return;
    void api.agentGreeting(root).then((r) => {
      updateNodeData(id, {
        content: r.greeting || '',
        name: r.name || 'CodeNode',
        status: 'done',
        greeted: true,
      });
      const st = useGraphStore.getState();
      const agent = st.nodes.find((n) => n.id === id);
      const already = st.nodes.some((n) => n.type === 'user');
      if (agent && !already) {
        const uidNode = uid('user');
        st.addNode({ id: uidNode, type: 'user', position: { x: agent.position.x, y: agent.position.y + 230 }, data: makeUserData() });
        st.onConnect({ source: id, target: uidNode } as Connection);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reasoning = d.reasoning;
  const tools = d.tools || [];

  return (
    <div className={`chat-window chat-agent ${selected ? 'is-selected' : ''}`} style={{ width: d.width || WIN_W }}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="chat-win-header">
        <span className="chat-win-name">{d.name || 'CodeNode'}</span>
        <span className={`chat-win-status st-${d.status || 'pending'}`}>
          {d.status === 'running' ? '思考中…' : d.status || ''}
        </span>
      </div>
      <div className="chat-win-body">
        <div className="chat-output">{d.content || (d.status === 'running' ? '…' : '')}</div>
        {reasoning ? (
          <div className="chat-section">
            <button className="chat-section-toggle" onClick={() => setShowReasoning((v) => !v)}>
              推理 {showReasoning ? '▾' : '▸'}
            </button>
            {showReasoning && <div className="chat-section-body chat-reasoning">{reasoning}</div>}
          </div>
        ) : null}
        {tools.length ? (
          <div className="chat-section">
            <button className="chat-section-toggle" onClick={() => setShowTools((v) => !v)}>
              工具调用（{tools.length}）{showTools ? '▾' : '▸'}
            </button>
            {showTools && (
              <div className="chat-section-body">
                {tools.map((t, i) => (
                  <div key={i} className="chat-tool">
                    <span className="ct-name">{t.name}</span>
                    {t.args ? <span className="ct-args">{typeof t.args === 'string' ? t.args : JSON.stringify(t.args)}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

function UserChatNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as UserChatData;
  const [text, setText] = useState(d.content || '');
  const reasoningRef = useRef('');
  const contentRef = useRef('');
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const addNode = useGraphStore((s) => s.addNode);
  const onConnect = useGraphStore((s) => s.onConnect);
  const sending = useChatStore((s) => s.sending);
  const nodes = useGraphStore((s) => s.nodes);
  const userNode = useGraphStore((s) => s.nodes.find((n) => n.id === id));
  const children = userNode ? computeChildren(userNode, nodes) : [];

  useContainerAutoFit(id, nodes, WIN_W, 240, 16);

  const send = async () => {
    const promptText = text.trim();
    const instruction = children
      .map((c) => {
        const cd = c.data as { label?: string; goal?: string };
        return `${cd.label || c.type}${cd.goal ? '：' + cd.goal : ''}`;
      })
      .join('；');
    const prompt = promptText ? (instruction ? `${instruction}\n${promptText}` : promptText) : instruction;
    if (!prompt || sending) return;

    const st = useGraphStore.getState();
    const user = st.nodes.find((n) => n.id === id);
    if (!user) return;

    // 立马生成 Agent 窗口（思考中），随后流式填充推理/内容/工具
    const agentId = uid('agent');
    const agentPos = { x: user.position.x, y: user.position.y + (d.height || 240) + 40 };
    st.addNode({ id: agentId, type: 'agent', position: agentPos, data: makeAgentData({ status: 'running' }) });
    st.onConnect({ source: id, target: agentId } as Connection);

    updateNodeData(id, { content: promptText, sent: true });
    setText('');

    const finalize = () => {
      updateNodeData(agentId, { status: 'done', content: contentRef.current, reasoning: reasoningRef.current || undefined });
    };

    const res = await useChatStore.getState().send(prompt, id, (ev) => {
      if (ev.kind === 'reasoning' && ev.text) {
        reasoningRef.current += ev.text;
        updateNodeData(agentId, { reasoning: reasoningRef.current });
      } else if (ev.kind === 'content' && ev.text) {
        contentRef.current += ev.text;
        updateNodeData(agentId, { content: contentRef.current });
      } else if (ev.kind === 'tool' && ev.toolCalls) {
        updateNodeData(agentId, { tools: ev.toolCalls as { name: string; args?: unknown }[] });
      }
    });

    if (res.reply) {
      contentRef.current = res.reply;
      updateNodeData(agentId, { tools: res.tools, reasoning: res.reasoning || undefined });
      finalize();
      // 回复完成后，在 Agent 窗口下方自动创建新的用户对话框
      const agent = useGraphStore.getState().nodes.find((n) => n.id === agentId);
      if (agent) {
        const uidNode = uid('user');
        addNode({ id: uidNode, type: 'user', position: { x: agent.position.x, y: agent.position.y + 230 }, data: makeUserData() });
        onConnect({ source: agentId, target: uidNode } as Connection);
      }
    } else {
      updateNodeData(agentId, { status: 'failed', content: '（调用失败，见状态栏）' });
    }
  };

  return (
    <div className={`chat-window chat-user ${selected ? 'is-selected' : ''}`} style={{ width: d.width || WIN_W, height: d.height || 240 }}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="chat-win-header">
        <span className="chat-win-name">用户</span>
        <span className="chat-win-count">{children.length} 个节点</span>
      </div>
      <div className="chat-zone chat-zone-prompt">
        <div className="chat-zone-label">Prompt</div>
        <textarea
          className="chat-input"
          value={text}
          rows={2}
          placeholder="输入 prompt…（Ctrl+Enter 发送）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') void send();
          }}
        />
      </div>
      <div className="chat-zone chat-zone-nodes">
        <div className="chat-zone-label">节点区（拖入节点作为指令）</div>
        <div className="chat-children">
          {children.length === 0 ? (
            <span className="chat-child-hint">暂无节点</span>
          ) : (
            children.map((c) => {
              const cd = c.data as { label?: string };
              return (
                <span key={c.id} className="chat-child-chip">
                  {cd.label || c.type}
                </span>
              );
            })
          )}
        </div>
      </div>
      <div className="chat-actions">
        <button className="chat-btn chat-btn-send" onClick={() => void send()} disabled={sending}>
          {sending ? '思考中…' : '发送执行'}
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export const AgentChatNodeMemo = memo(AgentChatNode);
export const UserChatNodeMemo = memo(UserChatNode);
