'use strict';
const { buildEvidence } = require('./faithfulness.cjs');
const { runInWorker } = require('../tools/fsRunner.cjs');
async function checkLiveVersions(root, answer, calls, signal) {
  const sources = buildEvidence(calls, answer);
  const expected = new Map();
  const unversioned = new Set();
  for (const source of sources) {
    const range = require('./citations.cjs').parseCitation(source.citation);
    if (range.kind !== 'range') continue;
    if (!/^sha256:[a-f0-9]{64}$/i.test(source.version || '')) unversioned.add(range.path);
    else {
      const previous = expected.get(range.path);
      if (previous && previous !== source.version) unversioned.add(range.path);
      expected.set(range.path, source.version);
    }
  }
  if (!expected.size && !unversioned.size) return { status: 'not_required', stalePaths: [], unknownPaths: [], checkedAt: new Date().toISOString() };
  if (expected.size + unversioned.size > 32) return { status: 'unknown', stalePaths: [], unknownPaths: [...expected.keys(), ...unversioned], reason: '文件数量超过版本核验预算' };
  const result = expected.size ? await runInWorker('fileVersions', { root, files: [...expected.keys()] }, { signal, timeoutMs: 10000 }) : null;
  const stalePaths = [], unknownPaths = [...unversioned];
  for (const [path, sha256] of expected) {
    const actual = result?.result?.versions?.[path];
    if (!result?.ok || actual?.error || !actual?.sha256) unknownPaths.push(path);
    else if (actual.sha256 !== sha256) stalePaths.push(path);
  }
  return { status: stalePaths.length ? 'stale' : unknownPaths.length ? 'unknown' : 'verified',
    stalePaths, unknownPaths: [...new Set(unknownPaths)], checkedAt: new Date().toISOString(),
    cancelled: result?.cancelled || false };
}
module.exports = { checkLiveVersions };
