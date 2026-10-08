'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function git(root, args, exec = execFileSync) {
  const workingDirectory = fs.realpathSync(path.resolve(root));
  // Scope Git's trust exception to these read-only metadata calls; never mutate
  // the user's global safe.directory configuration.
  return exec('git', ['-c', 'safe.directory=' + workingDirectory, ...args], {
    cwd: workingDirectory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  });
}

function repoFromRemote(value) {
  const remote = String(value || '').trim();
  let owner, repo;
  if (remote.startsWith('git@github.com:')) {
    const match = remote.slice('git@github.com:'.length).match(/^([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (!match) throw new Error('GitHub Actions wait requires an origin remote in owner/repo form');
    [, owner, repo] = match;
  } else {
    let url;
    try { url = new URL(remote); } catch { throw new Error('GitHub Actions wait requires a valid GitHub origin remote'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('GitHub Actions wait supports github.com repositories only');
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2) throw new Error('GitHub origin must identify exactly one owner/repository');
    [owner, repo] = parts;
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new Error('GitHub owner or repository name is invalid');
  }
  return { owner, repo };
}

function repository(root, exec = execFileSync) {
  let remote;
  try { remote = git(root, ['config', '--local', '--get', 'remote.origin.url'], exec).trim(); }
  catch { throw new Error('GitHub Actions wait requires a GitHub origin remote'); }
  return repoFromRemote(remote);
}

function commitFor(root, condition, exec = execFileSync) {
  const requested = String(condition?.commitSha || '').trim();
  if (requested && !/^[0-9a-f]{40}$/i.test(requested)) throw new Error('GitHub Actions wait requires a full 40-character commit SHA');
  if (requested) return requested.toLowerCase();
  try {
    const sha = git(root, ['rev-parse', 'HEAD'], exec).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('HEAD is not a full commit SHA');
    return sha.toLowerCase();
  } catch { throw new Error('GitHub Actions wait could not resolve the current commit SHA'); }
}

function latestRunsForWorkflows(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = String(run.workflow_id || run.path || run.name || run.id || 'unknown');
    const previous = latest.get(key);
    const attempt = Number(run.run_attempt) || 1;
    const previousAttempt = Number(previous?.run_attempt) || 1;
    const updated = Date.parse(run.updated_at || run.created_at || '') || 0;
    const previousUpdated = Date.parse(previous?.updated_at || previous?.created_at || '') || 0;
    if (!previous || attempt > previousAttempt || (attempt === previousAttempt && updated > previousUpdated)) latest.set(key, run);
  }
  return [...latest.values()];
}

async function check(root, condition, deps = {}) {
  if (condition?.provider !== 'github-actions') throw new Error('Task wait provider is not GitHub Actions');
  if (String(condition.expected || 'success').toLowerCase() !== 'success') throw new Error('GitHub Actions wait currently supports expected=success only');
  const exec = deps.execFileSync || execFileSync;
  const repo = repository(root, exec);
  const sha = commitFor(root, condition, exec);
  const apiUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/runs`);
  apiUrl.searchParams.set('head_sha', sha);
  apiUrl.searchParams.set('per_page', '100');
  const env = deps.env || process.env;
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CodeNode' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const fetcher = deps.fetch || globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('GitHub Actions wait requires fetch');
  const response = await fetcher(apiUrl, { method: 'GET', headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    const status = Number(response.status) || 0;
    throw new Error(status === 404 || status === 403
      ? 'GitHub Actions API denied repository access; check repository visibility or GH_TOKEN/GITHUB_TOKEN read access'
      : 'GitHub Actions API returned HTTP ' + status);
  }
  const payload = await response.json();
  const exactRuns = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs.filter(run => String(run.head_sha || '').toLowerCase() === sha) : [];
  const runs = latestRunsForWorkflows(exactRuns);
  const matched = runs.length > 0 && runs.every(run => run.status === 'completed' && run.conclusion === 'success');
  const pending = runs.some(run => run.status !== 'completed');
  const status = !runs.length ? 'no_runs' : matched ? 'success' : pending ? 'in_progress' : 'completed_' + String(runs.find(run => run.conclusion !== 'success')?.conclusion || 'unknown');
  const sorted = runs.map(run => [run.workflow_id || run.path || run.name || 'unknown', run.id, run.run_attempt || 1, run.updated_at || run.created_at || '', run.status || '', run.conclusion || ''].join(':')).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24);
  const minute = Math.floor((deps.now ? deps.now() : Date.now()) / 60000);
  const id = `github-actions:${sha}:${fingerprint}:${minute}`;
  const latest = runs.slice().sort((a,b)=>(Date.parse(b.updated_at||b.created_at||'')||0)-(Date.parse(a.updated_at||a.created_at||'')||0))[0];
  const runId = latest && latest.id != null ? String(latest.id) : null;
  const detailsUrl = runId ? `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${encodeURIComponent(runId)}` : null;
  return {
    id,
    source: 'github-actions',
    status,
    matched,
    revision: sha,
    runId,
    detailsUrl,
    checkedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
    workflowCount: runs.length,
  };
}

module.exports = { check, repoFromRemote, repository, commitFor, latestRunsForWorkflows };
