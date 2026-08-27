/**
 * 生成「CodeNode 控制台.cmd」启动器（打包后与 CodeNode-*.exe 同目录）。
 *
 * 桌面快捷方式指向该 .cmd 时，会同时打开一个 cmd 面板：
 *   1. 启动 CodeNode 便携版 exe；
 *   2. 面板实时跟随显示 <exe 目录>/logs/console.log（由 electron/main.cjs setupConsoleLog 写入）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LAUNCHER_NAME = 'CodeNode 控制台.cmd';

const launcherLines = [
  '@echo off',
  'chcp 65001 >nul',
  'title CodeNode 运行控制台',
  'setlocal',
  'cd /d "%~dp0"',
  '',
  'set "EXE="',
  'for %%f in (CodeNode-*.exe CodeNode.exe) do if not defined EXE set "EXE=%%~f"',
  'if not defined EXE (',
  '  echo [错误] 未找到 CodeNode-*.exe，请把本启动器与可执行文件放在同一目录。',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo [CodeNode] 启动应用：%EXE%',
  'start "" "%~dp0%EXE%"',
  '',
  'echo [CodeNode] 控制台面板已打开，正在跟随应用日志（logs\\console.log）...',
  'echo [CodeNode] 关闭本窗口不会关闭应用；按 Ctrl+C 可结束日志跟随。',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=\'%~dp0logs\\console.log\'; $d=Split-Path $p; if(!(Test-Path $d)){New-Item -ItemType Directory -Force -Path $d|Out-Null}; Write-Host \'[CodeNode] 等待应用写入日志...\'; Get-Content -Path $p -Wait -Tail 300 -Encoding UTF8"',
  '',
];

function build() {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['release', 'release/win-unpacked'];
  let written = 0;
  for (const rel of dirs) {
    const target = path.resolve(__dirname, '..', rel);
    if (!fs.existsSync(target)) continue;
    const exe = fs.readdirSync(target).find((f) => /^(CodeNode-.*\.exe|CodeNode\.exe)$/i.test(f));
    if (!exe) continue;
    const file = path.join(target, LAUNCHER_NAME);
    // 带 UTF-8 BOM + chcp 65001，保证 cmd 正确解析中文与特殊字符
    fs.writeFileSync(file, '\ufeff' + launcherLines.join('\r\n') + '\r\n', 'utf-8');
    console.log('launcher -> ' + file);
    written++;
  }
  if (written === 0) {
    console.log('未找到 CodeNode-*.exe（请先 npm run dist / electron-builder），已跳过启动器生成');
  }
}

build();
