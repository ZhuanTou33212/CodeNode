'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const cli = path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js');
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  electron_config_cache: process.env.electron_config_cache || path.join(process.cwd(), '.cache', 'electron'),
};
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status == null ? 1 : result.status);
