/**
 * save-project-boundary-test.cjs —— 工程保存的路径边界与「不许谎报成功」
 *
 * 回归 bug（P0）：
 *   1. `saveDoc()` 直接 `path.resolve(projectFile)` 写盘，而 projectFile 来自渲染层 payload，
 *      未做项目根边界校验 —— 与 write_file / edit_file 走 resolveInRoot 的口径不一致，
 *      等于给了一个绕过全部路径约束的任意写入入口；
 *   2. 保存失败时 `AgentToolContext.saveProject()` 把异常吞掉返回 null，
 *      而 save_project 工具无论拿到什么都返回 `AgentToolResult.ok('已保存当前工程到 磁盘')`
 *      —— 模型据此认为工程已落盘，实际什么都没写（判据不落在真实终态）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { saveDoc } = require('../electron/ipc/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-savedoc-'));
const root = path.join(temp, 'project');
const outside = path.join(temp, 'outside');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const link = path.join(root, 'linked');
try {
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
} catch {}

function expectThrow(label, fn, code) {
  try {
    fn();
    check(label, false, '未抛错（越界写入没有被拦下）');
  } catch (error) {
    check(label, (error && error.code) === code, 'code=' + (error && error.code) + ' msg=' + (error && error.message));
  }
}

// ---- (1) 项目内的目标：相对 / 绝对 / 子目录都允许 ----
const model = null;
const insideA = saveDoc(root, 'workflow.cnode', model);
check('项目根内（相对路径）可保存且文件已落盘', fs.existsSync(insideA) && path.dirname(insideA) === path.resolve(root), insideA);
const insideB = saveDoc(root, path.join(root, 'sub', 'graph.cnode'), model);
check('项目根内（绝对路径 + 子目录）可保存，父目录自动创建', fs.existsSync(insideB), insideB);

// ---- (2) 越界目标：必须拒绝且不产生任何文件 ----
const escapeTarget = path.join(outside, 'escaped.cnode');
expectThrow('相对路径越界（..\\）被拒绝', () => saveDoc(root, path.join('..', 'outside', 'escaped.cnode'), model), 'PATH_OUT_OF_ROOT');
expectThrow('绝对路径越界被拒绝', () => saveDoc(root, escapeTarget, model), 'PATH_OUT_OF_ROOT');
if (fs.existsSync(link)) {
  expectThrow('符号链接/联接目录越界被拒绝', () => saveDoc(root, path.join('linked', 'evil.cnode'), model), 'PATH_OUT_OF_ROOT');
}
check('越界目标没有任何文件被创建', !fs.existsSync(escapeTarget) && fs.readdirSync(outside).length === 0,
  JSON.stringify(fs.readdirSync(outside)));

// ---- (3) 工具层：保存失败必须报 error，成功必须报 ok ----
function registry() {
  return toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['save_project'] });
}

(async () => {
  const okContext = new AgentToolContext({
    projectRoot: root,
    saveProject: async () => saveDoc(root, 'workflow.cnode', model),
  });
  const okRes = await registry().execute('save_project', {}, okContext);
  check('save_project 成功：ok=true 且返回真实落盘路径', okRes.ok === true && String(okRes.data.filePath || '').endsWith('workflow.cnode'),
    JSON.stringify({ ok: okRes.ok, data: okRes.data }));

  const failContext = new AgentToolContext({
    projectRoot: root,
    saveProject: async () => { throw Object.assign(new Error('保存目标越出项目根目录（或项目根不存在）：C:/evil.cnode'), { code: 'PATH_OUT_OF_ROOT' }); },
  });
  const failRes = await registry().execute('save_project', {}, failContext);
  check('save_project 失败：ok=false（不再谎报「已保存」）', failRes.ok === false, JSON.stringify({ ok: failRes.ok, text: failRes.text }));
  check('save_project 失败：错误文本带上真实原因（便于模型修正而非空转重试）',
    /保存工程失败/.test(String(failRes.text)) && /PATH_OUT_OF_ROOT|越出项目根/.test(String(failRes.text)), String(failRes.text));

  const unwired = new AgentToolContext({ projectRoot: root });
  const unwiredRes = await registry().execute('save_project', {}, unwired);
  check('未接线保存回调：ok=false 且给出可读原因', unwiredRes.ok === false && /保存工程失败/.test(String(unwiredRes.text)), JSON.stringify({ ok: unwiredRes.ok, text: unwiredRes.text }));

  const readOnly = new AgentToolContext({ projectRoot: root, readOnly: true, saveProject: async () => saveDoc(root, 'workflow.cnode', model) });
  const readOnlyRes = await registry().execute('save_project', {}, readOnly);
  check('只读上下文：ok=false（不允许子代理/只读角色落盘）', readOnlyRes.ok === false, JSON.stringify({ ok: readOnlyRes.ok, text: readOnlyRes.text }));

  console.log(failures === 0 ? 'SAVE PROJECT BOUNDARY TEST: PASS' : 'SAVE PROJECT BOUNDARY TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('SAVE PROJECT BOUNDARY TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
