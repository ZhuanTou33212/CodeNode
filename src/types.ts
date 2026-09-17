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

/** 图像节点：展示一张图（项目内图片路径 或 直接粘贴的图片数据） */
export type ImageData = BaseData & {
  /** 项目内相对路径（优先） */
  imagePath?: string;
  /** 已解析出的图片 data URL（粘贴/拖入或读取项目文件后写入） */
  dataUrl?: string;
  /** 说明/来源备注 */
  note?: string;
  /** 预览宽度（px） */
  width?: number;
  /** 预览高度（px） */
  height?: number;
};

/** 对象节点：专门用于表示/存储对象名称（数据对象、配置对象、实体名等） */
export type ObjectData = BaseData & {
  objectName?: string;
};

/**
 * 画布节点：内嵌一块矢量画布（预设配件 + 自由绘制），
 * 左上角可切换 设计 / 逻辑 模式。文档本体按节点 id 独立存放，不写进节点 data。
 */
export type VectorData = BaseData & {
  width?: number;
  height?: number;
  mode?: 'design' | 'logic';
  dockOpen?: boolean;
};

export type WorkflowNodeData = BaseData | ScopeData | FileData | ObjectData | VectorData;

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


/** 随消息发送的图片附件（多模态输入）。dataUrl 是已在渲染端压缩过的 data: URL */
export type AgentAttachment = {
  /** 仅接受 image/png | image/jpeg | image/webp | image/gif */
  mime: string;
  /** data:image/...;base64,... （可直接作为 img.src） */
  dataUrl: string;
  /** 原始文件名，仅用于界面展示 */
  name?: string;
  /** 压缩后的字节数 */
  bytes?: number;
};

/** 会话中的一条消息 */
export type SessionMsg = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  tools?: ToolRecord[];
  status?: string;
  grounding?: RagGrounding;
  /** 用户消息携带的图片（仅用户消息会有） */
  attachments?: AgentAttachment[];
  /**
   * 上下文压缩（照 Codex CLI）：这条消息已经被摘要取代 —— 仍留在界面上供回溯，
   * 但**不再发给模型**（历史里只送摘要卡 + 压缩之后的新消息）。
   */
  compacted?: boolean;
  /** 压缩摘要卡：正文是给模型的 `<compaction>` 信封原文，不是对话轮次 */
  compaction?: boolean;
  compactionMeta?: {
    windowNumber?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    keptUserTurns?: number;
    /** 摘要正文（界面折叠区里给人看；发给模型的是 content 里的信封） */
    summary?: string;
  };
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
