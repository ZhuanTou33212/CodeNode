'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../config/agent.backends.json');
const {createBackend}=require('../../electron/backends/index.cjs');
const { redact } = require('../../electron/redaction.cjs');

function snapshot(root) {
  const output = [];
  const walk = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) { output.push([path.relative(root, file), 'symlink']); continue; }
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) output.push([path.relative(root, file), fs.readFileSync(file)]);
    }
  };
  walk(root);
  return JSON.stringify(output.map(([name, value]) => [name, Buffer.isBuffer(value) ? value.toString('base64') : value]).sort((a,b)=>a[0].localeCompare(b[0])));
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('需要通过 DEEPSEEK_API_KEY 提供 DeepSeek Harness 凭据；不会读取或打印凭据文件');
  const executable = String(process.env.CODENODE_DSH_BIN || config.commands['deepseek-harness']).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-deepseek-live-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, DSH_HOME: home };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const backend = createBackend('deepseek-harness',{
      backend: 'deepseek-harness', executable, args: ['--profile', 'acp'], home,
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    }, { env });
    const capabilities = await backend.health({projectRoot:workspace});
    if (!capabilities.available) throw new Error(capabilities.error || 'DeepSeek Harness ACP initialize 失败');
    const before = snapshot(workspace);
    const startedAt = Date.now();
    const result = await backend.submit({ projectRoot: workspace,
      prompt: 'Reply with exactly DSH_REAL_TEXT_SMOKE_OK. Do not call tools and do not edit files.',
      history: [], canvasSummary: '', signal: controller.signal, onDelta: () => {}, confirm: async () => false });
    const summary = {
      backend: 'deepseek-harness', protocol: capabilities.protocol, version: capabilities.version,
      state: result.state, stopReason: result.stopReason || null,
      sentinel: String(result.content || '').includes('DSH_REAL_TEXT_SMOKE_OK'),
      toolCalls: (result.toolCalls || []).length, usageReported: !!result.usage,
      workspaceUnchanged: snapshot(workspace) === before, latencyMs: Date.now() - startedAt,
      ...(result.error ? { error: String(redact(result.error)).slice(0, 400) } : {}),
    };
    console.log(JSON.stringify(summary));
    if (summary.state !== 'COMPLETED' || !summary.sentinel || summary.toolCalls !== 0 || !summary.workspaceUnchanged) process.exitCode = 1;
  } catch (error) {
    console.error(String(redact(error?.stack || error)));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-deepseek-live-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

main().catch(error => { console.error(String(redact(error?.stack || error))); process.exitCode = 1; });
