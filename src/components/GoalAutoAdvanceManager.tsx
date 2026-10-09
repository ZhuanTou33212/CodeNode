import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import { useGoalControlStore } from '../store/goalControlStore';
import { useProjectStore } from '../store/projectStore';
import { useUiStore } from '../store/uiStore';
import waitConfig from '../../config/goal.wait.json';

/** Runs only after a persisted wait release and an explicit Goal-level authorization. */
export default function GoalAutoAdvanceManager() {
  const root = useProjectStore(state => state.root);
  const goals = useGoalControlStore(state => state.goals);
  const refresh = useGoalControlStore(state => state.refresh);
  const claimInFlight = useRef(false);
  const mounted = useRef(false);
  const projectEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const retryTimer = useRef<number | null>(null);

  useEffect(() => {
    projectEpoch.current += 1;
    if (!root) return;
    void refresh(root);
  }, [root, refresh]);

  useEffect(() => {
    if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    if (!root) return;
    const due = goals.flatMap(goal => goal.tasks
      .filter(task => task.status === 'waiting' && task.waitCondition?.nextCheckAt &&
        (task.waitCondition.kind === 'time' || ['github-actions', 'agent-eval'].includes(task.waitCondition.provider)))
      .map(task => Date.parse(task.waitCondition.nextCheckAt)))
      .filter(Number.isFinite);
    if (!due.length) return;
    const now = Date.now();
    const delay = due.some(at => at <= now) ? 500 : Math.min(Math.max(100, Math.min(...due) - now), 24 * 60 * 60 * 1000);
    const timer = window.setTimeout(() => {
      if (useProjectStore.getState().root === root) void refresh(root);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [root, goals, refresh]);

  useEffect(() => {
    const api = window.codenode;
    if (!root || !api?.goalAutoAdvanceClaim || !api.goalAutoAdvanceRelease || claimInFlight.current) return;
    const maxRuns = Math.max(1, Number(waitConfig.autoAdvance.maxRunsPerGoal) || 1);
    const candidate = goals.flatMap(goal => goal.status === 'active' && goal.autoAdvanceAuthorized === true &&
      (Number(goal.autoAdvanceUsedRuns) || 0) < maxRuns
      ? goal.tasks.filter(task => task.status === 'ready' && task.autoAdvance?.status === 'ready').map(task => ({ goal, task }))
      : [])[0];
    if (!candidate) return;

    const start = async () => {
      if (useProjectStore.getState().root !== root) return;
      if (useChatStore.getState().inflight.size() > 0) {
        retryTimer.current = window.setTimeout(() => {
          if (useProjectStore.getState().root === root) void refresh(root);
        }, 3000);
        return;
      }
      claimInFlight.current = true;
      const claimedProjectEpoch = projectEpoch.current;
      const claimResult = await api.goalAutoAdvanceClaim(root, candidate.goal.id, candidate.task.id);
      if (!mounted.current || claimedProjectEpoch !== projectEpoch.current || useProjectStore.getState().root !== root) {
        if (claimResult.ok && claimResult.value) void api.goalAutoAdvanceRelease(root, candidate.goal.id, candidate.task.id, claimResult.value.claimId, 'project_changed_before_dispatch');
        claimInFlight.current = false;
        return;
      }
      if (!claimResult.ok || !claimResult.value) {
        claimInFlight.current = false;
        if (claimResult.error?.includes('Agent 正在运行')) {
          retryTimer.current = window.setTimeout(() => {
            if (useProjectStore.getState().root === root) void refresh(root);
          }, 3000);
        } else if (claimResult.error) useUiStore.getState().setToast(`自动推进未启动：${claimResult.error}`);
        return;
      }
      const claim = claimResult.value;
      useUiStore.getState().setToast(`等待条件已满足，自动启动 Task：${claim.title}（${claim.usedRuns}/${claim.maxRuns}）`);
      try {
        await useChatStore.getState().send(claim.objective, {
          projectRoot: root,
          goalId: claim.goalId,
          taskId: claim.taskId,
          requestId: claim.requestId,
          autoAdvanceClaimId: claim.claimId,
        });
      } catch (error) {
        useUiStore.getState().setToast(`自动推进启动失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await api.goalAutoAdvanceRelease(root, claim.goalId, claim.taskId, claim.claimId, 'chat_send_finished_without_admission');
        claimInFlight.current = false;
        if (useProjectStore.getState().root === root) void refresh(root);
      }
    };
    void start();
  }, [root, goals, refresh]);

  return null;
}
