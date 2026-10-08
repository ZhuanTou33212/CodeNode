'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentToolRegistry } = require("../../electron/tools/registry.cjs");
const { registerProjectExtensions } = require("../../electron/tools/extensions.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-extension-contract-'));
try {
  fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codenode', 'extensions.json'), JSON.stringify({ extensions: [
    {
      name: 'typed-mcp', kind: 'mcp', command: 'node', readOnly: true,
      outputSchema: { type: 'object', required: ['extension', 'tool', 'output'], additionalProperties: false,
        properties: { extension: { type: 'string' }, tool: { type: 'string' }, output: { type: 'string' } } },
      tools: [{ name: 'lookup', description: 'typed lookup', parameters: { type: 'object', properties: {} }, readOnly: true }],
    },
    { name: 'plain-extension', command: 'node', parameters: { type: 'object', properties: {} }, timeoutMs: 3210 },
  ] }, null, 2));

  const registry = new AgentToolRegistry();
  registerProjectExtensions(registry, root);
  const mcp = registry.descriptorOf('lookup');
  assert.equal(mcp.source, 'explicit');
  assert.equal(mcp.readOnly, true);
  assert.equal(mcp.mutatesWorkspace, false);
  assert.equal(mcp.requiredCapability, 'workspace.read');
  assert.equal(mcp.outputSchema.properties.output.type, 'string');
  const plain = registry.descriptorOf('plain-extension');
  assert.equal(plain.source, 'explicit');
  assert.equal(plain.timeoutMs, 3210);
  assert.equal(plain.readOnly, false);
  assert.equal(plain.mutatesWorkspace, true);
  assert.equal(plain.requiredCapability, 'shell.execute');
  console.log('EXTENSION CONTRACT: PASS — manifest descriptors preserved for MCP and project extensions');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
