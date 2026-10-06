'use strict';

const crypto = require('crypto');

/** A bounded, honest before/after preview for a completed file write. */
function fileChangeReview(before, after, existed) {
  const linesOf = (value) => String(value || '') === '' ? [] : String(value).split(/\r?\n/);
  const oldLines = existed ? linesOf(before) : [];
  const newLines = linesOf(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const maxLines = 80;
  const maxChars = 12000;
  const lines = [
    '@@ -' + (prefix + 1) + ',' + removed.length + ' +' + (prefix + 1) + ',' + added.length + ' @@',
    ...removed.slice(0, maxLines).map((line) => '-' + line),
    ...added.slice(0, maxLines).map((line) => '+' + line),
  ];
  const truncated = removed.length > maxLines || added.length > maxLines || lines.join('\n').length > maxChars;
  return {
    beforeExists: !!existed,
    beforeSha256: existed ? crypto.createHash('sha256').update(String(before || '')).digest('hex') : null,
    afterSha256: crypto.createHash('sha256').update(String(after || '')).digest('hex'),
    removedLines: removed.length,
    addedLines: added.length,
    diff: lines.join('\n').slice(0, maxChars),
    truncated,
  };
}

module.exports = { fileChangeReview };
