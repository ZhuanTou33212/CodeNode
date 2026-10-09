'use strict';
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let session='';let pendingPrompt=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);const result=value=>send({jsonrpc:'2.0',id:m.id,result:value});
  if(m.method==='initialize')result({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}},agentInfo:{name:'fixture',version:'1'}});
  else if(m.method==='error-test')send({jsonrpc:'2.0',id:m.id,error:{code:-32001,message:'fixture protocol error',data:{detail:'preserve diagnostic'}}});
  else if(m.method==='session/new'||m.method==='session/load'||m.method==='session/resume'){
    if(process.env.FIXTURE_REQUIRE_MCP_SERVERS==='1'&&!Array.isArray(m.params.mcpServers))send({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Invalid params',data:{_errors:[],mcpServers:{_errors:['Invalid input: expected array, received undefined']}}}});
    else{session=m.params.sessionId||'acp-fixture';if(process.env.FIXTURE_SESSION_PARAMS)require('node:fs').writeFileSync(process.env.FIXTURE_SESSION_PARAMS,JSON.stringify({method:m.method,params:m.params}));result(m.method==='session/new'?{sessionId:session}:{});}
  }
  else if(m.method==='session/prompt'){
    pendingPrompt=m.id;
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',messageId:'msg-1',content:{type:'text',text:'ACP_RUNTIME_OK'}}}});
    if(process.env.FIXTURE_PERMISSION==='1')send({jsonrpc:'2.0',id:'permission-1',method:'session/request_permission',params:{sessionId:session,title:'Read file',subject:{kind:'read',path:'sample.txt'},toolCall:{toolCallId:'read-1',kind:'read'},options:[{optionId:'allow',kind:'allow_once',name:'Read once'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
    else{result({stopReason:'end_turn'});pendingPrompt=null;}
  }else if(m.method==='session/cancel'&&pendingPrompt!=null){send({jsonrpc:'2.0',id:pendingPrompt,result:{stopReason:'cancelled'}});pendingPrompt=null;}
  else if(m.id==='permission-1'){
    if(process.env.FIXTURE_PERMISSION_RESPONSE)require('node:fs').writeFileSync(process.env.FIXTURE_PERMISSION_RESPONSE,JSON.stringify(m.result));
    send({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'selected',optionId:m.result?.outcome?.optionId||'deny'}}});
    if(pendingPrompt!=null)send({jsonrpc:'2.0',id:pendingPrompt,result:{stopReason:'end_turn'}});
    pendingPrompt=null;
  }
});
