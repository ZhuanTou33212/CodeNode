import { useTrellisStore } from '../store/trellisStore';
import { useUiStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
export default function ConversationTaskLink() {
  const project=useTrellisStore(s=>s.project);
  const root=useProjectStore(s=>s.root),storeRoot=useTrellisStore(s=>s.root);
  const task=project?.tasks.find(task=>task.taskPath===project.selectedTask);
  if(root!==storeRoot||!project?.selectedTask)return null;
  return <div className="conversation-task-link"><span>当前任务：{task?.title||'原任务不可读取'}</span><button onClick={()=>{useUiStore.getState().setAppPage('tasks');if(project.selectedTask!==useTrellisStore.getState().viewed)void useTrellisStore.getState().view(project.selectedTask!)}}>查看任务</button></div>;
}
