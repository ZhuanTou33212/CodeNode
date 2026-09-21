/**
 * tool-descriptor-test.cjs —— 工具契约（ToolDescriptor）与注册表按契约执行
 *
 * 审查第 3 项：工具的语义（只读吗/会改工作区吗/要确认吗/需要什么能力/超时/缓存/并行）
 * 此前散落在 5 份硬编码名单里，同一个工具要在多处各维护一遍。现在收敛成 descriptor.cjs 一份，
 * 并且注册表真的**按契约执行**：只读守卫、能力（网络）守卫、确认门、契约超时。
 *
 * 判据落在真实终态：文件有没有被创建/改写、工具是否真的被执行、耗时是否真的被超时截断。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const descriptorLib = require('../electron/tools/descriptor.cjs');
const { AgentToolRegistry } = require('../electron/tools/registry.cjs');
const { AgentToolResult } = require('../electron/tools/result.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const agent = require('../electron/agent.cjs');

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? ' :: ' + detail : ''));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-descriptor-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'CONTENT-A\n');
const sentinel = 'SENTINEL-DO-NOT-OVERWRITE\n';
fs.writeFileSync(path.join(root, 'workflow.cnode'), sentinel);

/**
 * 两个策略：`policyOff` = 隔离关闭**且网络未切断**（D3 的语义是「网络没被切时不一刀切」，
 * 所以必须显式给 network: 'inherit' —— 2026-09-21 起出厂口径是 deny，"不写 network" 不再等于不切网）；
 * `policyNoNet` = 显式切断网络的 best-effort。
 */
const policyOff = sandbox.resolvePolicy({ mode: 'off', network: 'inherit' }, { projectRoot: root, userDataDir: os.tmpdir() });
const policyNoNet = sandbox.resolvePolicy({ mode: 'best-effort', network: 'deny' }, { projectRoot: root, userDataDir: os.tmpdir() });
sandbox.setDefaultPolicy(policyOff);

function makeContext(options = {}) {
  return new AgentToolContext({
    projectRoot: root,
    model: null,
    sandbox: options.policy || policyOff,
    readOnly: options.readOnly === true,
    confirm: options.confirm,
    audit: () => {},
    saveProject: options.saveProject,
  });
}

const REGISTRY_KEYS = [
  'name', 'version', 'description', 'inputSchema', 'outputSchema',
  'readOnly', 'idempotent', 'mutatesWorkspace', 'requiresConfirmation', 'requiredCapability',
  'timeoutMs', 'cachePolicy', 'retryPolicy', 'concurrencyPolicy', 'roleAllowlist',
];

(async () => {
  // ======================= A. 契约语义（纯函数） =======================
  {
    assert.throws(() => descriptorLib.normalizeDescriptor({}), /缺少 name/);
    const bare = descriptorLib.normalizeDescriptor({ name: 'x' });
    check('A1 缺省一律保守：未声明只读 = 可写 + 会改工作区 + 不幂等 + 不要确认',
      bare.readOnly === false && bare.mutatesWorkspace === true && bare.idempotent === false &&
      bare.requiresConfirmation === false && bare.confirmationEnforced === false,
      JSON.stringify({ readOnly: bare.readOnly, mutates: bare.mutatesWorkspace, idem: bare.idempotent }));
    check('A2 缺省缓存策略 none、重试 1 次、不并行', bare.cachePolicy.mode === 'none' && bare.retryPolicy.maxAttempts === 1 && bare.concurrencyPolicy.parallelSafe === false);
    check('A3 requiresConfirmation:true 归一成 WRITE 级别', descriptorLib.normalizeDescriptor({ name: 'x', requiresConfirmation: true }).requiresConfirmation === 'WRITE');

    const legacyRead = descriptorLib.descriptorForLegacy('read_file', 'r', { type: 'object' });
    const legacyWrite = descriptorLib.descriptorForLegacy('write_file', 'w', { type: 'object' });
    const legacyShell = descriptorLib.descriptorForLegacy('execute_shell', 's', { type: 'object' });
    const legacyCanvas = descriptorLib.descriptorForLegacy('get_workbench_model', 'g', { type: 'object' });
    const unknownExt = descriptorLib.descriptorForLegacy('some_project_extension', 'e', { type: 'object' });
    check('A4 read_file：只读 + 可缓存 + 可并行 + workspace.read',
      legacyRead.readOnly === true && legacyRead.cachePolicy.mode === 'run' && legacyRead.concurrencyPolicy.parallelSafe === true &&
      legacyRead.requiredCapability === 'workspace.read' && legacyRead.mutatesWorkspace === false,
      JSON.stringify(descriptorLib.describeDescriptor(legacyRead)));
    check('A5 write_file：可写 + 幂等（按内容写）+ 不并行 + workspace.write',
      legacyWrite.readOnly === false && legacyWrite.idempotent === true && legacyWrite.concurrencyPolicy.parallelSafe === false &&
      legacyWrite.requiredCapability === 'workspace.write');
    check('A6 execute_shell：自管超时（timeoutMs=0）+ shell.execute 能力',
      legacyShell.timeoutMs === 0 && legacyShell.requiredCapability === 'shell.execute');
    check('A7 get_workbench_model：只读但**不进缓存**、不可并行（画布是权威读源）',
      legacyCanvas.readOnly === true && legacyCanvas.cachePolicy.mode === 'none' && legacyCanvas.concurrencyPolicy.parallelSafe === false);
    check('A8 未登记的外部工具（扩展/MCP）按最保守能力处理：shell.execute + 可写',
      unknownExt.readOnly === false && unknownExt.requiredCapability === 'shell.execute' && unknownExt.mutatesWorkspace === true);
    check('A9 旧接口合成的契约不做注册表级确认（避免行为突变）', legacyWrite.requiresConfirmation === false && legacyWrite.confirmationEnforced === false);
    check('A10 名单只有一份来源：agent.cjs 与 descriptor.cjs 是同一个对象',
      agent.CACHEABLE_TOOLS === descriptorLib.CACHEABLE_TOOLS && agent.SCALAR_BACKED_TOOLS === descriptorLib.SCALAR_BACKED_TOOLS &&
      agent.MUTATION_TOOLS === descriptorLib.MUTATION_TOOLS);
    check('A11 describeDescriptor 输出 UI/审计需要的摘要字段',
      ['name', 'version', 'readOnly', 'idempotent', 'mutatesWorkspace', 'requiresConfirmation', 'requiredCapability', 'timeoutMs', 'cacheMode', 'parallelSafe', 'source']
        .every((k) => Object.prototype.hasOwnProperty.call(descriptorLib.describeDescriptor(legacyRead), k)));
  }

  // ======================= B. 注册表：契约完整性 =======================
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: true });
    const specs = registry.listTools();
    const descriptors = registry.listDescriptors();
    check('B1 每个注册工具都有契约，且字段齐全', specs.length === descriptors.length && descriptors.length >= 24 &&
      descriptors.every((d) => REGISTRY_KEYS.every((k) => d[k] !== undefined)), JSON.stringify({ specs: specs.length, descriptors: descriptors.length }));
    check('B2 契约顺序与工具顺序一致（UI 可对照）', descriptors.every((d, i) => d.name === specs[i].name));
    check('B3 describeAll() 与 listDescriptors() 一一对应', registry.describeAll().length === descriptors.length &&
      registry.describeAll().every((s, i) => s.name === descriptors[i].name));
    check('B4 只读工具确实都在 READ_ONLY_TOOLS 里（含 retrieve_context / get_workbench_model / poll_job）',
      ['read_file', 'retrieve_context', 'get_workbench_model', 'poll_job', 'query_scalars'].every((n) => registry.descriptorOf(n).readOnly === true),
      JSON.stringify(['read_file', 'retrieve_context', 'get_workbench_model', 'poll_job', 'query_scalars'].map((n) => registry.descriptorOf(n).readOnly)));
    check('B5 写工具都不是只读（fail-closed：未声明即 write）',
      ['write_file', 'edit_file', 'bulk_edit', 'workbench_edit', 'save_project', 'execute_shell', 'ui_control'].every((n) => registry.descriptorOf(n).readOnly === false));
    check('B6 save_project 是显式契约（唯一行为有变化：执行前需用户确认）',
      registry.descriptorOf('save_project').source === 'explicit' && registry.descriptorOf('save_project').requiresConfirmation === 'WRITE' &&
      registry.descriptorOf('save_project').confirmationEnforced === true);
    check('B7 execute_shell / poll_job 自管超时（timeoutMs=0），避免注册表和工具各设一层超时',
      registry.descriptorOf('execute_shell').timeoutMs === 0 && registry.descriptorOf('poll_job').timeoutMs === 0,
      JSON.stringify({ shell: registry.descriptorOf('execute_shell').timeoutMs, poll: registry.descriptorOf('poll_job').timeoutMs }));
    check('B7b 未声明超时的工具 timeoutMs=null（= 用注册表兜底，不是 0=不限时）',
      registry.descriptorOf('read_file').timeoutMs === null && registry.descriptorOf('write_file').timeoutMs === null,
      JSON.stringify({ read: registry.descriptorOf('read_file').timeoutMs, write: registry.descriptorOf('write_file').timeoutMs }));
    check('B8 未注册工具契约查询返回 null', registry.descriptorOf('nope') === null);
  }

  // ======================= C. 注册表：按契约执行 =======================
  {
    const registry = new AgentToolRegistry();
    let ran = 0;
    registry.register('legacy_write', '旧接口写工具', { type: 'object', properties: {} }, async () => {
      ran += 1;
      return AgentToolResult.ok('ran');
    });
    // 显式声明只读的工具：只读上下文里必须放行
    registry.registerDescriptor(
      { name: 'explicit_read', description: '显式只读', inputSchema: { type: 'object', properties: {} }, readOnly: true },
      async () => AgentToolResult.ok('read')
    );

    const readOnlyContext = makeContext({ readOnly: true });
    const blocked = await registry.execute('legacy_write', {}, readOnlyContext);
    check('C1 只读上下文里执行写工具被拒（PERMISSION_DENIED）且工具没被调用',
      blocked.ok === false && blocked.data.code === 'PERMISSION_DENIED' && ran === 0, JSON.stringify({ ok: blocked.ok, code: blocked.data.code, ran }));
    const allowedRead = await registry.execute('explicit_read', {}, readOnlyContext);
    check('C2 只读上下文里声明只读的工具照常执行', allowedRead.ok === true && allowedRead.text === 'read');
    // 名单里没有的工具（例如项目扩展）走旧接口注册 → 契约里 readOnly=false（fail-closed），
    // 在只读上下文里必须被拦下，哪怕它的实现其实是只读的
    registry.register('legacy_unlisted', '旧接口未登记工具', { type: 'object', properties: {} }, async () => AgentToolResult.ok('read'));
    const legacyUnknown = await registry.execute('legacy_unlisted', {}, readOnlyContext);
    check('C2b 旧接口注册、只读名单里没有的工具在只读上下文里被拒（fail-closed：未声明即 write）',
      legacyUnknown.ok === false && legacyUnknown.data.code === 'PERMISSION_DENIED', JSON.stringify({ ok: legacyUnknown.ok, code: legacyUnknown.data.code }));

    // 角色白名单明确授予的写工具不能被只读守卫误伤（verifier 要能跑 execute_shell 才有验证能力）
    // S9：判据从「白名单里有这个名字」升级为「角色契约（tools/roles.cjs）显式授予的能力」——
    // 「只有白名单、没有角色能力」时必须被拒，那条负向用例在 subagent-isolation-test 的 B 段。
    const roleRegistry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
    roleRegistry.allowedTools = new Set(['execute_shell']);
    roleRegistry.roleCapabilities = new Set(require('../electron/tools/roles.cjs').roleCapabilities('verifier'));
    // verifier 是只读角色，但它的角色白名单里有 execute_shell（跑测试/验证的核心能力），
    // 且 node 命令属于 HIGH 敏感 → 这里显式批准确认，验证「角色授予的写工具不被只读守卫误伤」
    const verifierContext = makeContext({ readOnly: true, confirm: async () => true });
    const shellRes = await roleRegistry.execute('execute_shell', { command: 'node -e "console.log(1)"', timeoutSeconds: 30 }, verifierContext);
    check('C3 角色白名单授予的 execute_shell 在只读上下文里仍可执行（verifier 不被误伤）',
      shellRes.ok === true && /1/.test(String(shellRes.text)), JSON.stringify({ ok: shellRes.ok, text: String(shellRes.text).slice(0, 60) }));
    const stillBlocked = await roleRegistry.execute('write_file', { path: 'x.txt', content: 'x' }, verifierContext);
    check('C4 未授予的写工具（write_file）依然被拒（角色白名单先拦），且文件没被创建',
      stillBlocked.ok === false && /无权使用/.test(String(stillBlocked.text)) && !fs.existsSync(path.join(root, 'x.txt')),
      JSON.stringify({ ok: stillBlocked.ok, text: String(stillBlocked.text).slice(0, 60) }));
    // 角色白名单为空集合：角色门先拦（不到工具体、也到不了只读守卫）
    const noGrant = new AgentToolRegistry({ allowedTools: [] });
    noGrant.register('legacy_write2', '写', { type: 'object', properties: {} }, async () => { ran += 1; return AgentToolResult.ok('ran'); });
    const guardOnly = await noGrant.execute('legacy_write2', {}, readOnlyContext);
    check('C4b 角色白名单为空 → 角色门先拒（与只读守卫互为兜底，且工具体没被执行）',
      guardOnly.ok === false && /无权使用/.test(String(guardOnly.text)) && ran === 0, JSON.stringify({ ok: guardOnly.ok, text: String(guardOnly.text).slice(0, 50), ran }));
  }

  // ======================= D. 能力门：网络被切断时不放行 network.request =======================
  {
    const registry = new AgentToolRegistry();
    let fetched = 0;
    registry.register('fetch_url', '伪装抓取', { type: 'object', properties: {} }, async () => { fetched += 1; return AgentToolResult.ok('fetched'); });
    registry.register('read_local', '本地只读工具', { type: 'object', properties: {} }, async () => AgentToolResult.ok('local-read'));
    const denyRes = await registry.execute('fetch_url', {}, makeContext({ policy: policyNoNet }));
    check('D1 sandbox.network=deny 时 network.request 工具被直接拒绝，且没有真的发起请求',
      denyRes.ok === false && denyRes.data.code === 'PERMISSION_DENIED' && denyRes.data.capability === 'network.request' && fetched === 0,
      JSON.stringify({ ok: denyRes.ok, code: denyRes.data.code, capability: denyRes.data.capability, fetched }));
    check('D2 拒绝文案点明是隔离策略切断网络', /网络/.test(String(denyRes.text)) && /deny/.test(String(denyRes.text)), String(denyRes.text));
    const netOk = await registry.execute('fetch_url', {}, makeContext({ policy: policyOff }));
    check('D3 未切断网络时该工具照常执行（不是把所有网络工具一刀切）', netOk.ok === true && fetched === 1);
    const readUnderDeny = await registry.execute('read_local', {}, makeContext({ policy: policyNoNet }));
    check('D4 只读工具不受网络策略影响（deny 只拦 network.request，不一刀切）', readUnderDeny.ok === true && readUnderDeny.text === 'local-read');
  }

  // ======================= E. 契约超时 =======================
  {
    const registry = new AgentToolRegistry();
    let finished = 0;
    registry.register('never_returns', '永不返回', { type: 'object', properties: {} }, () => new Promise(() => {}));
    registry.registerDescriptor(
      { name: 'self_unlimited', description: '显式声明不受注册表超时限制', inputSchema: { type: 'object', properties: {} }, readOnly: true, timeoutMs: 0 },
      async () => { await new Promise((r) => setTimeout(r, 300)); finished += 1; return AgentToolResult.ok('slow-but-allowed'); }
    );
    registry.setDefaultTimeoutMs(150);
    const t0 = Date.now();
    const timedOut = await registry.execute('never_returns', {}, makeContext());
    const elapsed = Date.now() - t0;
    check('E1 未声明超时的工具按注册表兜底超时被截断（code=TIMEOUT）',
      timedOut.ok === false && timedOut.data.code === 'TIMEOUT' && timedOut.data.timeoutMs === 150, JSON.stringify({ ok: timedOut.ok, data: timedOut.data }));
    check('E2 超时真的生效（约 150ms 返回，不再傻等）', elapsed >= 100 && elapsed < 3000, elapsed + 'ms');
    const unlimited = await registry.execute('self_unlimited', {}, makeContext());
    check('E3 显式 timeoutMs=0 的工具不受兜底超时限制', unlimited.ok === true && finished === 1 && unlimited.text === 'slow-but-allowed');
    check('E4 setDefaultTimeoutMs 只接受非负数字', registry.setDefaultTimeoutMs(-5) === descriptorLib.DEFAULT_TIMEOUT_MS && registry.setDefaultTimeoutMs(900) === 900);
  }

  // ======================= F. 确认门（只对显式声明生效） =======================
  {
    const registry = toolkit.buildDefaultRegistryWithConfig({ projectRoot: root, ragEnabled: false });
    const confirmCalls = [];
    // 裸对象：没有任何可询问用户的通道（真实 app 里 context.confirm 一定存在，
    // 这个分支覆盖的是「没有 UI 桥」的场景，例如离屏调用 / 测试环境）
    const noConfirmContext = { projectRoot: () => root };
    const refused = await registry.execute('save_project', {}, noConfirmContext);
    check('F1 显式声明需要确认的工具，在无法询问用户时拒绝执行（APPROVAL_REQUIRED）',
      refused.ok === false && refused.data.code === 'APPROVAL_REQUIRED' && refused.data.userActionRequired === true,
      JSON.stringify({ ok: refused.ok, code: refused.data.code }));
    check('F2 拒绝后工程文件一个字节都没被改写（哨兵内容仍在）',
      fs.readFileSync(path.join(root, 'workflow.cnode'), 'utf8') === sentinel, fs.readFileSync(path.join(root, 'workflow.cnode'), 'utf8').slice(0, 40));

    let saved = 0;
    const deniedContext = makeContext({
      confirm: async (level, what) => { confirmCalls.push({ level, what }); return false; },
      saveProject: async () => { saved += 1; return path.join(root, 'workflow.cnode'); },
    });
    const denied = await registry.execute('save_project', {}, deniedContext);
    check('F3 用户不批准 → 工具不执行（APPROVAL_DENIED，副作用计数为 0）',
      denied.ok === false && denied.data.code === 'APPROVAL_DENIED' && saved === 0, JSON.stringify({ ok: denied.ok, code: denied.data.code, saved }));
    check('F4 确认请求带上了 WRITE 级别与工具名', confirmCalls.length === 1 && confirmCalls[0].level === 'WRITE' && confirmCalls[0].what === 'save_project',
      JSON.stringify(confirmCalls));

    const approvedContext = makeContext({
      confirm: async () => true,
      saveProject: async () => { saved += 1; return path.join(root, 'workflow.cnode'); },
    });
    const approved = await registry.execute('save_project', {}, approvedContext);
    check('F5 用户批准 → 正常执行', approved.ok === true && saved === 1 && approved.data.filePath.endsWith('workflow.cnode'), JSON.stringify({ ok: approved.ok, saved }));

    // 旧 register() 的写工具不会被注册表级确认拦下：用一个「内部不自我确认」的旧接口写工具验证——
    // 上下文里没有 confirm 通道，若注册表加了门就会 APPROVAL_REQUIRED；实际必须正常执行（行为未突变）
    const legacyRegistry = new AgentToolRegistry();
    legacyRegistry.register('legacy_writer', '旧接口写工具（不自我确认）', { type: 'object', properties: { path: { type: 'string' } } }, async (ctx) => {
      fs.writeFileSync(path.join(ctx.projectRoot(), 'legacy-ok.txt'), 'L\n');
      return AgentToolResult.ok('wrote');
    });
    const legacyWrite = await legacyRegistry.execute('legacy_writer', { path: 'legacy-ok.txt' }, { projectRoot: () => root });
    check('F6 旧 register() 合成的契约（requiresConfirmation=false）不触发注册表级确认（S7 起画布类写工具改用 declareContract 显式声明）',
      legacyWrite.ok === true && fs.readFileSync(path.join(root, 'legacy-ok.txt'), 'utf8') === 'L\n',
      JSON.stringify({ ok: legacyWrite.ok, text: String(legacyWrite.text).slice(0, 40) }));
  }

  console.log(failures === 0 ? 'TOOL DESCRIPTOR TEST: PASS' : 'TOOL DESCRIPTOR TEST: FAIL (' + failures + ')');
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((error) => {
  console.error('TOOL DESCRIPTOR TEST: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
