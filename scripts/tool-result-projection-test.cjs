#!/usr/bin/env node
/**
 * tool-result-projection-test.cjs —— 工具结果「只向模型投影一次」的回归判据（审计 §4 P0-2 / 阶段 A A1）
 *
 * 问题：`buildToolContent()` 先放 `result.text`，再把 `result.data` 序列化成 `[data]` 追加进去。
 * 而 `find_files` / `search_files` / `execute_shell` / `get_subagent_task` 的 `data` 里装的
 * **就是 `text` 里已经有的那份列表 / 输出 / 视图** —— 同一件事被发了两遍，随后主循环还会把这份
 * 重复内容登记去做 LLM 压缩（为重复再付一次费）。
 *
 * 修法：`AgentToolResult` 增加 `modelContent`（唯一进入上下文的那份）。判据：
 *   A. 那 4 个工具的返回结果带 `modelContent === text`（唯一来源，不是「各写一遍文案」）；
 *   B. `buildToolContent` 对它们**不产生** `[data]` 段（重复率 = 0，满足文档的 <5% 验收线）；
 *   C. 结构化 `data` 仍然完整可读（UI / 审计 / 回放 / 子代理合并照旧）——省的是重复，不是数据；
 *   D. **负向**：没有 `modelContent` 的结果（既有 60+ 处调用）逐字节照旧；失败结果照旧
 *      （失败 `[data]` 里的 code/retryable/userActionRequired 是判据，不能省）；
 *   E. **变异**：把 `modelContent` 改掉，模型看到的内容必须跟着变（证明投影真的生效，不是巧合）。
 *
 * 数字来自**真实执行**：走 `registry.execute()` 跑真的 `search_files` / `execute_shell`，
 * 而不是构造一个假结果比对字符串。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-projection-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
for (let i = 1; i <= 12; i++) {
  fs.writeFileSync(path.join(root, 'src', 'file' + i + '.txt'), 'line one\nNEEDLE_' + i + '\nline three\n');
}
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);
const CAP = 120000;

function makeContext() {
  return new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    askUser: async () => 'ok',
    ragConfig: { enabled: false },
    sandbox: policy,
  });
}

(async () => {
  const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, webSearchEnabled: false });
  const ctx = makeContext();

  // ============================ A/B/C. 真实执行：search_files ============================
  console.log('== A/B/C. search_files：真实执行后的投影 ==');
  const search = await registry.execute('search_files', { pattern: 'NEEDLE_\\d+' }, ctx);
  check('[A] search_files 执行成功', search.ok === true, String(search.text).slice(0, 60));
  check('[A] search_files 带 modelContent 且 === text（唯一来源）',
    typeof search.modelContent === 'string' && search.modelContent === search.text);
  const searchContent = agent.buildToolContent(search, 'search_files', false, false, CAP);
  check('[B] 投影后**没有** [data] 段（重复率 = 0）', !searchContent.includes('[data]'), 'len=' + searchContent.length);
  check('[C] 结构化 data 仍然完整（matches 数组照旧给 UI/审计）',
    Array.isArray(search.data.matches) && search.data.matches.length >= 12 && search.data.count === search.data.matches.length,
    JSON.stringify({ count: search.data.count, matches: search.data.matches.length }));
  const listed = searchContent.split('\n').slice(1).filter((line) => line.includes('NEEDLE_'));
  check('[C] 文本里列出的匹配条数与 data.matches 逐条一致（省的是重复，不是内容）',
    listed.length === search.data.matches.length, 'text=' + listed.length + ' data=' + search.data.matches.length);

  // ============================ A/B. 真实执行：find_files ============================
  console.log('\n== A/B. find_files：真实执行后的投影 ==');
  const found = await registry.execute('find_files', { pattern: '**/*.txt' }, ctx);
  check('[A] find_files 带 modelContent 且 === text', found.ok === true && found.modelContent === found.text, JSON.stringify({ ok: found.ok, count: found.data && found.data.count }));
  const foundContent = agent.buildToolContent(found, 'find_files', false, false, CAP);
  check('[B] 投影后没有 [data]', !foundContent.includes('[data]'));
  check('[C] 文件列表在文本里齐全', foundContent.includes('file1.txt') && foundContent.includes('file12.txt'));

  // ============================ A/B. 真实执行：execute_shell ============================
  console.log('\n== A/B. execute_shell：真实执行后的投影 ==');
  // 白名单里的程序（executeShellTool.cjs 的 ALLOWED）：node 随处可用且不是高危
  const shell = await registry.execute('execute_shell', { command: 'node --version' }, ctx);
  check('[A] execute_shell 真实执行成功（白名单命令 node --version）', shell.ok === true, String(shell.text).slice(0, 70));
  if (shell.ok === true) {
    check('[A] execute_shell 带 modelContent 且 === text', shell.modelContent === shell.text);
    const shellContent = agent.buildToolContent(shell, 'execute_shell', false, false, CAP);
    check('[B] 投影后没有 [data]（命令输出不再发两遍）', !shellContent.includes('[data]'), 'len=' + shellContent.length);
    check('[C] 退出码与输出都在文本里', shellContent.includes('退出码 0') && /v\d+\./.test(shellContent), JSON.stringify(shellContent.slice(0, 60)));
    check('[C] data.output 与文本里那份同源（所以才算重复）',
      String(shellContent).includes(String(shell.data.output).trim().split('\n')[0].slice(0, 8)));
  }

  // ============================ D. 负向：没有 modelContent 的一律照旧 ============================
  console.log('\n== D. 负向判据：没有投影的结果逐字节照旧 ==');
  const legacy = AgentToolResult.ok('找到了 3 个文件', { count: 3, files: ['a', 'b', 'c'] });
  const legacyContent = agent.buildToolContent(legacy, 'some_tool', false, false, CAP);
  check('[D] 未投影的结果照旧追加 [data]（与旧行为逐字节一致）',
    legacyContent.includes('[data]') && legacyContent.indexOf('[data]') > legacyContent.indexOf('找到了 3 个文件'),
    JSON.stringify(legacyContent.slice(0, 80)));
  check('[D] modelContent 缺省为 null（60+ 处既有调用零改动）', legacy.modelContent === null);
  const failed = AgentToolResult.failure('TIMEOUT', '执行超时', { tool: 'execute_shell', retryable: true });
  const failedContent = agent.buildToolContent(failed, 'execute_shell', false, false, CAP);
  check('[D] 失败结果照旧带 [data]（code/retryable 是判据，不能省）',
    failedContent.includes('[data]') && failedContent.includes('TIMEOUT'), JSON.stringify(failedContent.slice(0, 90)));
  check('[D] partial 结果也照旧', agent.buildToolContent(AgentToolResult.partial('部分完成', { n: 1 }, [{ unit: 'u', failure: { code: 'X' } }]), 't', false, false, CAP).includes('[data]'));
  check('[D] 只读标量工具的旧口径没被破坏（本就免 [data]）',
    !agent.buildToolContent(AgentToolResult.ok('画布快照', { nodes: [1] }), 'get_workbench_model', false, false, CAP).includes('[data]'));

  // ============================ E. 变异：投影真的生效 ============================
  console.log('\n== E. 变异校验：改掉 modelContent，模型看到的内容必须跟着变 ==');
  const mutated = AgentToolResult.ok('原文（不该被模型看到）', { a: 1 }, { modelContent: '投影后的紧凑内容' });
  const mutatedContent = agent.buildToolContent(mutated, 'x', false, false, CAP);
  check('[E] 模型看到的是 modelContent，不是 text', mutatedContent.includes('投影后的紧凑内容') && !mutatedContent.includes('原文（不该被模型看到）'), mutatedContent);
  check('[E] 空字符串是合法投影（表示「这次不需要给模型看任何东西」）',
    agent.buildToolContent(AgentToolResult.ok('y', { z: 1 }, { modelContent: '' }), 'x', false, false, CAP) === '');

  // ============================ F. 重复率（文档验收线 <5%） ============================
  console.log('\n== F. 重复率：投影前后对比（文档验收线 <5%） ==');
  for (const [name, result] of [['search_files', search], ['find_files', found], ['execute_shell', shell]]) {
    if (typeof result.modelContent !== 'string') continue;
    const newLen = agent.buildToolContent(result, name, false, false, CAP).length;
    const legacyShape = (result.text || '').length + (result.data && Object.keys(result.data).length ? JSON.stringify(result.data).length + 7 : 0);
    const saved = legacyShape > 0 ? 1 - newLen / legacyShape : 0;
    console.log('   ' + name.padEnd(15) + '旧口径 ' + legacyShape + ' 字符 → 投影后 ' + newLen + ' 字符（少 ' + (saved * 100).toFixed(1) + '%）');
    check('[F] ' + name + ' 投影后重复率 0（无 [data] 段）+ 显著省字符', saved > 0.3);
  }

  // ============================ G. 子代理视图（静态接线 + 结果契约） ============================
  console.log('\n== G. get_subagent_task：JSON 视图不再各发一遍 ==');
  const subSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'subagents.cjs'), 'utf8');
  check('[G] get_subagent_task 的成功路径已改为单份投影',
    /const viewJson = JSON\.stringify\(view\);\s*return AgentToolResult\.ok\(viewJson, view, \{ modelContent: viewJson \}\);/.test(subSrc));
  const viewLike = { taskId: 't1', role: 'explorer', summary: 'x'.repeat(500), envelope: { artifacts: [{ path: 'a', sha256: 'deadbeef' }] } };
  const viewJson = JSON.stringify(viewLike);
  const projected = agent.buildToolContent(AgentToolResult.ok(viewJson, viewLike, { modelContent: viewJson }), 'get_subagent_task', false, false, CAP);
  check('[G] 视图结果只发一份 JSON（data 里那份不再追加）',
    projected === viewJson && !projected.includes('[data]'), 'len=' + projected.length + ' vs ' + viewJson.length);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? 'TOOL RESULT PROJECTION TEST: PASS（结果只向模型投影一次，data 仍完整可读）' : 'TOOL RESULT PROJECTION TEST: FAIL —— ' + failures + ' 项断言未通过'));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('TOOL RESULT PROJECTION TEST: FAIL —— ' + String((error && error.stack) || error));
  process.exit(1);
});
