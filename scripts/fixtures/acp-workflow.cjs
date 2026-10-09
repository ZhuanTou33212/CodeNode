'use strict';
// Deterministic ACP peer with real stdio, permission, cancellation and persisted session effects.
const fs=require('fs'),path=require('path'),readline=require('readline');
const dir=path.join(process.cwd(),'.codenode');fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,'fixture-acp.json');let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{sessionId:'acp-workflow',active:false};
let prompt=null,text='';
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const persist=()=>fs.writeFileSync(file,JSON.stringify(state));
const update=value=>send({method:'session/update',params:{sessionId:state.sessionId,update:value}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(path.join(dir,'fixture-rpc.jsonl'),JSON.stringify(m)+'\n');const answer=result=>send({id:m.id,result});
 if(m.method==='initialize')answer({protocolVersion:1,agentInfo:{name:'fixture',version:'1'},agentCapabilities:{loadSession:true}});
 else if(m.method==='session/new'){state.active=false;persist();answer({sessionId:state.sessionId});}
 else if(m.method==='session/load'){if(state.active)send({id:m.id,error:{code:-32000,message:'原执行仍在运行'}});else answer({});}
 else if(m.method==='session/prompt'){
  prompt=m.id;text=m.params.prompt.map(p=>p.text||'').join('');state.active=true;persist();
  if(text.includes('disconnect-test')){setTimeout(()=>process.exit(1),20);return;}
  send({id:'permission-1',method:'session/request_permission',params:{sessionId:state.sessionId,title:text.includes('resume-edit')?'Edit math.cjs':'Run command',toolCall:{toolCallId:'tool-1',kind:text.includes('resume-edit')?'edit':'execute'},options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});
 }else if(m.method==='session/cancel'){state.active=false;persist();if(prompt!=null)send({id:prompt,result:{stopReason:'cancelled'}});prompt=null;}
 else if(m.id==='permission-1'&&m.result){
  if(m.result.outcome?.optionId==='allow'){if(text.includes('resume-edit'))fs.writeFileSync('math.cjs','module.exports = (a,b) => a + b;\n');else fs.writeFileSync('denied.txt','unexpected');}
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.includes('resume-edit')?'修改完成':'操作已拒绝'}});
  update({sessionUpdate:'usage_update',inputTokens:10,outputTokens:3,total_tokens:13});
  if(!text.includes('interrupt-test')){state.active=false;persist();send({id:prompt,result:{stopReason:'end_turn'}});prompt=null;}
 }
});
