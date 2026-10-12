import { useEffect } from 'react';
import { useBackendSwitchStore } from '../store/backendSwitchStore';
import { useChatStore } from '../store/chatStore';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';

/** Session transport only. Timers, candidate selection and continuation live in main. */
export default function GoalAutoAdvanceManager() {
  const root=useProjectStore(s=>s.root);
  useEffect(()=>{
    const api=window.codenode;
    if(!api?.goalSchedulerBind||!api.onGoalSchedulerDispatch||!api.onGoalSchedulerChanged)return;
    let live=true,sending=false;
    const ready=()=>live&&!sending&&useProjectStore.getState().root===root&&!useBackendSwitchStore.getState().switching&&useChatStore.getState().inflight.size()===0;
    const bind=()=>{if(live)void api.goalSchedulerBind(root,ready()).catch(()=>{});};
    const offDispatch=api.onGoalSchedulerDispatch(async claim=>{
      if(!live||claim.root!==root)return;
      if(!ready()){
        await api.goalAutoAdvanceRelease(claim.root,claim.goalId,claim.taskId,claim.claimId,'renderer_not_ready');bind();return;
      }
      sending=true;bind();
      const selected=useGoalControlStore.getState();
      if(selected.selectedGoalId===claim.goalId&&!selected.selectedTaskId)selected.select(claim.goalId,claim.taskId);
      useUiStore.getState().setToast(`${claim.executionId?'开始下一阶段':'等待条件已满足'}：${claim.title}`);
      try{
        await useChatStore.getState().send(claim.objective,{projectRoot:claim.root,goalId:claim.goalId,taskId:claim.taskId,requestId:claim.requestId,autoAdvanceClaimId:claim.claimId});
      }catch(error){if(live)useUiStore.getState().setToast(`任务启动失败：${error instanceof Error?error.message:String(error)}`);}
      finally{
        try{await api.goalAutoAdvanceRelease(claim.root,claim.goalId,claim.taskId,claim.claimId,'chat_send_finished_without_admission');}
        finally{sending=false;bind();if(live&&root)void useGoalControlStore.getState().refresh(root);}
      }
    });
    const offChanged=api.onGoalSchedulerChanged(change=>{if(live&&change.root===root&&root){if(change.error)useUiStore.getState().setToast(`目标调度暂未推进：${change.error}`);else void useGoalControlStore.getState().refresh(root);}});
    const offInflight=useChatStore.getState().inflight.subscribe(bind);
    const offBackend=useBackendSwitchStore.subscribe(bind);
    bind();
    return()=>{live=false;offDispatch();offChanged();offInflight();offBackend();void api.goalSchedulerBind(null,false).catch(()=>{});};
  },[root]);
  return null;
}
