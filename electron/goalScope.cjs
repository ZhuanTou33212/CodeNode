'use strict';

function normalize(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function violations(files, writeScope) {
  const scope = Array.isArray(writeScope) ? writeScope.map(normalize).filter(Boolean) : [];
  if (!scope.length) return [];
  return (Array.isArray(files) ? files : []).filter(file => {
    const candidate = normalize(file?.path);
    return !scope.some(allowed => allowed === '.' || candidate === allowed || candidate.startsWith(allowed + '/'));
  }).map(file => normalize(file.path));
}

module.exports = { normalize, violations };
