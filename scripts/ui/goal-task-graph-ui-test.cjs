'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codenode-goal-graph-ui-'));
const uiFile=process.env.CODENODE_PACKAGED_ASAR?path.join(path.resolve(process.env.CODENODE_PACKAGED_ASAR),'dist/index.html'):path.join(__dirname,'../../dist/index.html');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1260,height:850,show:false,webPreferences:{sandbox:true}});
  try{
    await win.loadFile(uiFile);
    await wait(400);
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const until=async(fn)=>{for(let i=0;i<80;i++){const v=fn();if(v)return v;await sleep(50);}throw Error('UI wait timed out');};
      const ui=window.__codenodeUi,project=window.__codenodeProject,session=window.__codenodeSession,graph=window.__codenodeStore,chat=window.__codenodeChat;
      const data={revision:1,goals:[{id:'g1',title:'稳定登录',objective:'解决登录失败',scope:'src',exclusions:'',status:'active',updatedAt:new Date().toISOString(),criteriaRevision:1,criteria:[{id:'c1',text:'登录测试通过',required:true}],tasks:[
        {id:'t1',title:'定位问题',objective:'查看登录入口',status:'todo',updatedAt:new Date().toISOString(),dependsOn:[],readScope:[],writeScope:[],criteriaIds:['c1'],decisionIds:[],runIds:[]},
        {id:'t2',title:'实现修复',objective:'修改登录逻辑',status:'todo',updatedAt:new Date().toISOString(),dependsOn:['t1'],readScope:[],writeScope:['src'],criteriaIds:['c1'],decisionIds:[],runIds:[]}],decisions:[],evidence:[],context:{rules:[],taskMaterial:[],confirmedExperience:[]},budget:{},qualified:false}]};
      let agentChatCalls=0,planCalls=0,simulateExternalGoalEdit=false;
      window.codenode=new Proxy({
        goalList:async()=>({ok:true,value:structuredClone(data)}),
        goalCreate:async(_root,input)=>{const created={...structuredClone(data.goals[0]),id:'g2',title:input.title,objective:input.objective,status:'active',criteria:input.criteria.map((text,index)=>({id:'new-c'+index,text,required:true})),tasks:[],evidence:[],decisions:[],updatedAt:new Date().toISOString()};data.goals.unshift(created);data.revision++;return{ok:true,value:created};},
        goalTaskUpdate:async(_root,_goalId,taskId,patch)=>{if(patch.expectedRevision!==data.revision)return{ok:false,error:'revision mismatch'};const task=data.goals[0].tasks.find(t=>t.id===taskId);Object.assign(task,patch,{updatedAt:new Date().toISOString()});data.revision++;return{ok:true,value:task};},
        goalTaskBatchCreate:async(_root,_goalId,steps,expectedRevision)=>{if(expectedRevision!==data.revision)return{ok:false,error:'stale goal'};const ids=new Map(steps.map(step=>[step.key,'generated-'+step.key]));const added=steps.map(step=>({id:ids.get(step.key),title:step.title,objective:step.objective,status:'todo',updatedAt:new Date().toISOString(),dependsOn:step.dependsOn.map(id=>ids.get(id)),readScope:[],writeScope:step.writeScope,criteriaIds:['c1'],decisionIds:[],runIds:[]}));data.goals[0].tasks.push(...added);data.revision++;return{ok:true,value:added};},
        goalCanRun:async(_root,goalId)=>{const goal=data.goals.find(item=>item.id===goalId),next=goal.tasks.find(task=>task.status==='todo'&&task.dependsOn.every(id=>goal.tasks.find(dep=>dep.id===id)?.status==='completed'));return{ok:true,value:next?{decision:'run',task:structuredClone(next)}:{decision:'complete',reason:'all tasks complete'}};},
        goalAudit:async(_root,goalId)=>({ok:true,value:{qualified:data.goals.find(item=>item.id===goalId).tasks.every(task=>task.status==='completed')}}),
        goalUpdate:async(_root,goalId,patch)=>{const goal=data.goals.find(item=>item.id===goalId);Object.assign(goal,patch);data.revision++;return{ok:true,value:structuredClone(goal)};},
        goalPlanPropose:async()=>{planCalls++;return{ok:true,value:{steps:[{key:'s1',title:'检查现状',objective:'读取现有实现',acceptance:'找到入口',dependsOn:[],writeScope:[]},{key:'s2',title:'完成修改',objective:'实施修复',acceptance:'检查通过',dependsOn:['s1'],writeScope:['src']}]}};},
        agentChat:async payload=>{agentChatCalls++;const goal=data.goals.find(item=>item.id===payload.goalId),task=goal?.tasks.find(item=>item.id===payload.taskId);if(task){task.status='completed';task.lastRun={runId:'ui-run-'+agentChatCalls,status:'completed',summary:'做了什么：'+task.title,finishedAt:new Date().toISOString()};data.revision++;if(simulateExternalGoalEdit&&goal.id==='g2'&&task.id==='generated-s1'){goal.tasks.find(item=>item.id==='generated-s2').objective='另一会话修改了后续任务';data.revision++;}}return{ok:true,reply:task?'完成 '+task.title:'unused',tools:[]};},
      },{get(target,name){if(name in target)return target[name];if(String(name).startsWith('on'))return()=>()=>{};return async()=>({ok:false,models:[],files:[],tools:[],runs:[],events:[],backend:{},settings:{},goals:[]});}});
      project.setState({root:${JSON.stringify(root)}});
      ui.getState().updatePreferences({workbenchView:'overview'});
      await until(()=>document.querySelector('[data-goal-id="g1"]'));
      document.querySelector('[data-goal-id="g1"]').click();
      await until(()=>document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length===2);
      await until(()=>document.querySelectorAll('.goal-task-graph-canvas .react-flow__edge').length===1);
      const out={nodes:document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length,edges:document.querySelectorAll('.goal-task-graph-canvas .react-flow__edge').length};
      document.querySelector('.goal-task-graph-canvas .react-flow__node[data-id="t1"]').click();
      await until(()=>document.querySelector('.goal-graph-editor'));
      out.selectedTask=document.querySelector('.goal-graph-editor strong')?.textContent;
      const oldTheme=ui.getState().theme;ui.getState().toggleTheme();
      await sleep(80);out.themeChanged=ui.getState().theme!==oldTheme;out.nodesAfterTheme=document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length;out.selectedAfterTheme=!!document.querySelector('.goal-graph-editor');
      [...document.querySelectorAll('.goal-task-graph-toolbar button')].find(button=>button.textContent.includes('规划任务')).click();
      await until(()=>document.querySelector('.goal-graph-proposal'));
      out.previewBeforeSave=document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length;
      [...document.querySelectorAll('.goal-graph-proposal button')].find(button=>button.textContent.includes('确认加入')).click();
      await until(()=>document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length===4);
      out.generatedGoalNodes=document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length;
      const titleInput=document.querySelector('.goal-graph-editor input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(titleInput,'确认登录入口');
      titleInput.dispatchEvent(new Event('input',{bubbles:true}));
      await until(()=>titleInput.value==='确认登录入口');
      [...document.querySelectorAll('.goal-graph-editor button')].find(button=>button.textContent.includes('保存节点')).click();
      await until(()=>document.querySelector('.goal-task-graph-canvas .react-flow__node[data-id="t1"] strong')?.textContent==='确认登录入口');
      out.editedGoalNode=document.querySelector('.goal-task-graph-canvas .react-flow__node[data-id="t1"] strong')?.textContent;
      data.goals.find(item=>item.id==='g1').tasks.find(item=>item.id==='t1').lastRun={runId:'r1',status:'completed',summary:'做了什么：确认了登录入口。结果与验证：测试通过。',finishedAt:new Date().toISOString()};
      document.querySelector('.goal-toolbar button').click();
      await until(()=>document.querySelector('.goal-graph-outcome pre')?.textContent.includes('确认了登录入口'));
      out.stageSummaryVisible=true;
      [...document.querySelectorAll('.goal-task-graph-toolbar button')].find(button=>button.textContent.includes('开始执行 Goal')).click();
      await until(()=>data.goals.find(item=>item.id==='g1').status==='completed');
      out.goalRunCalls=agentChatCalls;out.goalRunOrder=data.goals.find(item=>item.id==='g1').tasks.map(item=>item.status);
      document.querySelector('[aria-label="关闭目标编辑"]').click();
      ui.getState().updatePreferences({workbenchView:'conversation'});
      session.getState().startOnCurrent('test plan');
      session.getState().streamDelta({kind:'plan',runId:'ui-plan',items:[{id:'a',step:'读取现状',acceptanceCriteria:'已读取',status:'pending'},{id:'b',step:'修改文件',acceptanceCriteria:'测试通过',status:'pending',dependsOn:['a']}]});
      await until(()=>document.querySelector('.ap-plan-canvas-action'));
      document.querySelector('.ap-plan-canvas-action').click();
      await until(()=>graph.getState().nodes.length===2);
      out.planNodes=graph.getState().nodes.length;out.planEdges=graph.getState().edges.length;out.planPending=graph.getState().nodes.every(n=>n.data.status==='pending');
      await chat.getState().send('/plan 修复登录');
      out.slashPlanNodes=graph.getState().nodes.length;out.planCalls=planCalls;out.agentChatCalls=agentChatCalls;
      await chat.getState().send('/goal 改善登录稳定性');
      await until(()=>document.querySelector('.goal-create-form input[aria-label="Goal 标题"]')?.value==='改善登录稳定性');
      out.goalDraft=document.querySelector('.goal-create-form input[aria-label="Goal 标题"]')?.value;
      const criterion=document.querySelector('.goal-create-form textarea[aria-label="验收条件"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(criterion,'登录测试通过');
      criterion.dispatchEvent(new Event('input',{bubbles:true}));
      await until(()=>!document.querySelector('.goal-create-submit').disabled);
      document.querySelector('.goal-create-submit').click();
      await until(()=>document.querySelector('.goal-graph-proposal'));
      out.autoGoalPreview=document.querySelectorAll('.goal-graph-proposal li').length;
      out.autoGoalTasksBeforeConfirm=data.goals[0].tasks.length;
      out.planCallsAfterGoal=planCalls;
      [...document.querySelectorAll('.goal-graph-proposal button')].find(button=>button.textContent.includes('确认加入')).click();
      await until(()=>data.goals.find(item=>item.id==='g2').tasks.length===2);
      await until(()=>document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length===2&&![...document.querySelectorAll('.goal-task-graph-toolbar button')].find(button=>button.textContent.includes('开始执行 Goal')).disabled);
      simulateExternalGoalEdit=true;
      [...document.querySelectorAll('.goal-task-graph-toolbar button')].find(button=>button.textContent.includes('开始执行 Goal')).click();
      await until(()=>document.querySelector('.goal-graph-message')?.textContent.includes('另一会话修改'));
      out.stoppedAfterExternalEdit=data.goals.find(item=>item.id==='g2').tasks.map(item=>item.status);
      out.externalEditRunCalls=agentChatCalls-out.goalRunCalls;
      return out;
    })()`);
    assert.equal(result.nodes,2);assert.equal(result.edges,1);assert.match(result.selectedTask,/定位问题/);
    assert.equal(result.themeChanged,true);assert.equal(result.nodesAfterTheme,2);assert.equal(result.selectedAfterTheme,true);
    assert.equal(result.previewBeforeSave,2);assert.equal(result.generatedGoalNodes,4);assert.equal(result.editedGoalNode,'确认登录入口');assert.equal(result.stageSummaryVisible,true);
    assert.equal(result.goalRunCalls,4);assert.deepEqual(result.goalRunOrder,['completed','completed','completed','completed']);
    assert.equal(result.planNodes,2);assert.equal(result.planEdges,1);assert.equal(result.planPending,true);
    assert.equal(result.slashPlanNodes,4);assert.equal(result.planCalls,2);assert.equal(result.agentChatCalls,4);
    assert.equal(result.goalDraft,'改善登录稳定性');assert.equal(result.autoGoalPreview,2);assert.equal(result.autoGoalTasksBeforeConfirm,0);assert.equal(result.planCallsAfterGoal,3);
    assert.deepEqual(result.stoppedAfterExternalEdit,['completed','todo']);assert.equal(result.externalEditRunCalls,1);
    console.log('GOAL TASK GRAPH UI: PASS (Goal graph, selection, theme state, plan import, /plan, /goal)');
    app.exit(0);
  }catch(error){console.error(error);try{console.error(await win.webContents.executeJavaScript(`({body:document.body.innerText.slice(0,1200),overview:!!document.querySelector('.goal-overview'),editor:!!document.querySelector('.overview-goal-editor'),goalRow:!!document.querySelector('[data-goal-id="g1"]'),graphNodes:document.querySelectorAll('.goal-task-graph-canvas .react-flow__node').length,planAction:!!document.querySelector('.ap-plan-canvas-action'),goalDraft:!!document.querySelector('.goal-create-form')})`));}catch{}app.exit(1);}
  finally{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codenode-goal-graph-ui-'));fs.rmSync(root,{recursive:true,force:true});}
}).catch(error=>{console.error(error);app.exit(1)});
