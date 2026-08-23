import { computeFlow, computeChildren } from '../src/lib/flow';
import type { Node, Edge } from '@xyflow/react';
import type { Graph } from '../src/types';

const n = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x, y }, data: { label: id, ...extra }, measured: { width: 80, height: 50 } }) as Node;

// 主画布：start -> 组(in-1)，组(out-1) -> end
const nodes: Node[] = [
  n('start', 'start', 0, 0),
  n('g1', 'group', 300, 0, {
    width: 260,
    height: 160,
    sockets: { inputs: [{ id: 'in-1', toId: 'task1' }], outputs: [{ id: 'out-1', fromId: 'task1' }] },
  }),
  n('end', 'end', 700, 60),
];
const edges: Edge[] = [
  { id: 'e1', source: 'start', target: 'g1', targetHandle: 'in-1' },
  { id: 'e2', source: 'g1', sourceHandle: 'out-1', target: 'end' },
];

// 组内视图：组输入(in-1) -> task1 -> 组输出(out-1)
const gi = n('g1-gi', 'group-input', 0, 40, { socketIds: ['in-1'] });
const task1 = n('task1', 'task', 120, 20, { goal: '组内任务' });
const go = n('g1-go', 'group-output', 320, 40, { socketIds: ['out-1'] });
const groups: Record<string, Graph> = {
  g1: {
    nodes: [gi, task1, go],
    edges: [
      { id: 's1', source: 'g1-gi', sourceHandle: 'in-1', target: 'task1' },
      { id: 's2', source: 'task1', target: 'g1-go', targetHandle: 'out-1' },
    ],
  },
};

const flow = computeFlow(nodes, edges, groups);

console.log('start.out:', flow['start'].output.map((i) => i.kind).join(','));
console.log('group.input:', flow['g1'].input.map((i) => i.kind).join(','));
console.log('group.output:', flow['g1'].output.map((i) => i.kind + ':' + i.label).join('|'));
console.log('end.in:', flow['end'].input.length, 'end.out:', flow['end'].output.length);

// 容器成员制（computeChildren 返回显式成员）
const scopeNodes = [
  n('scope', 'scope', 100, 100, { width: 300, height: 200, members: ['a', 'b'] }),
  n('a', 'task', 130, 130),
  n('b', 'task', 260, 150),
  n('outside', 'task', 600, 600),
];
const kids = computeChildren(scopeNodes[0], scopeNodes);

const pass =
  flow['start'].output.length === 1 &&
  flow['g1'].input.length === 1 &&
  flow['g1'].output.length === 2 &&
  flow['end'].input.length === 2 &&
  flow['end'].output.length === 3 &&
  kids.map((k) => k.id).sort().join(',') === 'a,b';

console.log(pass ? 'GROUP FLOW TEST: PASS' : 'GROUP FLOW TEST: FAIL');
process.exit(pass ? 0 : 1);
