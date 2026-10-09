'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const config = require('../../config/agent.backends.json');
const {createBackend}=require('../../electron/backends/index.cjs');
const { resolveCommand } = require('../../electron/backends/stdioRpc.cjs');
const { redact } = require('../../electron/redaction.cjs');

const PREFIX = 'codenode-openclaw-live-';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a loopback port')); return; }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function childSpec(executable, args) {
  const resolved = resolveCommand(executable);
  return { command: resolved.command, args: [...resolved.prefix, ...args] };
}

/** @returns {NodeJS.ProcessEnv} */
function isolatedEnv(home, state, configPath, workspace, token) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^OPENCLAW_/i.test(key) || /(?:API_KEY|_TOKEN|_PASSWORD)$/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: workspace,
    OPENCLAW_GATEWAY_TOKEN: token,
    NO_COLOR: '1',
  });
  return env;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
  if (child.exitCode === null && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  }
}

function removeTemp(root) {
  const resolved = path.resolve(root);
  const temp = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith(PREFIX)) throw new Error('Refusing to clean unexpected OpenClaw path: ' + resolved);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function main() {
  const executable = String(process.env.CODENODE_OPENCLAW_BIN || config.commands.openclaw).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  let gateway;
  let stderr = '';
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const configPath = path.join(root, 'openclaw.json');
  const token = require('node:crypto').randomBytes(32).toString('hex');
  for (const dir of [home, state, workspace]) fs.mkdirSync(dir, { recursive: true });

  try {
    const version = execFileSync(childSpec(executable, ['--version']).command,
      childSpec(executable, ['--version']).args, { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    const port = await freePort();
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token' } },
      agents: { defaults: { model: { primary: 'openai/gpt-4o-mini' } } },
    }, null, 2) + '\n');
    const env = isolatedEnv(home, state, configPath, workspace, token);
    const gatewaySpec = childSpec(executable, ['gateway', 'run', '--allow-unconfigured', '--port', String(port), '--bind', 'loopback']);
    gateway = spawn(gatewaySpec.command, gatewaySpec.args, {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    gateway.stdout?.on('data', () => {});
    gateway.stderr?.on('data', chunk => { stderr = String(redact(stderr + String(chunk))).slice(-5000); });

    let ready = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (gateway.exitCode !== null) throw new Error('OpenClaw Gateway exited before health check: ' + stderr);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await sleep(200);
    }
    assert.equal(ready, true, 'isolated Gateway health endpoint responds');

    const backend = createBackend('openclaw',{
      ...config.defaults,
      backend: 'openclaw',
      executable,
      args: ['acp', '--url', `ws://127.0.0.1:${port}`],
      sandbox: 'workspace-write',
    }, { env });
    const controller = new AbortController();
    let sessionCreated = false;
    const before = fs.readdirSync(workspace);
    const result = await backend.submit({
      projectRoot: workspace,
      prompt: 'This prompt must not be sent.',
      history: [], canvasSummary: '', signal: controller.signal,
      onSession: session => { sessionCreated = !!session?.sessionId; controller.abort(); },
      onDelta: () => {}, confirm: async () => false,
    });
    const summary = {
      version, gateway: 'temporary loopback', sessionCreated, promptSent: false,
      state: result.state, stopReason: result.stopReason || null,
      toolCalls: (result.toolCalls || []).length,
      workspaceUnchanged: JSON.stringify(fs.readdirSync(workspace)) === JSON.stringify(before),
      ...(result.error ? { error: String(redact(result.error)).slice(0, 400) } : {}),
      ...(result.backendErrorMethod ? { backendErrorMethod: result.backendErrorMethod } : {}),
      ...(result.backendErrorCode != null ? { backendErrorCode: result.backendErrorCode } : {}),
      ...(result.backendErrorDetails != null ? { backendErrorDetails: redact(result.backendErrorDetails) } : {}),
      ...(result.backendStderr ? { backendStderr: String(redact(result.backendStderr)).slice(-1200) } : {}),
    };
    console.log(JSON.stringify(summary));
    assert.equal(summary.sessionCreated, true);
    assert.equal(summary.state, 'CANCELLED');
    assert.equal(summary.toolCalls, 0);
    assert.equal(summary.workspaceUnchanged, true);
    console.log('OPENCLAW ACP LIVE SMOKE: PASS (isolated Gateway, session/new, no model prompt)');
  } catch (error) {
    console.error(String(redact(error?.stack || error)));
    process.exitCode = 1;
  } finally {
    await stopProcess(gateway);
    removeTemp(root);
  }
}

main().catch(error => { console.error(String(redact(error?.stack || error))); process.exitCode = 1; });
