'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config/ui.editing.json');
const { atomicWriteFile } = require('./atomicFile.cjs');

function parseSettings(properties = {}) {
  const result = { ...config.defaults };
  for (const [key, fallback] of Object.entries(config.defaults)) {
    const value = properties['editing.' + key];
    if (value == null) continue;
    if (typeof fallback === 'boolean') result[key] = !/^(false|0|off)$/i.test(String(value));
    else if (typeof fallback === 'number') {
      const bounds = config.limits[key];
      result[key] = Number.isFinite(Number(value)) ? Math.max(bounds[0], Math.min(bounds[1], Number(value))) : fallback;
    } else result[key] = String(value);
  }
  return result;
}

function normalizeSettings(input) {
  const settings = { ...config.defaults, ...input };
  for (const [key, fallback] of Object.entries(config.defaults)) {
    const value = settings[key];
    if (typeof value !== typeof fallback) throw new Error('无效设置：' + key);
    if (typeof value === 'number') {
      const [minimum, maximum] = config.limits[key];
      if (!Number.isFinite(value) || value < minimum || value > maximum || (key !== 'maxDeletedRatio' && !Number.isInteger(value))) throw new Error('设置超出范围：' + key);
    }
    if (typeof value === 'string' && (value.length > 1500 || /[\r\n\0]/.test(value))) throw new Error('校验命令必须是单行且不超过 1500 字符');
  }
  return Object.fromEntries(Object.keys(config.defaults).map((key) => [key, settings[key]]));
}

function writeSettings(root, input) {
  const settings = normalizeSettings(input);
  const file = path.join(path.resolve(root), '.codenode', 'agent.properties');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('设置文件不可为符号链接');
  const dir = path.dirname(file);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('设置目录不可为符号链接');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const entries = new Map(Object.entries(settings).map(([key, value]) => ['editing.' + key, String(value)]));
  const lines = before.split(/\r?\n/).filter((line) => !entries.has(line.split('=')[0].trim()));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  atomicWriteFile(file, lines.concat([...entries].map(([key, value]) => key + '=' + value)).join('\n') + '\n');
  return settings;
}

module.exports = { parseSettings, normalizeSettings, writeSettings, config };
