'use strict';
const fs=require('fs'),path=require('path'),readline=require('readline');
const file=path.join(process.cwd(),'.codenode','port-protocol.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
let session='',prompt=null,mode='';const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
function finish(reason='end_turn',text='PORT_OK'){send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});send({id:prompt,result:{stopReason:reason}});prompt=null;}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(file,JSON.stringify(m)+'\n');const result=value=>send({id:m.id,result:value});
 if(m.method==='initialize')result({protocolVersion:1,agentInfo:{name:'port-fixture',version:'1'},agentCapabilities:{loadSession:true}});
 else if(m.method==='session/new'){session='session-'+Date.now();result({sessionId:session});}
 else if(m.method==='session/load'){session=m.params.sessionId;result({});}
 else if(m.method==='session/prompt'){
   prompt=m.id;mode=m.params.prompt[0].text;
   if(mode==='permission')send({id:'permission',method:'session/request_permission',params:{sessionId:session,title:'Permission',options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});
   else if(mode==='input')send({id:'input',method:'elicitation/create',params:{sessionId:session,message:'Return a JSON object with name',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}}});
   else if(mode==='truncated')finish('max_tokens');
   else finish();
 }else if(m.method==='session/cancel'){if(prompt!=null)finish('cancelled');}
 else if(m.id==='permission'&&m.result)finish('end_turn',m.result.outcome?.optionId==='allow'?'ALLOWED':'DENIED');
 else if(m.id==='input'&&m.result)finish('end_turn',m.result.action==='accept'?'INPUT_'+m.result.content.name:'INPUT_CANCELLED');
});
