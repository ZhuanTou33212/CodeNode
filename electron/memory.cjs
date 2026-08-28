'use strict';

const fs = require('fs');
const path = require('path');

function memoryPath(projectRoot) {
  return path.join(path.resolve(projectRoot || '.'), '.codenode', 'memory.json');
}

function readMemory(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath(projectRoot), 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeMemory(projectRoot, entries) {
  const file = memoryPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: entries.slice(-200) }, null, 2) + '\n', 'utf8');
}

module.exports = { readMemory, writeMemory };
