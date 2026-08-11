package local.codenode.agent;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

public final class AgentExecutionTimeline {
    public enum TaskState { IDLE, PLANNING, EXECUTING, VERIFYING, COMPLETED, FAILED, CANCELLED }
    public enum StepState { RUNNING, COMPLETED, FAILED, CANCELLED, UNDONE }
    public record Step(String id, String tool, StepState state, String summary,
                       long startedAt, long finishedAt, boolean reversible, String resultId) {}
    public record Snapshot(TaskState taskState, List<Step> steps, boolean canUndo) {
        public Snapshot { steps = List.copyOf(steps); }
    }
    private final List<Step> steps = new ArrayList<>();
    private final Deque<UndoEntry> undoStack = new ArrayDeque<>();
    private final CopyOnWriteArrayList<Consumer<Snapshot>> listeners = new CopyOnWriteArrayList<>();
    private TaskState taskState = TaskState.IDLE;
    public void addListener(Consumer<Snapshot> listener) { if (listener != null) { listeners.addIfAbsent(listener); listener.accept(snapshot()); } }
    public void removeListener(Consumer<Snapshot> listener) { listeners.remove(listener); }
    public synchronized Snapshot snapshot() { return new Snapshot(taskState, new ArrayList<>(steps), !undoStack.isEmpty()); }
    public void reset() { Snapshot next; synchronized (this) { taskState = TaskState.IDLE; steps.clear(); undoStack.clear(); next = snapshot(); } publish(next); }
    public void beginTask(String summary) { Snapshot next; synchronized (this) { taskState = TaskState.PLANNING; steps.clear(); undoStack.clear(); next = snapshot(); } publish(next); }
    public void beginPlanning() { setTaskState(TaskState.PLANNING); }
    public void setTaskState(TaskState nextState) { if (nextState == null) return; Snapshot next; synchronized (this) { taskState = nextState; next = snapshot(); } publish(next); }
    public String beginStep(String tool, String summary) { String id = "step_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10); Snapshot next; synchronized (this) { taskState = TaskState.EXECUTING; steps.add(new Step(id, tool == null ? "" : tool, StepState.RUNNING, summary == null ? "" : summary, System.currentTimeMillis(), 0L, false, "")); next = snapshot(); } publish(next); return id; }
    public void completeStep(String id, String resultId, String summary, Runnable undo) { updateStep(id, StepState.COMPLETED, summary, resultId, undo != null); if (undo != null) { synchronized (this) { undoStack.push(new UndoEntry(id, undo)); } publish(snapshot()); } }
    public void failStep(String id, String summary) { updateStep(id, StepState.FAILED, summary, "", false); }
    public void cancelStep(String id, String summary) { updateStep(id, StepState.CANCELLED, summary, "", false); }
    public void verify() { setTaskState(TaskState.VERIFYING); }
    public void completeTask() { setTaskState(TaskState.COMPLETED); }
    public void failTask() { setTaskState(TaskState.FAILED); }
    public void cancelTask() { setTaskState(TaskState.CANCELLED); }
    public synchronized boolean canUndo() { return !undoStack.isEmpty(); }
    public void undoLast() { UndoEntry entry; Snapshot next; synchronized (this) { entry = undoStack.pollFirst(); if (entry == null) return; markUndone(entry.stepId()); next = snapshot(); } publish(next); try { entry.action().run(); } catch (RuntimeException ignored) {} }
    private void updateStep(String id, StepState state, String summary, String resultId, boolean reversible) { Snapshot next; synchronized (this) { int index = findStep(id); if (index < 0) return; Step current = steps.get(index); steps.set(index, new Step(current.id(), current.tool(), state, summary == null ? current.summary() : summary, current.startedAt(), System.currentTimeMillis(), reversible, resultId == null ? current.resultId() : resultId)); next = snapshot(); } publish(next); }
    private int findStep(String id) { for (int i = steps.size() - 1; i >= 0; i--) if (steps.get(i).id().equals(id)) return i; return -1; }
    private void markUndone(String id) { int index = findStep(id); if (index < 0) return; Step current = steps.get(index); steps.set(index, new Step(current.id(), current.tool(), StepState.UNDONE, current.summary(), current.startedAt(), System.currentTimeMillis(), current.reversible(), current.resultId())); }
    private void publish(Snapshot snapshot) { for (Consumer<Snapshot> listener : listeners) try { listener.accept(snapshot); } catch (RuntimeException ignored) {} }
    private record UndoEntry(String stepId, Runnable action) {}
}
