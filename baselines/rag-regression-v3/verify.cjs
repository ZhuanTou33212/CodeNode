'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base=__dirname,host=path.resolve(base,'../..');const m=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const [file,expected] of Object.entries(m.files)){const target=path.resolve(base,file);assert.ok(target.startsWith(base+path.sep),'Manifest path escapes baseline');assert.equal(hash(target),expected,'Frozen file modified: '+file);}
assert.equal(hash(path.join(base,'data/rag-acceptance-v2.json')),m.datasetHash,'Dataset identity');
const report=JSON.parse(fs.readFileSync(path.join(base,'reports/agent-100.json'),'utf8'));
assert.ok(report.finishedAt);assert.equal(report.rows.length,100);assert.equal(new Set(report.rows.map(x=>x.id)).size,100);assert.equal(report.rows.filter(x=>x.error||!x.grade||x.grade.error).length,0);assert.equal(report.rows.filter(x=>x.success).length,m.metrics.overall);
for(const [file,expected] of Object.entries(report.runtimeHashes)){const target=file.startsWith('scripts/')?path.join(base,'evaluator',path.basename(file)):path.join(base,'runtime',file);assert.equal(hash(target),expected,'Measured code identity: '+file);}
if(process.argv.includes('--check-host-evaluator'))for(const [file,expected] of Object.entries(m.hostEvaluatorFiles))assert.equal(hash(path.join(host,file)),expected,'Host evaluator changed: '+file);
console.log(JSON.stringify({baselineId:m.baselineId,verifiedFiles:Object.keys(m.files).length,datasetHash:m.datasetHash,completed:100,successes:63,tuningClosed:m.tuningClosedOnThisDataset,hostEvaluatorChecked:process.argv.includes('--check-host-evaluator')}));
