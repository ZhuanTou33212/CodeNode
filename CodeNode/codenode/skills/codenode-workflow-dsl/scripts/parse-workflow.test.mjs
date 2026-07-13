import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflow } from './parse-workflow.mjs';

const nodes = [
  { id: 'a', type: 'constant', value: 10 },
  { id: 'b', type: 'constant', value: 20 },
  { id: 'c', type: 'operation' },
  { id: 'd', type: 'scope', scopeType: 'if' },
  { id: 'e', type: 'condition' },
  { id: 'f', type: 'operation' }
];

test('normalizes nested scopes, calls, else branches, and variables', () => {
  const result = normalizeWorkflow({
    schemaVersion: '2.0',
    requestId: 'request-1',
    expression: 'd[e]{c(a,b);f(c)}else{f(b)}',
    nodes,
    environment: {
      variables: {
        WORK_DIR: { dataType: 'path', source: 'literal', value: 'output' },
        API_TOKEN: { dataType: 'string', source: 'environment', key: 'API_TOKEN', secret: true }
      }
    }
  });
  assert.equal(result.ast.type, 'scope');
  assert.equal(result.ast.body.length, 2);
  assert.equal(result.ast.elseBody.length, 1);
  assert.deepEqual(new Set(result.reachableNodeIds), new Set(['a', 'b', 'c', 'd', 'e', 'f']));
});

test('rejects unknown node references', () => {
  assert.throws(() => normalizeWorkflow({ expression: 'c(a,missing)', nodes }), /Unknown node ID 'missing'/);
});

test('rejects implicit dependency cycles', () => {
  assert.throws(() => normalizeWorkflow({
    expression: 'c(a)',
    nodes: [
      { id: 'a', type: 'operation', inputs: ['c'] },
      { id: 'c', type: 'operation', inputs: ['a'] }
    ]
  }), /Implicit dependency cycle/);
});

test('rejects literal secrets', () => {
  assert.throws(() => normalizeWorkflow({
    expression: 'a',
    nodes: [{ id: 'a', type: 'constant' }],
    environment: { variables: { TOKEN: { dataType: 'string', source: 'literal', value: 'secret', secret: true } } }
  }), /cannot contain a literal value/);
});
