'use strict';
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('Trellis 0.6.17');process.exit(0)}
if(args.includes('--help')){console.log('Trellis init --codex --yes --user --skip-existing');process.exit(0)}
if(args[0]!=='init'||!args.includes('--yes')||!args.includes('--skip-existing'))throw Error('unexpected command');
const developer=args[args.indexOf('--user')+1];
const put=(file,text)=>{const full=path.join(process.cwd(),file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text)};
for(const folder of ['spec','tasks','workspace'])fs.mkdirSync(path.join('.trellis',folder),{recursive:true});
put('.trellis/spec/index.md','# Local CLI generated spec\n');
put('.trellis/tasks/10-10-local/task.json',JSON.stringify({id:'local',title:'本机 CLI 任务',status:'planning'}));
put('.trellis/tasks/10-10-local/prd.md','# 本机接入需求\n');
put('.trellis/tasks/10-10-local/implement.jsonl','{"file":".trellis/spec/index.md","reason":"rules"}\n');
put('.trellis/tasks/10-10-local/check.jsonl','{"file":".trellis/spec/index.md","reason":"checks"}\n');
put('.trellis/workspace/'+developer+'/journal-1.md','# Journal - '+developer+' (Part 1)\n');
put('.trellis/.developer',developer+'\n');
put('.codex/settings.json','{"fixture":true}');put('AGENTS.md','CLI platform config');
console.log('Generated local Trellis project materials');
