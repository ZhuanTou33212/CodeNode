'use strict';
const pathApi = require('node:path');
const normalize = (path) => {
  const value = pathApi.posix.normalize(String(path || '').replace(/\\/g, '/').replace(/^\.\//, ''));
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
function sourcePath(source) {
  if (String(source?.citation || '').startsWith('scalar:')) return null;
  const parsed = require('./citations.cjs').parseCitation(source?.citation);
  return normalize(source?.path || (parsed.kind === 'range' ? parsed.path : ''));
}
function currentEvidenceCalls(toolCalls) {
  let calls = [];
  let hadEvidence = false;
  const versions = new Map();
  const invalidate = (paths, scalar = false, all = false) => {
    calls = calls.flatMap((call) => {
      if (call.name === 'read_file' && (all || paths.has(normalize(call.data?.path || call.data?.matched)))) return [];
      if (call.name === 'query_scalars' && scalar) return [];
      if (call.name === 'retrieve_context' && Array.isArray(call.data?.sources)) return [{ ...call,
        data: { ...call.data, sources: call.data.sources.filter((source) => {
          if (String(source?.citation || '').startsWith('scalar:')) return !scalar;
          return !all && !paths.has(sourcePath(source));
        }) } }];
      if (call.name === 'search_files' && Array.isArray(call.data?.matches)) return [{ ...call,
        data: { ...call.data, matches: call.data.matches.filter((line) => {
          const match = /^(.*?):\d+:/.exec(String(line));
          return !all && (!match || !paths.has(normalize(match[1])));
        }) } }];
      return [call];
    });
  };
  for (const call of toolCalls || []) {
    if (!call) continue;
    let args = call.args || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (['write_file', 'edit_file', 'rename_file', 'delete_file', 'apply_patch', 'write_analysis_md'].includes(call.name) && call.data?.executed !== false) {
      const rawPaths = [call.data?.path, call.data?.from, call.data?.to, args.path, args.from, args.to, args.oldPath, args.newPath].filter(Boolean);
      const paths = new Set(rawPaths.map(normalize));
      const unresolved = !call.data?.path && rawPaths.some((path) => /^[A-Za-z]:[\\/]|^\//.test(String(path)) || String(path).replace(/\\/g, '/').startsWith('../'));
      invalidate(paths, false, !paths.size || unresolved);
    } else if (['execute_shell', 'run_project', 'run_workflow', 'delegate_task', 'delegate_tasks', 'subagent', 'poll_job', 'bulk_edit'].includes(call.name) && call.data?.executed !== false) {
      invalidate(new Set(), true, true);
    } else if (['workbench_edit', 'save_project', 'get_workbench_model'].includes(call.name) && call.ok !== false) {
      invalidate(new Set(), true);
    }
    if (call.ok !== false && call.name === 'read_file' && call.data?.sourceSha256) {
      const path = normalize(call.data.path);
      const version = String(call.data.sourceSha256).replace(/^sha256:/, '');
      if (!versions.has(path) || versions.get(path) !== version) invalidate(new Set([path]));
      versions.set(path, version);
    }
    if (call.ok !== false && call.name === 'retrieve_context') {
      for (const source of call.data?.sources || []) {
        if (!source?.sourceSha256 || !sourcePath(source)) continue;
        const path = sourcePath(source), version = String(source.sourceSha256).replace(/^sha256:/, '');
        if (!versions.has(path) || versions.get(path) !== version) invalidate(new Set([path]));
        versions.set(path, version);
      }
    }
    if (call.ok !== false) {
      const scalarKeys = new Set(call.name === 'query_scalars' ? (call.data?.items || []).map((item) => item.key).filter(Boolean) :
        call.name === 'retrieve_context' ? (call.data?.sources || []).map((source) => /^scalar:(.+)$/.exec(String(source?.citation || ''))?.[1]).filter(Boolean) : []);
      if (scalarKeys.size) calls = calls.map((previous) => {
        if (previous.name === 'query_scalars') return { ...previous, data: { ...previous.data,
          items: (previous.data?.items || []).filter((item) => !scalarKeys.has(item.key)) } };
        if (previous.name === 'retrieve_context') return { ...previous, data: { ...previous.data,
          sources: (previous.data?.sources || []).filter((source) => !scalarKeys.has(/^scalar:(.+)$/.exec(String(source?.citation || ''))?.[1])) } };
        return previous;
      });
    }
    if (call.ok !== false && (['read_file', 'search_files', 'query_scalars'].includes(call.name) || call.data?.sources?.length)) hadEvidence = true;
    calls.push(call);
  }
  return { calls, hadEvidence };
}
module.exports = { currentEvidenceCalls };
