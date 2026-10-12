export type GoalAttentionAction =
  | 'revalidate-goal'
  | 'reconcile-token-usage'
  | 'reconcile-cost-usage'
  | 'resolve-decision'
  | 'review-run'
  | 'retry-task'
  | 'resolve-task'
  | 'check-wait'
  | 'view-wait'
  | 'review-execution'
  | 'continue-goal';

export interface GoalAttentionGoal {
  id:string;
  title:string;
  status:string;
  complete?:boolean;
  budget?:{maxTokens?:number|null;tokenUnknown?:boolean;maxCostUsd?:number|null;costUnknown?:boolean};
  decisions?:Array<{id:string;status:string;question:string}>;
  tasks?:Array<{id:string;title:string;status:string;executionStatus?:string|null;waitDue?:boolean;waitCondition?:{description?:string}|null}>;
  execution?:{id:string;status:string;currentTaskId?:string|null;reason?:string;actionRequired?:boolean}|null;
}

export interface GoalAttentionItem {
  key:string;
  id:string;
  goalId:string;
  goal:GoalAttentionGoal;
  taskId:string|null;
  owner:'user';
  action:GoalAttentionAction;
  label:string;
  text:string;
}

function makeItem(goal:GoalAttentionGoal,id:string,taskId:string|null,action:GoalAttentionAction,label:string,text:string):GoalAttentionItem {
  return {key:`${goal.id}:${action}:${id}`,id,goalId:goal.id,goal,taskId,owner:'user',action,label,text};
}

/** One read-only user-action projection shared by the overview and Goal editor. */
export function goalAttention(goals:GoalAttentionGoal[]):GoalAttentionItem[] {
  return goals.filter(goal=>goal.status!=='archived').flatMap(goal=>{
    const items:GoalAttentionItem[]=[];
    if(goal.status==='completed'&&goal.complete===false){
      items.push(makeItem(goal,`recheck-${goal.id}`,null,'revalidate-goal','需重新核验','完成条件已失效，请重新验收或复核预算'));
    }
    const budget=goal.budget;
    if(budget?.maxTokens!=null&&budget.tokenUnknown===true){
      items.push(makeItem(goal,`token-budget-${goal.id}`,null,'reconcile-token-usage','Token 待核对','存在未知 Token 用量，请核对累计用量后继续'));
    }
    if(budget?.maxCostUsd!=null&&budget.costUnknown===true){
      items.push(makeItem(goal,`cost-budget-${goal.id}`,null,'reconcile-cost-usage','费用待核对','存在未知 ACP 费用，请核对累计 USD 费用后继续'));
    }
    for(const decision of goal.decisions||[]){
      if(decision.status==='open')items.push(makeItem(goal,decision.id,null,'resolve-decision','待决定',decision.question));
    }
    const tasks=goal.tasks||[];
    for(const task of tasks){
      if(task.executionStatus==='unknown')items.push(makeItem(goal,task.id,task.id,'review-run','待复核',`Run 结果未知：${task.title}`));
      else if(task.status==='failed')items.push(makeItem(goal,task.id,task.id,'retry-task','执行失败',task.title));
      else if(task.status==='cancelled')items.push(makeItem(goal,task.id,task.id,'retry-task','已取消',`任务已取消，可复核后重新排队：${task.title}`));
      else if(task.status==='blocked')items.push(makeItem(goal,task.id,task.id,'resolve-task','有阻塞',task.title));
      else if(task.status==='waiting')items.push(makeItem(goal,task.id,task.id,task.waitDue?'check-wait':'view-wait',task.waitDue?'到检查时间':'等待',task.waitCondition?.description||task.title));
    }
    const hasTaskBlocker=tasks.some(task=>['blocked','failed'].includes(task.status)||task.executionStatus==='unknown');
    const hasOpenDecision=(goal.decisions||[]).some(decision=>decision.status==='open');
    if(goal.execution&&(goal.execution.status==='blocked'||goal.execution.actionRequired)&&!hasTaskBlocker&&!hasOpenDecision){
      const blocked=goal.execution.status==='blocked';
      items.push(makeItem(goal,goal.execution.id,goal.execution.currentTaskId||null,blocked?'review-execution':'continue-goal',blocked?'执行待复核':'等待继续',goal.execution.reason||'Goal 执行需要检查'));
    }
    return items;
  });
}
