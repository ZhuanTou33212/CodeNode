'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../../config/agent.backends.json');
const agent = require('../../electron/agent.cjs');
const sandbox = require('../../electron/sandbox.cjs');
const runStore = require('../../electron/runStore.cjs');
const { runExternal } = require('../../electron/backends/runExternal.cjs');
const { resolveCommand } = require('../../electron/backends/stdioRpc.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-agent-lifecycle-'));
  const sessions = new Set();
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: { bash: 'ask' },
  }, null, 2) + '\n');
  const cfg = agent.loadConfig(root);
  const userDataDir = path.join(root, '.userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const sandboxPolicy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir });
  const settings = {
    ...config.defaults,
    backend: 'opencode',
    executable: config.commands.opencode,
    args: config.defaultArgs.opencode,
    sandbox: 'workspace-write',
    turnTimeoutMs: 90000,
  };
  const permission = { approved: 0, denied: 0 };
  const confirm = async () => { permission.denied++; return false; };
  const execute = (input) => runExternal({
    projectRoot: root,
    requestId: 'acp-lifecycle-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    history: [], canvasSummary: '', settings, cfg, sandboxPolicy,
    onDelta: input.onDelta || (() => {}), confirm, ...input,
  });
  const recordSession = runId => {
    const event = runStore.readRun(root, runId).find(item => item.type === 'backend_session');
    if (event?.sessionId) sessions.add(event.sessionId);
    return event || null;
  };
  let permissionResult;
  let cancelledResult;
  let resumedResult;
  let cancelledOnChunk = false;
  let cleanupOk = true;

  try {
    const nonce = Date.now().toString(36);
    permissionResult = await execute({
      prompt: `Use your bash tool exactly once to run this harmless command: node -e "process.stdout.write('ACP_PERMISSION_${nonce}')". Do not use another tool. If CodeNode rejects permission, reply exactly ACP_PERMISSION_DENIED.`,
    });
    recordSession(permissionResult.runId);

    const controller = new AbortController();
    const fallbackCancel = setTimeout(() => controller.abort(), 25000);
    try {
      cancelledResult = await execute({
        signal: controller.signal,
        prompt: 'Write a very long explanation of how to design a robust local software test harness. Produce at least 3000 words, using detailed numbered sections. Do not use any tools.',
        onDelta: delta => {
          if (delta.kind === 'content' && !controller.signal.aborted) {
            cancelledOnChunk = true;
            controller.abort();
          }
        },
      });
    } finally { clearTimeout(fallbackCancel); }
    const cancelledSession = recordSession(cancelledResult.runId);

    if (cancelledResult.state === 'CANCELLED' && cancelledSession?.sessionId) {
      const resumePrompt = 'Continue in this existing session and reply with exactly ACP_RESUME_OK. Do not use tools.';
      resumedResult = await execute({ resumeRunId: cancelledResult.runId, resumeForce: true, prompt: resumePrompt });
      recordSession(resumedResult.runId);
    }

    const permissionSummary = {
      state: permissionResult?.state || 'FAILED',
      deniedRequests: permission.denied,
      toolCalls: (permissionResult?.toolCalls || []).map(call => ({ name: call.name, ok: call.ok })),
      changedFiles: permissionResult?.changes?.files?.map(file => file.path) || [],
    };
    const cancelSummary = {
      state: cancelledResult?.state || 'FAILED',
      cancelledOnFirstTextChunk: cancelledOnChunk,
      changedFiles: cancelledResult?.changes?.files?.map(file => file.path) || [],
    };
    const resumeSummary = {
      state: resumedResult?.state || 'NOT_RUN',
      sentinel: String(resumedResult?.reply || '').includes('ACP_RESUME_OK'),
      sameSession: !!cancelledSession?.sessionId && recordSession(resumedResult?.runId)?.sessionId === cancelledSession.sessionId,
    };
    const passed = permissionSummary.deniedRequests > 0 && permissionSummary.changedFiles.length === 0
      && cancelSummary.state === 'CANCELLED' && cancelSummary.cancelledOnFirstTextChunk
      && cancelSummary.changedFiles.length === 0 && resumeSummary.state === 'COMPLETED'
      && resumeSummary.sentinel && resumeSummary.sameSession;
    console.log(JSON.stringify({ permission: permissionSummary, cancellation: cancelSummary, resume: resumeSummary }));
    if (!passed) process.exitCode = 1;
  } finally {
    try {
      const resolvedRoot = path.resolve(root);
      const tempRoot = fs.realpathSync(os.tmpdir());
      if (path.dirname(resolvedRoot) === tempRoot && path.basename(resolvedRoot).startsWith('codenode-agent-lifecycle-')) {
        for (const sessionId of sessions) {
          try {
            const command = resolveCommand(config.commands.opencode);
            execFileSync(command.command, [...command.prefix, 'session', 'delete', sessionId], {
              cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: 'ignore',
            });
          } catch { cleanupOk = false; }
        }
        fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } else cleanupOk = false;
    } catch { cleanupOk = false; }
    if (!cleanupOk) {
      console.error('Could not remove all test-created OpenCode sessions or the isolated workspace.');
      process.exitCode = 1;
    }
  }
}

main().catch(error => { console.error(String(error?.stack || error)); process.exitCode = 1; });
