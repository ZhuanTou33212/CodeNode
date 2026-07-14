import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(root, 'schemas');
const requiredFiles = ['node.schema.json', 'edge.schema.json', 'workflow-request.schema.json', 'workflow-result.schema.json', 'agent-canary-output.schema.json'];
for (const filename of requiredFiles) {
  const file = path.join(schemaDir, filename);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!document.$schema || !document.$id || document.type !== 'object') throw new Error(`Invalid schema metadata: ${filename}`);
  if (!Array.isArray(document.required) || document.required.length === 0) throw new Error(`Schema has no required fields: ${filename}`);
}
const request = JSON.parse(await fs.readFile(path.join(schemaDir, 'workflow-request.schema.json'), 'utf8'));
if (!request.properties.nodes.items.$ref.endsWith('node.schema.json')) throw new Error('Workflow schema must reference node schema');
if (!request.properties.edges.items.$ref.endsWith('edge.schema.json')) throw new Error('Workflow schema must reference edge schema');
console.log(`Validated ${requiredFiles.length} CodeNode JSON Schemas`);
