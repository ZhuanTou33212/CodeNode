import { create } from 'zustand';
import { useProjectStore } from './projectStore';

type GoalItem={id:string;title:string;objective:string;status:string;criteriaRevision:number;criteria:any[];tasks:any[];decisions:any[];evidence:any[];complete:boolean;budget:any};
interface GoalControlState { goals:GoalItem[];selectedGoalId:string|null;selectedTaskId:string|null;loading:boolean;error:string;refresh:(root?:string|null)=>Promise<void>;select:(goalId:string|null,taskId?:string|null)=>void }
export const useGoalControlStore=create<GoalControlState>((set,get)=>({goals:[],selectedGoalId:null,selectedTaskId:null,loading:false,error:'',
  select:(selectedGoalId,selectedTaskId=null)=>set({selectedGoalId,selectedTaskId}),
  refresh:async(root=useProjectStore.getState().root)=>{
    if(!root||!window.codenode?.goalList){set({goals:[],selectedGoalId:null,selectedTaskId:null,error:''});return;}
    set({loading:true,error:''});
    try{const result=await window.codenode.goalList(root);if(useProjectStore.getState().root!==root)return;if(!result.ok)throw new Error(result.error||'读取项目目标失败');
      const goals=(result.value?.goals||[]) as GoalItem[];const previous=get();
      const selectedGoalId=goals.some(g=>g.id===previous.selectedGoalId)?previous.selectedGoalId:goals[0]?.id||null;
      const selectedGoal=goals.find(g=>g.id===selectedGoalId);
      const selectedTask=selectedGoal?.tasks.find(t=>t.id===previous.selectedTaskId);
      const selectedTaskId=selectedTask&&!['completed','cancelled'].includes(selectedTask.status)?selectedTask.id:null;
      set({goals,selectedGoalId,selectedTaskId,error:''});
    }catch(error){if(useProjectStore.getState().root===root)set({error:error instanceof Error?error.message:String(error)});}
    finally{if(useProjectStore.getState().root===root)set({loading:false});}
  }
}));
