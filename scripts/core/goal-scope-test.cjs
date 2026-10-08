'use strict';
const assert = require('node:assert/strict');
const scope = require('../../electron/goalScope.cjs');
assert.deepEqual(scope.violations([{ path: 'src/a.ts' }, { path: 'src/nested/b.ts' }], ['src']), []);
assert.deepEqual(scope.violations([{ path: 'src2/a.ts' }, { path: 'README.md' }], ['src']), ['src2/a.ts', 'README.md']);
assert.deepEqual(scope.violations([{ path: 'src/a.ts' }], ['src\\']), []);
assert.deepEqual(scope.violations([{ path: 'README.md' }], []), [], 'an undeclared scope does not claim enforcement');
assert.deepEqual(scope.violations([{ path: 'anything' }], ['.']), [], 'project root explicitly permits all project paths');
console.log('GOAL SCOPE: PASS (directory boundary matching, slash normalization, explicit root, and empty-scope behavior)');
