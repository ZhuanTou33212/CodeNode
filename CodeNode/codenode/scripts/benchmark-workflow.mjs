import { performance } from 'node:perf_hooks';
import { normalizeWorkflow } from '../skills/codenode-workflow-dsl/scripts/parse-workflow.mjs';

const count = Number(process.argv[2] || 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Node count must be an integer between 1 and 10000');
const nodes = Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, type: 'operation' }));
const expression = nodes.map(node => node.id).join(';');
const start = performance.now();
const result = normalizeWorkflow({ schemaVersion: '2.0', requestId: 'benchmark', expression, nodes }, { maxNodes: 10000 });
const elapsedMs = performance.now() - start;
console.log(JSON.stringify({ nodes: count, reachable: result.reachableNodeIds.length, elapsedMs: Number(elapsedMs.toFixed(2)) }, null, 2));
