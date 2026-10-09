'use strict';
const fs=require('fs');
const path=require('path');
const waitConfig=require('../../config/goal.wait.json');

function childPath(root,relative){const base=fs.realpathSync(root),candidate=path.resolve(base,relative),rel=path.relative(base,candidate);if(!rel||rel==='.'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('Agent Eval 报告目录必须位于项目内');return{base,candidate};}
function reportDirectory(root){const {base,candidate}=childPath(root,waitConfig.agentEval.reportDirectory);try{const stat=fs.lstatSync(candidate);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Agent Eval 报告目录必须是普通目录');const actual=fs.realpathSync(candidate),rel=path.relative(base,actual);if(!rel||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('Agent Eval 报告目录逃出项目根');return{base,dir:actual};}catch(error){if(error.code==='ENOENT')return{base,dir:null};throw error;}}
/** @param {Record<string, unknown>} [details] @returns {any} */
function observationBase(commitSha,mode,datasetVersion,checkedAt,status,details={}){return{id:`agent-eval:${commitSha}:${mode}:${datasetVersion}:${checkedAt}`,source:'agent-eval',status,matched:false,revision:commitSha,runId:null,detailsUrl:null,checkedAt,workflowCount:0,evaluation:{mode,datasetVersion,...details}};}
function isRequiredPass(report){
  if(!Array.isArray(report.taskSet)||!Array.isArray(report.tasks)||!report.taskSet.length)return{ok:false,total:0,passed:0,missing:[]};
  const required=report.taskSet.filter(item=>item&&item.required!==false).map(item=>String(item.id||'' )).filter(Boolean);
  const results=new Map(report.tasks.map(item=>[String(item.id||''),item]));
  const missing=required.filter(id=>results.get(id)?.status!=='pass');
  return{ok:required.length>0&&missing.length===0,total:required.length,passed:required.length-missing.length,missing};
}
function inspectReport(file,config){
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())return{invalid:'不是普通文件'};
  if(stat.size>config.agentEval.maxReportBytes)return{invalid:'报告超过读取上限'};
  try{const report=JSON.parse(fs.readFileSync(file,'utf8'));if(!report||typeof report!=='object'||Array.isArray(report))return{invalid:'报告结构无效'};return{report};}catch{return{invalid:'报告 JSON 无效'};}
}
function check(projectRoot,condition,options={}){
  const config=options.config||waitConfig,commitSha=String(condition?.commitSha||'').trim().toLowerCase(),mode=String(condition?.mode||config.agentEval.defaultMode),datasetVersion=String(condition?.datasetVersion||config.agentEval.defaultDatasetVersion),checkedAt=new Date().toISOString();
  if(!/^[0-9a-f]{40}$/.test(commitSha)||!config.agentEval.modes.includes(mode)||!datasetVersion||datasetVersion.length>100)return observationBase(commitSha,mode,datasetVersion,checkedAt,'invalid_wait_condition');
  const createdAt=Date.parse(String(condition?.createdAt||''));
  if(!Number.isFinite(createdAt))return observationBase(commitSha,mode,datasetVersion,checkedAt,'invalid_wait_condition');
  let location;
  try{location=reportDirectory(projectRoot);}catch(error){return observationBase(commitSha,mode,datasetVersion,checkedAt,'invalid_report_directory',{detail:String(error.message||error).slice(0,200)});}
  if(!location.dir)return observationBase(commitSha,mode,datasetVersion,checkedAt,'not_found');
  const prefix=`agent-eval-${commitSha.slice(0,7)}-${mode}-`;
  let candidates;
  try{candidates=fs.readdirSync(location.dir).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).map(name=>{const file=path.join(location.dir,name),stat=fs.lstatSync(file);return{name,file,mtime:stat.mtimeMs,regular:stat.isFile()&&!stat.isSymbolicLink()};}).filter(item=>item.regular).sort((a,b)=>b.mtime-a.mtime).slice(0,config.agentEval.maxCandidateReports);}catch(error){return observationBase(commitSha,mode,datasetVersion,checkedAt,'report_scan_failed',{detail:String(error.message||error).slice(0,200)});}
  let latest=null,invalidCount=0;
  for(const candidate of candidates){
    const inspected=inspectReport(candidate.file,config);
    if(!inspected.report){invalidCount++;continue;}
    const report=inspected.report;
    if(String(report.git?.fullCommit||'').toLowerCase()!==commitSha||report.mode!==mode||report.datasetVersion!==datasetVersion)continue;
    const startedAt=Date.parse(String(report.startedAt||'')),finishedAt=Date.parse(String(report.finishedAt||''));
    if(!Number.isFinite(startedAt)||!Number.isFinite(finishedAt)||finishedAt<startedAt||startedAt<createdAt)continue;
    if(!latest||startedAt>Date.parse(String(latest.report.startedAt||'')))latest={...candidate,report};
  }
  if(!latest){const result=observationBase(commitSha,mode,datasetVersion,checkedAt,invalidCount?'invalid_report':'not_found',{invalidCandidates:invalidCount});result.id=`agent-eval:${commitSha}:${mode}:${datasetVersion}:${checkedAt}`;return result;}
  const report=latest.report,required=isRequiredPass(report),selfChecks=Array.isArray(report.harness?.selfChecks)&&report.harness.selfChecks.length>0&&report.harness.selfChecks.every(item=>item?.pass===true),clean=config.agentEval.requireCleanWorktree===false||report.git?.dirty===false;
  const success=report.exitCode===config.agentEval.successExitCode&&Number(report.totals?.requiredFailed)===0&&required.ok&&selfChecks&&clean;
  const status=success?'success':!clean?'dirty_worktree':!selfChecks?'harness_failed':!required.ok?'required_tasks_incomplete':'evaluation_failed';
  const evaluation={mode,datasetVersion,model:String(report.model||'unknown').slice(0,200),total:Number(report.totals?.total)||0,run:Number(report.totals?.run)||0,passed:Number(report.totals?.passed)||0,failed:Number(report.totals?.failed)||0,skipped:Number(report.totals?.skipped)||0,requiredTotal:required.total,requiredPassed:required.passed,requiredMissing:required.missing.slice(0,50),exitCode:Number.isInteger(report.exitCode)?report.exitCode:null,dirty:report.git?.dirty===true,reportFile:latest.name.slice(0,240)};
  return{id:`agent-eval:${commitSha}:${mode}:${datasetVersion}:${latest.name}:${checkedAt}`,source:'agent-eval',status,matched:success,revision:commitSha,runId:latest.name.replace(/\.json$/i,''),detailsUrl:null,checkedAt,workflowCount:evaluation.total,evaluation};
}
module.exports={check,isRequiredPass};
