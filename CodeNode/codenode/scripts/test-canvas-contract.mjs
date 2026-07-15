import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await fs.readFile(path.join(root, 'assets', 'node-canvas', 'canvas.html'), 'utf8');
const script = await fs.readFile(path.join(root, 'assets', 'node-canvas', 'canvas.js'), 'utf8');

for (const id of ['node-code-editor', 'input-port-count', 'output-port-count', 'input-port-config', 'output-port-config']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `Missing inspector control: ${id}`);
}
assert.match(script, /inspector\.make\.addEventListener\('click', \(\) => buildSelected\('node'\)\)/);
assert.match(script, /target\.dataType === 'auto'/);
assert.match(script, /target\.dataType = sourcePort\.dataType/);
assert.match(script, /method: 'DELETE'/);
assert.match(script, /className = 'request-delete'/);
assert.match(html, /id="workspace-mode"/);
assert.match(script, /mode: state\.mode/);
assert.match(script, /artifactPolicy: executable \? 'executable' : 'markdown-only'/);
assert.match(script, /\/result\?filename=/);
assert.match(script, /item\.nodeId === node\.id/);
assert.match(script, /ownResult\?\.status === 'failed'/);
assert.match(script, /markdown-blueprint/);
assert.match(script, /\['auto', '自动'\]/);
assert.doesNotMatch(script, /function portHtml[^\n]+· 整数/);

console.log('CodeNode canvas contract test passed');
