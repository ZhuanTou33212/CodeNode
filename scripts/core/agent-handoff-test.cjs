'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const settings=require('../../electron/backends/settings.cjs'),external=require('../../electron/backends/runExternal.cjs'),runs=require('../../electron/runStore.cjs');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codenode-handoff-'))),data=path.join(root,'user');
const fixture=path.resolve(__dirname,'../fixtures/acp-port.cjs'),conversationId='same-conversation';
const select=name=>settings.write(root,data,'project',{...settings.config.defaults,backend:name,executable:name==='builtin'?'':process.execPath,args:name==='builtin'?[]:[fixture]},{conversationId});
const binding=()=>settings.conversationBinding(root,conversationId);
const execute=async(id)=>{
 const b=binding();return external.runExternal({projectRoot:root,requestId:id,sessionId:'same-canvas',memoryConversationId:conversationId,backendEpoch:b.epoch,settings:b.settings,cfg:{editing:{autoVerify:false}},prompt:'Reply PORT_OK',history:[{role:'user',content:'HANDOFF_HISTORY_SENTINEL'},{role:'assistant',content:'Previous answer'}],canvasSummary:'CANVAS_HANDOFF_SENTINEL',onDelta:()=>{},confirm:async()=>false});
};
async function main(){
 select('opencode');const firstEpoch=binding().epoch;
 assert.equal((await execute('first')).ok,true);const first=external.sessionFromRun(root,'first');
 assert.equal(first.start.backendEpoch,firstEpoch);assert.equal(first.start.memoryConversationId,conversationId);
 assert.equal((await execute('same-agent')).ok,true);
 let calls=fs.readFileSync(path.join(root,'.codenode/port-protocol.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert(calls.some(m=>m.method==='session/load'),'same selection continues precise session');
 select('hermes');assert.notEqual(binding().epoch,firstEpoch);assert.equal((await execute('new-agent')).ok,true);
 assert.equal(external.sessionFromRun(root,'new-agent').start.backend,'hermes');
 select('builtin');assert.equal(binding().settings.backend,'builtin');assert.equal(external.previousSession(root,'same-canvas',{conversationId,epoch:binding().epoch}),null,'CodeNode selection cannot restore previous ACP Agent');
 select('opencode');assert.equal((await execute('return-agent')).ok,true);
 calls=fs.readFileSync(path.join(root,'.codenode/port-protocol.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(calls.filter(m=>m.method==='session/load').length,1,'switching back opens fresh internal session');assert.equal(calls.filter(m=>m.method==='session/new').length,3);
 const prompts=calls.filter(m=>m.method==='session/prompt');for(const at of [0,2,3]){assert(prompts[at].params.prompt[0].text.includes('HANDOFF_HISTORY_SENTINEL'));assert(prompts[at].params.prompt[0].text.includes('CANVAS_HANDOFF_SENTINEL'));}
 const epoch=binding().epoch;settings.write(root,data,'project',null);assert.equal(binding().epoch,epoch,'project inherit preserves explicit conversation binding');
 assert.throws(()=>select('not-a-backend'));assert.throws(()=>settings.write(root,data,'machine',{...settings.config.defaults,backend:'builtin'},{conversationId}));
 console.log('AGENT HANDOFF: PASS (same visible conversation, history/canvas handoff, precise same-Agent continuation, new protocol session on each switch, CodeNode routing, persisted binding)');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(path.dirname(root)===fs.realpathSync(os.tmpdir())&&path.basename(root).startsWith('codenode-handoff-'))fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
