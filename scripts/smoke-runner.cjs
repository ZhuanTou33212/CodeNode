'use strict';

/**
 * Electron 冒烟测试入口。
 * Codex/CI 沙箱没有 macOS WindowServer，Electron 会在加载用户脚本前由
 * AppKit 的 NSApplication 初始化触发 SIGABRT；这种环境应明确跳过，而不是
 * 把宿主机图形能力误报成应用回归。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.env.CODEX_CI === '1' || process.env.ELECTRON_HEADLESS === '1') {
  console.log('SMOKE: SKIP (当前环境没有可用的图形会话；请在桌面环境运行真实 Electron 冒烟测试)');
  process.exit(0);
}

const electronCli = path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js');
if (!fs.existsSync(electronCli)) {
  console.error('SMOKE: FAIL（Electron CLI 不存在，请先运行 npm install）');
  process.exit(1);
}

const result = spawnSync(process.execPath, [electronCli, path.join(__dirname, 'smoke.cjs')], { stdio: 'inherit' });
if (result.error) {
  console.error('SMOKE: FAIL ' + result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
