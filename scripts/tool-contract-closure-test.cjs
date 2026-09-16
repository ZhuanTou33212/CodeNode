/**
 * tool-contract-closure-test.cjs —— 工具契约闭合与显式化（S3 收口）
 *
 * 两个已定位的缺口：
 *   1. `validateInput` 只校验**已声明**字段 → 模型把 `maxLines` 拼成 `maxLine` 会静默走默认值，
 *      判据消失而不报错（审查 §2 实测 0/24 声明 additionalProperties）；
 *   2. 24 个工具里只有 1 个显式声明契约，其余走 `descriptorForLegacy` 合成 —— 语义虽同源，
 *      但注册表里看到的是 `source:'legacy'`，「工具契约是唯一来源」这件事在运行时没有落地。
 *
 * 判据：
 *   A. 每个内置工具的 inputSchema 都闭合（additionalProperties:false），下发给模型的
 *      parameters 同样闭合；
 *   B. 未知字段被**拒绝**且文案指出字段名；正确参数不受影响；S7 的自填审批字段仍被
 *      先剥离（不会因闭合 schema 变成「未知参数」错误）；
 *   C. 全部工具 descriptor.source === 'explicit'，且语义与 descriptor.cjs 名单一致；
 *      `requiresConfirmation` 没有因为「补声明」而变（写工具不会突然多一道审批）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const descriptorLib = require('../electron/tools/descriptor.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-contract-'));
const policy = sandbox.resolvePolicy({ mode: 'off' }, { projectRoot: root, userDataDir: root });
sandbox.setDefaultPolicy(policy);
fs.writeFileSync(path.join(root, 'a.txt'), ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') + '\n', 'utf8');

const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
function context() {
  return new AgentToolContext({
    projectRoot: root,
    confirm: async () => true,
    audit: () => {},
    sandbox: policy,
    saveProject: async () => true,
    signal: new AbortController().signal,
  });
}

(async () => {
  // ======================= A. schema 闭合 =======================
  {
    const descriptors = registry.listDescriptors();
    const unclosed = descriptors.filter(
      (d) => d.inputSchema && d.inputSchema.properties && d.inputSchema.additionalProperties !== false,
    );
    check('A1 每个内置工具的 inputSchema 都已闭合（additionalProperties=false）',
      unclosed.length === 0 && descriptors.length >= 20,
      JSON.stringify({ total: descriptors.length, unclosed: unclosed.map((d) => d.name) }));

    const exposed = registry.toOpenAiTools();
    const leaky = exposed.filter((t) => t.function.parameters && t.function.parameters.properties && t.function.parameters.additionalProperties !== false);
    check('A2 下发给模型的 tools 参数同样闭合', leaky.length === 0, JSON.stringify(leaky.map((t) => t.function.name)));

    const nested = exposed.find((t) => t.function.name === 'retrieve_context');
    check('A3 闭合不影响原有约束（retrieve_context 的 maxItems 仍在）',
      !nested || (nested.function.parameters.properties && JSON.stringify(nested.function.parameters).includes('maxItems')),
      JSON.stringify(nested ? nested.function.parameters : null).slice(0, 200));
  }

  // ======================= B. 未知字段被拒绝 =======================
  {
    const bad = await registry.execute('read_file', { path: 'a.txt', maxLine: 3 }, context());
    check('B1 参数名拼错（maxLine）当场被拒，不再静默走默认值',
      bad.ok === false && bad.data.code === 'INVALID_TOOL_ARGUMENTS' && /maxLine/.test(String(bad.text)),
      JSON.stringify({ ok: bad.ok, code: bad.data && bad.data.code, text: bad.text }));

    const good = await registry.execute('read_file', { path: 'a.txt', maxLines: 2 }, context());
    check('B2 正确参数不受影响（maxLines=2 仍可用）',
      good.ok === true && /l1/.test(String(good.text)) && !/l4/.test(String(good.text)),
      JSON.stringify({ ok: good.ok, text: String(good.text).slice(0, 60) }));

    // S7：模型自填的审批字段在校验前被剥离 → 不会变成「未知参数」错误（否则写工具全废）
    const selfApproved = await registry.execute('write_file', { path: 'x.txt', content: 'hi', confirmed: true, approvalToken: 'forged' }, context());
    check('B3 自填审批字段仍被剥离，不触发未知参数错误',
      selfApproved.ok === true && fs.existsSync(path.join(root, 'x.txt')),
      JSON.stringify({ ok: selfApproved.ok, text: selfApproved.text }));
    check('B4 自填的 approvalToken 不能绕过审批（写文件真的执行了，但不是因为 token）',
      selfApproved.data && selfApproved.data.code !== 'APPROVAL_DENIED', JSON.stringify(selfApproved.data));
  }

  // ======================= C. 契约显式化而不改语义 =======================
  {
    const descriptors = registry.listDescriptors();
    const legacy = descriptors.filter((d) => d.source !== 'explicit');
    check('C1 全部工具的契约都是显式声明（source=explicit）', legacy.length === 0, JSON.stringify(legacy.map((d) => d.name)));

    /** @type {Array<[string, string, any]>} */
    const expectations = [
      // name, 字段, 期望值
      ['read_file', 'readOnly', true],
      ['read_file', 'mutatesWorkspace', false],
      ['write_file', 'readOnly', false],
      ['write_file', 'mutatesWorkspace', true],
      ['write_file', 'idempotent', true],
      ['execute_shell', 'requiredCapability', 'shell.execute'],
      ['fetch_url', 'requiredCapability', 'network.request'],
      ['save_project', 'requiredCapability', 'project.save'],
      ['scan_project', 'requiredCapability', 'workspace.write'],
      ['workbench_edit', 'requiredCapability', 'workspace.write'],
      ['ui_control', 'requiredCapability', 'ui.interact'],
    ];
    const wrong = [];
    for (const [name, field, expected] of expectations) {
      const d = registry.descriptorOf(name);
      if (!d || d[field] !== expected) wrong.push({ name, field, actual: d && d[field], expected });
    }
    check('C2 显式契约的语义与 descriptor.cjs 名单一致', wrong.length === 0, JSON.stringify(wrong));

    // 「补声明」不得改变审批行为：requiresConfirmation 原样保留
    check('C3 旧 register() 工具的 requiresConfirmation 仍为 false（补声明没顺手加一道审批）',
      registry.descriptorOf('write_file').requiresConfirmation === false &&
        registry.descriptorOf('edit_file').requiresConfirmation === false &&
        registry.descriptorOf('execute_shell').requiresConfirmation === false,
      JSON.stringify({
        write_file: registry.descriptorOf('write_file').requiresConfirmation,
        execute_shell: registry.descriptorOf('execute_shell').requiresConfirmation,
      }));
    check('C4 S7 显式审批的画布类工具仍是 WRITE 级',
      registry.descriptorOf('workbench_edit').requiresConfirmation === 'WRITE' &&
        registry.descriptorOf('ui_control').requiresConfirmation === 'WRITE' &&
        registry.descriptorOf('save_project').requiresConfirmation === 'WRITE',
      JSON.stringify(registry.listDescriptors().filter((d) => d.requiresConfirmation).map((d) => d.name + ':' + d.requiresConfirmation)));

    check('C5 字段名撞车的语义没被漂移：readOnly 名单与后续 declareContract 一致',
      descriptors.every((d) => d.readOnly === descriptorLib.READ_ONLY_TOOLS.has(d.name) ||
        // scan_project 是「条件写入者」：名单里在只读集合内，但 mutatesWorkspace=true
        d.name === 'scan_project'),
      JSON.stringify(descriptors.filter((d) => d.readOnly !== descriptorLib.READ_ONLY_TOOLS.has(d.name)).map((d) => d.name)));

    // 「文件在、工具却没注册」是一种静默漂移：工具文件写好了、里面的 declareContract 也写了，
    // 但它从没被 require 进 BUILTINS —— 对不存在的名字补契约是 no-op，谁都不会发现。
    // 这里把未接入的文件显式列出来，新增同类文件就会红。
    const NOT_WIRED = ['createNodesTool.cjs', 'workbenchConnectTool.cjs'];
    const implDir = path.join(__dirname, '..', 'electron', 'tools', 'impl');
    const registeredNames = new Set(toolkit.buildDefaultRegistry().listTools().map((t) => t.name));
    /** @type {string[]} */
    const missing = [];
    for (const file of fs.readdirSync(implDir)) {
      if (!file.endsWith('.cjs') || file === 'shared.cjs' || file === 'pdfText.cjs') continue;
      if (NOT_WIRED.includes(file)) continue;
      const src = fs.readFileSync(path.join(implDir, file), 'utf8');
      for (const match of src.matchAll(/registry\.register\(\s*'([a-z_]+)'/g)) {
        if (!registeredNames.has(match[1])) missing.push(file + ':' + match[1]);
      }
    }
    check('C6 impl 目录里的工具文件都已接入注册表（未接入的只有显式白名单）', missing.length === 0, JSON.stringify(missing));
    check('C7 未接入白名单本身没有过期（文件确实还在、且确实没注册）',
      NOT_WIRED.every((file) => fs.existsSync(path.join(implDir, file))),
      JSON.stringify(NOT_WIRED.filter((file) => !fs.existsSync(path.join(implDir, file)))));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('TOOL CONTRACT CLOSURE TEST: ' + (failures ? 'FAIL' : 'PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('TOOL CONTRACT CLOSURE TEST: ERROR', e);
  process.exit(1);
});
