import type { Node, Edge } from '@xyflow/react';

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export type BaseData = {
  label: string;
  subtitle?: string;
  goal?: string;
  prompt?: string;
  status: NodeStatus;
  accent?: string;
  /** 所属 scope（唯一父，null=顶层） */
  parentId?: string | null;
  /** scope 成员列表（有序，仅 scope 非空） */
  childIds?: string[];
  /** 状态栏角标，如 'in:scope-1' */
  memberBadge?: string | null;
  /** scope 折叠状态 */
  collapsed?: boolean;
};

export type ScopeData = BaseData & {
  width: number;
  height: number;
  fill: string;
  opacity: number;
  /** 兼容旧画布：members 与 childIds 等价，加载时会归一化到 childIds */
  members?: string[];
  shrink?: boolean;
};

export type FileData = BaseData & {
  filePath?: string;
  role?: string;
  content?: string;
};

/** 对象节点：专门用于表示/存储对象名称（数据对象、配置对象、实体名等） */
export type ObjectData = BaseData & {
  objectName?: string;
};

export type WorkflowNodeData = BaseData | ScopeData | FileData | ObjectData;

export type Graph = { nodes: Node[]; edges: Edge[] };

/** 连线附加数据：waypoints 为纯几何中转点（不进入节点模型） */
export type EdgeData = {
  waypoints?: { x: number; y: number }[];
};

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

export type RagGrounding = {
  status: 'not_required' | 'valid' | 'missing' | 'invalid';
  valid: boolean;
  required: boolean;
  allowed: string[];
  used: string[];
  invalid: string[];
};


/** 会话中的一条消息 */
export type SessionMsg = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  tools?: ToolRecord[];
  status?: string;
  grounding?: RagGrounding;
};

/** 单个画布的文档快照（仅根图，无组嵌套） */
export type SessionDoc = {
  root: Graph;
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
