package local.codenode;

import java.io.IOException;
import java.nio.file.Path;
import java.util.function.Consumer;

/**
 * Agent 会话生命周期门面（Stage4.5）：
 * 既有单次申请流程（start/running/cancel）保持不变，新增会话级方法
 * （startSession/sendTurn/cancelCurrentSession/closeSession/getSessionState）。
 *
 * <p>会话状态机：IDLE → ACTIVE_IDLE → ACTIVE_RUNNING → ACTIVE_IDLE；
 * 手动停止走 ACTIVE_CANCELLED → IDLE。</p>
 */
public interface AgentProvider extends AutoCloseable {
    enum SessionState { IDLE, ACTIVE_IDLE, ACTIVE_RUNNING, ACTIVE_CANCELLED }

    // ---------- 既有单次申请流程（MainFrame 队列提交用） ----------
    void start(Path projectRoot, Path requestDirectory, Consumer<String> events) throws IOException;
    boolean running();
    void cancel();

    // ---------- Stage4.5 会话生命周期门面 ----------
    default SessionState sessionState() { return SessionState.IDLE; }
    default String startSession(String systemPrompt) throws IOException {
        throw new UnsupportedOperationException("当前 Agent 不支持会话");
    }
    default void sendTurn(String sessionId, String userMessage, Consumer<String> events) throws IOException {
        throw new UnsupportedOperationException("当前 Agent 不支持多轮会话");
    }
    default void submitToolResult(String sessionId, String toolCallId, String jsonResult) throws IOException {
        throw new UnsupportedOperationException("当前 Agent 不支持工具结果回传");
    }
    default void cancelCurrentSession() { }
    default void closeSession(String sessionId) { }

    @Override void close();
}
