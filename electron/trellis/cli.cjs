'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { atomicWriteFile } = require('../atomicFile.cjs');
const { withFileLock } = require('../fileLock.cjs');
const { killProcessTree } = require('../processTree.cjs');
const { redact } = require('../redaction.cjs');
const { resolveCommand } = require('../backends/stdioRpc.cjs');
const { internal } = require('./writes.cjs');
const trellis = require('./index.cjs');
const config = require('../../config/trellis.cli.json');
const active = new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function exists(file){try{fs.lstatSync(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
function settingsFile(userData) {
  if (!path.isAbsolute(userData)) throw new Error('设置目录必须为绝对路径');
  const file = path.join(userData, 'trellis-cli.json');
  for (const target of [userData, file]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Trellis 设置路径不能为链接');
  return file;
}
function normalize(input) {
  const executable = String(input?.executable || config.defaults.executable).trim();
  const developer = String(input?.developer || '').trim();
  if (!executable || executable.length > 2048 || /[\r\n\0]/.test(executable) || (!path.isAbsolute(executable) && !/^[A-Za-z0-9_.-]+$/.test(executable))) throw new Error('请填写命令名、绝对可执行路径或本地仓库目录');
  if (developer && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(developer)) throw new Error('开发者名称使用字母、数字、下划线或短横线，最多 64 字符');
  return { executable, developer };
}
function readSettings(userData) {
  const file = settingsFile(userData);
  if(fs.existsSync(file)&&fs.statSync(file).size>16384)throw new Error('Trellis 本机设置文件过大');
  return fs.existsSync(file) ? normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) : { ...config.defaults };
}
function saveSettings(userData, input) {
  const settings = normalize(input); atomicWriteFile(settingsFile(userData), JSON.stringify(settings, null, 2) + '\n'); return settings;
}
function commandOf(executable) {
  let command = executable;
  if (path.isAbsolute(command) && fs.existsSync(command) && fs.statSync(command).isDirectory()) {
    command = config.localEntries.map(entry => path.join(command, entry)).find(file => fs.existsSync(file)) || '';
    if (!command) throw new Error('目录中没有 Trellis CLI 入口；请选择已安装的命令或已构建的仓库');
  }
  if (path.isAbsolute(command) && /\.cmd$/i.test(command)) {
    const text = fs.readFileSync(command, 'utf8');
    const match = text.match(/"%dp0%\\([^"\r\n]+\.(?:js|mjs))"/i);
    if (!match) throw new Error('此 CMD 不是可识别的 npm 启动器；请选择实际 JS 或 EXE 入口');
    command = path.resolve(path.dirname(command), match[1]);
  }
  if (/\.(?:js|mjs|cjs)$/i.test(command) && path.isAbsolute(command)) {
    if (!fs.statSync(command).isFile()) throw new Error('CLI 入口不是文件');
    return { command: process.execPath, prefix: [command] };
  }
  const resolved = resolveCommand(command);
  if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(resolved.command)) throw new Error('不通过 shell 执行启动脚本，请选择 npm 的 JS 入口');
  return resolved;
}
function run(resolved, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE:'1', CI:'1', NO_UPDATE_NOTIFIER:'1' };
    for (const key of Object.keys(env)) if (/^GIT_/.test(key) || ['NODE_OPTIONS','NODE_PATH'].includes(key)) delete env[key];
    const child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd, env, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'], detached:process.platform!=='win32' });
    let output = '', bytes = 0, ended = false;
    /** @type {Error|null} */ let failure=null;
    /** @type {NodeJS.Timeout|undefined} */ let grace;
    const finish = (error, code) => { if (ended) return; ended=true;clearTimeout(timer);clearTimeout(grace);error?reject(error):resolve({code,output:redact(output)}); };
    const stop=error=>{if(ended||failure)return;failure=error;killProcessTree(child,true);grace=setTimeout(()=>finish(error),config.killGraceMs)};
    const timer = setTimeout(()=>stop(new Error('Trellis 命令超时，已停止进程')),timeout);
    const collect = data => { if(ended||failure)return;bytes+=data.length;if(bytes>config.maxOutputBytes)stop(new Error('Trellis 输出超过预算，已停止进程'));else output+=data.toString('utf8'); };
    child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',error=>finish(error));child.on('close',code=>finish(failure,code));
  });
}
/** @param {string} userData @param {{executable:string,developer:string}|null} [override] */
async function probe(userData,override=null) {
  const settings=override||readSettings(userData); let resolved;
  const scratch=path.join(userData,'trellis-probe-'+randomUUID());fs.mkdirSync(scratch,{recursive:true});
  try {
    resolved=commandOf(settings.executable);
    const version=await run(resolved,['--version'],scratch,config.probeTimeoutMs);
    if(version.code!==0)throw new Error('CLI 无法启动：'+version.output);
    const help=await run(resolved,['init','--help'],scratch,config.probeTimeoutMs);
    const supported=help.code===0&&/trellis/i.test(help.output)&&config.requiredFlags.every(flag=>help.output.includes(flag));
    return {settings,found:true,supported,version:version.output.trim().slice(0,160),entry:resolved.prefix[0]||resolved.command,error:supported?'':'本机 CLI 的初始化参数不在已识别范围内，请检查版本或入口'};
  }catch(error){return {settings,found:false,supported:false,version:'',entry:resolved?.prefix[0]||resolved?.command||'',error:String(error.message||error)};}
  finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
function planDir(root,id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('接入记录编号无效');
  return internal(root,'connect/'+id);
}
function manifest(directory) {
  const files=[];let totalBytes=0;
  const walk=relative=>{
    const full=path.join(directory,relative);
    for(const entry of fs.readdirSync(full,{withFileTypes:true})){
      const source=relative?relative+'/'+entry.name:entry.name;
      const file=path.join(directory,source);
      if(entry.isSymbolicLink())throw new Error('初始化产物包含链接，未导入：'+source);
      if(entry.isDirectory())walk(source);
      else if(entry.isFile()){const bytes=fs.readFileSync(file);totalBytes+=bytes.length;if(files.length>=config.maxFiles||totalBytes>config.maxTotalBytes)throw new Error('初始化产物超过文件预算');files.push({source,bytes:bytes.length,fingerprint:hash(bytes)});}
    }
  };
  if(fs.lstatSync(directory).isSymbolicLink())throw new Error('初始化目录不能为链接');walk('');
  files.sort((a,b)=>a.source.localeCompare(b.source));return {files,totalBytes,fingerprint:hash(JSON.stringify(files))};
}
async function prepare(root,userData,input) {
  root=fs.realpathSync(root);
  if(exists(path.join(root,'.trellis')))throw new Error('项目已有 .trellis，直接刷新任务即可；不会重新初始化');
  if(active.has(root))throw new Error('该项目正在准备接入');
  const settings=normalize({...readSettings(userData),developer:input?.developer});if(!settings.developer)throw new Error('请填写开发者名称');
  active.add(root);const id=randomUUID(),directory=planDir(root,id),generated=path.join(directory,'generated');fs.mkdirSync(generated,{recursive:true});
  try {
    const info=await probe(userData,settings);if(!info.supported)throw new Error(info.error);
    // Prevent upstream Git probes/auto-commits from walking into the user's repository.
    const git=resolveCommand('git');const initialized=await run(git,['init','--quiet','--template='],generated,config.probeTimeoutMs);if(initialized.code!==0)throw new Error('隔离 Git 工程无法创建：'+initialized.output);
    const hooks=await run(git,['config','core.hooksPath',path.join(generated,'no-hooks')],generated,config.probeTimeoutMs);if(hooks.code!==0)throw new Error('隔离 Git 配置失败');
    const result=await run(commandOf(settings.executable),[...config.initArgs,'--user',settings.developer],generated,config.initTimeoutMs);
    if(result.code!==0)throw new Error('初始化失败，当前项目未接入：'+result.output);
    const shared=path.join(generated,'.trellis');
    manifest(shared);
    for(const name of ['spec','tasks','workspace'])if(!fs.statSync(path.join(shared,name)).isDirectory())throw new Error('生成的 .trellis 缺少 '+name+' 目录');
    // Keep per-checkout identity/runtime private without changing the user's root .gitignore.
    const ignores=path.join(shared,'.gitignore');if(!fs.existsSync(ignores))fs.writeFileSync(ignores,'.developer\n.runtime/\n');
    const data=manifest(shared),plan={version:1,id,root,status:'prepared',developer:settings.developer,cliVersion:info.version,createdAt:new Date().toISOString(),...data,diagnostics:trellis.detectProject(generated).diagnostics};
    atomicWriteFile(path.join(directory,'plan.json'),JSON.stringify(plan,null,2)+'\n');
    // Only the shared project materials are retained, never platform hooks or a Git repo.
    const kept=path.join(directory,'shared');fs.renameSync(shared,kept);fs.rmSync(generated,{recursive:true,force:true});
    return plan;
  }catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}finally{active.delete(root);}
}
function readPlan(root,id) {
  const directory=planDir(root,id),file=path.join(directory,'plan.json');
  if(fs.statSync(file).size>config.maxFiles*1000)throw new Error('接入记录过大');
  const plan=JSON.parse(fs.readFileSync(file,'utf8'));
  if(plan.version!==1||plan.id!==id||plan.root!==fs.realpathSync(root)||!Array.isArray(plan.files)||!plan.fingerprint)throw new Error('接入记录损坏或工程不匹配');
  if(plan.files.length>config.maxFiles||hash(JSON.stringify(plan.files))!==plan.fingerprint||plan.files.some(file=>typeof file.source!=='string'||/\\|\0/.test(file.source)||path.isAbsolute(file.source)||file.source.split('/').includes('..')))throw new Error('接入文件清单损坏或包含越界路径');
  return plan;
}
function readPreview(root,id,source) {
  const plan=readPlan(root,id);if(!plan.files.some(file=>file.source===source))throw new Error('文件不属于此接入预览');
  const base=plan.status==='applied'?path.join(root,'.trellis'):path.join(planDir(root,id),'shared');
  const current=manifest(base);if(current.fingerprint!==plan.fingerprint)throw new Error('预览文件已变化，请重新生成');
  const bytes=fs.readFileSync(path.join(base,source));return {source,content:bytes.subarray(0,config.previewBytes).toString('utf8'),truncated:bytes.length>config.previewBytes};
}
function apply(root,id) {
  const directory=planDir(root,id),file=path.join(directory,'plan.json');
  return withFileLock(file,()=>{
    const plan=readPlan(root,id),target=path.join(fs.realpathSync(root),'.trellis'),shared=path.join(directory,'shared');
    const save=()=>atomicWriteFile(file,JSON.stringify(plan,null,2)+'\n');
    if(plan.status==='applied')return plan;
    if(plan.status==='applying'&&exists(target)){
      if(manifest(target).fingerprint!==plan.fingerprint)throw new Error('接入目录存在外部修改，请先核对；不会覆盖');
      plan.status='applied';save();return plan;
    }
    if(exists(target))throw new Error('预览后项目出现 .trellis，已停止导入；请刷新任务');
    if(manifest(shared).fingerprint!==plan.fingerprint)throw new Error('暂存文件发生变化，请重新生成预览');
    plan.status='applying';save();fs.renameSync(shared,target);
    plan.status='applied';save();return plan;
  });
}
function reconcile(root){
  const directory=internal(root,'connect');if(!fs.existsSync(directory))return [];
  const diagnostics=[];
  for(const name of fs.readdirSync(directory).filter(name=>/^[0-9a-f-]{36}$/.test(name))){
    const file=path.join(planDir(root,name),'plan.json');if(!fs.existsSync(file))continue;
    try{if(fs.statSync(file).size>config.maxFiles*1000)throw Error('接入记录过大');const header=JSON.parse(fs.readFileSync(file,'utf8'));if(header.status==='applying'&&exists(path.join(root,'.trellis')))apply(root,name);}
    catch(error){diagnostics.push({source:'.codenode/trellis-connect/'+name,error:'初始化记录需要核对：'+String(error.message||error)})}
  }
  return diagnostics;
}
module.exports={readSettings,saveSettings,probe,prepare,readPlan,readPreview,apply,commandOf,reconcile};
