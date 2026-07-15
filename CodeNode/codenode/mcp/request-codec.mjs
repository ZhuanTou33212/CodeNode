const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_NODES = 10000;
const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
const LANGUAGES = new Set(['java', 'powershell', 'go']);

function fail(message) {
  throw new Error(`Invalid CodeNode request: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
}

function validateOutput(output) {
  if (!output || typeof output !== 'object') fail('output is required');
  requireString(output.workspaceRoot, 'output.workspaceRoot');
  requireString(output.relativePath, 'output.relativePath');
  if (/^[A-Za-z]:/.test(output.relativePath) || /^[\\/]{2}/.test(output.relativePath) || /(^|[\\/])\.\.([\\/]|$)/.test(output.relativePath)) {
    fail('output.relativePath must stay inside workspaceRoot');
  }
}

function validateNodes(request) {
  if (!Array.isArray(request.nodes)) fail('nodes must be an array');
  if (request.nodes.length > MAX_NODES) fail(`nodes exceeds ${MAX_NODES}`);
  if (!Array.isArray(request.edges)) fail('edges must be an array');
  const ids = new Set();
  for (const node of request.nodes) {
    if (!node || typeof node !== 'object') fail('every node must be an object');
    if (!ID_PATTERN.test(node.id || '')) fail(`invalid node id '${node.id || ''}'`);
    if (ids.has(node.id)) fail(`duplicate node id '${node.id}'`);
    ids.add(node.id);
    requireString(node.name, `nodes.${node.id}.name`);
    if (!Array.isArray(node.inputs) || !Array.isArray(node.outputs)) fail(`node '${node.id}' requires inputs and outputs`);
    if (request.mode === 'markdown-blueprint' && (node.implementation || (typeof node.code === 'string' && node.code.trim()))) {
      fail(`markdown node '${node.id}' cannot contain executable code`);
    }
  }
  for (const edge of request.edges) {
    if (!Array.isArray(edge?.source) || !Array.isArray(edge?.target) || edge.source.length !== 2 || edge.target.length !== 2) fail('edge source and target must be [nodeId, portId]');
    if (!ids.has(edge.source[0]) || !ids.has(edge.target[0])) fail('edge references an unknown node');
  }
  return ids;
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('JSON root must be an object');
  if (request.schemaVersion !== '3.0') fail("schemaVersion must be '3.0'");
  requireString(request.requestId, 'requestId');
  if (!['executable-workflow', 'markdown-blueprint'].includes(request.mode)) fail('mode is not supported');
  if (!request.scope || typeof request.scope !== 'object') fail('scope is required');
  if (typeof request.requiresConfirmation !== 'boolean') fail('requiresConfirmation must be boolean');
  validateOutput(request.output);
  const ids = validateNodes(request);

  if (request.mode === 'executable-workflow') {
    if (!['build-node', 'build-program'].includes(request.action)) fail('executable mode requires build-node or build-program');
    if (!LANGUAGES.has(request.language)) fail('executable mode requires a supported language');
    if (request.output.artifactPolicy !== 'executable') fail("executable mode requires artifactPolicy 'executable'");
    const expectedScope = request.action === 'build-node' ? 'selected-node' : 'reachable-graph';
    if (request.scope.kind !== expectedScope) fail(`${request.action} requires ${expectedScope} scope`);
    requireString(request.scope.targetNodeId, 'scope.targetNodeId');
    if (!ids.has(request.scope.targetNodeId)) fail('scope.targetNodeId is not present in nodes');
    requireString(request.expression, 'expression');
    if (request.expression.length > MAX_MARKDOWN_BYTES) fail('expression is too large');
  } else {
    if (!['build-markdown', 'analyze-project'].includes(request.action)) fail('markdown mode requires build-markdown or analyze-project');
    if (!LANGUAGES.has(request.language)) fail('markdown mode requires a supported target language');
    const expectedScope = request.action === 'build-markdown' ? 'selected-node' : 'project';
    if (request.scope.kind !== expectedScope) fail(`${request.action} requires ${expectedScope} scope`);
    if (request.output.artifactPolicy !== 'markdown-only') fail("markdown mode requires artifactPolicy 'markdown-only'");
    if (request.action === 'build-markdown') {
      requireString(request.scope.targetNodeId, 'scope.targetNodeId');
      if (!ids.has(request.scope.targetNodeId)) fail('scope.targetNodeId is not present in nodes');
    }
    if (request.execution?.compile || request.execution?.run) fail('markdown mode cannot compile or run');
  }
  return request;
}

export function decodeMarkdownRequest(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) fail('Markdown content is required');
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) fail('Markdown file is too large');
  const blocks = [...markdown.matchAll(/## BuildRequest\s*\r?\n+```json\s*\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) fail('Markdown must contain exactly one BuildRequest JSON block');
  let request;
  try {
    request = JSON.parse(blocks[0][1]);
  } catch (error) {
    fail(`BuildRequest JSON cannot be decoded: ${error.message}`);
  }
  return validateRequest(request);
}

export function buildResult(request, value = {}) {
  const status = value.status || 'succeeded';
  if (!['queued', 'processing', 'succeeded', 'failed', 'cancelled'].includes(status)) fail('result status is not supported');
  return {
    schemaVersion: '3.0',
    requestId: request.requestId,
    mode: request.mode,
    action: request.action,
    status,
    summary: String(value.summary || ''),
    output: value.output,
    diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [],
    nodeResults: Array.isArray(value.nodeResults) ? value.nodeResults : [],
    processedAt: new Date().toISOString()
  };
}
