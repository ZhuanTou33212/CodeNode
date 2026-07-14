import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const serverName = 'codenode';
const serverVersion = '0.2.0';
const httpPort = Number(process.env.CODENODE_MCP_PORT || 32145);
const dataRoot = process.env.PLUGIN_DATA || process.env.CODENODE_DATA_DIR || path.join(os.tmpdir(), 'codenode-mcp');
const inboxDir = path.join(dataRoot, 'inbox');
const processedDir = path.join(dataRoot, 'processed');
const maxMarkdownBytes = 1024 * 1024;

await fs.mkdir(inboxDir, { recursive: true });
await fs.mkdir(processedDir, { recursive: true });

function safeMarkdownName(value) {
  const name = path.basename(String(value || '')).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!name || !name.toLowerCase().endsWith('.md')) throw new Error('filename must end with .md');
  return name;
}

async function markdownFiles() {
  const entries = await fs.readdir(inboxDir, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(async entry => {
    const stat = await fs.stat(path.join(inboxDir, entry.name));
    return { filename: entry.name, size: stat.size, submittedAt: stat.mtime.toISOString() };
  }));
  return files.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

async function readMarkdown(filename) {
  const safeName = safeMarkdownName(filename);
  return { filename: safeName, content: await fs.readFile(path.join(inboxDir, safeName), 'utf8') };
}

async function deleteMarkdown(filename) {
  const request = await readMarkdown(filename);
  await fs.rm(path.join(inboxDir, request.filename));
  await fs.rm(queueMetadataPath(request.filename), { force: true });
  return { filename: request.filename, status: 'deleted' };
}

function queueMetadataPath(filename, root = inboxDir) {
  return path.join(root, `${safeMarkdownName(filename)}.queue.json`);
}

async function readQueueMetadata(filename) {
  try {
    return JSON.parse(await fs.readFile(queueMetadataPath(filename), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function initializeQueueSequence() {
  const files = (await markdownFiles()).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const records = await Promise.all(files.map(async file => ({ file, metadata: await readQueueMetadata(file.filename) })));
  let sequence = Math.max(0, ...records.map(record => Number(record.metadata?.sequence) || 0));
  for (const record of records) {
    if (record.metadata) continue;
    sequence += 1;
    await fs.writeFile(queueMetadataPath(record.file.filename), JSON.stringify({ sequence }), { encoding: 'utf8', flag: 'wx' });
  }
  return sequence;
}

let queueSequence = await initializeQueueSequence();

async function markdownQueue() {
  const requests = await Promise.all((await markdownFiles()).map(async file => {
    const { content } = await readMarkdown(file.filename);
    const metadata = await readQueueMetadata(file.filename);
    const action = content.match(/^action:\s*(build-node|build-program)\s*$/m)?.[1] || 'build-program';
    const nodeName = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.filename;
    return { sequence: metadata.sequence, filename: file.filename, nodeName, action, submittedAt: file.submittedAt };
  }));
  return requests.sort((a, b) => a.sequence - b.sequence);
}

const tools = [
  {
    name: 'codenode_list_markdown_requests',
    description: 'List Markdown build requests submitted by the CodeNode canvas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'codenode_read_latest_markdown',
    description: 'Read the latest Markdown build request from the CodeNode canvas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'codenode_read_markdown',
    description: 'Read a CodeNode Markdown build request by filename.',
    inputSchema: { type: 'object', properties: { filename: { type: 'string', description: 'Inbox .md filename.' } }, required: ['filename'], additionalProperties: false }
  },
  {
    name: 'codenode_mark_processed',
    description: 'Move a completed Markdown request out of the inbox and save a result summary.',
    inputSchema: { type: 'object', properties: { filename: { type: 'string' }, summary: { type: 'string' } }, required: ['filename', 'summary'], additionalProperties: false }
  }
];

function toolText(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function callTool(name, args = {}) {
  if (name === 'codenode_list_markdown_requests') return toolText(await markdownFiles());
  if (name === 'codenode_read_latest_markdown') {
    const [latest] = await markdownFiles();
    if (!latest) return { ...toolText('No CodeNode Markdown requests are waiting.'), isError: true };
    return toolText(await readMarkdown(latest.filename));
  }
  if (name === 'codenode_read_markdown') return toolText(await readMarkdown(args.filename));
  if (name === 'codenode_mark_processed') {
    const request = await readMarkdown(args.filename);
    const destination = path.join(processedDir, request.filename);
    await fs.rename(path.join(inboxDir, request.filename), destination);
    try {
      await fs.rename(queueMetadataPath(request.filename), queueMetadataPath(request.filename, processedDir));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.writeFile(`${destination}.result.json`, JSON.stringify({ summary: String(args.summary), processedAt: new Date().toISOString() }, null, 2), 'utf8');
    return toolText({ filename: request.filename, status: 'processed' });
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: serverName, version: serverVersion }, instructions: 'CodeNode receives Markdown build requests from its local canvas. When the user asks to process the latest CodeNode request, call codenode_read_latest_markdown, route by its language field to exactly one language skill, respect requiresConfirmation before writes or execution, then call codenode_mark_processed after completion.' } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
  if (method === 'tools/call') return { jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments) };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    const response = await handleMcp(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const id = message?.id ?? null;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } })}\n`);
  }
});

function corsHeaders(origin) {
  if (origin && origin !== 'null') return null;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-CodeNode-Bridge',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cache-Control': 'no-store'
  };
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const httpServer = http.createServer((request, response) => {
  const headers = corsHeaders(request.headers.origin);
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (!headers) return sendJson(response, 403, { error: 'origin not allowed' });
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    return response.end();
  }
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(response, 200, {
      status: 'ok',
      server: serverName,
      delivery: 'mcp-queue',
      canInjectCodexConversation: false
    }, headers);
  }
  if (request.method === 'GET' && requestUrl.pathname === '/markdown') {
    markdownQueue()
      .then(requests => sendJson(response, 200, { requests }, headers))
      .catch(error => sendJson(response, 500, { error: error.message }, headers));
    return;
  }
  if (request.method === 'DELETE' && requestUrl.pathname === '/markdown') {
    if (request.headers['x-codenode-bridge'] !== '1') return sendJson(response, 403, { error: 'missing bridge header' }, headers);
    deleteMarkdown(requestUrl.searchParams.get('filename'))
      .then(result => sendJson(response, 200, result, headers))
      .catch(error => sendJson(response, error.code === 'ENOENT' ? 404 : 400, { error: error.message }, headers));
    return;
  }
  if (request.method !== 'POST' || requestUrl.pathname !== '/markdown') return sendJson(response, 404, { error: 'not found' }, headers);
  if (request.headers['x-codenode-bridge'] !== '1') return sendJson(response, 403, { error: 'missing bridge header' }, headers);
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxMarkdownBytes) request.destroy();
  });
  request.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const filename = safeMarkdownName(payload.filename);
      const content = String(payload.content || '');
      if (!content.trim()) throw new Error('content is required');
      if (Buffer.byteLength(content, 'utf8') > maxMarkdownBytes) throw new Error('Markdown file is too large');
      await fs.writeFile(path.join(inboxDir, filename), content, { encoding: 'utf8', flag: 'wx' });
      const sequence = ++queueSequence;
      try {
        await fs.writeFile(queueMetadataPath(filename), JSON.stringify({ sequence }), { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        await fs.rm(path.join(inboxDir, filename), { force: true });
        throw error;
      }
      sendJson(response, 201, {
        filename,
        sequence,
        status: 'queued',
        delivery: 'mcp-queue',
        requiresUserTurn: true,
        nextPrompt: '处理最新 CodeNode 请求'
      }, headers);
    } catch (error) {
      const status = error.code === 'EEXIST' ? 409 : 400;
      sendJson(response, status, { error: error.code === 'EEXIST' ? 'request already exists' : error.message }, headers);
    }
  });
});

httpServer.on('error', error => {
  process.stderr.write(`CodeNode HTTP bridge unavailable: ${error.message}\n`);
});
httpServer.listen(httpPort, '127.0.0.1', () => {
  const address = httpServer.address();
  process.stderr.write(`CodeNode HTTP bridge listening on 127.0.0.1:${address.port}\n`);
});
