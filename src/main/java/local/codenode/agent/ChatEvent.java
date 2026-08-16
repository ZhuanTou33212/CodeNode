package local.codenode.agent;

import local.codenode.AgentProvider;

/** Events emitted by the embedded Agent, including current tool activity. */
public record ChatEvent(ChatEventKind kind, String text, AgentToolCall toolCall, String error,
                        AgentProvider.SessionState state, String activity) {
    public ChatEvent(ChatEventKind kind, String text, AgentToolCall toolCall, String error, AgentProvider.SessionState state) {
        this(kind, text, toolCall, error, state, "");
    }
    public ChatEvent {
        text = text == null ? "" : text;
        error = error == null ? "" : error;
        activity = activity == null ? "" : activity;
    }
    public static ChatEvent stream(String text) { return new ChatEvent(ChatEventKind.STREAM, text, null, "", null); }
    public static ChatEvent reasoning(String text) { return new ChatEvent(ChatEventKind.REASONING, text, null, "", null); }
    public static ChatEvent toolCall(AgentToolCall call) { return new ChatEvent(ChatEventKind.TOOL_CALL, "", call, "", null); }
    public static ChatEvent turnComplete(String text) { return new ChatEvent(ChatEventKind.TURN_COMPLETE, text, null, "", null); }
    public static ChatEvent error(String message) { return new ChatEvent(ChatEventKind.ERROR, "", null, message, null); }
    public static ChatEvent cancelled() { return new ChatEvent(ChatEventKind.CANCELLED, "", null, "", null); }
    public static ChatEvent state(AgentProvider.SessionState state) { return new ChatEvent(ChatEventKind.STATE, "", null, "", state); }
    public static ChatEvent toolProgress(String tool) { return new ChatEvent(ChatEventKind.STATE, "", null, "", AgentProvider.SessionState.ACTIVE_RUNNING, tool); }
    /** 系统级提示（如 API 失败自动重试），灰色展示、不进入消息历史。 */
    public static ChatEvent system(String text) { return new ChatEvent(ChatEventKind.SYSTEM, text, null, "", null); }
}