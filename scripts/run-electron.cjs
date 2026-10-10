'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const cli = path.join(__dirname, "../node_modules/electron/cli.js");
/**
 * 为什么必须显式摘掉 ELECTRON_RUN_AS_NODE：`electron/cli.js` 是**原样继承**环境变量去 spawn
 * electron 二进制的，而这个变量会让 electron 以「纯 Node」身份运行 —— 于是 `require('electron')`
 * 拿到的是可执行文件路径字符串而不是 app/BrowserWindow，任何真 Electron 用例都会在
 * `app.whenReady()` 处报 `Cannot read properties of undefined`。外层工具（如本机 harness）一旦设了它，
 * 所有 `npm run test:*ui` / `scripts/run-electron.cjs` 用例都会一起红，且现象与用例本身无关。
 */
const inherited = { ...process.env };
delete inherited.ELECTRON_RUN_AS_NODE;
const env = {
  ...inherited,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  electron_config_cache: process.env.electron_config_cache || path.join(process.cwd(), '.cache', 'electron'),
};
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status == null ? 1 : result.status);
