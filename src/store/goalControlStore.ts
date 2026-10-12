import { create } from 'zustand';
import { useProjectStore } from './projectStore';

export type GoalItem={id:string;title:string;objective:string;scope:string;exclusions:string;status:string;updatedAt:string;criteriaRevision:number;criteria:any[];tasks:any[];decisions:any[];evidence:any[];context:any;complete:boolean;qualified:boolean;budget:any;autoAdvanceAuthorized?:boolean;autoAdvanceUsedRuns?:number;execution?:{id:string;status:string;reason:string;actionRequired?:boolean;currentTaskId?:string|null;attemptedTaskIds:string[]}};
let refreshTicket=0;
interface GoalControlState { goals:GoalItem[];revision:number;selectedGoalId:string|null;selectedTaskId:string|null;pendingDraft:string|null;loading:boolean;error:string;refresh:(root?:string|null)=>Promise<void>;select:(goalId:string|null,taskId?:string|null)=>void;startDraft:(objective:string)=>void;clearDraft:()=>void }
export const useGoalControlStore=create<GoalControlState>((set,get)=>({goals:[],revision:0,selectedGoalId:null,selectedTaskId:null,pendingDraft:null,loading:false,error:'',
  select:(selectedGoalId,selectedTaskId=null)=>set({selectedGoalId,selectedTaskId}),
  startDraft:(objective)=>set({pendingDraft:objective}),
  clearDraft:()=>set({pendingDraft:null}),
  refresh:async(root=useProjectStore.getState().root)=>{
    const ticket=++refreshTicket;
    if(!root||!window.codenode?.goalList){set({goals:[],revision:0,selectedGoalId:null,selectedTaskId:null,error:''});return;}
    set({loading:true,error:''});
    try{const result=await window.codenode.goalList(root);if(useProjectStore.getState().root!==root||ticket!==refreshTicket)return;if(!result.ok)throw new Error(result.error||'读取项目目标失败');
      const goals=(result.value?.goals||[]) as GoalItem[];const previous=get();
      const selectedGoalId=goals.some(g=>g.id===previous.selectedGoalId)?previous.selectedGoalId:goals[0]?.id||null;
      const selectedGoal=goals.find(g=>g.id===selectedGoalId);
      const selectedTask=selectedGoal?.tasks.find(t=>t.id===previous.selectedTaskId);
      const selectedTaskId=selectedTask&&!['completed','cancelled'].includes(selectedTask.status)?selectedTask.id:null;
      set({goals,revision:Number(result.value?.revision)||0,selectedGoalId,selectedTaskId,error:''});
    }catch(error){if(useProjectStore.getState().root===root&&ticket===refreshTicket)set({error:error instanceof Error?error.message:String(error)});}
    finally{if(useProjectStore.getState().root===root&&ticket===refreshTicket)set({loading:false});}
  }
}));
