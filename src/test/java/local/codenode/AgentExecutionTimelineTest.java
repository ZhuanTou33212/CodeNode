package local.codenode.agent;

import local.codenode.agent.tools.AgentToolResult;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

class AgentExecutionTimelineTest {
    @Test
    void resultStoreDefersDataAndPagesStructuredResult() {
        AgentResultStore store = new AgentResultStore();
        AgentToolResult result = AgentToolResult.ok("summary", Map.of("large", "payload"));
        String id = store.store("demo", result);
        String payload = store.modelPayload(id, "demo", result, 1000);
        assertTrue(payload.contains(id));
        assertTrue(payload.contains("deferred"));
        assertFalse(payload.contains("payload"));
        AgentToolResult page = store.read(id, 0, 1000);
        assertTrue(page.ok());
        assertTrue(page.text().contains("payload"));
    }

    @Test
    void timelineTracksStatesAndUndo() {
        AgentExecutionTimeline timeline = new AgentExecutionTimeline();
        AtomicBoolean undone = new AtomicBoolean();
        timeline.beginTask("demo");
        String step = timeline.beginStep("workbench_edit", "edit");
        timeline.completeStep(step, "result_1", "done", () -> undone.set(true));
        assertTrue(timeline.canUndo());
        timeline.verify();
        timeline.completeTask();
        assertEquals(AgentExecutionTimeline.TaskState.COMPLETED, timeline.snapshot().taskState());
        timeline.undoLast();
        assertTrue(undone.get());
        assertEquals(AgentExecutionTimeline.StepState.UNDONE, timeline.snapshot().steps().get(0).state());
        assertFalse(timeline.canUndo());
    }
}
