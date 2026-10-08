import { create } from 'zustand';
import { useProjectStore } from './projectStore';

type GoalItem={id:string;title:string;objective:string;scope:string;exclusions:string;status:string;criteriaRevision:number;criteria:any[];tasks:any[];decisions:any[];evidence:any[];context:any;complete:boolean;qualified:boolean;budget:any};
let waitRefreshTimer:ReturnType<typeof setTimeout>|null=null;
function scheduleWaitRefresh(root:string,goals:GoalItem[]){
  if(waitRefreshTimer)clearTimeout(waitRefreshTimer);
  waitRefreshTimer=null;
  const now=Date.now();
  const dueTimes=goals.flatMap(goal=>goal.tasks.filter(task=>task.status==='waiting'&&task.waitCondition?.nextCheckAt).map(task=>Date.parse(task.waitCondition.nextCheckAt))).filter(at=>Number.isFinite(at)&&at>now);
  if(!dueTimes.length)return;
  const delay=Math.min(Math.max(100,Math.min(...dueTimes)-now),24*60*60*1000);
  waitRefreshTimer=setTimeout(()=>{waitRefreshTimer=null;if(useProjectStore.getState().root===root)void useGoalControlStore.getState().refresh(root);},delay);
}
interface GoalControlState { goals:GoalItem[];selectedGoalId:string|null;selectedTaskId:string|null;loading:boolean;error:string;refresh:(root?:string|null)=>Promise<void>;select:(goalId:string|null,taskId?:string|null)=>void }
export const useGoalControlStore=create<GoalControlState>((set,get)=>({goals:[],selectedGoalId:null,selectedTaskId:null,loading:false,error:'',
  select:(selectedGoalId,selectedTaskId=null)=>set({selectedGoalId,selectedTaskId}),
  refresh:async(root=useProjectStore.getState().root)=>{
    if(!root||!window.codenode?.goalList){if(waitRefreshTimer)clearTimeout(waitRefreshTimer);waitRefreshTimer=null;set({goals:[],selectedGoalId:null,selectedTaskId:null,error:''});return;}
    set({loading:true,error:''});
    try{const result=await window.codenode.goalList(root);if(useProjectStore.getState().root!==root)return;if(!result.ok)throw new Error(result.error||'读取项目目标失败');
      const goals=(result.value?.goals||[]) as GoalItem[];const previous=get();
      const selectedGoalId=goals.some(g=>g.id===previous.selectedGoalId)?previous.selectedGoalId:goals[0]?.id||null;
      const selectedGoal=goals.find(g=>g.id===selectedGoalId);
      const selectedTask=selectedGoal?.tasks.find(t=>t.id===previous.selectedTaskId);
      const selectedTaskId=selectedTask&&!['completed','cancelled'].includes(selectedTask.status)?selectedTask.id:null;
      set({goals,selectedGoalId,selectedTaskId,error:''});scheduleWaitRefresh(root,goals);
    }catch(error){if(useProjectStore.getState().root===root)set({error:error instanceof Error?error.message:String(error)});}
    finally{if(useProjectStore.getState().root===root)set({loading:false});}
  }
}));
