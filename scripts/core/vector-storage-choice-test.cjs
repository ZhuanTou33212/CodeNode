'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const settings=require("../../electron/ragSettings.cjs");const agent=require("../../electron/agent.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-vector-choice-'));
(async()=>{try{
  for(const backend of ['memory','sqlite','milvus']){
    const value=settings.normalizedSettings({provider:'none',backend,dim:4096,milvusAddress:'http://127.0.0.1:19530',milvusCollection:'sample_vectors',milvusToken:'synthetic-secret'},{});
    assert.equal(value.backend,backend);assert.equal((await settings.checkSettings(value)).ok,true);
    settings.writeSettings(root,value,{});const loaded=agent.loadConfig(root).rag;assert.equal(loaded.vectorStore,backend);
    if(backend==='milvus'){assert.equal(loaded.milvusCollection,'sample_vectors');assert.equal(settings.publicSettings(loaded).hasMilvusToken,true);assert.ok(!JSON.stringify(settings.publicSettings(loaded)).includes('synthetic-secret'));}
  }
  assert.throws(()=>settings.normalizedSettings({provider:'none',backend:'invalid',dim:4096},{}),/请选择/);
  assert.throws(()=>settings.normalizedSettings({provider:'local',backend:'milvus',dim:4096},{}),/服务地址/);
  for (const enabled of [true, false]) for (const strictValidation of [true, false]) {
    const value = settings.normalizedSettings({ provider: 'none', backend: 'memory', dim: 4096, enabled, strictValidation }, {});
    settings.writeSettings(root, value, {});
    const loaded = agent.loadConfig(root);
    assert.equal(loaded.rag.enabled, enabled);
    assert.equal(loaded.grounding.mode, strictValidation ? 'enforce' : 'warn');
    assert.equal(loaded.grounding.semanticMode, strictValidation ? 'enforce' : 'off');
    assert.equal(settings.publicSettings(loaded.rag, loaded.grounding).strictValidation, strictValidation);
    assert.equal(settings.publicSettings(loaded.rag).enabled, enabled);
  }
  assert.equal(settings.normalizedSettings({ provider: 'none', backend: 'memory', dim: 4096 }, {}, { semanticMode: 'enforce' }).strictValidation, true);
  assert.throws(() => settings.normalizedSettings({ provider: 'none', backend: 'memory', dim: 4096, strictValidation: 'false' }, {}), /布尔值/);
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Unexpected network request'); };
  try {
    const disabled = settings.normalizedSettings({ provider: 'ollama', backend: 'memory', dim: 4096, enabled: false, model: 'test', base: 'http://127.0.0.1:9' }, {});
    assert.equal((await settings.checkSettings(disabled)).ok, true);
  } finally { global.fetch = originalFetch; }
  console.log('VECTOR CHOICE: PASS (all choices persisted without forced memory, BM25 stays offline, Milvus fields and secret redaction, invalid settings rejected)');
}finally{if(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('codenode-vector-choice-'))fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1});
