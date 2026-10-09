import {useGoalControlStore} from '../store/goalControlStore';
export function GoalBinding() {
  const {goals,selectedGoalId,selectedTaskId,select}=useGoalControlStore();
  const goal=goals.find(g=>g.id===selectedGoalId),task=goal?.tasks.find(t=>t.id===selectedTaskId);
  if(!task)return null;
  return <div className="conversation-goal-binding"><span title={goal?.title+' · '+task.title}>目标 · {goal?.title} / {task.title}</span><button aria-label="解除目标任务绑定" title="解除绑定" onClick={()=>select(selectedGoalId,null)}>×</button></div>;
}
