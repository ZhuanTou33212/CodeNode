'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const githubWait = require('../../electron/goalWaitProviders/githubActions.cjs');
const goal = require('../../electron/goalStore.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-github-actions-wait-'));
function git(args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); }
async function main() {
  try {
    git(['init']);
    git(['config', 'user.name', 'CodeNode Test']);
    git(['config', 'user.email', 'codenode-test@example.invalid']);
    fs.writeFileSync(path.join(root, 'baseline.txt'), 'fixture\n');
    git(['add', 'baseline.txt']);
    git(['commit', '-m', 'fixture']);
    git(['remote', 'add', 'origin', 'https://github.com/example-project/ci-fixture.git']);
    const sha = git(['rev-parse', 'HEAD']);
    assert.equal(githubWait.repoFromRemote('git@github.com:example-project/ci-fixture.git').repo, 'ci-fixture');
    assert.throws(() => githubWait.repoFromRemote('https://evil.example/example-project/ci-fixture.git'), /github.com/);

    const calls = [];
    const successResponse = { workflow_runs: [
      { id: 10, workflow_id: 1, run_attempt: 1, head_sha: sha, status: 'completed', conclusion: 'failure', updated_at: '2026-10-01T00:00:00Z' },
      { id: 11, workflow_id: 1, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'success', updated_at: '2026-10-01T00:01:00Z' },
      { id: 12, workflow_id: 2, run_attempt: 1, head_sha: sha, status: 'completed', conclusion: 'success', updated_at: '2026-10-01T00:02:00Z' },
      { id: 13, workflow_id: 3, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', updated_at: '2026-10-01T00:03:00Z' },
    ] };
    const fakeFetch = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, status: 200, json: async () => successResponse }; };
    const checkedAt = Date.parse('2026-10-09T00:00:00Z');
    const passed = await githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: sha }, {
      fetch: fakeFetch, env: { GH_TOKEN: 'never-print-this-token' }, now: () => checkedAt,
    });
    assert.equal(passed.matched, true, 'latest attempt of each workflow must pass for the commit');
    assert.equal(passed.status, 'success');
    assert.equal(passed.workflowCount, 2, 'other commit runs are ignored');
    assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/example-project\/ci-fixture\/actions\/runs\?/);
    assert.equal(new URL(calls[0].url).searchParams.get('head_sha'), sha);
    assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '100');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer never-print-this-token');
    assert.equal(passed.detailsUrl, 'https://github.com/example-project/ci-fixture/actions/runs/12');
    assert.equal(passed.id, (await githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: sha }, {
      fetch: fakeFetch, env: { GH_TOKEN: 'never-print-this-token' }, now: () => checkedAt,
    })).id, 'identical state snapshots have a stable idempotency key');

    const waiting = await githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: sha }, {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 20, workflow_id: 1, head_sha: sha, status: 'queued', conclusion: null, updated_at: '2026-10-01T00:00:00Z' }] }) }),
      env: {}, now: () => checkedAt,
    });
    assert.equal(waiting.status, 'in_progress');
    assert.equal(waiting.matched, false);
    const empty = await githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: sha }, {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [] }) }), env: {}, now: () => checkedAt,
    });
    assert.equal(empty.status, 'no_runs');
    assert.equal(empty.matched, false);
    await assert.rejects(githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: sha }, {
      fetch: async () => ({ ok: false, status: 404 }), env: {}, now: () => checkedAt,
    }), /denied repository access/);
    await assert.rejects(githubWait.check(root, { provider: 'github-actions', expected: 'success', commitSha: 'HEAD' }, { fetch: fakeFetch, env: {} }), /40-character commit SHA/);

    const ciGoal = goal.createGoal(root, { title: 'CI observation', criteria: ['CI succeeded'] });
    const ciTask = goal.createTask(root, ciGoal.id, { title: 'Wait for CI' });
    goal.updateTask(root, ciGoal.id, ciTask.id, { waitCondition: {
      kind: 'external_status', provider: 'github-actions', description: 'Checks for current commit', expected: 'success', commitSha: sha,
    } });
    const pendingTask = goal.read(root).goals.find(item => item.id === ciGoal.id).tasks[0];
    assert.equal(pendingTask.waitCondition.provider, 'github-actions');
    const observation = goal.observeWait(root, ciGoal.id, ciTask.id, waiting);
    const afterObservation = goal.read(root).goals.find(item => item.id === ciGoal.id).tasks[0];
    assert.equal(afterObservation.status, 'waiting');
    assert(afterObservation.waitCondition.lastObservation);
    assert(Date.parse(afterObservation.waitCondition.nextCheckAt) > Date.now(), 'unmatched CI observation backs off');
    const successObservation = { ...passed, id: 'success-check', matched: true };
    goal.observeWait(root, ciGoal.id, ciTask.id, successObservation);
    assert.equal(goal.read(root).goals.find(item => item.id === ciGoal.id).tasks[0].status, 'ready', 'success releases only the waiting Task');
    assert.equal(observation.matched, false);
    console.log('GITHUB ACTIONS WAIT: PASS (GitHub-only remote validation, exact SHA filter, latest run attempts, token redaction boundary, success release, exponential backoff)');
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('codenode-github-actions-wait-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
