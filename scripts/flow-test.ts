import { computeFlow, computeChildren } from '../src/lib/flow';
import type { Node, Edge } from '@xyflow/react';

const n = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x, y }, data: { label: id, ...extra }, measured: { width: 80, height: 50 } }) as Node;

// 主画布：start -> task1 -> end
const nodes: Node[] = [
  n('start', 'start', 0, 0, { goal: '开始' }),
  n('task1', 'task', 200, 0, { goal: '任务一', prompt: '做某事' }),
  n('task2', 'task', 400, 0, { goal: '任务二', prompt: '做另一事' }),
  n('end', 'end', 600, 60),
];
const edges: Edge[] = [
  { id: 'e1', source: 'start', target: 'task1' },
  { id: 'e2', source: 'task1', target: 'task2' },
  { id: 'e3', source: 'task2', target: 'end' },
];

const flow = computeFlow(nodes, edges);

console.log('start.out:', flow['start'].output.map((i) => i.kind).join(','));
console.log('task1.in:', flow['task1'].input.map((i) => i.kind).join(','));
console.log('task2.out:', flow['task2'].output.map((i) => i.kind + ':' + i.label).join('|'));
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
  flow['task1'].input.length === 1 &&
  flow['task2'].output.length === 3 &&
  flow['end'].input.length === 3 &&
  flow['end'].output.length === 4 &&
  kids.map((k) => k.id).sort().join(',') === 'a,b';

console.log(pass ? 'FLOW TEST: PASS' : 'FLOW TEST: FAIL');
process.exit(pass ? 0 : 1);
