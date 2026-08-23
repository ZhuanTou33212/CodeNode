import type { NodeTypes } from '@xyflow/react';
import type { WorkflowNodeData } from '../types';
import WorkflowNode from './WorkflowNode';

export const nodeTypes: NodeTypes = {
  task: WorkflowNode,
  stage: WorkflowNode,
  tool: WorkflowNode,
  start: WorkflowNode,
  end: WorkflowNode,
};

export type NodeTemplate = {
  label: string;
  subtitle: string;
  data: WorkflowNodeData;
};

export const NODE_TEMPLATES: Record<string, NodeTemplate> = {
  start: {
    label: '入口',
    subtitle: 'Start',
    data: { label: '入口', status: 'done', accent: '#22c55e' },
  },
  end: {
    label: '出口',
    subtitle: 'End',
    data: { label: '出口', status: 'pending', accent: '#ef4444' },
  },
  task: {
    label: '任务节点',
    subtitle: 'Task',
    data: { label: '任务节点', status: 'pending', accent: '#3b82f6' },
  },
  stage: {
    label: '阶段节点',
    subtitle: 'Stage',
    data: { label: '阶段节点', status: 'pending', accent: '#8b5cf6' },
  },
  tool: {
    label: '工具节点',
    subtitle: 'Tool',
    data: { label: '工具节点', status: 'pending', accent: '#f59e0b' },
  },
};

export const DND_MIME = 'application/codenode';
