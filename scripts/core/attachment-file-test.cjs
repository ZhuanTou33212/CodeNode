'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const attachments = require('../../electron/attachments.cjs');

const dataUrl = (mime, value) => `data:${mime};base64,${Buffer.from(value).toString('base64')}`;

const text = attachments.normalizeAttachments([{
  name: 'sample.ts',
  mime: 'application/typescript',
  dataUrl: dataUrl('application/typescript', 'export const answer = 42;\n'),
}]);
assert.equal(text.ok, true, text.error);
assert.equal(text.attachments[0].mime, 'application/typescript');
const textMessage = attachments.buildUserMessage('Review this file.', text.attachments);
assert.equal(typeof textMessage.content, 'string');
if (typeof textMessage.content !== 'string') throw new Error('text-only attachment must produce string content');
assert.match(textMessage.content, /<attachment name="sample\.ts"/);
assert.match(textMessage.content, /export const answer = 42/);

const inferred = attachments.normalizeAttachments([{
  name: 'README.md',
  mime: 'application/octet-stream',
  dataUrl: dataUrl('application/octet-stream', '# Project\n'),
}]);
assert.equal(inferred.ok, true, inferred.error);
assert.equal(inferred.attachments[0].mime, 'text/plain');

const mixed = attachments.normalizeAttachments([
  text.attachments[0],
  { name: 'shot.png', mime: 'image/png', dataUrl: dataUrl('image/png', 'png') },
]);
assert.equal(mixed.ok, true, mixed.error);
const mixedMessage = attachments.buildUserMessage('Inspect both.', mixed.attachments);
assert.ok(Array.isArray(mixedMessage.content));
if (!Array.isArray(mixedMessage.content)) throw new Error('mixed attachment must produce multimodal content');
assert.match(mixedMessage.content[0].text, /sample\.ts/);
assert.equal(mixedMessage.content[1].type, 'image_url');

const binary = attachments.normalizeAttachments([{
  name: 'archive.zip', mime: 'application/zip', dataUrl: dataUrl('application/zip', 'binary'),
}]);
assert.equal(binary.ok, false);
assert.match(binary.error, /不支持/);

const nul = attachments.normalizeAttachments([{
  name: 'unsafe.txt', mime: 'text/plain', dataUrl: dataUrl('text/plain', 'a\0b'),
}]);
assert.equal(nul.ok, false);
assert.match(nul.error, /二进制/);

const tooLarge = attachments.normalizeAttachments([{
  name: 'large.txt', mime: 'text/plain', dataUrl: `data:text/plain;base64,${Buffer.alloc(attachments.MAX_TEXT_FILE_BYTES + 1, 97).toString('base64')}`,
}]);
assert.equal(tooLarge.ok, false);
assert.match(tooLarge.error, /2MB/);

const agentIpcSource = fs.readFileSync(path.join(__dirname, '../../electron/ipc/agent.cjs'), 'utf8');
assert.match(agentIpcSource, /hasImageAttachment/);
assert.match(agentIpcSource, /hasImageAttachment\s*&&\s*sel/);

console.log('ATTACHMENT FILE TEST: PASS (text/code normalization, prompt projection, mixed images, type and size guards)');
