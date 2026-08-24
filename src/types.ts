import type { Node, Edge } from '@xyflow/react';

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export type BaseData = {
  label: string;
  subtitle?: string;
  goal?: string;
  prompt?: string;
  status: NodeStatus;
  accent?: string;
};

export type ScopeData = BaseData & {
  width: number;
  height: number;
  fill: string;
  opacity: number;
};

export type FileData = BaseData & {
  filePath?: string;
  role?: string;
  content?: string;
};

export type SocketDef = {
  id: string;
  toId?: string;
  fromId?: string;
};

export type GroupData = BaseData & {
  width: number;
  height: number;
  sockets: { inputs: SocketDef[]; outputs: SocketDef[] };
};

export type GroupIOData = BaseData & {
  socketIds: string[];
};

export type AgentChatData = BaseData & {
  name: string;
  content: string;
  greeted?: boolean;
  reasoning?: string;
  tools?: { name: string; args?: unknown; result?: string; ok?: boolean }[];
  width?: number;
};

export type UserChatData = BaseData & {
  content: string;
  sent?: boolean;
  width?: number;
  height?: number;
};

export type WorkflowNodeData = BaseData | ScopeData | FileData | GroupData | GroupIOData | AgentChatData | UserChatData;

export type Graph = { nodes: Node[]; edges: Edge[] };

export type FlowItem = {
  nodeId: string;
  kind: string;
  label: string;
  payload?: unknown;
};

export type FlowResult = {
  input: FlowItem[];
  output: FlowItem[];
};

/** Agent 工具调用记录 */
export type ToolRecord = {
  id?: string;
  name: string;
  args?: unknown;
  result?: string;
  ok?: boolean;
  data?: unknown;
};

/** 会话中的一条消息 */
export type SessionMsg = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  tools?: ToolRecord[];
  status?: string;
};

/** 单个画布的文档快照（根图 + 组图 + 组导航栈） */
export type SessionDoc = {
  root: Graph;
  groups: Record<string, Graph>;
  viewStack: string[];
};

/** 一个会话画布（每次 Agent 制作任务的输出画布） */
export type SessionCanvas = {
  id: string;
  label: string;
  prompt: string;
  doc: SessionDoc;
  status: 'active' | 'completed';
  createdAt: number;
  nodeCount: number;
  summary?: string;
};
