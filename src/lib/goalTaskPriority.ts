import config from '../../config/goal.task-priorities.json';

export const taskPriorities = config.priorities;
export const defaultTaskPriority = config.default;
export function taskPriority(value?:string):string {
  return taskPriorities.some(item=>item.id===value)?value!:defaultTaskPriority;
}
export function taskPriorityLabel(value?:string):string {
  return taskPriorities.find(item=>item.id===taskPriority(value))!.label;
}
export function taskPriorityRank(value?:string):number {
  return taskPriorities.find(item=>item.id===taskPriority(value))!.rank;
}
