'use strict';
const { AcpBackend } = require('./acp.cjs');
const { BackendPort, assertBackendPort } = require('./backendPort.cjs');
const config = require('../../config/agent.backends.json');
class BuiltinBackend {
  constructor(){this.controller=null;}
  capabilitySnapshot(){return {conversation:true,events:true,approvals:true,interrupt:true,resume:true,customTools:true,hardBudget:true,usage:true};}
  run(input){const controller=input.controller||new AbortController();this.controller=controller;const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();return require('../agent.cjs').runAgentChat({...input,signal:controller.signal}).finally(()=>input.signal?.removeEventListener('abort',abort));}
  async interrupt(){this.controller?.abort();}
  async close(){this.controller=null;}
}
function createBackend(name,settings={},deps={}){
  if(!config.backends.includes(name))throw new Error('未知 Agent 后端：'+name);
  const normalized=require('./settings.cjs').normalize({...config.defaults,...settings,backend:name});
  return assertBackendPort(new BackendPort(name,normalized,name==='builtin'?new BuiltinBackend():new AcpBackend({...normalized,turnTimeoutMs:settings.turnTimeoutMs},deps)));
}
module.exports={createBackend,BuiltinBackend};
