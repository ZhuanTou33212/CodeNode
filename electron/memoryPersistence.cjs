'use strict';

async function persistCandidates(candidates, options = {}) {
  const registry = options.registry || null;
  const context = options.context || null;
  const signal = options.signal || null;
  const results = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (signal && signal.aborted) break;
    if (!candidate || !['project', 'user'].includes(candidate.scope)) {
      results.push({ key: candidate && candidate.key || '', status: 'ambiguous' });
      continue;
    }
    if (!registry || !context || !registry.contains('remember') || !registry.isExposed('remember')) {
      results.push({ key: candidate.key, status: 'unavailable' });
      continue;
    }
    try {
      const saved = await registry.execute('remember', {
        content: candidate.content || candidate.key + ' = ' + candidate.value,
        key: candidate.key, kind: candidate.kind, value: candidate.value, scope: candidate.scope,
      }, context);
      results.push({ key: candidate.key, status: saved && saved.ok ? 'saved' : 'not_saved' });
    } catch {
      results.push({ key: candidate.key, status: 'not_saved' });
    }
  }
  return results;
}

module.exports = { persistCandidates };
