import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_EXPRESSION_LENGTH = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
const VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

class WorkflowParser {
  constructor(source, maxDepth = DEFAULT_MAX_DEPTH) {
    this.source = source;
    this.maxDepth = maxDepth;
    this.position = 0;
  }

  parse() {
    const body = this.parseList(null, 0);
    this.skipWhitespace();
    if (this.position !== this.source.length) this.fail('Unexpected trailing input');
    if (body.length === 0) this.fail('Workflow expression is empty');
    return body.length === 1 ? body[0] : { type: 'sequence', body };
  }

  parseList(endCharacter, depth) {
    const body = [];
    this.skipWhitespace();
    if (endCharacter && this.peek() === endCharacter) return body;
    while (this.position < this.source.length) {
      body.push(this.parseExpression(depth));
      this.skipWhitespace();
      if (this.peek() === ';') {
        this.position += 1;
        this.skipWhitespace();
        if (endCharacter && this.peek() === endCharacter) this.fail('Trailing semicolon is not allowed');
        continue;
      }
      if (endCharacter && this.peek() === endCharacter) return body;
      if (!endCharacter && this.position === this.source.length) return body;
      this.fail(endCharacter ? `Expected ';' or '${endCharacter}'` : "Expected ';' or end of input");
    }
    if (endCharacter) this.fail(`Expected '${endCharacter}'`);
    return body;
  }

  parseExpression(depth) {
    if (depth > this.maxDepth) this.fail(`Maximum nesting depth ${this.maxDepth} exceeded`);
    const nodeId = this.readIdentifier();
    this.skipWhitespace();
    if (this.peek() === '(') return this.parseCall(nodeId, depth);
    if (this.peek() === '[') return this.parseScope(nodeId, depth);
    return { type: 'reference', nodeId };
  }

  parseCall(nodeId, depth) {
    this.expect('(');
    const args = [];
    this.skipWhitespace();
    if (this.peek() !== ')') {
      while (true) {
        args.push(this.parseExpression(depth + 1));
        this.skipWhitespace();
        if (this.peek() !== ',') break;
        this.position += 1;
        this.skipWhitespace();
      }
    }
    this.expect(')');
    return { type: 'call', nodeId, arguments: args };
  }

  parseScope(nodeId, depth) {
    this.expect('[');
    const condition = this.parseExpression(depth + 1);
    this.expect(']');
    this.expect('{');
    const body = this.parseList('}', depth + 1);
    this.expect('}');
    this.skipWhitespace();
    let elseBody = [];
    if (this.source.startsWith('else', this.position)) {
      const next = this.source[this.position + 4];
      if (next && /[A-Za-z0-9_]/.test(next)) this.fail("Expected '{' after else");
      this.position += 4;
      this.expect('{');
      elseBody = this.parseList('}', depth + 1);
      this.expect('}');
    }
    return { type: 'scope', nodeId, condition, body, elseBody };
  }

  readIdentifier() {
    this.skipWhitespace();
    const start = this.position;
    while (this.position < this.source.length && /[A-Za-z0-9_.:/-]/.test(this.source[this.position])) this.position += 1;
    const value = this.source.slice(start, this.position);
    if (!value || !ID_PATTERN.test(value)) this.fail('Expected a portable node ID', start);
    return value;
  }

  expect(character) {
    this.skipWhitespace();
    if (this.peek() !== character) this.fail(`Expected '${character}'`);
    this.position += 1;
  }

  peek() { return this.source[this.position]; }

  skipWhitespace() {
    while (this.position < this.source.length && /\s/.test(this.source[this.position])) this.position += 1;
  }

  fail(message, position = this.position) {
    throw new Error(`${message} at character ${position + 1}`);
  }
}

function visitAst(node, visitor) {
  visitor(node);
  if (node.type === 'sequence') node.body.forEach(child => visitAst(child, visitor));
  if (node.type === 'call') node.arguments.forEach(child => visitAst(child, visitor));
  if (node.type === 'scope') {
    visitAst(node.condition, visitor);
    node.body.forEach(child => visitAst(child, visitor));
    node.elseBody.forEach(child => visitAst(child, visitor));
  }
}

function nodeReference(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return value.nodeId || value.sourceNodeId || value.source || value.ref || null;
}

function validateEnvironment(environment = {}) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('environment must be an object');
  const variables = environment.variables || {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('environment.variables must be an object');
  for (const [name, definition] of Object.entries(variables)) {
    if (!VARIABLE_PATTERN.test(name)) throw new Error(`Environment variable '${name}' is not portable`);
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`Environment variable '${name}' must be an object`);
    if (!definition.dataType) throw new Error(`Environment variable '${name}' requires dataType`);
    if (!['literal', 'environment', 'node'].includes(definition.source)) throw new Error(`Environment variable '${name}' has an invalid source`);
    if (definition.source === 'literal' && !Object.hasOwn(definition, 'value')) throw new Error(`Literal variable '${name}' requires value`);
    if (definition.source === 'literal' && definition.secret) throw new Error(`Secret variable '${name}' cannot contain a literal value`);
    if (definition.source === 'environment' && !definition.key) throw new Error(`Environment variable '${name}' requires key`);
    if (definition.source === 'node' && !definition.nodeId) throw new Error(`Node variable '${name}' requires nodeId`);
  }
  return { ...environment, variables };
}

function buildDependencies(nodes, edges = []) {
  const dependencies = new Map(nodes.map(node => [node.id, new Set()]));
  for (const node of nodes) {
    for (const input of node.inputs || []) {
      const dependency = nodeReference(input);
      if (dependency && dependencies.has(dependency)) dependencies.get(node.id).add(dependency);
    }
  }
  for (const edge of edges || []) {
    const source = Array.isArray(edge.source) ? edge.source[0] : nodeReference(edge.source);
    const target = Array.isArray(edge.target) ? edge.target[0] : nodeReference(edge.target);
    if (source && target && dependencies.has(source) && dependencies.has(target)) dependencies.get(target).add(source);
  }
  return dependencies;
}

function validateCycles(nodes, dependencies, warnings) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const state = new Map();
  const stack = [];
  const visit = id => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const explicitLoop = cycle.some(nodeId => byId.get(nodeId)?.type === 'loop' || byId.get(nodeId)?.scopeType === 'loop');
      if (!explicitLoop) throw new Error(`Implicit dependency cycle: ${cycle.join(' -> ')}`);
      warnings.push(`Explicit loop cycle requires a termination condition: ${cycle.join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of dependencies.get(id) || []) visit(dependency);
    stack.pop();
    state.set(id, 2);
  };
  for (const node of nodes) visit(node.id);
}

export function normalizeWorkflow(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object');
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxExpressionLength = options.maxExpressionLength ?? DEFAULT_MAX_EXPRESSION_LENGTH;
  const expression = String(request.expression || '').trim();
  if (!expression) throw new Error('Request requires expression');
  if (expression.length > maxExpressionLength) throw new Error(`Expression exceeds ${maxExpressionLength} characters`);
  if (!Array.isArray(request.nodes)) throw new Error('Request nodes must be an array');
  if (request.nodes.length > maxNodes) throw new Error(`Node count exceeds ${maxNodes}`);

  const byId = new Map();
  for (const node of request.nodes) {
    if (!node || typeof node !== 'object' || !ID_PATTERN.test(node.id || '')) throw new Error('Every node requires a portable id');
    if (byId.has(node.id)) throw new Error(`Duplicate node ID '${node.id}'`);
    byId.set(node.id, node);
  }

  const ast = new WorkflowParser(expression, maxDepth).parse();
  const environment = validateEnvironment(request.environment);
  const directReferences = new Set();
  visitAst(ast, node => { if (node.nodeId) directReferences.add(node.nodeId); });
  for (const definition of Object.values(environment.variables)) {
    if (definition.source === 'node') directReferences.add(definition.nodeId);
  }
  for (const id of directReferences) if (!byId.has(id)) throw new Error(`Unknown node ID '${id}'`);

  const warnings = [];
  const dependencies = buildDependencies(request.nodes, request.edges);
  validateCycles(request.nodes, dependencies, warnings);
  const reachable = new Set(directReferences);
  const pending = [...directReferences];
  while (pending.length) {
    const id = pending.pop();
    for (const dependency of dependencies.get(id) || []) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }

  visitAst(ast, node => {
    if (node.type === 'scope') {
      const scope = byId.get(node.nodeId);
      if (scope?.type && !['scope', 'condition-scope', 'loop'].includes(scope.type)) warnings.push(`Node '${node.nodeId}' is used as a scope but has type '${scope.type}'`);
    }
  });

  return {
    schemaVersion: String(request.schemaVersion || '2.0'),
    requestId: request.requestId || null,
    action: request.action || null,
    language: request.language || null,
    entry: request.entry || ast.nodeId || null,
    ast,
    environment,
    reachableNodeIds: [...reachable],
    nodes: request.nodes.filter(node => reachable.has(node.id)),
    requiresConfirmation: request.requiresConfirmation !== false,
    warnings
  };
}

function parseArguments(argv) {
  const options = {};
  let filename;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--max-depth') options.maxDepth = Number(argv[++index]);
    else if (value === '--max-nodes') options.maxNodes = Number(argv[++index]);
    else if (!filename) filename = value;
    else throw new Error(`Unexpected argument '${value}'`);
  }
  if (!filename) throw new Error('Usage: node parse-workflow.mjs <request.json> [--max-depth N] [--max-nodes N]');
  return { filename, options };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { filename, options } = parseArguments(process.argv.slice(2));
    const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    process.stdout.write(`${JSON.stringify(normalizeWorkflow(JSON.parse(source), options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`CodeNode workflow error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
