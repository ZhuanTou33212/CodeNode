'use strict';

/**
 * 依赖声明门禁：主进程 / 工具层 / 脚本里出现的**字面量** require('<裸模块>')，其模块必须已在
 * package.json 的 dependencies / devDependencies / optionalDependencies 里声明。
 *
 * 为什么需要它（2026-09-16 实测）：`scripts/vector-store-semantic-probe.cjs` 曾经字面量
 * require('@zilliz/milvus2-sdk-node') —— 而该 SDK 是**刻意不写进 package.json 的可选依赖**
 * （见 electron/vectorStore/milvus.cjs 头部注释）。本机手动装过 SDK 时 `npm run check:js` 全绿，
 * CI（`npm ci` 后没有它）三平台全部 TS2307 → 整条门禁连续 8 次全红，`npm test` 与打包从未跑到。
 *
 * 本用例把「本机装了才绿」的偶然性变成「不需要安装任何可选依赖就能判定」的确定性检查：
 * 可选依赖请走惰性加载（模块名放常量/参数，如 milvus.cjs 的 `loadSdk()`），字面量 require 的
 * 只能是已声明的依赖。
 *
 * 扫描前先剥掉注释（保留换行以便报行号），所以文档里的示例不会误报；字符串里出现 `//` 的行
 * 会被当作行注释提前截断（本仓库的 require 都在行首，实测不受影响）——偏保守而非偏严。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);
const builtins = new Set(builtinModules.concat(builtinModules.map((m) => 'node:' + m)));

/** 把注释内容替换成空格（保留 \n），行号不变。 */
function stripComments(text) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2);
    if (state === 'code') {
      if (two === '//') {
        state = 'line';
        out += '  ';
        i += 1;
      } else if (two === '/*') {
        state = 'block';
        out += '  ';
        i += 1;
      } else {
        out += text[i];
      }
    } else if (state === 'line') {
      if (text[i] === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
    } else if (two === '*/') {
      state = 'code';
      out += '  ';
      i += 1;
    } else {
      out += text[i] === '\n' ? '\n' : ' ';
    }
  }
  return out;
}

/** 收集待检查文件：electron/ 与 scripts/ 下的 .cjs（与 check:js 覆盖范围一致）。 */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.cache') continue;
      collect(full, out);
    } else if (entry.name.endsWith('.cjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(path.join(ROOT, 'electron')).concat(collect(path.join(ROOT, 'scripts')));

/** 只匹配字面量形式的 require('x') / require("x")；模板串与变量形式不在此用例的判定范围。 */
const REQUIRE_LITERAL = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

const violations = [];
let bareRequires = 0;
let totalRequires = 0;
for (const file of files) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  text.split('\n').forEach((line, i) => {
    REQUIRE_LITERAL.lastIndex = 0;
    let m;
    while ((m = REQUIRE_LITERAL.exec(line)) !== null) {
      totalRequires += 1;
      const spec = m[2];
      if (spec.startsWith('.') || spec.startsWith('/') || path.isAbsolute(spec)) continue; // 相对/绝对路径
      if (builtins.has(spec)) continue; // Node 内置
      bareRequires += 1;
      const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!declared.has(top)) {
        violations.push(
          path.relative(ROOT, file).replace(/\\/g, '/') + ':' + (i + 1) + ' → ' + spec
        );
      }
    }
  });
}

// 扫描范围自检：文件数/命中数过小说明扫描逻辑失效（不是「没问题」）。
assert.ok(
  files.length > 60 && totalRequires > 200 && bareRequires > 5,
  '扫描范围过小（文件 ' +
    files.length +
    ' 个 / 字面量 require ' +
    totalRequires +
    ' 处 / 其中裸模块 ' +
    bareRequires +
    ' 处），扫描逻辑可能失效'
);
assert.deepStrictEqual(
  violations,
  [],
  '以下字面量 require 的模块未在 package.json 声明（可选依赖请走惰性 loadSdk 形式的非常量 require）：\n  ' +
    violations.join('\n  ')
);

console.log(
  'DEP DECLARATION: PASS 扫描 ' +
    files.length +
    ' 个 .cjs、' +
    totalRequires +
    ' 处字面量 require（裸模块 ' +
    bareRequires +
    ' 处）全部已声明'
);
