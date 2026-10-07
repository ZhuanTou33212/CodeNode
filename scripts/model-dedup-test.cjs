const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {deduplicateModels}=require('../electron/modelIdentity.cjs');
const store=require('../electron/modelStore.cjs');
const old={id:'seed-flash',model:'deepseek-v4-flash',apiBase:'https://api.deepseek.com',apiKeyError:true,apiKey:''};
const live={id:'deepseek:deepseek-flash',model:'deepseek-flash',apiBase:'https://api.deepseek.com/v1/',provider:'deepseek',apiKey:'test-key'};
let result=deduplicateModels([old,live],old.id);
assert.equal(result.models.length,1);assert.equal(result.activeId,live.id);assert.equal(result.modelAliases[old.id],live.id);
assert.equal(deduplicateModels([live,{...live,id:'other-endpoint',apiBase:'https://gateway.example/v1'}],live.id).models.length,2);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-dedup-'));
try {
 const locked={...old,apiKey:'safe:v1:invalid-cipher'}; delete locked.apiKeyError;
 const raw={models:[locked,live],activeId:old.id};fs.writeFileSync(path.join(root,'models.json'),JSON.stringify(raw));
 const stored=store.readUsableModels(root,{});assert.equal(stored.models.length,1);assert.equal(stored.activeId,live.id);
 assert.equal(store.findModel(root,{},old.id).id,live.id);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'models.json'),'utf8')),raw,'display dedup must preserve stored credentials');
 console.log('MODEL DEDUP: PASS (alias migration, valid connection priority, endpoint isolation, raw data preservation)');
} finally {fs.rmSync(root,{recursive:true,force:true});}
