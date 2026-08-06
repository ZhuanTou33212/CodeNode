package local.codenode.agent.tools;

import java.util.LinkedHashMap;
import java.util.Map;

/** 工具执行结果：确定性文本 + 结构化数据。 */
public record AgentToolResult(boolean ok, String text, Map<String, Object> data) {

    public AgentToolResult {
        data = data == null ? Map.of() : Map.copyOf(data);
    }

    public static AgentToolResult ok(String text) {
        return new AgentToolResult(true, text, Map.of());
    }

    public static AgentToolResult ok(String text, Map<String, Object> data) {
        return new AgentToolResult(true, text, data);
    }

    public static AgentToolResult error(String text) {
        return new AgentToolResult(false, text, Map.of());
    }

    public String toJson() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("ok", ok);
        value.put("text", text);
        value.put("data", data);
        return local.codenode.Json.stringify(value);
    }
}
