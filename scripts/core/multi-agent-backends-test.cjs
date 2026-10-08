'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {AcpBackend}=require('../../electron/backends/acp.cjs');
const {DeepSeekHarnessBackend}=require('../../electron/backends/deepseekHarness.cjs');
const settings=require('../../electron/backends/settings.cjs');
const config=require('../../config/agent.backends.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-multi-backend-'));
const fixture=path.join(__dirname,'../fixtures/acp-and-dsh.cjs');
class FixtureRpc{
  constructor(_command,_args,cwd,options={}){const protocol=options.env?.FIXTURE_PROTOCOL||'';const Rpc=require('../../electron/backends/stdioRpc.cjs').StdioRpc;this.inner=new Rpc(process.execPath,[fixture],cwd,{...options,spawn:(_f,_a,opts)=>spawn(process.execPath,[fixture],{...opts,env:{...opts.env,FIXTURE_PROTOCOL:protocol}})});}
  on(event,listener){this.inner.on(event,listener);return this;} request(method,params,timeout){return this.inner.request(method,params,timeout)} send(message){return this.inner.send(message)} respond(id,result){return this.inner.respond(id,result)} close(){return this.inner.close()} get proxySource(){return this.inner.proxySource}
}
async function main(){
  const data=path.join(root,'userdata');
  for(const backend of config.backends){const value=settings.normalize({...config.defaults,backend});assert.equal(value.backend,backend);}
  const diagnosticRpc=new FixtureRpc('fixture',root);
  try{await assert.rejects(diagnosticRpc.request('error-test'),error=>{const diagnostic=/** @type {any} */ (error);return diagnostic.code===-32001&&diagnostic.method==='error-test'&&diagnostic.data?.detail==='preserve diagnostic';},'JSON-RPC error code, method and data should survive transport for actionable backend diagnostics');}
  finally{await diagnosticRpc.close();}
  for(const backend of ['hermes','opencode','openclaw']){
    const available=await new AcpBackend({...config.defaults,backend,executable:'fixture'} ,{StdioRpc:FixtureRpc}).capabilities(root);
    assert.equal(available.available,true,backend+' ACP initialization');assert.equal(available.protocol,'ACP');
  }
  const acpSettings={...config.defaults,backend:'opencode',executable:'fixture',args:['acp'],sandbox:'workspace-write'};
  const deltas=[];const acp=new AcpBackend(acpSettings,{StdioRpc:FixtureRpc});
  const acpResult=await acp.start({projectRoot:root,prompt:'Say hello',onDelta:d=>deltas.push(d),confirm:async()=>true});
  assert.equal(acpResult.state,'COMPLETED');assert.match(acpResult.content,/ACP_RUNTIME_OK/);
  assert.equal(acpResult.backendSession.sessionId,'acp-fixture');
  assert(deltas.some(d=>d.kind==='content'));assert(deltas.some(d=>d.kind==='tool_result')===false);
  const openclawSessionParams=path.join(root,'openclaw-session-params.json');
  const openclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_SESSION_PARAMS:openclawSessionParams}})}}});
  const openclawResult=await openclaw.start({projectRoot:root,prompt:'Gateway bridge',confirm:async()=>false});
  assert.equal(openclawResult.state,'COMPLETED');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(openclawSessionParams,'utf8')).params,'mcpServers'),false,'OpenClaw rejects even an empty per-session mcpServers field');
  const legacyOpenclawParams=path.join(root,'openclaw-legacy-session-params.json');
  const legacyOpenclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_REQUIRE_MCP_SERVERS:'1',FIXTURE_SESSION_PARAMS:legacyOpenclawParams}})}}});
  const legacyOpenclawResult=await legacyOpenclaw.start({projectRoot:root,prompt:'Legacy gateway bridge',confirm:async()=>false});
  assert.equal(legacyOpenclawResult.state,'COMPLETED','older OpenClaw schema retries only after its explicit missing-mcpServers error');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyOpenclawParams,'utf8')).params.mcpServers,[],'legacy retry supplies an empty MCP list');
  const permissionResponse=path.join(root,'acp-permission-response.json');
  const readonly=new AcpBackend({...acpSettings,backend:'hermes',sandbox:'read-only'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1',FIXTURE_PERMISSION_RESPONSE:permissionResponse}})}}});
  let approved=false;
  const readonlyResult=await readonly.start({projectRoot:root,prompt:'Read',confirm:async()=>{approved=true;return true;}});
  assert.equal(readonlyResult.state,'COMPLETED');assert.equal(approved,false,'read-only must decline a permission escalation without showing approval');
  assert.equal(JSON.parse(fs.readFileSync(permissionResponse,'utf8')).outcome.optionId,'deny','ACP read metadata cannot self-authorize a permission request');
  const writable=new AcpBackend({...acpSettings,backend:'opencode',sandbox:'workspace-write'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1'}})}}});
  const writeResult=await writable.start({projectRoot:root,prompt:'Read',confirm:async()=>true});
  assert.equal(writeResult.state,'COMPLETED');
  const home=path.join(root,'dsh-home');fs.mkdirSync(home);
  const dsh=new DeepSeekHarnessBackend({...config.defaults,backend:'deepseek-harness',executable:'node',home},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PROTOCOL:'dsh'}})}}});
  const dshResult=await dsh.start({projectRoot:root,prompt:'Say hello'});
  assert.equal(dshResult.state,'COMPLETED');assert.match(dshResult.content,/DSH_RUNTIME_OK/);assert.equal(dshResult.backendSession.sessionId.startsWith('codenode-'),true);
  assert(dshResult.toolCalls.some(call=>call.name==='read_file'&&call.callId==='dsh-tool-1'),'DeepSeek SDK tool/call events are surfaced');
  assert(dshResult.toolCalls.some(call=>call.ok===true&&call.callId==='dsh-tool-1'),'DeepSeek SDK tool/result events are paired');
  const maxTokens=new DeepSeekHarnessBackend({...config.defaults,backend:'deepseek-harness',executable:'node',home},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PROTOCOL:'dsh',DSH_STOP_REASON:'max-tokens'}})}}});
  assert.equal((await maxTokens.start({projectRoot:root,prompt:'Max tokens'})).state,'COMPLETED','SDK max-token termination is a completed partial response');
  const missing=await new DeepSeekHarnessBackend({...config.defaults,backend:'deepseek-harness',executable:'node',home:''},{env:{DSH_HOME:''}}).capabilities(root);
  assert.equal(missing.available,false);assert.match(missing.error,/DSH_HOME/);
  assert.equal(require('../../electron/backends/index.cjs').createBackend('hermes',acpSettings) instanceof AcpBackend,true);
  assert.equal(require('../../electron/backends/index.cjs').createBackend('deepseek-harness',{...acpSettings,backend:'deepseek-harness'}) instanceof DeepSeekHarnessBackend,true);
  console.log('MULTI AGENT BACKENDS: PASS (ACP lifecycle, permission policy, DeepSeek SDK JSON-RPC, settings normalization, missing runtime detection)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  const resolved=path.resolve(root);if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-multi-backend-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
