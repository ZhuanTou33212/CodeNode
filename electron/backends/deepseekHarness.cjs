'use strict';
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const {StdioRpc}=require('./stdioRpc.cjs');
const config=require('../../config/agent.backends.json');
const {redact}=require('../redaction.cjs');

class DeepSeekHarnessBackend {
  constructor(settings,deps={}){this.settings=settings;this.deps=deps;this.rpc=null;this.listener=(delta)=>{};this.sessionId=null;this.settle=null;this.running=false;this.statuses=[];this.messages=[];this.tools=[];this.usage=null;}
  emit(delta){this.listener(delta);}
  events(listener){this.listener=listener;}
  async connect(cwd){
    const env={...(process.env),...(this.deps.env||{})};
    const home=this.settings.home||env.DSH_HOME;
    if(!home||!path.isAbsolute(home)||!fs.existsSync(home)||!fs.statSync(home).isDirectory())throw new Error('DeepSeek Harness 要求显式设置有效的 DSH_HOME；请安装 deepseek-harness-sdk/runtime 并初始化 sdk profile');
    env.DSH_HOME=home;
    const args=this.settings.args?.length?this.settings.args:config.defaultArgs['deepseek-harness']||[];
    this.rpc=new (this.deps.StdioRpc||StdioRpc)(this.settings.executable||'dsh',[...args],cwd,{...this.deps,env});
    this.rpc.on('notification',m=>this.notification(m));this.rpc.on('disconnect',e=>this.fail(e));
    const result=await this.rpc.request('initialize',{cwd,provider:this.settings.provider||'deepseek-official',model:this.settings.model||'deepseek-v4-flash',...(this.settings.reasoningEffort?{reasoningEffort:this.settings.reasoningEffort}:{})});
    this.serverInfo=result.serverInfo;
  }
  async capabilities(cwd){try{await this.connect(cwd);return{backend:'deepseek-harness',available:true,authenticated:null,protocol:'DeepSeek Harness SDK JSON-RPC',version:this.serverInfo?.version||'unknown',conversation:true,events:true,approvals:false,interrupt:false,resume:true,usage:false,hardBudget:false,customTools:false,permissions:'runtime-profile',cost:'unknown',home:this.settings.home||process.env.DSH_HOME||null};}catch(error){return{backend:'deepseek-harness',available:false,error:error.message};}finally{await this.rpc?.close();this.rpc=null;}}
  async start(input){
    this.input=input;this.listener=input.onDelta||this.listener;this.messages=[];this.tools=[];this.statuses=[];this.running=false;this.usage=null;this.error=null;this.messageId=null;
    this.sessionId=input.backendSession?.sessionId||('codenode-'+crypto.randomUUID());
    const abort=()=>{void this.interrupt();};input.signal?.addEventListener('abort',abort,{once:true});
    try{
      if(input.signal?.aborted)return{content:'',state:'CANCELLED',aborted:true,stopReason:'cancelled'};
      await this.connect(input.projectRoot);
      input.onSession?.({backend:'deepseek-harness',protocol:'dsh-sdk-jsonrpc',protocolVersion:this.serverInfo?.version||'unknown',sessionId:this.sessionId,cwd:input.projectRoot,model:this.settings.model||'deepseek-v4-flash',adapterSettings:this.settings,permissions:{sandbox:'runtime-profile',network:'runtime-profile'}});
      if(input.signal?.aborted)return{content:'',state:'CANCELLED',aborted:true,stopReason:'cancelled',backendSession:{sessionId:this.sessionId}};
      this.emit({kind:'state',state:'RUNNING',previous:null,sequence:0});
      const text=String(input.prompt||'')+(input.canvasSummary?'\n\n当前画布上下文：\n'+input.canvasSummary:'');
      const wait=new Promise(resolve=>{this.settle=resolve;});
      this.timer=setTimeout(()=>this.fail(new Error('DeepSeek Harness 运行状态超时，结果需要复核')),10*60*1000);
      const receipt=await this.rpc.request('session/prompt',{sessionId:this.sessionId,contentBlocks:[{type:'text',text}]});
      if(!receipt||typeof receipt.messageId!=='string')throw new Error('DeepSeek Harness 未确认提示词已入队');
      this.messageId=receipt.messageId;
      if(this.statuses.includes('idle'))this.finish();
      return await wait;
    }catch(error){return{content:this.content(),state:'FAILED',error:error.message,stopReason:this.messageId?'backend_result_unknown':'backend_start_failed',backendSession:{sessionId:this.sessionId}};}
    finally{clearTimeout(this.timer);input.signal?.removeEventListener('abort',abort);await this.rpc?.close();this.rpc=null;this.settle=null;}
  }
  resume(input){return this.start(input);}
  content(){return this.messages.join('\n');}
  notification(message){
    const p=message.params||{};if(p.sessionId&&this.sessionId&&p.sessionId!==this.sessionId)return;
    if(message.method==='session.status'){
      this.statuses.push(p.status);if(p.status==='running'){this.running=true;this.emit({kind:'state',state:'RUNNING',previous:null,sequence:1});}
      else if(p.status==='idle'&&this.running&&this.messageId)this.finish();
    }else if(message.method==='session.event'){
      const event=p.event||{};
      if(event.type==='assistant/message'){
        const blocks=event.data?.message?.content||[];const text=blocks.filter(x=>x?.type==='text').map(x=>x.text||'').join('');
        if(text){this.messages.push(text);this.emit({kind:'content',text});}
        for(const block of blocks)if(block?.type==='tool-call'){
          const call={name:block.name||'tool',callId:block.id,args:redact(block.arguments||''),ok:null};this.tools.push(call);this.emit({kind:'tool',toolCalls:[call]});
        }
        if(event.data?.usage)this.usage=event.data.usage;
      }else if(event.type==='tool/call'){
        const call={name:event.data?.name||'tool',callId:event.data?.callId||null,args:redact(event.data?.arguments||''),ok:null};this.tools.push(call);this.emit({kind:'tool',toolCalls:[call]});
      }else if(event.type==='tool/result'){
        const message=event.data?.message||{};const record={name:message.name||event.data?.name||'tool',callId:message.toolCallId||event.data?.callId||null,ok:message.isError!==true&&!event.data?.error,args:'',data:redact(message.content||event.data||{})};this.tools.push(record);this.emit({kind:'tool_result',toolCalls:[record]});
      }else if(event.type==='turn/end'){
        const reason=event.data?.reason;if(reason?.kind==='error')this.error=reason.error?.message||'DeepSeek Harness turn failed';
        this.finish(reason?.kind||'completed');
      }
    }
  }
  finish(reason='completed'){
    if(!this.settle)return;const done=this.settle;this.settle=null;clearTimeout(this.timer);const aborted=['interrupted','cancelled','aborted'].includes(reason);const failed=['error','blocked'].includes(reason)||!!this.error;
    done({content:this.content(),reasoning:'',toolCalls:this.tools,usage:this.usage,state:aborted?'CANCELLED':failed?'FAILED':'COMPLETED',aborted,error:this.error||null,stopReason:reason,backendSession:{sessionId:this.sessionId}});
  }
  fail(error){if(this.settle){const done=this.settle;this.settle=null;done({content:this.content(),state:'FAILED',error:error.message,stopReason:'backend_result_unknown'});}}
  async interrupt(){
    if(!this.rpc||!this.settle)return;
    const rpc=this.rpc;try{await rpc.request('shutdown',{},config.interruptTimeoutMs);this.finish('interrupted');}
    catch{this.fail(new Error('DeepSeek Harness SDK 没有逐会话取消接口；runtime shutdown 未确认，原执行结果未知'));}
  }
}
module.exports={DeepSeekHarnessBackend};
