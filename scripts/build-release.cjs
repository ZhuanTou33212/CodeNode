'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const platform = process.argv[2] || process.platform;
const targets = {
  win: ['--win', 'portable'],
  mac: ['--mac', 'dmg', 'zip'],
  linux: ['--linux', 'AppImage', 'deb'],
};
if (!targets[platform]) {
  console.error('用法：node scripts/build-release.cjs win|mac|linux');
  process.exit(2);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status || 1);

const cache = path.join(process.cwd(), '.cache', 'electron-builder');
const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: cache,
  electron_config_cache: path.join(process.cwd(), '.cache', 'electron'),
};
const builder = process.platform === 'win32'
  ? path.join(process.cwd(), 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(process.cwd(), 'node_modules', '.bin', 'electron-builder');
const result = spawnSync(builder, [...targets[platform], '--publish', 'never'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(result.status == null ? 1 : result.status);
