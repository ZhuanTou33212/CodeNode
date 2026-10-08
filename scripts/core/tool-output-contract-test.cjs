'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentToolRegistry } = require("../../electron/tools/registry.cjs");
const { AgentToolResult } = require("../../electron/tools/result.cjs");
const { AgentToolContext } = require("../../electron/tools/context.cjs");
const { normalizeOutputSchema, validateOutput } = require("../../electron/tools/outputSchema.cjs");
const { SideEffectLedger, createGuard } = require("../../electron/sideEffects.cjs");
const { installScriptedModel } = require("../lib/scripted-model.cjs");
const agent = require("../../electron/agent.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-output-contract-'));
const payloadSchema = {
  type: 'object', required: ['count', 'file'], additionalProperties: false,
  properties: { count: { type: 'integer', minimum: 0 }, file: { type: ['string', 'null'] } },
};
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
function registerResult(result, descriptor = {}) {
  const registry = new AgentToolRegistry();
  registry.registerDescriptor({ name: 'output_probe', readOnly: true, outputSchema: payloadSchema, ...descriptor }, async () => result);
  return registry;
}
const context = new AgentToolContext({ projectRoot: root, confirm: async () => true });

async function runScript(registry, guardedContext, calls) {
  const model = installScriptedModel([...calls.map((call, i) => ({ toolCalls: [{ id: 'output-' + i, ...call }] })), { content: 'Stopped after inspecting tool outcomes.' }], { loopLast: true });
  try {
    return await agent.runAgentChat({
      cfg: {
        apiBase: 'http://scripted.local/v1', apiKey: 'scripted', model: 'scripted-model', maxTokens: 2048,
        reliability: { maxAttempts: 1 }, limits: { maxTotalTokens: 1000000, maxToolIterations: 6 },
        compression: { enabled: false }, rag: { enabled: false }, tools: {},
      },
      messages: [{ role: 'user', content: 'Execute the requested file operation and report the tool outcome.' }],
      tools: { registry, context: guardedContext }, timeoutMs: 10000,
    });
  } finally { model.restore(); }
}

(async () => {
  await test('schema validates successful data and preserves the exact envelope/projection', async () => {
    const result = AgentToolResult.ok('separate display text', { count: 1, file: null }, { modelContent: 'compact view' });
    assert.equal(await registerResult(result).execute('output_probe', {}, context), result);
  });
  await test('schema failures report field location and never forward invalid success text', async () => {
    const result = await registerResult(AgentToolResult.ok('FALSE SUCCESS', { count: '1', file: null })).execute('output_probe', {}, context);
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'SYSTEM_ERROR');
    assert.equal(result.failure.retryable, false);
    assert.equal(result.data.outputValidation.path, '$.data.count');
    assert.equal(result.data.contractCode, 'INVALID_TOOL_OUTPUT');
    assert.equal(result.data.sideEffectStatus, 'none');
    assert.doesNotMatch(JSON.stringify(result), /FALSE SUCCESS/);
  });
  await test('required nullable output is valid but missing required data is rejected', async () => {
    const valid = normalizeOutputSchema(payloadSchema);
    assert.equal(validateOutput({ count: 1, file: null }, valid), null);
    assert.equal(validateOutput({ count: 1 }, valid).keyword, 'required');
    assert.equal(validateOutput({ count: 1, file: null, extra: true }, valid).path, '$.data.extra');
  });
  await test('existing failures retain original category, retry policy, and non-success data', async () => {
    const failure = AgentToolResult.failure('APPROVAL_DENIED', 'denied', { reason: 'permission' });
    assert.equal(await registerResult(failure).execute('output_probe', {}, context), failure);
    const legacy = AgentToolResult.error('network issue', { code: 'TIMEOUT', other: 4 });
    assert.equal(await registerResult(legacy).execute('output_probe', {}, context), legacy);
  });
  await test('partial results are validated without promoting them to full success', async () => {
    const partialSchema = { ...payloadSchema, additionalProperties: true };
    const partial = AgentToolResult.partial('some results', { count: 2, file: null }, [{ unit: 'x', failure: { code: 'TIMEOUT' } }]);
    assert.equal(await registerResult(partial, { outputSchema: partialSchema }).execute('output_probe', {}, context), partial);
    const bad = AgentToolResult.partial('some results', { count: 'bad', file: null }, []);
    assert.equal((await registerResult(bad, { outputSchema: partialSchema }).execute('output_probe', {}, context)).ok, false);
  });
  await test('conflicting success/error markers and malformed envelopes fail closed', async () => {
    for (const result of [null, undefined, {}, { count: 1 }, { ok: true, text: 'x', data: { count: 1, file: null }, kind: 'failure' }, { ok: true, text: 'x', data: { count: 1, file: null }, isError: true }]) {
      assert.equal((await registerResult(result).execute('output_probe', {}, context)).ok, false);
    }
  });
  await test('none and missing output contracts preserve existing tools', async () => {
    const original = AgentToolResult.ok('legacy', { oldShape: 1 });
    for (const schema of [undefined, null, 'none']) {
      const registry = registerResult(original, { outputSchema: schema });
      assert.equal(registry.descriptorOf('output_probe').outputSchema, null);
      assert.equal(await registry.execute('output_probe', {}, context), original);
    }
  });
  await test('boolean schemas retain their JSON Schema meanings', async () => {
    assert.equal((await registerResult(AgentToolResult.ok('ok', { anything: 1 }), { outputSchema: true }).execute('output_probe', {}, context)).ok, true);
    assert.equal((await registerResult(AgentToolResult.ok('ok', {}), { outputSchema: false }).execute('output_probe', {}, context)).ok, false);
  });
  await test('declareContract takes effect and validates before replacing a contract', async () => {
    const registry = registerResult(AgentToolResult.ok('x', { count: 'bad' }), { outputSchema: null });
    assert.equal((await registry.execute('output_probe', {}, context)).ok, true);
    registry.declareContract('output_probe', { outputSchema: payloadSchema });
    assert.equal((await registry.execute('output_probe', {}, context)).ok, false);
    assert.throws(() => registry.declareContract('output_probe', { outputSchema: { type: 'wombat' } }), /type/);
    assert.equal((await registry.execute('output_probe', {}, context)).ok, false);
  });
  await test('schema contracts are immutable snapshots of the registration input', async () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' } } };
    const registry = registerResult(AgentToolResult.ok('x', { count: 'bad' }), { outputSchema: schema });
    schema.properties.count.type = 'string';
    assert.equal((await registry.execute('output_probe', {}, context)).ok, false);
    assert.equal(Object.isFrozen(registry.descriptorOf('output_probe').outputSchema.properties.count), true);
  });
  await test('unsupported or malformed schemas are rejected before execution', async () => {
    for (const schema of [{ format: 'email' }, { required: 'id' }, { minItems: -1 }, { pattern: '[' }, { $ref: 'https://example.com/schema' }, { $ref: '#/missing' }, { anyOf: [] }]) {
      assert.throws(() => registerResult(null, { outputSchema: schema }));
    }
  });
  await test('nested refs, branch conditions, and exact object enum comparisons work', async () => {
    const schema = normalizeOutputSchema({
      $defs: { id: { type: 'integer', minimum: 1 } }, type: 'object', required: ['id', 'kind'],
      properties: { id: { $ref: '#/$defs/id' }, kind: { enum: ['file', 'empty'] } },
      if: { properties: { kind: { const: 'file' } } }, then: { required: ['path'] }, else: { not: { required: ['path'] } },
      allOf: [{ anyOf: [{ properties: { id: { maximum: 9 } } }, { properties: { id: { minimum: 20 } } }] }],
    });
    assert.equal(validateOutput({ id: 1, kind: 'file', path: 'x' }, schema), null);
    assert.equal(validateOutput({ id: 1, kind: 'empty' }, schema), null);
    assert.notEqual(validateOutput({ id: 1, kind: 'file' }, schema), null);
    assert.notEqual(validateOutput({ id: 15, kind: 'empty' }, schema), null);
    assert.notEqual(validateOutput({ id: 0, kind: 'empty' }, schema), null);
    assert.equal(validateOutput({ b: 2, a: 1 }, normalizeOutputSchema({ enum: [{ a: 1, b: 2 }] })), null);
    assert.equal(validateOutput(1, normalizeOutputSchema({ oneOf: [{ type: 'integer' }, { type: 'number' }] })).keyword, 'oneOf');
  });
  await test('array/string/numeric bounds and typed additional fields are enforced', async () => {
    const cases = [
      [{ type: 'array', items: { type: 'integer' } }, [1, 'bad']],
      [{ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 1 }]],
      [{ type: 'array', prefixItems: [{ type: 'string' }], items: false }, ['first', 'extra']],
      [{ type: 'array', contains: { const: 2 }, minContains: 2 }, [1, 2]],
      [{ type: 'object', additionalProperties: { type: 'integer' } }, { x: 'wrong' }],
      [{ type: 'object', patternProperties: { '^x': { type: 'number' } } }, { x1: 'wrong' }],
      [{ type: 'string', minLength: 2 }, 'x'], [{ type: 'string', pattern: '^good' }, 'bad'],
      [{ type: 'number', exclusiveMinimum: 2 }, 2], [{ type: 'number', multipleOf: 2 }, 3],
    ];
    for (const [schema, value] of cases) assert.notEqual(validateOutput(value, normalizeOutputSchema(schema)), null);
    assert.equal(validateOutput('😀', normalizeOutputSchema({ type: 'string', maxLength: 1 })), null);
    // Output lists do not inherit the model-input default maxItems=1000.
    assert.equal(validateOutput(Array.from({ length: 1100 }, (_, i) => i), normalizeOutputSchema({ type: 'array', items: { type: 'integer' } })), null);
  });
  await test('cyclic/non-JSON data and non-consuming refs cannot pass or hang', async () => {
    const cycle = {}; cycle.self = cycle;
    for (const value of [cycle, [undefined], { a: NaN }, { a: Infinity }, { a: BigInt(1) }, { a: new Date() }]) {
      assert.notEqual(validateOutput(value, normalizeOutputSchema({ type: 'object' })), null);
    }
    assert.equal(validateOutput({ optional: undefined }, normalizeOutputSchema({ type: 'object', additionalProperties: false })), null);
    assert.equal(validateOutput({ required: undefined }, normalizeOutputSchema({ type: 'object', required: ['required'] })).keyword, 'required');
    assert.equal(validateOutput({}, normalizeOutputSchema({ $ref: '#' })).keyword, 'limit');
    assert.equal(validateOutput({}, normalizeOutputSchema({ not: { $ref: '#' } })).keyword, 'limit');
  });
  await test('real update_plan returns valid nullable paths with and without persistence', async () => {
    const registry = new AgentToolRegistry();
    require("../../electron/tools/impl/updatePlanTool.cjs").register(registry);
    const args = { items: [{ id: 'check', step: 'Inspect', acceptanceCriteria: 'Source inspected', status: 'pending' }] };
    const noRun = await registry.execute('update_plan', args, context);
    assert.equal(noRun.ok, true);
    assert.equal(noRun.data.file, null);
    const withRun = await registry.execute('update_plan', args, new AgentToolContext({ projectRoot: root, runId: 'output-test' }));
    assert.equal(withRun.ok, true);
    assert.equal(withRun.data.sessionFile, null);
    assert.equal(fs.existsSync(withRun.data.file), true);
  });
  await test('real save_project success data satisfies the output contract', async () => {
    const registry = new AgentToolRegistry();
    require("../../electron/tools/impl/saveProjectTool.cjs").register(registry);
    const result = await registry.execute('save_project', {}, new AgentToolContext({ projectRoot: root, confirm: async () => true, saveProject: async () => path.join(root, 'saved.cnode') }));
    assert.equal(result.ok, true);
    assert.equal(result.data.filePath, path.join(root, 'saved.cnode'));
  });
  await test('a real write with invalid output remains unknown across restart and cannot replay', async () => {
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'invalid-write' });
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(ledger) });
    let executions = 0;
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'write_file', readOnly: false, idempotent: true, outputSchema: payloadSchema }, async () => {
      executions++; fs.appendFileSync(path.join(root, 'effects.txt'), 'applied\n');
      return AgentToolResult.ok('success', { count: 'invalid', file: null });
    });
    const args = { path: 'effects.txt', content: 'applied' };
    const token = await guarded.beginSideEffect('write_file', args);
    const result = await registry.execute('write_file', args, guarded);
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.failure.retryable, false);
    assert.equal(result.data.executed, true);
    await guarded.failSideEffect(token, result);
    assert.equal(ledger.review().unknown[0].phase, 'unknown');
    await assert.rejects(() => guarded.beginSideEffect('write_file', args), { code: 'EFFECT_UNKNOWN' });
    const restarted = new SideEffectLedger({ projectRoot: root, scopeRunId: 'invalid-write' });
    assert.throws(() => restarted.begin('write_file', { content: 'applied', path: 'effects.txt' }), { code: 'EFFECT_UNKNOWN' });
    assert.equal(fs.readFileSync(path.join(root, 'effects.txt'), 'utf8'), 'applied\n');
    assert.equal(executions, 1);
  });
  await test('interrupted pending effects cannot replay after restart', async () => {
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'interrupted' });
    ledger.begin('write_file', { path: 'interrupted.txt', content: 'x' });
    const restarted = new SideEffectLedger({ projectRoot: root, scopeRunId: 'interrupted' });
    assert.throws(() => restarted.begin('write_file', { path: 'interrupted.txt', content: 'x' }), { code: 'EFFECT_UNKNOWN' });
  });
  await test('conditional read tools with possible writes persist unknown effects', async () => {
    const registry = registerResult(AgentToolResult.ok('bad result', { count: 'bad', file: null }), {
      name: 'scan_project', readOnly: true, mutatesWorkspace: true,
    });
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'conditional-write' });
    const token = ledger.begin('scan_project', { applyToWorkbench: true });
    const result = await registry.execute('scan_project', {}, context);
    assert.equal(result.failure.code, 'EFFECT_UNKNOWN');
    ledger.fail(token, result);
    const restarted = new SideEffectLedger({ projectRoot: root, scopeRunId: 'conditional-write' });
    assert.equal(restarted.review().unknown[0].phase, 'unknown');
    assert.throws(() => restarted.begin('scan_project', { applyToWorkbench: true }), { code: 'EFFECT_UNKNOWN' });
  });
  await test('executor exceptions after writes are not classified as safely retryable', async () => {
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'write_probe', readOnly: false }, async () => {
      fs.writeFileSync(path.join(root, 'exception-effect.txt'), 'written');
      throw new Error('result serialization failed');
    });
    const result = await registry.execute('write_probe', {}, context);
    assert.equal(fs.readFileSync(path.join(root, 'exception-effect.txt'), 'utf8'), 'written');
    assert.equal(result.failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.failure.retryable, false);
  });
  await test('a write still completing after timeout is held as unknown with no replay permission', async () => {
    let finish = () => {};
    const completion = new Promise((resolve) => { finish = () => resolve(undefined); });
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'timed_write', readOnly: false, timeoutMs: 5, retryPolicy: { maxAttempts: 3 } }, async () => {
      await completion; fs.writeFileSync(path.join(root, 'late-effect.txt'), 'late');
      return AgentToolResult.ok('late success');
    });
    const result = await registry.execute('timed_write', {}, context);
    assert.equal(result.data.code, 'TIMEOUT');
    assert.equal(result.failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.failure.retryable, false);
    assert.equal(result.data.sideEffectStatus, 'unknown');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.readFileSync(path.join(root, 'late-effect.txt'), 'utf8'), 'late');
  });
  await test('corrupt or unwritable ledgers fail before writes while reads remain usable', async () => {
    const brokenFile = path.join(root, 'broken.json'); fs.writeFileSync(brokenFile, '{');
    const broken = new SideEffectLedger({ projectRoot: root, file: brokenFile });
    assert.throws(() => broken.begin('write_file', {}), { code: 'SYSTEM_ERROR' });
    assert.equal(broken.begin('read_file', {}).skip, false);
    const blocker = path.join(root, 'not-a-directory'); fs.writeFileSync(blocker, 'x');
    const unwritable = new SideEffectLedger({ projectRoot: root, file: path.join(blocker, 'ledger.json') });
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(unwritable) });
    await assert.rejects(() => guarded.beginSideEffect('write_file', {}), { code: 'SYSTEM_ERROR' });
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
  });
  await test('commit persistence failure is reported as an unknown executed effect', async () => {
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'commit-failure' });
    const token = ledger.begin('write_file', { path: 'commit.txt' });
    const blocker = path.join(root, 'commit-blocker'); fs.writeFileSync(blocker, 'x');
    ledger.file = path.join(blocker, 'ledger.json');
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(ledger) });
    await assert.rejects(() => guarded.commitSideEffect(token, { ok: true }), { code: 'EFFECT_UNKNOWN', executed: true });
    assert.equal(ledger.review().unknown[0].phase, 'unknown');
  });
  await test('the real agent blocks a second invalid-output write and records both failures', async () => {
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'agent-invalid-write' });
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(ledger) });
    let executed = 0;
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'write_file', readOnly: false, outputSchema: payloadSchema }, async () => {
      executed++; fs.appendFileSync(path.join(root, 'agent-effects.txt'), 'once\n');
      return AgentToolResult.ok('invalid', { count: 'wrong', file: null });
    });
    const call = { name: 'write_file', args: { path: 'agent-effects.txt', content: 'once' } };
    const result = await runScript(registry, guarded, [call, call]);
    assert.equal(executed, 1);
    assert.equal(fs.readFileSync(path.join(root, 'agent-effects.txt'), 'utf8'), 'once\n');
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.toolCalls[1].failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.toolCalls[1].data.executed, false);
    assert.equal(ledger.review().unknown[0].phase, 'unknown');
  });
  await test('the real agent does not execute a tool when the intent journal is unavailable', async () => {
    const blocker = path.join(root, 'agent-blocker'); fs.writeFileSync(blocker, 'x');
    const ledger = new SideEffectLedger({ projectRoot: root, file: path.join(blocker, 'ledger.json') });
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(ledger) });
    let executed = 0;
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'write_file', readOnly: false, outputSchema: payloadSchema }, async () => {
      executed++; return AgentToolResult.ok('valid', { count: 1, file: null });
    });
    const result = await runScript(registry, guarded, [{ name: 'write_file', args: { path: 'unwritten.txt' } }]);
    assert.equal(executed, 0);
    assert.equal(result.toolCalls[0].ok, false);
    assert.equal(result.toolCalls[0].failure.code, 'SYSTEM_ERROR');
    assert.equal(result.toolCalls[0].data.executed, false);
  });
  await test('the real agent never reports success after a commit journal failure', async () => {
    const ledger = new SideEffectLedger({ projectRoot: root, scopeRunId: 'agent-commit-failure' });
    const guarded = new AgentToolContext({ projectRoot: root, sideEffectGuard: createGuard(ledger) });
    const blocker = path.join(root, 'agent-commit-blocker'); fs.writeFileSync(blocker, 'x');
    const registry = new AgentToolRegistry();
    registry.registerDescriptor({ name: 'write_file', readOnly: false, outputSchema: payloadSchema }, async () => {
      fs.writeFileSync(path.join(root, 'committed-effect.txt'), 'effect exists');
      ledger.file = path.join(blocker, 'ledger.json');
      return AgentToolResult.ok('valid output', { count: 1, file: null });
    });
    const result = await runScript(registry, guarded, [{ name: 'write_file', args: { path: 'committed-effect.txt' } }]);
    assert.equal(fs.readFileSync(path.join(root, 'committed-effect.txt'), 'utf8'), 'effect exists');
    assert.equal(result.toolCalls[0].ok, false);
    assert.equal(result.toolCalls[0].failure.code, 'EFFECT_UNKNOWN');
    assert.equal(result.toolCalls[0].data.executed, true);
  });
  console.log('TOOL OUTPUT CONTRACT TEST: PASS (' + passed + ')');
})().catch((error) => { console.error(error); process.exitCode = 1; });
