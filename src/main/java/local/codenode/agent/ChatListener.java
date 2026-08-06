package local.codenode.agent;

/** 会话事件监听（UI 通过此接口接收事件；所有回调均应在 EDT 处理 UI 变更）。 */
@FunctionalInterface
public interface ChatListener {
    void onEvent(ChatEvent event);
}
