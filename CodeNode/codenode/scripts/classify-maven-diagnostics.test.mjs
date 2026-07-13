import test from 'node:test';
import assert from 'node:assert/strict';

const classify = output => {
  const rules = [
    { category: 'dependency-resolution', scope: 'project', patterns: [/Could not resolve dependencies/i, /Could not find artifact/i, /Failed to read artifact descriptor/i, /Non-resolvable parent POM/i] },
    { category: 'plugin-resolution', scope: 'project', patterns: [/No plugin found for prefix/i, /Plugin .* could not be resolved/i] }
  ];
  return rules.filter(rule => rule.patterns.some(pattern => pattern.test(output))).map(({ category, scope }) => ({ category, scope }));
};

test('classifies Maven dependency failures as project diagnostics', () => {
  assert.deepEqual(classify('[ERROR] Could not resolve dependencies for project demo:app:jar:1.0'), [{ category: 'dependency-resolution', scope: 'project' }]);
});

test('classifies plugin resolution failures as project diagnostics', () => {
  assert.deepEqual(classify('[ERROR] No plugin found for prefix wrapper'), [{ category: 'plugin-resolution', scope: 'project' }]);
});
