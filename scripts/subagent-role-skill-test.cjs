#!/usr/bin/env node
/**
 * subagent-role-skill-test.cjs —— 子代理「身份 / 能力 / 工作 / 技能」对齐用例（2026-09-16）
 *
 * 起因：子代理的角色只有一句抽象职责，system prompt 里没有工作范围、没有可用工具清单、
 * 没有职责技能、也拿不到项目 Skill —— 于是「有工具、能干活的姿势却不对」：
 * 拿 explorer 去改代码、拿 reviewer 去跑测试、子代理不知道先读后写、改完不自检。
 *
 * 判据：
 *   A. 角色档案完整且自洽（身份/工作/不做的事/技能/工具/能力一一对应）；
 *   B. 技能库里每个被引用的 id 都真实存在（含 ≥2 条可执行规程），未知 id 显式报出；
 *   C. `buildSubagentPrompt` 纯函数：五个分区齐全、工具清单与传入一致、未知技能有告警；
 *   D. 真实委派：子代理 system prompt 里的工具清单 **== 它实际能用的工具集**（防权限与说明漂移），
 *      且项目 Skill 真的注入；
 *   E. `delegate_task` 的描述带派活对照表（主代理能把「工作」对到「角色」）；
 *   F. 只读角色的注册表里没有任何写工具。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const roles = require('../electron/tools/roles.cjs');
const roleSkills = require('../electron/tools/roleSkills.cjs');
const subagentPrompt = require('../electron/subagentPrompt.cjs');
const { SubagentManager } = require('../electron/subagents.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const { GraphModel } = require('../electron/tools/GraphModel.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const ok = (label) => console.log('  ✓ ' + label);
const WRITE_TOOLS = ['write_file', 'edit_file', 'workbench_edit', 'save_project', 'bulk_edit', 'ui_control', 'write_analysis_md'];

(async () => {
  // ---- A. 角色档案完整且自洽 ----
  {
    for (const name of roles.ROLE_NAMES) {
      const def = roles.roleDefinition(name);
      assert.ok(def, name + ' 必须在角色档案里');
      assert.ok(def.label && def.label.length >= 2, name + ' 必须有身份名（label）');
      assert.ok(def.work.length >= 2, name + ' 必须声明≥2 项负责的工作');
      assert.ok(def.notWork.length >= 1, name + ' 必须声明不归它管的事');
      assert.ok(def.guidance.length >= 10, name + ' 必须有工作方式说明');
      assert.ok(def.prompt.length > 0, name + ' 必须保留一句话角色提示（向后兼容）');
      assert.ok(def.tools.length > 0, name + ' 必须有工具白名单');
      const resolved = roleSkills.resolveRoleSkills(def.skills);
      assert.strictEqual(resolved.unknown.length, 0, name + ' 声明的技能 id 必须都存在，未知：' + resolved.unknown.join(','));
      assert.ok(resolved.entries.length >= 2, name + ' 至少要有 2 个技能');
    }
    check('A1 五个角色都有 身份/工作/不做的事/技能/工具/能力 六件套',
      roles.ROLE_NAMES.length === 5, roles.ROLE_NAMES.join('/'));

    // 只读角色不得声明写工作，也不得在工具白名单里出现写工具
    const readOnlyIssues = [];
    const writeCapabilityIssues = [];
    for (const name of roles.ROLE_NAMES) {
      const def = roles.roleDefinition(name);
      const mentionsWrite = def.work.some((item) => /修改|写入|新建|编辑|保存|增删/.test(item));
      if (def.readOnly && mentionsWrite) readOnlyIssues.push(name);
      if (mentionsWrite && !def.capabilities.includes('workspace.write')) writeCapabilityIssues.push(name);
      if (def.readOnly) {
        const leaked = def.tools.filter((tool) => WRITE_TOOLS.includes(tool));
        if (leaked.length) readOnlyIssues.push(name + '(工具泄漏:' + leaked.join(',') + ')');
      }
    }
    check('A2 只读角色不声明写工作、白名单不含写工具', readOnlyIssues.length === 0, readOnlyIssues.join('; '));
    check('A3 声明写工作的角色都具备 workspace.write 能力', writeCapabilityIssues.length === 0, writeCapabilityIssues.join(';'));
    ok('A 角色档案：' + roles.ROLE_NAMES.map((n) => n + '(' + roles.roleLabel(n) + ')').join(' / '));
  }

  // ---- B. 技能库 ----
  {
    const catalog = roleSkills.skillCatalog();
    assert.ok(catalog.length >= 10, '技能库至少 10 条，实际 ' + catalog.length);
    const thin = catalog.filter((item) => item.count < 2);
    check('B1 每个技能都有 ≥2 条可执行规程（不是抽象人格）', thin.length === 0, JSON.stringify(thin));
    const usedIds = new Set(roles.ROLE_NAMES.flatMap((name) => roles.roleSkillIds(name)));
    const orphans = catalog.filter((item) => !usedIds.has(item.id)).map((item) => item.id);
    check('B2 技能库里没有「没被任何角色用到」的孤儿技能', orphans.length === 0, orphans.join(','));
    const unknownResolved = roleSkills.resolveRoleSkills(['explore-structure-first', 'no-such-skill']);
    check('B3 未知技能 id 显式报出（不静默跳过）',
      unknownResolved.entries.length === 1 && unknownResolved.unknown.length === 1 && unknownResolved.unknown[0] === 'no-such-skill',
      JSON.stringify(unknownResolved.unknown));
    ok('B 技能库：' + catalog.length + ' 条，全部被角色引用');
  }

  // ---- C. prompt 组装（纯函数） ----
  {
    const task = {
      taskId: 'task-x',
      role: 'builder',
      objective: '给 a.txt 补一行',
      acceptanceCriteria: ['文件里有新增行'],
      inputs: { note: '来自 stage-1' },
      totalTimeoutMs: 120000,
    };
    const tools = [{ name: 'read_file', description: '读文件' }, { name: 'edit_file', description: '精确替换' }];
    const prompt = subagentPrompt.buildSubagentPrompt(task, {
      role: 'builder',
      tools,
      projectSkills: [{ name: '项目约定', instructions: '改动前先跑 check:js' }],
    });
    check('C1 身份：中文身份名 + 角色名都在（不是「你是子代理」这类无身份描述）',
      /实现工程师/.test(prompt) && /role=builder/.test(prompt), prompt.split('\n')[0]);
    check('C2 工作范围：你的工作 / 不归你管 两个分区都在',
      /【你的工作】/.test(prompt) && /【不归你管/.test(prompt));
    check('C3 能力：可用工具逐条列出且与传入完全一致（含描述）',
      /- edit_file：精确替换/.test(prompt) && /- read_file：读文件/.test(prompt));
    check('C4 技能：职责技能逐条展开（标题 + 规程）',
      /【职责技能/.test(prompt) && /先读后写/.test(prompt) && /优先用 edit_file 做精确替换/.test(prompt));
    check('C5 项目 Skill：与主代理同款标注（不可信数据）并含内容',
      /【项目 Skills/.test(prompt) && /不可信数据/.test(prompt) && /改动前先跑 check:js/.test(prompt));
    check('C6 运行规则：禁止谎报 + 失败要分析重试 + 不绕道 都在',
      /禁止在回复里声称/.test(prompt) && /分析原因/.test(prompt) && /不要试图绕过/.test(prompt));
    check('C7 任务信息与交付格式齐全',
      /任务编号：task-x/.test(prompt) && /验收条件/.test(prompt) && /上游输入/.test(prompt) &&
      /总时长上限：120 秒/.test(prompt) && /交付格式/.test(prompt) && /未完成事项/.test(prompt));

    const noProject = subagentPrompt.buildSubagentPrompt(task, { role: 'builder', tools });
    check('C8 没有项目 Skill 时不出现空分区（不编造内容）', !/【项目 Skills/.test(noProject));
    const unknownSkill = subagentPrompt.buildSubagentPrompt(
      { taskId: 't', role: 'explorer', objective: 'o', totalTimeoutMs: 1000 },
      { role: 'explorer', tools: [{ name: 'read_file' }] },
    );
    check('C9 只读角色的 prompt 里也不含写工具', !/- write_file/.test(unknownSkill) && !/- edit_file/.test(unknownSkill));
    ok('C prompt 组装：七个分区 + 无项目 Skill / 未知技能 两条边界');
  }

  // ---- D. 真实委派：prompt 工具清单 == 实际可用工具 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-role-skill-'));
  const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: os.tmpdir() });
  sandbox.setDefaultPolicy(policy);
  {
    const cfgBase = {
      apiBase: 'http://scripted.local/v1', apiKey: '', model: 'scripted', maxTokens: 2048, reasoningEffort: '',
      reliability: { maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 2 },
      limits: { maxTotalTokens: 1000000, maxConcurrentRuns: 1 },
      rag: { enabled: false },
    };
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: [] });
    const model = new GraphModel({ root: { nodes: [], edges: [] } });
    const parent = new AgentToolContext({
      projectRoot: root, model, confirm: async () => true, audit: () => {}, askUser: async () => '',
      sandbox: policy, runId: 'run-role-skill', mutateWorkbench: async (fn) => { fn(model); return true; },
    });
    const manager = new SubagentManager({
      agent: { runAgentChat: agent.runAgentChat },
      toolkit,
      cfg: Object.assign({}, cfgBase, { tools: {} }),
      registry,
      runId: 'run-role-skill',
      readProjectSkills: () => [{ name: '项目约定', instructions: '改动前先跑 npm run check:js' }],
    });
    manager.register(registry);

    const stub = installScriptedModel([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { content: '子完成', finishReason: 'stop' },
    ], { loopLast: false });
    fs.writeFileSync(path.join(root, 'a.txt'), 'HELLO\n');
    let res;
    try {
      res = await registry.execute('delegate_task', { role: 'explorer', objective: '看看 a.txt' }, parent);
    } finally {
      stub.restore();
    }
    check('D1 委派成功执行（子代理真的跑起来了）', !!(res && res.ok), String(res && res.text).slice(0, 120));

    const system = String(((stub.seen[0] || {}).messages || [{}])[0].content || '');
    const section = (system.split('【可用工具')[1] || '').split('【')[0];
    const promptTools = (section.match(/^- ([a-z_]+)/gm) || []).map((line) => line.replace('- ', '').trim()).sort();
    const expectedTools = toolkit
      .buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, role: 'explorer', toolsAllowed: [] })
      .listTools()
      .map((spec) => spec.name)
      .sort();
    check('D2 子代理 prompt 里的工具清单 == 它实际能用的工具集（防权限与说明漂移）',
      promptTools.length > 0 && JSON.stringify(promptTools) === JSON.stringify(expectedTools),
      JSON.stringify({ prompt: promptTools.length, actual: expectedTools.length, promptTools: promptTools.slice(0, 4) }));
    check('D3 只读角色的清单里没有写工具（explorer 不得出现 write_file/edit_file）',
      !promptTools.includes('write_file') && !promptTools.includes('edit_file'), promptTools.join(','));
    check('D4 项目 Skill 真的注入到子代理 system（主代理能看到，子代理此前看不到）',
      /改动前先跑 npm run check:js/.test(system), system.length + ' chars');
    check('D5 子代理 system 里带身份与运行规则（不是只有任务描述）',
      /项目探查员/.test(system) && /【运行规则/.test(system) && /【职责技能/.test(system));

    // 越权工具在子代理注册表里直接不可用（能力由注册表强制）
    const childRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, role: 'explorer', toolsAllowed: [] });
    const childContext = parent.fork({ runId: 'run-role-skill', taskId: 't', role: 'explorer', readOnly: true, signal: new AbortController().signal });
    const denied = await childRegistry.execute('write_file', { path: 'x.txt', content: 'x' }, childContext);
    check('D6 子代理调用越权工具被拒（不依赖 prompt 自觉）',
      denied.ok === false && (denied.data.code === 'UNKNOWN_TOOL' || denied.data.code === 'PERMISSION_DENIED' || denied.data.code === 'TOOL_NOT_FOUND'),
      JSON.stringify({ ok: denied.ok, code: denied.data && denied.data.code }));
  }

  // ---- E. 派活对照表 ----
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, toolsAllowed: [] });
    new SubagentManager({ agent: { runAgentChat: async () => ({}) }, toolkit, cfg: { tools: {} }, registry }).register(registry);
    const desc = String(registry.descriptorOf('delegate_task').description || '');
    const missing = roles.ROLE_NAMES.filter((name) => !desc.includes(name) || !desc.includes(roles.roleLabel(name)));
    check('E1 delegate_task 描述里每个角色都带身份名（主代理据此派活）', missing.length === 0, missing.join(','));
    check('E2 描述里带「工作类型」而不仅是角色名（能对上工作与角色）',
      /回答「在哪里/.test(desc) && /跑测试/.test(desc) && /审查/.test(desc), desc.slice(0, 160));
  }

  // ---- F. 只读角色的注册表不含写工具 ----
  {
    for (const role of ['explorer', 'verifier', 'reviewer']) {
      const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false, role, toolsAllowed: [] });
      const names = registry.listTools().map((spec) => spec.name);
      const leaked = names.filter((name) => WRITE_TOOLS.includes(name));
      check('F 只读角色 ' + role + ' 的注册表里没有写工具', leaked.length === 0, leaked.join(','));
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('SUBAGENT ROLE SKILL TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('SUBAGENT ROLE SKILL TEST: ERROR', error);
  process.exit(1);
});
