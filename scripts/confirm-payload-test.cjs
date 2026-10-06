#!/usr/bin/env node
/**
 * confirm-payload-test.cjs —— 确认对话框的信息面（增量审查 2026-09-19 #10）
 *
 * 建议 npm script 名：`test:confirm-payload`（核心套件，无需显示环境/网络/真实命令）。
 *
 * 缺陷：用户对「要不要写 / 要不要跑」唯一的判断依据来自确认框，而确认框此前只给字节数
 * （`write_file`）、只给文件路径不给内容（`bulk_edit.create_files`）、连命令原文都不给（MCP 分支）——
 * 「确认」于是退化成无条件放行，提示注入只要让模型调一次工具，内容就再也不会被人看到。
 *
 * 判据：确认 payload（what/detail）必须含 ① 内容摘要（小内容=预览，大内容=哈希+行数+前几行）、
 * ② 批量写入的每条文件内容预览、③ MCP 的 command 与参数 JSON；并保留原有的路径/字节数信息（反向锁）。
 * 本用例**不真正执行**任何命令：confirm spy 一律返回 false，扩展分支因此不会 spawn。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../electron/sandbox.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-confirm-payload-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);
const registry = toolkit.buildDefaultRegistryWithConfig({
  projectRoot: root,
  ragEnabled: false,
  toolsAllowed: ['write_file', 'bulk_edit'],
});

/** 捕获确认 payload；approved 决定是否继续（默认 false = 只看对话框、不执行任何写） */
function makeContext(projectRoot, approved) {
  const seen = [];
  const context = new AgentToolContext({
    projectRoot: projectRoot || root,
    confirm: async (level, what, detail) => {
      seen.push({ level, what, detail });
      return approved === true;
    },
    audit: () => {},
    sandbox: policy,
    signal: new AbortController().signal,
  });
  return { context, seen };
}

(async () => {
  // ============ write_file：内容摘要 ============
  {
    const run = makeContext();
    await registry.execute('write_file', { path: 'note.md', content: '# 标题\n这是要被写进项目的内容\n' }, run.context);
    const payload = run.seen[0] || { what: '', detail: '' };
    check('#10 write_file 小内容：确认框给出内容预览（不再只有字节数）',
      /内容预览/.test(payload.detail) && payload.detail.includes('# 标题') && payload.detail.includes('这是要被写进项目的内容'),
      JSON.stringify(payload.detail).slice(0, 160));
    check('#10 write_file 小内容：原有信息（路径/字节数）仍保留（反向锁）',
      payload.what.includes('note.md') && /信息写入|字节/.test(payload.detail),
      JSON.stringify({ what: payload.what, detail: payload.detail.slice(0, 80) }));
  }
  {
    const run = makeContext();
    await registry.execute('write_file', { path: 'big.txt', content: 'x'.repeat(5000) }, run.context);
    const payload = run.seen[0] || { detail: '' };
    check('#10 write_file 大内容：给哈希 + 行数概览（不撑爆对话框、但用户能核对）',
      /5000 字符/.test(payload.detail) && /sha256=/.test(payload.detail) && /预览/.test(payload.detail),
      JSON.stringify(payload.detail).slice(0, 200));
  }

  // ============ bulk_edit.create_files：逐条内容预览 ============
  {
    const run = makeContext();
    await registry.execute('bulk_edit', {
      action: 'create_files',
      list: [
        { path: 'a.md', content: 'AAA 内容' },
        { path: 'b.md', content: 'BBB 内容' },
      ],
    }, run.context);
    const payload = run.seen[0] || { detail: '' };
    check('#10 bulk_edit.create_files：每条文件都给出长度与首行预览',
      /a\.md（\d+ 字符）/.test(payload.detail) && /b\.md（\d+ 字符）/.test(payload.detail) &&
        payload.detail.includes('首行：AAA 内容') && payload.detail.includes('首行：BBB 内容'),
      JSON.stringify(payload.detail).slice(0, 240));
  }

  // ============ MCP 扩展：command + 参数 JSON ============
  {
    const project = path.join(root, 'mcp-project');
    fs.mkdirSync(path.join(project, '.codenode'), { recursive: true });
    fs.writeFileSync(path.join(project, '.codenode', 'extensions.json'), JSON.stringify([{
      name: 'stubmcp',
      kind: 'mcp',
      description: '确认面用例替身',
      command: 'C:/tools/mcp-server.exe',
      args: ['--stdio'],
      tools: [{ name: 'stub_echo', description: '回显', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    }], null, 2), 'utf8');
    const mcpRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: project, ragEnabled: false });
    const run = makeContext(project);
    const res = await mcpRegistry.execute('stub_echo', { q: 'hi' }, run.context);
    const payload = run.seen[0] || { detail: '' };
    check('#10 MCP 扩展：确认框给出 command 原文与参数 JSON（此前只有「来源」）',
      payload.detail.includes('C:/tools/mcp-server.exe') && payload.detail.includes('--stdio') && payload.detail.includes('"q":"hi"'),
      JSON.stringify(payload.detail).slice(0, 240));
    check('#10 拒绝确认后不执行（确认框不是装饰）', res.ok === false && /已取消/.test(String(res.text)), String(res.text).slice(0, 60));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('CONFIRM PAYLOAD TEST: ' + (failures ? 'FAIL' : 'PASS') + (failures ? ' (' + failures + ')' : ''));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('CONFIRM PAYLOAD TEST: ERROR');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
