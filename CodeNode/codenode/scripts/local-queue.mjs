import fs from 'node:fs';
import path from 'node:path';
import { validateRequest } from '../mcp/request-codec.mjs';

const [command, projectArg, requestArg, resultArg] = process.argv.slice(2);

function fail(message) { throw new Error(`CodeNode local queue: ${message}`); }
function requestId(value) {
  if (!/^request-[A-Za-z0-9_.-]+$/.test(value || '')) fail('invalid request id');
  return value;
}
function state(project) {
  const root = path.resolve(project || '.');
  const stateRoot = path.join(root, '.codenode');
  if (!fs.existsSync(path.join(stateRoot, 'project.json'))) fail(`project is not initialized: ${root}`);
  return { root, stateRoot };
}
function newest(inbox) {
  const entries = fs.readdirSync(inbox, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^request-/.test(entry.name)).map(entry => entry.name).sort().reverse();
  if (!entries.length) fail('inbox is empty');
  return entries[0];
}
function readValidated(file) {
  const request = validateRequest(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (request.transport && request.transport !== 'local-file-queue') fail('unsupported transport');
  return request;
}

function claim(project, wanted) {
  const { stateRoot } = state(project); const inbox = path.join(stateRoot, 'queue', 'inbox');
  const id = requestId(wanted === 'latest' || !wanted ? newest(inbox) : wanted);
  const source = path.join(inbox, id); const target = path.join(stateRoot, 'queue', 'processing', id);
  const request = readValidated(path.join(source, 'request.json'));
  try { fs.renameSync(source, target); } catch (error) { fail(`cannot claim ${id}; it may already be processing (${error.message})`); }
  process.stdout.write(`${JSON.stringify({ request, processingDirectory: target }, null, 2)}\n`);
}

function complete(project, wanted, draftArg) {
  const { stateRoot } = state(project); const id = requestId(wanted);
  const processing = path.join(stateRoot, 'queue', 'processing', id); readValidated(path.join(processing, 'request.json'));
  const draft = path.resolve(draftArg || path.join(processing, 'result.draft.json'));
  const result = JSON.parse(fs.readFileSync(draft, 'utf8'));
  if (result.schemaVersion !== '3.0' || result.requestId !== id) fail('result schemaVersion/requestId mismatch');
  if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) fail('terminal result status is required');
  if (!Array.isArray(result.diagnostics) || !Array.isArray(result.nodeResults)) fail('result requires diagnostics and nodeResults arrays');
  const resultDir = path.join(stateRoot, 'results', id); fs.mkdirSync(resultDir, { recursive: true });
  const temporary = path.join(resultDir, 'result.json.tmp'); const final = path.join(resultDir, 'result.json');
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, final);
  const bucket = result.status === 'succeeded' ? 'completed' : 'failed'; fs.renameSync(processing, path.join(stateRoot, 'queue', bucket, id));
  process.stdout.write(`${JSON.stringify({ requestId: id, status: result.status, result: final })}\n`);
}

try {
  if (command === 'claim') claim(projectArg, requestArg);
  else if (command === 'complete') complete(projectArg, requestArg, resultArg);
  else fail('usage: local-queue.mjs claim <projectRoot> <requestId|latest> | complete <projectRoot> <requestId> [resultDraft]');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
