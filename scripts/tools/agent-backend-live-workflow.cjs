'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const config=require('../../config/agent.backends.json');
const agent=require('../../electron/agent.cjs');
const sandbox=require('../../electron/sandbox.cjs');
const {runExternal}=require('../../electron/backends/runExternal.cjs');
const {redact}=require('../../electron/redaction.cjs');

const requested=process.argv.find(arg=>arg.startsWith('--backends='))?.slice('--backends='.length);
const backends=(requested||'hermes,opencode').split(',').map(value=>value.trim()).filter(Boolean);
if(!backends.length||backends.some(name=>!['hermes','opencode','openclaw'].includes(name))){
  console.error('Usage: node scripts/tools/agent-backend-live-workflow.cjs [--backends=hermes,opencode]');process.exit(2);
}
function inputObject(value){if(value&&typeof value==='object')return value;try{return JSON.parse(String(value||''));}catch{return{};}}
function approvedPath(root,value){if(typeof value!=='string'||!value)return'';const absolute=path.isAbsolute(value)?path.resolve(value):path.resolve(root,value);const relative=path.relative(root,absolute);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)?relative.replace(/\\/g,'/'):'';}
function createApproval(root,counters){
  return async(_level,what,detail)=>{
    let request={};try{request=JSON.parse(String(detail||'{}'));}catch{}
    const subject=request.subject||{},tool=request.toolCall||{},raw=inputObject(tool.rawInput||tool.arguments);
    const action=[String(what||''),String(request.title||''),String(subject.kind||''),String(tool.name||'')].join(' ').toLowerCase();
    if(/execute|terminal|command|shell/.test(action)||subject.kind==='execute'){counters.denied++;return false;}
    const file=approvedPath(root,subject.path||raw.path||raw.filePath||raw.file);
    const write=/write|edit|patch|apply/.test(action);
    const read=/read|search|inspect|view/.test(action);
    const allowed=write?file==='math.cjs':read?['math.cjs','math.test.cjs'].includes(file):false;
    if(allowed)counters.approved++;else counters.denied++;
    return allowed;
  };
}
async function main(){
  const results=[];
  for(const backend of backends){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-agent-workflow-'+backend+'-'));
    try{
      fs.writeFileSync(path.join(root,'math.cjs'),'module.exports=(a,b)=>a-b;\n');
      fs.writeFileSync(path.join(root,'math.test.cjs'),"const assert=require('node:assert/strict');const add=require('./math.cjs');assert.equal(add(2,3),5);\n");
      const cfg=agent.loadConfig(root);
      cfg.editing={...cfg.editing,autoVerify:true,blockOnFailure:true,lintCommand:'node -e "process.exit(0)"',testCommand:'node --test math.test.cjs',timeoutSeconds:30,maxVerificationRuns:1};
      const userDataDir=path.join(root,'.userdata');fs.mkdirSync(userDataDir,{recursive:true});
      const sandboxPolicy=sandbox.resolvePolicy({mode:'off'},{projectRoot:root,userDataDir});
      const permission={approved:0,denied:0};const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),120000);const startedAt=Date.now();
      let result;
      try{
        result=await runExternal({projectRoot:root,requestId:'live-workflow-'+backend+'-'+Date.now(),prompt:'Fix math.cjs so the existing node:test test passes. Do not edit math.test.cjs. Do not run commands or install dependencies; CodeNode will run the test independently after your edits. Reply with exactly AGENT_LIVE_WORKFLOW_DONE after editing.',history:[],canvasSummary:'',goalWriteScope:['math.cjs'],settings:{...config.defaults,backend,executable:config.commands[backend],args:config.defaultArgs[backend]||[],sandbox:'workspace-write',turnTimeoutMs:70000},cfg,sandboxPolicy,signal:controller.signal,onDelta:()=>{},confirm:createApproval(root,permission),verifyRun:async hook=>{
          const command=String(hook.command||'');let argv;
          if(command==='node -e "process.exit(0)"')argv=['-e','process.exit(0)'];
          else if(command==='node --test math.test.cjs')argv=['--test','math.test.cjs'];
          else return{ok:false,output:'live smoke rejected an unexpected verification command',exitCode:126};
          try{const output=execFileSync(process.execPath,argv,{cwd:root,encoding:'utf8',windowsHide:true,timeout:35000});return{ok:true,output,exitCode:0};}
          catch(error){return{ok:false,output:String(error.stdout||'')+'\n'+String(error.stderr||error.message||error),exitCode:error.status||1};}
        }});
      }finally{clearTimeout(timer);}
      const summary={backend,state:result?.state||'FAILED',stopReason:result?.stopReason||null,accepted:result?.ok===true,sentinel:String(result?.reply||'').includes('AGENT_LIVE_WORKFLOW_DONE'),verified:result?.codeVerification?.verified===true,changedFiles:result?.changes?.files?.map(file=>file.path)||[],goalScopeViolations:result?.goalScopeViolations||[],toolCalls:(result?.toolCalls||[]).map(call=>({name:call.name,ok:call.ok,callId:call.callId})),permissions:permission,latencyMs:Date.now()-startedAt,...(result?.error?{error:String(redact(result.error)).slice(0,500)}:{}),...(result?.backendErrorCode!=null?{backendErrorCode:result.backendErrorCode}:{}),...(result?.backendErrorMethod?{backendErrorMethod:result.backendErrorMethod}:{}),...(result?.backendErrorDetails!=null?{backendErrorDetails:redact(result.backendErrorDetails)}:{}),...(result?.backendStderr?{backendStderr:redact(result.backendStderr).slice(-2500)}:{})};
      results.push(summary);console.log(JSON.stringify(summary));
    }catch(error){const summary={backend,state:'FAILED',stopReason:null,accepted:false,sentinel:false,verified:false,changedFiles:[],goalScopeViolations:[],toolCalls:[],permissions:{approved:0,denied:0},latencyMs:0,error:String(redact(error?.message||error)).slice(0,500)};results.push(summary);console.log(JSON.stringify(summary));}
    finally{const resolved=path.resolve(root);if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-agent-workflow-'+backend+'-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
  }
  const failed=results.some(result=>result.accepted!==true||result.verified!==true||result.changedFiles.length!==1||result.changedFiles[0]!=='math.cjs'||result.goalScopeViolations.length>0);
  console.log('REAL AGENT FILE WORKFLOW: '+(failed?'FAIL':'PASS')+' ('+results.length+' ACP backends; isolated workspace; command approval denied; independent node:test)');
  if(failed)process.exitCode=1;
}
main().catch(error=>{console.error(String(redact(error?.stack||error)));process.exitCode=1;});
