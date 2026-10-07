'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../electron/agent.cjs');
const toolkit = require('../electron/tools/toolkit.cjs');
const { AgentToolContext } = require('../electron/tools/context.cjs');
const sandbox = require('../electron/sandbox.cjs');
const { config } = require('../electron/editingSettings.cjs');
const { PREFIX } = require('../electron/codeVerification.cjs');
const { installScriptedModel } = require('./lib/scripted-model.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-coding-loop-'));
  try {
    const file = path.join(root,'calc.cjs');
    fs.writeFileSync(path.join(root,'calc.test.cjs'),"require('node:assert/strict').equal(require('./calc.cjs').value,2);\n");
    const policy = sandbox.resolvePolicy({mode:'off'},{projectRoot:root,userDataDir:root});sandbox.setDefaultPolicy(policy);
    const controller=new AbortController();
    const context=new AgentToolContext({projectRoot:root,confirm:async()=>true,sandbox:policy,signal:controller.signal});
    const registry=toolkit.buildDefaultRegistryWithConfig({ragEnabled:false});
    const cfg={apiBase:'http://scripted.local/v1',apiKey:'',model:'scripted-model',maxTokens:1024,
      limits:{maxTotalTokens:1000000,maxConcurrentRuns:1},reliability:{maxAttempts:1,retryBaseMs:1,retryMaxMs:2},
      compression:{enabled:false},rag:{enabled:false},tools:{},editing:{...config.defaults,lintCommand:'node -e "process.exit(0)"',timeoutSeconds:8}};
    const run=async(settings,script)=>{
      fs.writeFileSync(file,'module.exports = { value: 1 };\n');
      const deltas=[];const stub=installScriptedModel(script,{loopLast:false});
      try {
        const result=await agent.runAgentChat({cfg:{...cfg,editing:{...cfg.editing,...settings}},messages:[{role:'system',content:'Coding task'},{role:'user',content:'修复 calc 并验证'}],
          tools:{registry,context},signal:controller.signal,onDelta:event=>deltas.push(event),timeoutMs:20000});
        return{result,deltas,seen:stub.seen};
      }finally{stub.restore();}
    };
    const edit={toolCalls:[{name:'edit_file',args:{path:'calc.cjs',oldText:'value: 1',newText:'value: 2'}}]};
    let checked=await run({},[edit,{content:'局部测试通过。'}]);
    assert.equal(checked.result.state,'COMPLETED',JSON.stringify(checked.result));
    assert.ok(checked.deltas.some(delta=>delta.kind==='code_verification'&&delta.codeVerification.verified));
    assert.ok(checked.seen[1].messages.some(message=>message.role==='user'&&String(message.content).startsWith(PREFIX)),'Model sees executed test results before final response');
    assert.equal(checked.seen.length,2,'Local verification makes no model planning call');
    checked=await run({testCommand:'node -e "process.exit(1)"'},[edit,{content:'所有测试都通过。'},{content:'已经完成，全部通过。'}]);
    assert.equal(checked.result.state,'FAILED');assert.match(checked.result.error,/校验未通过/);
    assert.doesNotMatch(checked.result.content,/全部通过/);assert.match(fs.readFileSync(file,'utf8'),/value: 2/,'Failed validation preserves the edit for repair');
    assert.ok(checked.deltas.some(delta=>delta.kind==='content_reset'&&delta.reason==='code_verification_failed'));
    checked=await run({autoVerify:false},[edit,{content:'修改完成。'}]);
    assert.equal(checked.result.state,'COMPLETED');assert.ok(checked.deltas.some(delta=>delta.codeVerification?.status==='disabled'&&delta.codeVerification.verified===false));
    console.log('CODING LOOP: PASS (real tool loop, pre-answer test results, zero planner calls, false-success rejection and explicit disable)');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
