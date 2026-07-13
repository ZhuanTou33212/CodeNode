import { normalizeWorkflow } from '../skills/codenode-workflow-dsl/scripts/parse-workflow.mjs';

const nodes = [
  { id: 'a', type: 'constant' },
  { id: 'b', type: 'constant' },
  { id: 'c', type: 'operation' },
  { id: 'd', type: 'scope', scopeType: 'if' },
  { id: 'e', type: 'condition' },
  { id: 'f', type: 'operation' }
];
const expressions = Array.from({ length: 20 }, (_, index) => index % 2 === 0
  ? 'd[e]{c(a,b)}'
  : 'd[e]{c(a,b);f(c)}else{f(b)}');
let success = 0;
const failures = [];
for (const [index, expression] of expressions.entries()) {
  try {
    const result = normalizeWorkflow({ schemaVersion: '2.0', requestId: `canary-${index + 1}`, expression, nodes });
    if (result.ast && result.reachableNodeIds.length >= 5) success += 1;
    else failures.push({ index: index + 1, error: 'normalized result was incomplete' });
  } catch (error) {
    failures.push({ index: index + 1, error: error.message });
  }
}
const result = {
  source: 'deterministic-fixtures',
  attempts: expressions.length,
  success,
  successRate: success / expressions.length,
  failures
};
console.log(JSON.stringify(result, null, 2));
if (success !== expressions.length) process.exitCode = 1;
