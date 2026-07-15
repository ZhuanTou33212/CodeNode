import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codenode-queue-'));
const state = path.join(root, '.codenode');
for (const dir of ['inbox','processing','completed','failed']) fs.mkdirSync(path.join(state,'queue',dir),{recursive:true});
fs.mkdirSync(path.join(state,'results'),{recursive:true}); fs.writeFileSync(path.join(state,'project.json'),'{}');
const id='request-test'; const requestDir=path.join(state,'queue','inbox',id); fs.mkdirSync(requestDir);
const request={schemaVersion:'3.0',requestId:id,transport:'local-file-queue',mode:'markdown-blueprint',action:'build-markdown',scope:{kind:'selected-node',targetNodeId:'doc'},output:{workspaceRoot:root,relativePath:'output/docs',artifactPolicy:'markdown-only'},execution:{compile:false,run:false},nodes:[{id:'doc',name:'Docs',category:'document',prompt:'write docs',inputs:[],outputs:[]}],edges:[],requiresConfirmation:true};
fs.writeFileSync(path.join(requestDir,'request.json'),JSON.stringify(request));
const script=fileURLToPath(new URL('./local-queue.mjs',import.meta.url));let run=spawnSync(process.execPath,[script,'claim',root,'latest'],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.ok(fs.existsSync(path.join(state,'queue','processing',id)));
const draft=path.join(state,'queue','processing',id,'result.draft.json');fs.writeFileSync(draft,JSON.stringify({schemaVersion:'3.0',requestId:id,mode:'markdown-blueprint',action:'build-markdown',status:'succeeded',summary:'ok',diagnostics:[],nodeResults:[{nodeId:'doc',status:'succeeded'}],processedAt:new Date().toISOString()}));
run=spawnSync(process.execPath,[script,'complete',root,id,draft],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.ok(fs.existsSync(path.join(state,'results',id,'result.json')));assert.ok(fs.existsSync(path.join(state,'queue','completed',id)));
fs.rmSync(root,{recursive:true,force:true}); console.log('CodeNode local queue lifecycle test passed');
