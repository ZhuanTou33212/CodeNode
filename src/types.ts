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
  tools?: { name: string; args?: unknown; result?: string }[];
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
