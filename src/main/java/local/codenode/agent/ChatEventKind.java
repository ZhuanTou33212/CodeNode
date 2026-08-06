package local.codenode.agent;

import local.codenode.AgentProvider;

/** 会话事件类型。 */
public enum ChatEventKind {
    STREAM, REASONING, TOOL_CALL, TURN_COMPLETE, ERROR, CANCELLED, STATE
}
