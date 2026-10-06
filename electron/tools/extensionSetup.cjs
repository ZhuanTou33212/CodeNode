'use strict';
const fs=require('fs');const path=require('path');
const config=require('../../config/extension.setup.json');
const {atomicWriteFile}=require('../atomicFile.cjs');
const mcp=require('./mcpClient.cjs');
const queues=new Map();
function targetFor(root) {
  if(typeof root!=='string'||!root.trim())throw Error('请先打开项目');
  const resolved=fs.realpathSync(root);if(!fs.statSync(resolved).isDirectory())throw Error('项目目录无效');
  const target=path.join(resolved,'.codenode','extensions.json');
  for(const candidate of [path.dirname(target),target])if(fs.existsSync(candidate)) {
    const real=fs.realpathSync(candidate);if(real!==resolved&&!real.startsWith(resolved+path.sep))throw Error('扩展配置路径超出项目目录');
  }
  return {root:resolved,target,fallback:path.join(resolved,'config','extensions.json')};
}
function decode(raw) {
  if(typeof raw==='string') {if(Buffer.byteLength(raw)>config.maxImportBytes)throw Error('配置过大');raw=JSON.parse(raw);}
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&raw.mcpServers) {
    return Object.entries(raw.mcpServers).map(([name,value])=>({ ...value,name,kind:'mcp',enabled:true }));
  }
  const list=Array.isArray(raw)?raw:raw&&Array.isArray(raw.extensions)?raw.extensions:raw&&raw.name?[raw]:null;
  if(!list||!list.length)throw Error('请提供扩展对象、extensions 数组或 mcpServers 配置');
  if(list.length>config.maxEntries)throw Error('一次最多接入 '+config.maxEntries+' 个扩展');
  return list;
}
function readExisting(loc) {
  const file=fs.existsSync(loc.target)?loc.target:fs.existsSync(loc.fallback)?loc.fallback:null;
  if(!file)return {file:null,text:null,data:{extensions:[]},entries:[]};
  const real=fs.realpathSync(file);if(!real.startsWith(loc.root+path.sep))throw Error('已有配置路径超出项目目录');
  const text=fs.readFileSync(file,'utf8');let data;
  try {data=JSON.parse(text);}catch {throw Error('已有扩展配置不是有效 JSON，未覆盖原文件');}
  const entries=Array.isArray(data)?data:data&&Array.isArray(data.extensions)?data.extensions:null;
  if(!entries)throw Error('已有扩展配置格式不支持，未覆盖原文件');
  return {file,text,data,entries};
}
async function prepare(item,root,discover) {
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error('扩展条目格式错误');
  const entry={...item,name:String(item.name||'').trim(),kind:String(item.kind||'项目扩展'),enabled:item.enabled!==false};
  delete entry.source;
  if(!/^[\p{L}\p{N}_-]{1,80}$/u.test(entry.name))throw Error('名称请使用字母、中文、数字、下划线或连字符，最多 80 字');
  if(entry.kind.toLowerCase()==='skills') {
    if(!String(entry.instructions||'').trim())throw Error('请填写 Skill 指令内容');
  } else if(entry.kind.toLowerCase()==='mcp') {
    if(entry.env && (typeof entry.env!=='object'||Array.isArray(entry.env)||Object.entries(entry.env).some(([name,value])=>! /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string'||value.includes('\0'))))throw Error('MCP 环境变量必须是名称与字符串值的 JSON 对象');
    if(entry.url) {const url=new URL(entry.url);if(!['http:','https:'].includes(url.protocol))throw Error('MCP 地址必须为 HTTP 或 HTTPS');}
    else if(!String(entry.command||'').trim())throw Error('请填写 MCP 启动命令或服务地址');
    if(entry.args&&!Array.isArray(entry.args))throw Error('MCP args 必须是数组');
    if(discover && entry.enabled) {
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),config.discoveryTimeoutMs);
      try {
        const ready=await mcp.ensureSession(root,entry,{signal:controller.signal});
        if(!ready.ok)throw Error(ready.error);
        if(!Array.isArray(ready.session.toolDefinitions)||!ready.session.toolDefinitions.length)throw Error('MCP 未返回可用工具，未保存配置');
        const definitions=[...ready.session.toolDefinitions];let cursor=ready.session.toolsNextCursor;const cursors=new Set();
        while(cursor) {
          if(cursors.has(cursor)||cursors.size>=config.maxDiscoveryPages)throw Error('MCP 工具分页异常，未保存配置');
          cursors.add(cursor);const page=await ready.session.rpc('tools/list',{cursor},config.discoveryTimeoutMs,controller.signal);
          if(!Array.isArray(page.tools))throw Error('MCP 工具列表格式错误');definitions.push(...page.tools);cursor=page.nextCursor;
        }
        entry.tools=definitions.filter(tool=>tool&&typeof tool.name==='string'&&tool.name.trim()).map(tool=>({name:String(tool.name),description:String(tool.description||''),parameters:tool.inputSchema||{type:'object',properties:{}},readOnly:entry.readOnly===true}));
      } finally {clearTimeout(timer);mcp.closeSession(mcp.sessionKey(root,entry));}
    }
  } else if(!String(entry.command||'').trim())throw Error('请填写扩展启动命令');
  return entry;
}
async function addUnlocked(root,input) {
  const loc=targetFor(root);const before=readExisting(loc);
  const raw=decode(input);if(raw.length>config.maxEntries)throw Error('一次接入的扩展过多');
  const names=new Set(require('./toolkit.cjs').buildDefaultRegistryWithConfig({}).listTools().map(tool=>tool.name));
  for(const entry of before.entries) {names.add(entry.name);for(const tool of entry.tools||[])names.add(tool.name);}
  const added=[];
  for(const item of raw) {
    if(names.has(String(item.name||'').trim()))throw Error('名称已存在：'+item.name);
    const entry=await prepare(item,loc.root,true);names.add(entry.name);
    for(const tool of entry.tools||[]) {if(tool.name!==entry.name&&names.has(tool.name))throw Error('工具名称已存在：'+tool.name);names.add(tool.name);}
    added.push(entry);
  }
  const latest=readExisting(loc);if(latest.file!==before.file||latest.text!==before.text)throw Error('扩展配置已被其他程序修改，请重试');
  const entries=[...before.entries,...added];const data=Array.isArray(before.data)?entries:{...before.data,extensions:entries};
  atomicWriteFile(loc.target,JSON.stringify(data,null,2)+'\n');
  return {ok:true,added:added.map(entry=>({name:entry.name,kind:entry.kind,toolCount:entry.tools?.length||0})),file:loc.target};
}
function add(root,input) {
  const key=String(root);const previous=queues.get(key)||Promise.resolve();
  const run=previous.catch(()=>{}).then(()=>addUnlocked(root,input)).catch(error=>({ok:false,error:String(error.message||error)}));
  queues.set(key,run);run.finally(()=>{if(queues.get(key)===run)queues.delete(key)});return run;
}
module.exports={add,decode,prepare,targetFor};
