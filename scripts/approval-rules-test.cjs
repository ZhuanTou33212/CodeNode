/**
 * approval-rules-test.cjs —— 持久化审批规则（对照文档 §5 #6）
 *
 * 短板：审批令牌只存内存、单次有效，同一个工具每写一次都要点一次 → 用户要么接受疲劳、
 * 要么干脆关掉确认（等于对所有写入放开）。本轮补「这个工具在本项目里我信它」这一档。
 *
 * 判据：
 *   A 规则账本：读写/去重/上限/坏文件偏保守（当没有规则，只多问不会少问）
 *   B 匹配语义：capability / tool / level 三个字段**全都要命中**才算命中（少写一个 = 更宽，不许）
 *   C 执行链路：命中 → 不调 confirmHandler 就签发令牌 + 留 approval_rule_hit；未命中 → 照旧询问
 *   D 受保护路径：写工具**写不进** `.codenode/approvals.json`（否则模型能自己给自己发白名单）
 *   E 界面接线：桥在收到 `{ok:true, always:'project'}` 时落规则；且只对「工具名形态」的审批记忆
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const rules = require('../electron/approvalRules.cjs');
const { ApprovalService } = require('../electron/tools/approval.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-approval-rules-'));
fs.mkdirSync(path.join(root, '.codenode'), { recursive: true });
const policy = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policy);

(async () => {
  // ==================== A. 规则账本 ====================
  console.log('\n== A. 规则账本 ==');
  {
    check('[A] 默认无规则文件 → 空规则（不是抛异常）', rules.readRules(root).rules.length === 0);
    const added = rules.addRule(root, { capability: 'workspace.write', tool: 'write_file', level: 'WRITE' });
    check('[A] 写入一条规则', added.ok === true && added.duplicate === false && rules.readRules(root).rules.length === 1, JSON.stringify(added));
    const dup = rules.addRule(root, { capability: 'workspace.write', tool: 'write_file', level: 'WRITE' });
    check('[A] 同 capability+tool+level 重复加 → 报 duplicate 且不重复写', dup.duplicate === true && rules.readRules(root).rules.length === 1, JSON.stringify(dup));
    const empty = rules.addRule(root, {});
    check('[A] 空规则被拒（EMPTY_RULE）', empty.ok === false && empty.error === 'EMPTY_RULE');
    for (let i = 0; i < rules.MAX_RULES + 5; i += 1) rules.addRule(root, { tool: 'tool_' + i });
    check('[A] 上限生效', rules.readRules(root).rules.length === rules.MAX_RULES, 'len=' + rules.readRules(root).rules.length);
    const file = rules.rulesFile(root);
    fs.writeFileSync(file, '{坏 JSON', 'utf8');
    check('[A] 坏文件 → 当「没有规则」（偏保守：只多问一次，不会少问）', rules.readRules(root).rules.length === 0);
    rules.writeRules(root, []);
  }

  // ==================== B. 匹配语义 ====================
  console.log('\n== B. 匹配语义 ==');
  {
    const list = [
      { id: 'r1', capability: 'workspace.write', tool: 'write_file', level: 'WRITE' },
      { id: 'r2', tool: 'edit_file' },
    ];
    check('[B] 三字段全中才算命中', rules.matchRule(list, { capability: 'workspace.write', tool: 'write_file', level: 'WRITE' }).id === 'r1');
    check('[B] capability 不同 → 不命中（不能越权到别的能力）', rules.matchRule(list, { capability: 'project.save', tool: 'write_file', level: 'WRITE' }) === null);
    check('[B] tool 不同 → 不命中', rules.matchRule(list, { capability: 'workspace.write', tool: 'bulk_edit', level: 'WRITE' }) === null);
    check('[B] 规则只写了 tool（没写 capability/level）→ 命中该工具的任意级别', rules.matchRule(list, { capability: 'workspace.write', tool: 'edit_file', level: 'HIGH' }).id === 'r2');
    check('[B] 工具名形态判定：shell 命令文本不是可记忆的 tool', rules.isRememberableTool('write_file') === true && rules.isRememberableTool('在项目目录执行命令：npm install') === false);
  }

  // ==================== C. 执行链路（命中免打扰 / 未命中照问）====================
  console.log('\n== C. 执行链路 ==');
  {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-approval-run-'));
    let confirmCalls = 0;
    const service = new ApprovalService({
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      runId: 'run-rules',
      projectRoot: runDir,
      rules: [{ id: 'r-write', capability: 'workspace.write', tool: 'write_file', level: 'WRITE' }],
    });
    const events = service.events || [];
    const token = await service.request({ capability: 'workspace.write', level: 'WRITE', what: 'write_file', detail: '写文件', scope: {}, toolCallId: 'c1' });
    check('[C] 命中规则 → 直接签发令牌（不再打扰用户）', !!token && confirmCalls === 0, JSON.stringify({ token: !!token, confirmCalls }));
    check('[C] 命中留痕 approval_rule_hit（授权面可回查）', (service.events || []).some((e) => e.event === 'approval_rule_hit' && e.ruleId === 'r-write'), JSON.stringify((service.events || []).slice(-2)));
    check('[C] 令牌仍然是一次性的（命中不等于永久豁免单次校验）', service.verify(token, { capability: 'workspace.write', scope: {}, toolCallId: 'c1' }).valid === true && service.verify(token, { capability: 'workspace.write', scope: {}, toolCallId: 'c1' }).valid === false);
    const other = await service.request({ capability: 'workspace.write', level: 'WRITE', what: 'edit_file', detail: '改文件', scope: {}, toolCallId: 'c2' });
    check('[C] 未命中（别的工具）→ 仍然询问用户', !!other && confirmCalls === 1, 'confirmCalls=' + confirmCalls);
    check('[C] 未命中时不留 approval_rule_hit 假痕迹', !(service.events || []).some((e) => e.event === 'approval_rule_hit' && e.tool === 'edit_file'));
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}
  }

  // ==================== D. 受保护路径 ====================
  console.log('\n== D. 受保护路径（授权面不能被 Agent 写）==');
  {
    const reg = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: ['write_file', 'edit_file'] });
    const ctx = new AgentToolContext({ projectRoot: root, confirm: async () => true, audit: () => {}, sandbox: policy, signal: new AbortController().signal });
    const approvalPath = path.join(root, '.codenode', 'approvals.json');
    const before = fs.existsSync(approvalPath) ? fs.readFileSync(approvalPath, 'utf8') : null;
    const res = await reg.execute('write_file', { path: '.codenode/approvals.json', content: '{"version":1,"rules":[{"id":"evil","tool":"write_file"}]}' }, ctx);
    check('[D] write_file 写 approvals.json 被拒（模型不能自己发白名单）', res.ok === false, JSON.stringify({ ok: res.ok, code: res.data && res.data.code }));
    const after = fs.existsSync(approvalPath) ? fs.readFileSync(approvalPath, 'utf8') : null;
    check('[D] 终态判据：文件内容逐字节没变', after === before, JSON.stringify({ before: before && before.length, after: after && after.length }));
    const res2 = await reg.execute('write_file', { path: 'normal.txt', content: 'ok' }, ctx);
    check('[D] 负向：普通文件照常可写（没有过度修复）', res2.ok === true && fs.existsSync(path.join(root, 'normal.txt')));
    check('[D] isProtectedWriteTarget 判定（含正反例）', rules.isProtectedWriteTarget(root, approvalPath) === true && rules.isProtectedWriteTarget(root, path.join(root, 'normal.txt')) === false);
  }

  // ==================== E. 界面接线 ====================
  console.log('\n== E. 桥的「始终允许」接线 ==');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'tools', 'bridge.cjs'), 'utf8');
    check('[E] 桥处理 always=project（落项目规则）', /r\.always === 'project'/.test(src) && /approvalRules\.addRule\(/.test(src));
    check('[E] 只对工具名形态的审批记忆（命令类不记忆）', /isRememberableTool\(tool\)/.test(src));
    const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ToolDialog.tsx'), 'utf8');
    check('[E] 界面有「本项目始终允许」按钮并回 always=project', /本项目始终允许/.test(ui) && /always: 'project'/.test(ui));
    const ipc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'agent.cjs'), 'utf8');
    check('[E] ipc 把 projectRoot 传给桥（否则规则无处落盘）', /makeBridge\(sender, controller\.signal, \{ projectRoot \}\)/.test(ipc));
  }

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log('\n' + (failures === 0 ? 'APPROVAL RULES TEST: PASS' : 'APPROVAL RULES TEST: FAIL (' + failures + ')'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('APPROVAL RULES TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
