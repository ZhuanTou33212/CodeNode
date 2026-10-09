'use strict';
// Method contract follows QwenAudio/qwen-audio-agent BackendPort; implementation is CodeNode-owned.
const crypto = require('node:crypto');
const path = require('node:path');
const { redact } = require('../redaction.cjs');
const config = require('../../config/agent.backends.json');
const METHODS = Object.freeze(['describe','start','health','submit','status','cancel','respondAuthorization','respondInput','subscribe','close']);
function portError(message, code='UNSUPPORTED_BACKEND_OPERATION') { return Object.assign(new Error(message),{code}); }
function assertBackendPort(port) { const missing=METHODS.filter(method=>typeof port?.[method]!=='function'); if(missing.length)throw portError('BackendPort 缺少方法：'+missing.join(', '),'INVALID_BACKEND_PORT'); return port; }
function normalizedEvent(delta, task) {
  const type=['content','reasoning'].includes(delta.kind)?'message':delta.kind==='state'?'state':delta.kind==='backend_approval'?'authorization':delta.kind==='backend_input'?'input':delta.kind==='backend_content'?'artifact':'activity';
  return {type,taskId:task.id,ownerId:task.ownerId,at:new Date().toISOString(),data:redact(delta)};
}
// Rendering compatibility stays at the runtime boundary; adapters publish normalized events.
function toAgentDelta(event) { return event.data; }
class BackendPort {
  constructor(name, settings, driver) {
    this.name=name; this.settings=settings; this.driver=driver;
    /** @type {Map<string,any>} */ this.tasks=new Map();
    /** @type {Map<string,any>} */ this.sessions=new Map();
    /** @type {Map<string,any>} */ this.pending=new Map();
    /** @type {Set<Function>} */ this.listeners=new Set();
    /** @type {Promise<any>|null} */ this.starting=null;
    /** @type {any} */ this.runtime={state:'idle',available:false,error:null};this.root=null;this.closed=false;
  }
  describe() { return {kind:this.name,label:config.labels[this.name],transport:this.name==='builtin'?'builtin':'acp',capabilities:{conversation:true,events:true,permissions:true,cancel:true,inputRequests:this.name==='builtin'?'native':'elicitation',sessionContinuity:this.name==='builtin'?'native':'negotiated',hardBudget:this.name==='builtin'}}; }
  async start(context={}) {
    if(this.closed)throw portError('BackendPort 已关闭','BACKEND_CLOSED');
    const root=path.resolve(context.projectRoot||context.cwd||this.root||process.cwd());
    if(this.root&&this.root!==root)throw portError('BackendPort 不能跨工程复用','BACKEND_SCOPE_MISMATCH');
    this.root=root;
    if(this.runtime.available)return this.status();
    if(this.starting)return this.starting;
    this.runtime={state:'starting',available:false,error:null};
    this.starting=(async()=>{
      const abort=()=>{void this.driver.close();};context.signal?.addEventListener('abort',abort,{once:true});
      try {
        if(context.signal?.aborted)throw portError('启动已取消','BACKEND_CANCELLED');
        if(this.name!=='builtin')await this.driver.connect(root);
        if(context.signal?.aborted)throw portError('启动已取消','BACKEND_CANCELLED');
        this.runtime={state:'ready',available:true,error:null};return this.status();
      } catch(error){this.runtime={state:'failed',available:false,error:String(redact(error.message))};await this.driver.close();throw error;}
      finally{context.signal?.removeEventListener('abort',abort);this.starting=null;}
    })();
    return this.starting;
  }
  async health(context={}) {
    try{await this.start(context);return {...this.driver.capabilitySnapshot(),...this.describe(),backend:this.name,available:true,state:this.runtime.state};}
    catch(error){return {...this.describe(),backend:this.name,available:false,state:'failed',error:String(redact(error.message))};}
  }
  status(taskId, context={}) {
    if(!taskId)return {...this.runtime,backend:this.name,closed:this.closed};
    const task=this.tasks.get(String(taskId));
    if(!task||task.ownerId!==String(context.ownerId||'local'))return {taskId:String(taskId),state:'not_found'};
    return {taskId:task.id,state:[...this.pending.values()].some(r=>r.taskId===task.id)?'input_required':task.state,activity:task.activity.slice(-5),result:task.result||null};
  }
  publish(delta, task) {
    if(delta.kind==='backend_approval'&&delta.phase==='requested'&&!delta.authorizationId)return;
    const event=normalizedEvent(delta,task);
    if(event.type==='activity'){task.activity.push({kind:delta.kind,title:String(delta.title||delta.info?.sessionUpdate||delta.toolCalls?.[0]?.name||delta.kind).slice(0,300)});if(task.activity.length>20)task.activity.shift();}
    for(const listener of this.listeners){try{listener(event);}catch{}}
  }
  subscribe(listener) { if(typeof listener!=='function')throw new TypeError('BackendPort listener must be a function');this.listeners.add(listener);return()=>this.listeners.delete(listener); }
  request(task, kind, question, automatic) {
    if(task.controller.signal.aborted)return Promise.resolve(kind==='authorization'?false:null);
    if(this.pending.size>=config.backendPort.maxPendingRequests)throw portError('待处理请求达到上限','BACKEND_REQUEST_LIMIT');
    const id=crypto.randomUUID();
    return new Promise(resolve=>{
      const record={id,taskId:task.id,ownerId:task.ownerId,kind,resolve};this.pending.set(id,record);
      this.publish({kind:kind==='authorization'?'backend_approval':'backend_input',phase:'requested',...(kind==='authorization'?{authorizationId:id}:{inputRequestId:id}),...question},task);
      if(automatic)Promise.resolve().then(automatic).then(value=>{if(this.pending.delete(id))resolve(value);},()=>{if(this.pending.delete(id))resolve(kind==='authorization'?false:null);});
    });
  }
  respondAuthorization(taskId, authorizationId, decision, context={}) {
    if(!['once','reject'].includes(decision))throw portError('授权决定必须为 once 或 reject','INVALID_AUTHORIZATION');
    return this.respond(taskId,authorizationId,'authorization',decision==='once',context);
  }
  respondInput(taskId,inputRequestId,response,context={}) {return this.respond(taskId,inputRequestId,'input',response,context);}
  respond(taskId,id,kind,value,context){
    const request=this.pending.get(String(id));
    if(!request||request.kind!==kind||request.taskId!==String(taskId)||request.ownerId!==String(context.ownerId||'local'))throw portError('请求不属于该 Task 或 owner，或已处理','BACKEND_REQUEST_NOT_FOUND');
    this.pending.delete(String(id));request.resolve(value);return {accepted:true};
  }
  releasePending(taskId){for(const [id,request]of this.pending)if(request.taskId===taskId){this.pending.delete(id);request.resolve(request.kind==='authorization'?false:null);}}
  async submit(input,context={}) {
    if(this.closed)throw portError('BackendPort 已关闭','BACKEND_CLOSED');
    const id=String(input.id||input.requestId||crypto.randomUUID()),ownerId=String(context.ownerId||'local');
    if(!id||id.length>120)throw portError('Task ID 无效','INVALID_BACKEND_TASK');
    const sessionKey=ownerId+':'+path.resolve(input.projectRoot||this.root||process.cwd());
    const prior=input.continuity==='isolated'?null:(input.backendSession?{session:input.backendSession}:this.sessions.get(sessionKey));
    if(prior?.unknown)throw portError('原会话结果未知，需要复核后显式恢复','BACKEND_RESULT_UNKNOWN');
    if(this.tasks.has(id))throw portError('Task ID 已存在，不能重复执行','DUPLICATE_BACKEND_TASK');
    if([...this.tasks.values()].some(t=>t.state==='working'))throw portError('当前 BackendPort 已有活动 Task','BACKEND_BUSY');
    if(input.continuity&&!['shared','isolated'].includes(input.continuity))throw portError('会话连续性无效','INVALID_CONTINUITY');
    /** @type {any} */ const task={id,ownerId,state:'working',activity:[],result:null,controller:new AbortController()};this.tasks.set(id,task);
    while(this.tasks.size>config.backendPort.maxRetainedTasks){const first=[...this.tasks].find(([,t])=>t.state!=='working');if(!first)break;this.tasks.delete(first[0]);}
    const abort=()=>{void this.cancel(id,{ownerId}).catch(()=>{});};
    input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
    const run={...input,...context,requestId:id,signal:task.controller.signal,backendSession:prior?.session,
      onSession:session=>{this.sessions.set(sessionKey,{session,unknown:false});input.onSession?.(session);},
      onDelta:delta=>{this.publish(delta,task);input.onDelta?.(delta);},
      confirm:(level,what,detail)=>this.request(task,'authorization',{level,title:what,detail},input.confirm?()=>input.confirm(level,what,detail):null),
      askUser:(question,options)=>this.request(task,'input',{question,options},input.askUser?()=>input.askUser(question,options):null)};
    try{
      await this.start(run);
      task.result=await this.driver.run(run);task.state=task.result.state==='COMPLETED'?'completed':task.result.state==='CANCELLED'?'cancelled':'failed';
      if(task.result.stopReason==='backend_result_unknown'&&this.sessions.has(sessionKey))this.sessions.get(sessionKey).unknown=true;
      return task.result;
    }catch(error){task.state=task.controller.signal.aborted?'cancelled':'failed';task.result={state:task.state==='cancelled'?'CANCELLED':'FAILED',content:'',error:task.controller.signal.aborted?null:String(redact(error.message)),aborted:task.controller.signal.aborted,stopReason:task.controller.signal.aborted?'cancelled':'backend_start_failed'};return task.result;}
    finally{input.signal?.removeEventListener('abort',abort);this.releasePending(id);this.runtime={state:this.closed?'closed':'idle',available:false,error:null};await this.driver.close();}
  }
  async cancel(taskId,context={}) {const task=this.tasks.get(String(taskId));if(!task||task.ownerId!==String(context.ownerId||'local'))throw portError('Task 不属于此 owner','BACKEND_TASK_NOT_FOUND');if(task.state!=='working')return {cancelled:false,state:task.state};task.controller.abort();this.releasePending(task.id);return {cancelled:true,state:'cancelling'};}
  async control(method,params={},context={}) {
    if(this.name==='builtin')throw portError('内置后端不提供 ACP 管理方法');
    if([...this.tasks.values()].some(t=>t.state==='working'))throw portError('请先结束当前 Task','BACKEND_BUSY');
    await this.start(context);
    if(method==='inspect'){
      const info=await this.driver.sessionRequest('session/new',{cwd:this.root,...(this.name==='openclaw'?{}:{mcpServers:[]})});
      if(info.sessionId&&this.driver.capabilityInfo.sessionCapabilities?.close)await this.driver.rpc.request('session/close',{sessionId:info.sessionId});
      return {...info,authMethods:this.driver.authMethods,agentCapabilities:this.driver.capabilityInfo};
    }
    return this.driver.control(method,params);
  }
  async close(){if(this.closed)return;this.closed=true;for(const task of this.tasks.values())if(task.state==='working'){task.controller.abort();this.releasePending(task.id);}await this.driver.interrupt();await this.driver.close();this.listeners.clear();this.runtime={state:'closed',available:false,error:null};}
}
module.exports={BackendPort,METHODS,assertBackendPort,toAgentDelta};
