import type { NodeTypes } from '@xyflow/react';
import type { WorkflowNodeData, ScopeData, FileData } from '../types';
import WorkflowNode from './WorkflowNode';
import ScopeNode from './ScopeNode';
import FileNode from './FileNode';
import { GroupNodeMemo, GroupInputNodeMemo, GroupOutputNodeMemo } from './GroupNode';
import { AgentChatNodeMemo, UserChatNodeMemo } from './ChatNodes';

export const nodeTypes: NodeTypes = {
  task: WorkflowNode,
  stage: WorkflowNode,
  tool: WorkflowNode,
  start: WorkflowNode,
  end: WorkflowNode,
  scope: ScopeNode,
  file: FileNode,
  group: GroupNodeMemo,
  'group-input': GroupInputNodeMemo,
  'group-output': GroupOutputNodeMemo,
  agent: AgentChatNodeMemo,
  user: UserChatNodeMemo,
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
    data: { label: '任务节点', status: 'pending', prompt: '', accent: '#3b82f6' },
  },
  stage: {
    label: '阶段节点',
    subtitle: 'Stage',
    data: { label: '阶段节点', status: 'pending', prompt: '', accent: '#8b5cf6' },
  },
  tool: {
    label: '工具节点',
    subtitle: 'Tool',
    data: { label: '工具节点', status: 'pending', prompt: '', accent: '#f59e0b' },
  },
  scope: {
    label: '范围节点',
    subtitle: 'Scope / 组',
    data: {
      label: '范围节点',
      status: 'pending',
      accent: '#8b5cf6',
      width: 320,
      height: 220,
      fill: '#3b2f6b',
      opacity: 0.16,
    } as ScopeData,
  },
  file: {
    label: '文件节点',
    subtitle: 'File',
    data: { label: '文件节点', status: 'pending', accent: '#f97316' } as FileData,
  },
};

export const DND_MIME = 'application/codenode';
