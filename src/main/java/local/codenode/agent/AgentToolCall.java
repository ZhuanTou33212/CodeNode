package local.codenode.agent;

import java.util.Map;

/** 模型工具调用。 */
public record AgentToolCall(String callId, String name, Map<String, Object> arguments) {}
