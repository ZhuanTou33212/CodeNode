package local.codenode.agent;

import local.codenode.AgentProvider;

/** 会话事件：STREAM 正式回复增量 / REASONING 推理增量 / TOOL_CALL 工具调用 / TURN_COMPLETE 回合完成 / ERROR / CANCELLED / STATE。 */
public record ChatEvent(ChatEventKind kind, String text, AgentToolCall toolCall, String error,
                        AgentProvider.SessionState state) {

    public ChatEvent {
        text = text == null ? "" : text;
        error = error == null ? "" : error;
    }

    public static ChatEvent stream(String text) {
        return new ChatEvent(ChatEventKind.STREAM, text, null, "", null);
    }

    public static ChatEvent reasoning(String text) {
        return new ChatEvent(ChatEventKind.REASONING, text, null, "", null);
    }

    public static ChatEvent toolCall(AgentToolCall call) {
        return new ChatEvent(ChatEventKind.TOOL_CALL, "", call, "", null);
    }

    public static ChatEvent turnComplete(String text) {
        return new ChatEvent(ChatEventKind.TURN_COMPLETE, text, null, "", null);
    }

    public static ChatEvent error(String message) {
        return new ChatEvent(ChatEventKind.ERROR, "", null, message, null);
    }

    public static ChatEvent cancelled() {
        return new ChatEvent(ChatEventKind.CANCELLED, "", null, "", null);
    }

    public static ChatEvent state(AgentProvider.SessionState state) {
        return new ChatEvent(ChatEventKind.STATE, "", null, "", state);
    }
}
