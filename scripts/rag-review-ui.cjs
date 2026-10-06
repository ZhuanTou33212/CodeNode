'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
const { dataset, lock } = loadFrozen();
const orderKey = (id) => require('node:crypto').createHash('sha256').update(lock.datasetSha256 + '/review/' + id).digest('hex');
const reviewDataset = { files: dataset.files, cases: dataset.cases.map(({ id, query, sources }) => ({ id, query, sources }))
  .sort((a, b) => orderKey(a.id).localeCompare(orderKey(b.id))) };
const payload = JSON.stringify({ dataset: reviewDataset, hash: lock.datasetSha256 }).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CodeNode RAG 人工复核</title>
<style>body{font:16px system-ui;margin:24px auto;max-width:1100px;padding:0 20px;color:#202b38;background:#f5f7fa}header{position:sticky;top:0;background:#f5f7fa;padding:12px 0;border-bottom:1px solid #ccd4df}button,select,input{font:inherit;padding:8px;margin:4px;border:1px solid #bcc6d4;border-radius:6px;background:white}button{cursor:pointer}article{background:white;border:1px solid #d8dfe8;border-radius:12px;padding:20px;margin:18px 0}pre{white-space:pre-wrap;word-break:break-word;background:#f0f3f8;padding:12px;max-height:420px;overflow:auto;font-size:13px}textarea{box-sizing:border-box;width:100%;height:75px;font:inherit;padding:8px}.ok{color:#14683f}.warn{color:#9c3c20}small{color:#526175}h2{font-size:18px}label{display:block;margin:12px 0}</style>
<header><h1>RAG 人工复核 · 100 题</h1><p>先按源码独立判定，作者标签不在界面显示。核对：所供证据是否足以回答问题。明确证明“否”也可回答是非问题；相关名称不证明某能力已实现。每题需说明关键依据或缺失事实；问题含糊时选择需修订。</p>
<input id="reviewer" placeholder="真实复核者姓名或标识" aria-label="复核者"><select id="filter"><option value="all">全部</option><option value="pending">待复核</option><option value="reviewed">已复核</option></select><input id="search" placeholder="搜索题目编号或问题"><button id="export">导出复核 JSON</button><span id="count"></span></header><main id="list"></main>
<script>const payload=${payload};
const key='codenode-rag-review-'+payload.hash;let reviews={};try{reviews=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
const reviewer=document.getElementById('reviewer');const filter=document.getElementById('filter');const search=document.getElementById('search');const list=document.getElementById('list');
function node(tag,text){const n=document.createElement(tag);n.textContent=text||'';return n}
function reviewNumber(c){return String(payload.dataset.cases.findIndex(item=>item.id===c.id)+1).padStart(3,'0')}
function reviewed(id){return typeof reviews[id]?.humanLabel==='boolean'&&reviews[id]?.reviewer&&reviews[id]?.reviewedAt}
function save(){localStorage.setItem(key,JSON.stringify(reviews));document.getElementById('count').textContent=payload.dataset.cases.filter(c=>reviewed(c.id)).length+'/100 已复核'}
function render(){list.replaceChildren();for(const c of payload.dataset.cases){if(filter.value==='pending'&&reviewed(c.id)||filter.value==='reviewed'&&!reviewed(c.id))continue;if(search.value&&!((reviewNumber(c)+' '+c.query).toLowerCase().includes(search.value.toLowerCase())))continue;const a=node('article');a.append(node('h2','题目 '+reviewNumber(c)+' · '+c.query),node('small','请依据下列冻结源码判定；作者标签、题型和原始编号不显示'));
for(const s of c.sources){a.append(node('h3',s.citation),node('pre',s.excerpt));const d=node('details');d.append(node('summary','查看该文件完整冻结源码'),node('pre',payload.dataset.files[s.path]));a.append(d)}
const label=node('label','判定');const select=node('select');for(const [value,text]of [['','尚未判定'],['true','所供证据充分'],['false','所供证据不足'],['unclear','问题或证据需修订']]){const o=node('option',text);o.value=value;select.append(o)}select.value=reviewed(c.id)?String(reviews[c.id].humanLabel):reviews[c.id]?.unclear?'unclear':'';label.append(select);a.append(label);
const note=node('textarea');note.placeholder='说明关键支持证据、缺失事实、矛盾或问题歧义；每道题均需填写';note.value=reviews[c.id]?.note||'';a.append(note);const button=node('button','保存本人复核');const status=node('span',reviewed(c.id)?' 已由 '+reviews[c.id].reviewer+' 复核':' 待复核');
button.onclick=()=>{if(!reviewer.value.trim()){alert('请填写真实复核者，不可用模型伪装人工复核');return}if(!select.value){alert('请选择判定');return}const humanLabel=select.value==='unclear'?null:select.value==='true';if(!note.value.trim()){alert('请说明关键支持证据、缺失事实或问题歧义');return}reviews[c.id]={id:c.id,humanLabel,unclear:select.value==='unclear',reviewer:reviewer.value.trim(),reviewedAt:new Date().toISOString(),note:note.value.trim(),reviewProtocol:'source-first-author-label-hidden'};save();status.textContent=humanLabel===null?' 已记录修订问题（不计有效标签）':' 已保存本人复核';status.className=humanLabel===null?'warn':'ok'};a.append(button,status);list.append(a)}save()}
filter.onchange=render;search.oninput=render;document.getElementById('export').onclick=()=>{const data={datasetHash:payload.hash,reviews:payload.dataset.cases.map(c=>({id:c.id,...(reviews[c.id]||{humanLabel:null,reviewer:'',reviewedAt:'',note:''})}))};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='rag-acceptance-human-reviewed.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};render();</script></html>`;
const out = path.resolve(__dirname, '../out/rag-human-review.html');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, html);
console.log('Human review UI created: ' + out + ' (no labels auto-filled, no external requests)');
