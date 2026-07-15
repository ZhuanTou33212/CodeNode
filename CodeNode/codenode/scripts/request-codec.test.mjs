import assert from 'node:assert/strict';
import { decodeMarkdownRequest, validateRequest } from '../mcp/request-codec.mjs';

const output = { workspaceRoot: 'E:\\CodeNode', relativePath: 'output/test', artifactPolicy: 'markdown-only' };
const node = { id: 'doc', name: 'Docs', category: 'section', prompt: '', inputs: [], outputs: [], documentation: { role: 'section', summary: '', markdownFragment: '# Docs' } };
const request = {
  schemaVersion: '3.0', requestId: 'request-doc', mode: 'markdown-blueprint', action: 'build-markdown',
  scope: { kind: 'selected-node', targetNodeId: 'doc' }, output, execution: { compile: false, run: false },
  nodes: [node], edges: [], requiresConfirmation: true
};
const markdown = `# Docs\n\n## BuildRequest\n\n\`\`\`json\n${JSON.stringify(request)}\n\`\`\`\n`;
assert.equal(decodeMarkdownRequest(markdown).requestId, 'request-doc');

assert.throws(() => decodeMarkdownRequest('# no request'), /exactly one BuildRequest/);
assert.throws(() => validateRequest({ ...request, language: 'java' }), /cannot select a code language/);
assert.throws(() => validateRequest({ ...request, execution: { compile: true, run: false } }), /cannot compile or run/);
assert.throws(() => validateRequest({ ...request, nodes: [{ ...node, code: 'doBadThing()' }] }), /cannot contain executable code/);
assert.throws(() => validateRequest({ ...request, action: 'build-program' }), /markdown mode requires/);
assert.throws(() => validateRequest({ ...request, output: { ...output, artifactPolicy: 'executable' } }), /markdown-only/);

const executable = {
  ...request, requestId: 'request-code', mode: 'executable-workflow', action: 'build-node', language: 'java',
  scope: { kind: 'selected-node', targetNodeId: 'doc' }, expression: 'doc', execution: { compile: true, run: false },
  output: { ...output, artifactPolicy: 'executable' }, nodes: [{ id: 'doc', name: 'Code', category: 'transform', prompt: '', inputs: [], outputs: [], code: '' }]
};
assert.equal(validateRequest(executable).language, 'java');
assert.throws(() => validateRequest({ ...executable, scope: { kind: 'project', targetNodeId: 'doc' } }), /requires selected-node/);

console.log('CodeNode request codec isolation test passed');
