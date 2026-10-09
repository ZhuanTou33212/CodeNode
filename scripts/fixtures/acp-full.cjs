'use strict';
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map(); let sequence = 100; let session; let mcp;
function request(method, params) { return new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params: { sessionId: session, ...params } }); }); }
const options = [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'One' }, { value: 'm2', name: 'Two' }] }, { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false }];
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line); if (m.id >= 100) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  const respond = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') { fs.writeFileSync('initialize.json', JSON.stringify(m.params)); respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, sessionCapabilities: { close: {}, list: {}, delete: {} }, auth: { logout: {} } }, authMethods: [{ id: 'login', name: 'Login' }], agentInfo: { name: 'full-fixture', version: '1' } }); }
  else if (m.method === 'session/new') { session = 'full-session'; mcp = m.params.mcpServers?.find(x => x.name === 'codenode'); respond({ sessionId: session, modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] }, configOptions: options }); }
  else if (m.method === 'authenticate' || m.method === 'logout' || m.method === 'session/close' || m.method === 'session/delete' || m.method === 'session/set_mode') { fs.appendFileSync('controls.jsonl', JSON.stringify(m) + '\n'); respond({}); }
  else if (m.method === 'session/set_config_option') { fs.appendFileSync('controls.jsonl', JSON.stringify(m) + '\n'); const option = options.find(x => x.id === m.params.configId); option.currentValue = m.params.value; respond({ configOptions: options }); }
  else if (m.method === 'session/list') respond({ sessions: [{ sessionId: session, cwd: process.cwd() }] });
  else if (m.method === 'session/prompt') {
    try {
      fs.writeFileSync('prompt.json', JSON.stringify(m.params));
      const report = {};
      report.read = await request('fs/read_text_file', { path: path.join(process.cwd(), 'source.txt'), line: 2, limit: 1 });
      report.write = await request('fs/write_text_file', { path: path.join(process.cwd(), 'output.txt'), content: 'ACP_WRITE_OK' });
      report.escape = await request('fs/read_text_file', { path: path.join(process.cwd(), '..', 'outside.txt') });
      report.unknown = await request('unknown/method', {});
      report.badSession = await request('fs/read_text_file', { sessionId: 'other', path: path.join(process.cwd(), 'source.txt') });
      report.badParams = await request('fs/read_text_file', { path: path.join(process.cwd(), 'source.txt'), line: 0 });
      const created = await request('terminal/create', { command: process.execPath, args: ['-e', 'process.stdout.write("你好".repeat(40))'], outputByteLimit: 31 });
      if (created.result) {
        const id = created.result.terminalId;
        report.wait = await request('terminal/wait_for_exit', { terminalId: id });
        report.output = await request('terminal/output', { terminalId: id });
        report.release = await request('terminal/release', { terminalId: id });
        report.released = await request('terminal/output', { terminalId: id });
      } else report.terminalDenied = created;
      if (mcp) {
        const env = { ...process.env, ...Object.fromEntries(mcp.env.map(x => [x.name, x.value])) };
        const child = spawn(mcp.command, mcp.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const messages = []; const waiting = new Map();
        readline.createInterface({ input: child.stdout }).on('line', data => { const value = JSON.parse(data); messages.push(value); waiting.get(value.id)?.(value); });
        const call = (id, method, params) => new Promise(resolve => { waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
        await call(1, 'initialize', { protocolVersion: '2024-11-05' });
        report.mcpList = await call(2, 'tools/list', {});
        report.mcpRead = await call(3, 'tools/call', { name: report.mcpList.result.tools.some(x => x.name === 'fixture_read') ? 'fixture_read' : 'get_workbench_model', arguments: {} });
        report.mcpUnknown = await call(4, 'tools/call', { name: 'not_registered', arguments: {} });
        child.kill();
      }
      fs.writeFileSync('report.json', JSON.stringify(report));
      const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: value } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Fixture thought' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FULL_ACP_OK' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'aGk=' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'audio', mimeType: 'audio/wav', data: 'aGk=' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'fixture://resource', text: 'resource text' } } });
      update({ sessionUpdate: 'plan', entries: [{ content: 'Verify', status: 'completed', priority: 'high' }] });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Write', kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: 'output.txt', oldText: '', newText: 'ACP_WRITE_OK' }] });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
      update({ sessionUpdate: 'current_mode_update', currentModeId: 'code' });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help' }] });
      update({ sessionUpdate: 'config_option_update', configOptions: options });
      update({ sessionUpdate: 'session_info_update', title: 'Fixture session' });
      update({ sessionUpdate: 'usage_update', size: 1000, used: 15, cost: { amount: 0.01, currency: 'USD' } });
      respond({ stopReason: 'end_turn' });
    } catch (error) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: error.message } }); }
  }
});
