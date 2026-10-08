'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const config=require('../../config/agent.backends.json');
const {AcpBackend}=require('../../electron/backends/acp.cjs');
const {capture,compare}=require('../../electron/backends/workspaceDiff.cjs');
const {redact}=require('../../electron/redaction.cjs');

const requested=process.argv.find(arg=>arg.startsWith('--backends='))?.slice('--backends='.length);
const backends=(requested||'hermes,opencode').split(',').map(value=>value.trim()).filter(Boolean);
if(!backends.length||backends.some(name=>!['hermes','opencode','openclaw'].includes(name))){
  console.error('Usage: node scripts/tools/agent-backend-live-smoke.cjs [--backends=hermes,opencode]');process.exit(2);
}

async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-agent-backend-live-'));
  const results=[];
  try{
    for(const name of backends){
      const settings={...config.defaults,backend:name,sandbox:'read-only',turnTimeoutMs:45000};
      const backend=new AcpBackend(settings);
      const controller=new AbortController();
      const watchdog=setTimeout(()=>controller.abort(),60000);
      const before=capture(root),startedAt=Date.now();
      let result;
      try{
        result=await backend.start({projectRoot:root,prompt:'Do not call tools or access files. Reply with exactly CODENODE_'+name.toUpperCase()+'_OK.',history:[],signal:controller.signal,confirm:async()=>false,onDelta:()=>{}});
      }catch(error){result={state:'FAILED',error:error?.message||String(error)};}
      finally{clearTimeout(watchdog);}
      const changes=compare(before,capture(root));
      const sentinel=String(result.content||'').includes('CODENODE_'+name.toUpperCase()+'_OK');
      const summary={backend:name,state:result.state||'FAILED',stopReason:result.stopReason||null,sentinel,changedFiles:changes.files.map(file=>file.path),snapshotComplete:changes.complete,latencyMs:Date.now()-startedAt,...(result.error?{error:String(redact(result.error)).slice(0,500)}:{})};
      results.push(summary);console.log(JSON.stringify(summary));
    }
    const failed=results.some(result=>result.state!=='COMPLETED'||!result.sentinel||result.changedFiles.length>0||!result.snapshotComplete);
    console.log('REAL AGENT ACP SMOKE: '+(failed?'FAIL':'PASS')+' ('+results.length+' backends; isolated project; permission requests denied)');
    if(failed)process.exitCode=1;
  }finally{
    const resolved=path.resolve(root);
    if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('codenode-agent-backend-live-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
main().catch(error=>{console.error(String(redact(error?.stack||error)));process.exitCode=1;});
