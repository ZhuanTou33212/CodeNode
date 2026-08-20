package local.codenode.agent.components;

import local.codenode.agent.AgentTraceWriter;
import local.codenode.agent.tools.AgentToolContext;

import java.util.Map;

/**
 * trace 监听器（内置 {@code listener.trace}）：把 harness 事件写入
 * {@code .codenode/agent-traces/<sessionId>.jsonl}（原
 * {@code AgentChatController} 内联 trace 逻辑的组件化封装）。
 */
public final class TraceHarnessListener implements HarnessListener {

    private final AgentToolContext toolContext;
    private AgentTraceWriter writer;

    public TraceHarnessListener(AgentToolContext toolContext) {
        this.toolContext = toolContext;
    }

    @Override
    public String name() {
        return "trace";
    }

    @Override
    public void beginSession(String sessionId) {
        this.writer = new AgentTraceWriter(toolContext.projectRoot(), sessionId);
    }

    @Override
    public void endSession() {
        if (writer != null) {
            writer.close();
            writer = null;
        }
    }

    @Override
    public void onEvent(String type, Map<String, Object> fields) {
        if (writer != null) writer.event(type, fields);
    }

    /** 当前会话 trace 文件（beginSession 后可用；测试/调试用）。 */
    public java.nio.file.Path file() {
        return writer == null ? null : writer.file();
    }
}
