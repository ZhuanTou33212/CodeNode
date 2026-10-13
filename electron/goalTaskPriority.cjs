'use strict';
const config=require('../config/goal.task-priorities.json');
const priorities=new Map(config.priorities.map(item=>[item.id,item]));
if(!priorities.has(config.default)||priorities.size!==config.priorities.length||config.priorities.some(item=>!Number.isFinite(item.rank))||new Set(config.priorities.map(item=>item.rank)).size!==config.priorities.length)throw new Error('Goal Task 优先级配置无效');

function normalize(value){
  const id=value==null||String(value).trim()===''?config.default:String(value).trim();
  if(!priorities.has(id))throw new Error('Task 优先级无效：'+id);
  return id;
}
function stored(value){const id=String(value||config.default);return priorities.has(id)?id:config.default;}
function item(value){const found=priorities.get(stored(value));if(!found)throw new Error('Goal Task 优先级配置无效');return found;}
function rank(value){return item(value).rank;}
function label(value){return item(value).label;}
function order(tasks){return tasks.map((task,index)=>({task,index})).sort((a,b)=>rank(a.task.priority)-rank(b.task.priority)||a.index-b.index).map(item=>item.task);}

module.exports={config,normalize,stored,rank,label,order};
