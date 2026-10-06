'use strict';
/** UTF-16 offsets into original text; metadata is never presented as source evidence. */
function sourceOffsets(text) {
  const starts = [0];
  const endings = /\r\n|\r|\n/g;
  let match;
  while ((match = endings.exec(text))) starts.push(match.index + match[0].length);
  return starts;
}
function decorateChunk(chunk, text, starts, metadata = {}) {
  const startOffset = starts[chunk.startLine - 1];
  const endOffset = (starts[chunk.endLine] == null ? text.length : starts[chunk.endLine]);
  chunk.sourceMapping = { unit: 'utf16', startOffset, endOffset,
    startLine: chunk.startLine, endLine: chunk.endLine };
  chunk.metadata = { path: chunk.path, symbol: chunk.qualifiedSymbol || '',
    parentSymbol: chunk.parentSymbol || '', kind: chunk.kind, ...metadata,
    retrievalTerms: require('./symbolTerms.cjs').symbolTerms(chunk.qualifiedSymbol || chunk.symbol) };
  const header = Object.entries(chunk.metadata).filter(([, value]) => value)
    .map(([key, value]) => key + ': ' + value).join('\n');
  chunk.searchText = header + '\n\n' + chunk.content;
  return chunk;
}
module.exports = { sourceOffsets, decorateChunk };
