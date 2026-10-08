'use strict';
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let session='';let pendingPrompt=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);const result=value=>send({jsonrpc:'2.0',id:m.id,result:value});
  if(process.env.FIXTURE_PROTOCOL==='dsh'){
    if(m.method==='initialize')result({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});
    else if(m.method==='session/prompt'){const p=m.params;result({messageId:'message-1'});send({jsonrpc:'2.0',method:'session.status',params:{sessionId:p.sessionId,status:'running'}});send({jsonrpc:'2.0',method:'session.event',params:{sessionId:p.sessionId,event:{type:'assistant/message',data:{message:{content:[{type:'text',text:'DSH_RUNTIME_OK'}]},usage:{inputTokens:3,outputTokens:2}}}}});send({jsonrpc:'2.0',method:'session.event',params:{sessionId:p.sessionId,event:{type:'tool/call',data:{name:'read_file',callId:'dsh-tool-1',arguments:'{"path":"README.md"}'}}}});send({jsonrpc:'2.0',method:'session.event',params:{sessionId:p.sessionId,event:{type:'tool/result',data:{message:{name:'read_file',toolCallId:'dsh-tool-1',content:[{type:'text',text:'fixture'}]}}}}});send({jsonrpc:'2.0',method:'session.event',params:{sessionId:p.sessionId,event:{type:'turn/end',data:{reason:{kind:process.env.DSH_STOP_REASON||'completed'}}}}});send({jsonrpc:'2.0',method:'session.status',params:{sessionId:p.sessionId,status:'idle'}});}
    else if(m.method==='shutdown')result({});
    return;
  }
  if(m.method==='initialize')result({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}},agentInfo:{name:'fixture',version:'1'}});
  else if(m.method==='session/new'){session='acp-fixture';result({sessionId:session});}
  else if(m.method==='session/load'||m.method==='session/resume'){session=m.params.sessionId;result({});}
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
