package local.codenode;

import local.codenode.agent.AgentChatController;
import local.codenode.agent.AgentExecutionTimeline;
import local.codenode.agent.ChatClient;
import local.codenode.agent.ChatEvent;
import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Agent harness 行为评估套件（确定性、无网络）。
 *
 * <p>通过注入脚本化 {@link ChatClient} 驱动完整 harness 循环，验证关键行为：
 * 失败自愈重试、强制总结、规划层进度检查、trace 持久化、停止取消。这些是
 * harness 的“能力回归基准”：改动 prompt/超时/重试策略后跑一遍即可发现回归。</p>
 */
class AgentEvalSuite {

    /** 脚本化模型客户端：按预设脚本逐轮返回响应，并记录每轮收到的消息列表。 */
    static final class ScriptedChatClient implements ChatClient {
        private final List<Map<String, Object>> script;
        private final List<List<Map<String, Object>>> messageLog = new ArrayList<>();
        private final AtomicInteger index = new AtomicInteger();

        ScriptedChatClient(List<Map<String, Object>> script) {
            this.script = script;
        }

        @Override
        public Map<String, Object> chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools,
                                        Consumer<ChatEvent> events) {
            messageLog.add(List.copyOf(messages));
            int i = index.getAndIncrement();
            Map<String, Object> response = i < script.size() ? script.get(i) : textResponse("（脚本耗尽）");
            if (response.get("content") instanceof String text) {
                events.accept(ChatEvent.stream(text));
            }
            return response;
        }

        List<List<Map<String, Object>>> messageLog() {
            return messageLog;
        }

        static Map<String, Object> textResponse(String text) {
            return Map.of("role", "assistant", "content", text);
        }

        static Map<String, Object> toolCallResponse(String callId, String name, Map<String, Object> args) {
            Map<String, Object> function = new LinkedHashMap<>();
            function.put("name", name);
            function.put("arguments", local.codenode.Json.stringify(args == null ? Map.of() : args).replace("\n", ""));
            Map<String, Object> call = new LinkedHashMap<>();
            call.put("id", callId);
            call.put("type", "function");
            call.put("function", function);
            return Map.of("role", "assistant", "tool_calls", List.of(call));
        }
    }

    private static AgentToolRegistry evalRegistry() {
        AgentToolRegistry registry = new AgentToolRegistry();
        Map<String, Object> emptySchema = Map.of("type", "object", "properties", Map.of());
        registry.register("fake_ok", "总是成功", emptySchema,
                (context, args) -> AgentToolResult.ok("fake ok result"));
        registry.register("fake_fail", "总是失败", emptySchema,
                (context, args) -> AgentToolResult.error("fake failure"));
        registry.register("fake_sleep", "睡眠 5 秒", emptySchema, (context, args) -> {
            try {
                Thread.sleep(5000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return AgentToolResult.error("sleep interrupted");
            }
            return AgentToolResult.ok("slept");
        });
        return registry;
    }

    private static AgentToolContext evalContext(Path root) {
        return new AgentToolContext(() -> root, () -> null, (level, what, detail) -> true, entry -> {});
    }

    private static void awaitIdle(AgentChatController controller, long timeoutMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (controller.state() != AgentProvider.SessionState.IDLE && System.currentTimeMillis() < deadline) {
            Thread.sleep(50);
        }
        assertEquals(AgentProvider.SessionState.IDLE, controller.state(), "会话应在超时前回到 IDLE");
    }
    private static boolean logContains(List<List<Map<String, Object>>> log, String keyword) {
        for (List<Map<String, Object>> messages : log) {
            for (Map<String, Object> message : messages) {
                if ("user".equals(message.get("role"))
                        && String.valueOf(message.get("content")).contains(keyword)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static List<String> toolCallSequence(AgentChatController controller) {
        return controller.timeline().snapshot().steps().stream().map(AgentExecutionTimeline.Step::tool).toList();
    }

    @Test
    void failsToolThenRetriesWithNudgeAndForcesSummary(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("call_1", "unknown_tool", Map.of()),
                ScriptedChatClient.toolCallResponse("call_2", "fake_ok", Map.of()),
                ScriptedChatClient.textResponse("任务完成"),
                ScriptedChatClient.textResponse("总结：已完成")));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        controller.sendMessage("执行一个任务", events -> {});
        awaitIdle(controller, 20_000);

        assertEquals(List.of("unknown_tool", "fake_ok"), toolCallSequence(controller),
                "失败后应换工具重试而非直接结束");
        assertTrue(logContains(client.messageLog(), "重新思考") || logContains(client.messageLog(), "换一种思路"),
                "工具失败后应注入重试提示");
        assertTrue(logContains(client.messageLog(), "请基于以上工具执行结果"),
                "执行过工具后应强制总结");
        assertEquals(AgentExecutionTimeline.TaskState.COMPLETED, controller.timeline().snapshot().taskState());
    }

    @Test
    void forcesSummaryEvenIfModelStopsAfterTool(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("call_1", "fake_ok", Map.of()),
                ScriptedChatClient.textResponse("完成"),
                ScriptedChatClient.textResponse("总结")));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        controller.sendMessage("做一件事", events -> {});
        awaitIdle(controller, 20_000);

        assertTrue(logContains(client.messageLog(), "请基于以上工具执行结果"), "工具执行后必须补总结轮");
    }

    @Test
    void planCheckInjectedEveryThreeSteps(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("c1", "fake_ok", Map.of()),
                ScriptedChatClient.toolCallResponse("c2", "fake_ok", Map.of()),
                ScriptedChatClient.toolCallResponse("c3", "fake_ok", Map.of()),
                ScriptedChatClient.toolCallResponse("c4", "fake_ok", Map.of()),
                ScriptedChatClient.textResponse("完成"),
                ScriptedChatClient.textResponse("总结")));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        controller.sendMessage("长任务", events -> {});
        awaitIdle(controller, 20_000);

        assertTrue(logContains(client.messageLog(), "【进度检查】"), "每 3 步应注入进度检查");
        assertEquals(4, toolCallSequence(controller).size());
    }

    @Test
    void traceFileRecordsFullExecution(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("call_1", "fake_ok", Map.of()),
                ScriptedChatClient.textResponse("完成"),
                ScriptedChatClient.textResponse("总结")));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        controller.sendMessage("带 trace 的任务", events -> {});
        awaitIdle(controller, 20_000);

        Path trace = root.resolve(".codenode/agent-traces").resolve(controller.sessionId() + ".jsonl");
        assertTrue(Files.isRegularFile(trace), "应生成 trace 文件: " + trace);
        String content = Files.readString(trace, StandardCharsets.UTF_8);
        for (String type : List.of("session_start", "llm_call", "tool_call", "session_end")) {
            assertTrue(content.contains("\"type\": \"" + type + "\""), "trace 应包含 " + type + " 事件");
        }
    }

    @Test
    void stopCancelsRunningTool(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("call_1", "fake_sleep", Map.of())));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        Thread runner = new Thread(() -> controller.sendMessage("睡眠任务", events -> {}));
        runner.start();
        Thread.sleep(400);
        controller.requestStop();
        awaitIdle(controller, 10_000);

        List<String> calls = toolCallSequence(controller);
        assertEquals(List.of("fake_sleep"), calls);
        assertTrue(controller.timeline().snapshot().taskState() == AgentExecutionTimeline.TaskState.CANCELLED
                        || controller.timeline().snapshot().steps().get(0).state() == AgentExecutionTimeline.StepState.FAILED,
                "停止后工具步骤应处于取消/失败状态，实际: " + controller.timeline().snapshot());
    }

    @Test
    void consecutiveFailuresGetMultipleNudgesUntilSuccess(@TempDir Path root) throws Exception {
        ScriptedChatClient client = new ScriptedChatClient(List.of(
                ScriptedChatClient.toolCallResponse("call_1", "fake_fail", Map.of()),
                ScriptedChatClient.toolCallResponse("call_2", "fake_fail", Map.of()),
                ScriptedChatClient.toolCallResponse("call_3", "fake_ok", Map.of()),
                ScriptedChatClient.textResponse("完成"),
                ScriptedChatClient.textResponse("总结")));
        AgentChatController controller = new AgentChatController(evalRegistry(), evalContext(root), client);
        controller.sendMessage("失败后继续尝试", events -> {});
        awaitIdle(controller, 20_000);

        assertEquals(List.of("fake_fail", "fake_fail", "fake_ok"), toolCallSequence(controller),
                "连续失败也应持续收到提示并最终成功");
    }
}
