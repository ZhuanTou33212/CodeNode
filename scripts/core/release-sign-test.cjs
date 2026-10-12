'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

if(process.platform!=='win32'){
  console.log('RELEASE SIGN: SKIP (Authenticode integration requires Windows PowerShell)');
  process.exit(0);
}

const prefix='codenode-release-sign-';
const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
const release=path.join(root,'release');
const unpacked=path.join(release,'win-unpacked');
const sourceExe=path.join(process.env.SystemRoot||'C:\\Windows','System32','whoami.exe');
fs.mkdirSync(path.join(unpacked,'resources'),{recursive:true});
fs.copyFileSync(sourceExe,path.join(release,'CodeNode-0.13.0.exe'));
fs.copyFileSync(sourceExe,path.join(unpacked,'CodeNode.exe'));
fs.writeFileSync(path.join(unpacked,'resources','app.asar'),'archive fixture');

try{
  const script=path.join(__dirname,'../release-sign.cjs');
  const result=spawnSync(process.execPath,[script,'--no-sign','--release-dir='+release],{
    cwd:path.resolve(__dirname,'../..'),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr||result.stdout);
  const manifest=JSON.parse(fs.readFileSync(path.join(release,'manifest.json'),'utf8'));
  const executableStatuses=manifest.artifacts.filter(item=>item.kind!=='asar').map(item=>item.signatureStatus);
  assert.deepEqual(executableStatuses,['Valid','Valid'],'PowerShell reports the signed PE fixture, not an unavailable cmdlet');
  assert.equal(manifest.artifacts.find(item=>item.kind==='asar')?.signatureStatus,'NotApplicable');
  console.log('RELEASE SIGN: PASS (Windows Security module path isolation and Authenticode status verification)');
}finally{
  const resolved=path.resolve(root),temp=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)===temp&&path.basename(resolved).startsWith(prefix))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
