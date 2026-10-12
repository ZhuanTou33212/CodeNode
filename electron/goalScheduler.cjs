'use strict';
const store=require('./goalStore.cjs');
const config=require('../config/goal.wait.json');

// The main process owns timers, graph selection and persisted execution intent.
// A live, bound renderer transports the selected request through the normal chat path.
class GoalScheduler{
  /** @param {any} deps */
  constructor(deps){this.deps=deps;this.bindings=new Map();this.revisions=new Map();this.watchedSenders=new Map();this.timer=null;this.dueAt=0;this.running=false;this.again=false;this.closed=false;}
  bind(sender,root,ready){
    const prior=this.bindings.get(sender.id);
    if(!root){this.bindings.delete(sender.id);if(prior&&!this.hasRoot(prior.root))this.revisions.delete(prior.root);this.deps.detach?.(sender.id);this.poke();return;}
    if(prior&&prior.root!==root)this.deps.detach?.(sender.id);
    this.bindings.set(sender.id,{sender,root,ready:ready===true});
    if(prior&&prior.root!==root&&!this.hasRoot(prior.root))this.revisions.delete(prior.root);
    if(!this.watchedSenders.has(sender.id)&&typeof sender.once==='function'){
      const onDestroyed=()=>{const binding=this.bindings.get(sender.id);this.bindings.delete(sender.id);if(binding&&!this.hasRoot(binding.root))this.revisions.delete(binding.root);this.watchedSenders.delete(sender.id);this.deps.detach?.(sender.id);this.poke();};
      this.watchedSenders.set(sender.id,{sender,onDestroyed});sender.once('destroyed',onDestroyed);
    }
    // A reloaded renderer needs its initial snapshot even when disk revision is unchanged.
    sender.send('goal:scheduler-changed',{root,revision:store.read(root).revision});
    this.poke();
  }
  hasRoot(root){return [...this.bindings.values()].some(b=>b.root===root);}
  poke(){
    if(this.closed)return;
    if(this.running){this.again=true;return;}
    this.arm(config.scheduler.minDelayMs);
  }
  arm(delay){
    if(this.closed)return;
    if(!this.bindings.size){if(this.timer)clearTimeout(this.timer);this.timer=null;this.dueAt=0;return;}
    const bounded=Math.max(config.scheduler.minDelayMs,Math.min(delay,config.scheduler.maxDelayMs)),dueAt=Date.now()+bounded;
    // Coalesce notifications without postponing an already earlier wake-up.
    if(this.timer&&this.dueAt<=dueAt)return;
    if(this.timer)clearTimeout(this.timer);this.timer=null;this.dueAt=dueAt;
    this.timer=setTimeout(()=>{this.timer=null;this.dueAt=0;void this.tick();},bounded);
    this.timer.unref?.();
  }
  async tick(){
    if(this.closed)return;
    if(this.running){this.again=true;return;}
    if(this.timer)clearTimeout(this.timer);this.timer=null;this.dueAt=0;
    this.running=true;let nextDelay=Infinity;
    try{
      const roots=[...new Set([...this.bindings.values()].map(b=>b.root))];
      for(const root of roots){
        let endpoint=[...this.bindings.values()].find(b=>b.root===root&&!b.sender.isDestroyed());
        if(!endpoint)continue;
        try{
          await this.deps.refresh(root);
          if(this.closed)break;
          endpoint=[...this.bindings.values()].find(b=>b.root===root&&!b.sender.isDestroyed()&&b.ready)||[...this.bindings.values()].find(b=>b.root===root&&!b.sender.isDestroyed());
          if(!endpoint)continue;
          const data=store.read(root);let candidate=null;
          for(const goal of data.goals){
            if(goal.execution){
              if(['active','waiting','stopping'].includes(goal.execution.status)&&!(goal.status==='paused'&&goal.execution.status==='waiting')){
                const planned=store.advanceExecution(root,goal.id);
                if(planned.decision==='run'&&!candidate)candidate={mode:'execution',goalId:goal.id,taskId:planned.task.id};
                if(['run','waiting'].includes(planned.decision)||(planned.decision==='idle'&&['active','stopping'].includes(goal.execution.status)))nextDelay=Math.min(nextDelay,config.scheduler.busyPollMs);
              }
            }else if(goal.status==='active'&&goal.autoAdvanceAuthorized===true&&(Number(goal.autoAdvanceUsedRuns)||0)<config.autoAdvance.maxRunsPerGoal){
              const task=goal.tasks.find(t=>t.status==='ready'&&t.autoAdvance?.status==='ready'&&store.canRun(root,goal.id,t.id).decision==='run');
              if(task&&!candidate)candidate={mode:'wait',goalId:goal.id,taskId:task.id};
            }
            if(goal.status==='active')for(const task of goal.tasks){
              if(task.status!=='waiting'||!(task.waitCondition?.kind==='time'||['github-actions','agent-eval'].includes(task.waitCondition?.provider)))continue;
              const due=Date.parse(task.waitCondition.nextCheckAt||'');
              nextDelay=Math.min(nextDelay,Number.isFinite(due)?Math.max(config.scheduler.minDelayMs,due-Date.now()):config.scheduler.minDelayMs);
            }
          }
          if(candidate){
            nextDelay=Math.min(nextDelay,config.scheduler.busyPollMs);
            if(endpoint.ready&&!this.deps.busy()){
              const claim=await this.deps.claim(root,candidate,endpoint.sender.id);
              // Binding may change while a claim hook is awaiting; never send to a new project.
              const binding=this.bindings.get(endpoint.sender.id);
              if(!binding||binding.root!==root||endpoint.sender.isDestroyed())await this.deps.release(root,claim,'project_changed_before_dispatch');
              else{
                binding.ready=false;
                try{endpoint.sender.send('goal:scheduler-dispatch',{root,...claim});}
                catch{await this.deps.release(root,claim,'renderer_dispatch_failed');}
              }
            }
          }
          const revision=store.read(root).revision;
          if(this.revisions.get(root)!==revision){
            this.revisions.set(root,revision);
            for(const binding of this.bindings.values())if(binding.root===root&&!binding.sender.isDestroyed())binding.sender.send('goal:scheduler-changed',{root,revision});
          }
          if(this.deps.pending(root))nextDelay=Math.min(nextDelay,config.scheduler.busyPollMs);
        }catch(error){if(!this.closed)this.deps.onError?.(root,error);nextDelay=Math.min(nextDelay,config.scheduler.maxDelayMs);}
      }
    }finally{this.running=false;const again=this.again;this.again=false;if(again)this.poke();else if(Number.isFinite(nextDelay))this.arm(nextDelay);}
  }
  close(){this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=null;this.dueAt=0;this.bindings.clear();this.revisions.clear();for(const {sender,onDestroyed}of this.watchedSenders.values())sender.removeListener?.('destroyed',onDestroyed);this.watchedSenders.clear();}
}
module.exports={GoalScheduler};
