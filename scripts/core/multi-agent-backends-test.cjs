'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {AcpBackend}=require('../../electron/backends/acp.cjs');

const settings=require('../../electron/backends/settings.cjs');
const config=require('../../config/agent.backends.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-multi-backend-'));
const fixture=path.join(__dirname,'../fixtures/acp-basic.cjs');
class FixtureRpc{
  constructor(_command,_args,cwd,options={}){const protocol=options.env?.FIXTURE_PROTOCOL||'';const Rpc=require('../../electron/backends/stdioRpc.cjs').StdioRpc;this.inner=new Rpc(process.execPath,[fixture],cwd,{...options,spawn:(_f,_a,opts)=>spawn(process.execPath,[fixture],{...opts,env:{...opts.env,FIXTURE_PROTOCOL:protocol}})});}
  on(event,listener){this.inner.on(event,listener);return this;} request(method,params,timeout){return this.inner.request(method,params,timeout)} send(message){return this.inner.send(message)} respond(id,result){return this.inner.respond(id,result)} close(){return this.inner.close()} get proxySource(){return this.inner.proxySource}
}
async function main(){
  const data=path.join(root,'userdata');
  for(const backend of config.backends){const value=settings.normalize({...config.defaults,backend,executable:config.commands[backend]||'fixture'});assert.equal(value.backend,backend);}
  const diagnosticRpc=new FixtureRpc('fixture',root);
  try{await assert.rejects(diagnosticRpc.request('error-test'),error=>{const diagnostic=/** @type {any} */ (error);return diagnostic.code===-32001&&diagnostic.method==='error-test'&&diagnostic.data?.detail==='preserve diagnostic';},'JSON-RPC error code, method and data should survive transport for actionable backend diagnostics');}
  finally{await diagnosticRpc.close();}
  for(const backend of ['codex','deepseek-harness','hermes','opencode','openclaw','acp']){
    const available=await new AcpBackend({...config.defaults,backend,executable:'fixture'} ,{StdioRpc:FixtureRpc}).capabilities(root);
    assert.equal(available.available,true,backend+' ACP initialization');assert.equal(available.protocol,'ACP');
  }
  const acpSettings={...config.defaults,backend:'opencode',executable:'fixture',args:['acp'],sandbox:'workspace-write'};
  const deltas=[];const acp=new AcpBackend(acpSettings,{StdioRpc:FixtureRpc});
  const acpResult=await acp.run({projectRoot:root,prompt:'Say hello',onDelta:d=>deltas.push(d),confirm:async()=>true});
  assert.equal(acpResult.state,'COMPLETED');assert.match(acpResult.content,/ACP_RUNTIME_OK/);
  assert.equal(acpResult.backendSession.sessionId,'acp-fixture');
  assert(deltas.some(d=>d.kind==='content'));assert(deltas.some(d=>d.kind==='tool_result')===false);
  let failConnect=false;
  const reusedAcp=new AcpBackend(acpSettings,{StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){if(failConnect)throw new Error('fixture connection failed');super(c,a,w,o);}}});
  assert.equal((await reusedAcp.run({projectRoot:root,prompt:'First session',confirm:async()=>false})).state,'COMPLETED');
  failConnect=true;
  assert.equal((await reusedAcp.run({projectRoot:root,prompt:'New connection',confirm:async()=>false})).stopReason,'backend_start_failed','old ACP session cannot misclassify a new connection failure as an unknown dispatched run');
  const openclawSessionParams=path.join(root,'openclaw-session-params.json');
  const openclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_SESSION_PARAMS:openclawSessionParams}})}}});
  const openclawResult=await openclaw.run({projectRoot:root,prompt:'Gateway bridge',confirm:async()=>false});
  assert.equal(openclawResult.state,'COMPLETED');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(openclawSessionParams,'utf8')).params,'mcpServers'),false,'OpenClaw rejects even an empty per-session mcpServers field');
  const legacyOpenclawParams=path.join(root,'openclaw-legacy-session-params.json');
  const legacyOpenclaw=new AcpBackend({...acpSettings,backend:'openclaw'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_REQUIRE_MCP_SERVERS:'1',FIXTURE_SESSION_PARAMS:legacyOpenclawParams}})}}});
  const legacyOpenclawResult=await legacyOpenclaw.run({projectRoot:root,prompt:'Legacy gateway bridge',confirm:async()=>false});
  assert.equal(legacyOpenclawResult.state,'COMPLETED','older OpenClaw schema retries only after its explicit missing-mcpServers error');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyOpenclawParams,'utf8')).params.mcpServers,[],'legacy retry supplies an empty MCP list');
  const permissionResponse=path.join(root,'acp-permission-response.json');
  const readonly=new AcpBackend({...acpSettings,backend:'hermes',sandbox:'read-only'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1',FIXTURE_PERMISSION_RESPONSE:permissionResponse}})}}});
  let approved=false;
  const readonlyResult=await readonly.run({projectRoot:root,prompt:'Read',confirm:async()=>{approved=true;return true;}});
  assert.equal(readonlyResult.state,'COMPLETED');assert.equal(approved,false,'read-only must decline a permission escalation without showing approval');
  assert.equal(JSON.parse(fs.readFileSync(permissionResponse,'utf8')).outcome.optionId,'deny','ACP read metadata cannot self-authorize a permission request');
  const writable=new AcpBackend({...acpSettings,backend:'opencode',sandbox:'workspace-write'},
    {StdioRpc:class extends FixtureRpc{constructor(c,a,w,o){super(c,a,w,{...o,env:{...o.env,FIXTURE_PERMISSION:'1'}})}}});
  const writeResult=await writable.run({projectRoot:root,prompt:'Read',confirm:async()=>true});
  assert.equal(writeResult.state,'COMPLETED');
  for(const backend of config.acpBackends){const port=require('../../electron/backends/index.cjs').createBackend(backend,{...acpSettings,backend});assert.equal(port.describe().transport,'acp');}
  console.log('MULTI AGENT BACKENDS: PASS (unified ACP lifecycle, permissions, settings, all external drivers)');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  const resolved=path.resolve(root);if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-multi-backend-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
});
