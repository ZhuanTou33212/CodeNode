import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(pluginRoot, '..', '..');
const codexEntry = process.env.CODENODE_CODEX_ENTRY
  || path.join(workspaceRoot, 'tools', 'codex-cli', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const schemaPath = path.join(pluginRoot, 'schemas', 'agent-canary-output.schema.json');
const outputDir = path.join(pluginRoot, '.cache', 'agent-live-canary');
const attempts = Number.parseInt(process.argv[2] || '20', 10);
const minimumSuccessRate = 0.9;

if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
  throw new Error('attempts must be an integer between 1 and 100');
}

await fs.access(codexEntry);
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

function runCodex(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [codexEntry, ...args], {
      cwd: pluginRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function validate(result, requestId, language) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result is not an object');
  if (result.requestId !== requestId) throw new Error('requestId mismatch');
  if (result.language !== language) throw new Error('language mismatch');
  if (typeof result.nodeName !== 'string' || !result.nodeName.trim()) throw new Error('nodeName is empty');
  if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('summary is empty');
  if (!Array.isArray(result.steps) || result.steps.length < 1 || result.steps.some(step => typeof step !== 'string' || !step.trim())) {
    throw new Error('steps must contain non-empty strings');
  }
}

const records = [];
for (let index = 1; index <= attempts; index += 1) {
  const requestId = `live-canary-${index}`;
  const language = ['java', 'powershell', 'go'][(index - 1) % 3];
  const outputPath = path.join(outputDir, `${requestId}.json`);
  const prompt = [
    'Return only the structured result required by the supplied JSON Schema.',
    `requestId must be exactly ${requestId}.`,
    `language must be exactly ${language}.`,
    'Describe a CodeNode node that creates a folder named CodeNodeCanary in a user-selected location.',
    'Do not run tools, edit files, or execute code. Provide a concise nodeName, summary, and implementation steps.'
  ].join(' ');
  const execution = await runCodex([
    'exec',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--output-schema', schemaPath,
    '--output-last-message', outputPath,
    '--color', 'never',
    prompt
  ]);
  try {
    if (execution.code !== 0) throw new Error(`Codex exited with ${execution.code}: ${execution.stderr.slice(-500)}`);
    const parsed = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    validate(parsed, requestId, language);
    records.push({ attempt: index, requestId, language, success: true });
  } catch (error) {
    records.push({ attempt: index, requestId, language, success: false, error: error.message });
  }
  process.stdout.write(`[${index}/${attempts}] ${records.at(-1).success ? 'PASS' : 'FAIL'} ${requestId}\n`);
}

const success = records.filter(record => record.success).length;
const summary = {
  source: 'codex-exec-live',
  attempts,
  success,
  failures: attempts - success,
  successRate: success / attempts,
  requiredSuccessRate: minimumSuccessRate,
  passed: success / attempts >= minimumSuccessRate,
  records
};
await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
