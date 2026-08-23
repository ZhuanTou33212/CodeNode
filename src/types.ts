export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export type WorkflowNodeData = {
  label: string;
  subtitle?: string;
  goal?: string;
  status: NodeStatus;
  accent?: string;
};
