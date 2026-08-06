package local.codenode;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Message builders for the newline-delimited Codex App Server protocol. */
final class AppServerMessages {
    private AppServerMessages() {}

    /** Stage4.5 会话消息类型：类型名 camelCase ↔ 线上方法 snake_case/方法路径。 */
    enum MessageType {
        START_THREAD_REQUEST("startThreadRequest", "thread/start"),
        START_THREAD_RESPONSE("startThreadResponse", null),
        START_TURN_REQUEST("startTurnRequest", "turn/start"),
        AGENT_TURN_RESPONSE("agentTurnResponse", "turn/agent_response"),
        AGENT_TOOL_CALL("agentToolCall", "tool/call"),
        CANCEL_REQUEST("cancelRequest", "turn/interrupt"),
        CANCEL_RESPONSE("cancelResponse", null);

        final String camelCase;
        final String wireMethod;

        MessageType(String camelCase, String wireMethod) {
            this.camelCase = camelCase;
            this.wireMethod = wireMethod;
        }

        static MessageType fromWire(String method) {
            if (method == null) return null;
            for (MessageType type : values()) {
                if (type.wireMethod != null && type.wireMethod.equals(method)) return type;
            }
            return null;
        }

        static MessageType fromCamelCase(String camel) {
            if (camel == null) return null;
            for (MessageType type : values()) {
                if (type.camelCase.equals(camel)) return type;
            }
            return null;
        }
    }

    /** camelCase → snake_case（如 startThreadRequest → start_thread_request）。 */
    static String toSnakeCase(String camelCase) {
        if (camelCase == null || camelCase.isEmpty()) return camelCase;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < camelCase.length(); i++) {
            char c = camelCase.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) out.append('_');
                out.append(Character.toLowerCase(c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** snake_case → camelCase（如 start_thread_request → startThreadRequest）。 */
    static String toCamelCase(String snakeCase) {
        if (snakeCase == null || snakeCase.isEmpty()) return snakeCase;
        StringBuilder out = new StringBuilder();
        boolean upper = false;
        for (char c : snakeCase.toCharArray()) {
            if (c == '_') { upper = true; continue; }
            out.append(upper ? Character.toUpperCase(c) : c);
            upper = false;
        }
        return out.toString();
    }

    static Map<String,Object> initialize(long id) {
        return request(id, "initialize", Map.of(
                "clientInfo", Map.of("name", "codenode_desktop", "title", "CodeNode Desktop", "version", "0.5.0")));
    }

    static Map<String,Object> initialized() {
        return Map.of("method", "initialized");
    }

    /** StartThreadRequest：发起一个新线程。 */
    static Map<String,Object> startThreadRequest(long id, Path projectRoot) {
        Map<String,Object> params = new LinkedHashMap<>();
        params.put("cwd", projectRoot.toAbsolutePath().normalize().toString());
        params.put("sandbox", "workspace-write");
        params.put("approvalPolicy", "never");
        params.put("serviceName", "codenode_desktop");
        return request(id, "thread/start", params);
    }

    /** 兼容旧名 startThread。 */
    static Map<String,Object> startThread(long id, Path projectRoot) {
        return startThreadRequest(id, projectRoot);
    }

    /** StartTurnRequest：在指定线程发起一轮（可携带工具列表与系统提示）。 */
    static Map<String,Object> startTurnRequest(long id, String threadId, Path projectRoot, String userMessage,
                                               String systemPrompt, List<Map<String,Object>> tools) {
        Map<String,Object> sandbox = new LinkedHashMap<>();
        sandbox.put("type", "workspaceWrite");
        sandbox.put("writableRoots", List.of(projectRoot.toAbsolutePath().normalize().toString()));
        sandbox.put("networkAccess", false);
        List<Map<String,Object>> input = new ArrayList<>();
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            input.add(Map.of("type", "text", "text", systemPrompt));
        }
        input.add(Map.of("type", "text", "text", userMessage));
        Map<String,Object> params = new LinkedHashMap<>();
        params.put("threadId", threadId);
        params.put("cwd", projectRoot.toAbsolutePath().normalize().toString());
        params.put("approvalPolicy", "never");
        params.put("sandboxPolicy", sandbox);
        params.put("input", input);
        if (tools != null && !tools.isEmpty()) params.put("tools", tools);
        return request(id, "turn/start", params);
    }

    /** 与既有申请流程兼容的 startTurn（读取 request.md/request.json）。 */
    static Map<String,Object> startTurn(long id, String threadId, Path projectRoot, Path requestDirectory) {
        Path root = projectRoot.toAbsolutePath().normalize();
        Path request = requestDirectory.toAbsolutePath().normalize();
        String prompt = "处理 CodeNode 本地申请。先读取 " + request.resolve("request.md")
                + " 和 " + request.resolve("request.json")
                + "。遵循其中的代码槽、DSL、语言和审查约束；不要修改 .cnode 文件，不要编译或运行。"
                + "完成后只将符合 workflow-result 4.0 的 JSON 原子写入 "
                + root.resolve(".codenode/results").resolve(request.getFileName()).resolve("result.json") + "。";
        Map<String,Object> sandbox = new LinkedHashMap<>();
        sandbox.put("type", "workspaceWrite");
        sandbox.put("writableRoots", List.of(root.toString()));
        sandbox.put("networkAccess", false);
        Map<String,Object> params = new LinkedHashMap<>();
        params.put("threadId", threadId);
        params.put("cwd", root.toString());
        params.put("approvalPolicy", "never");
        params.put("sandboxPolicy", sandbox);
        params.put("input", List.of(Map.of("type", "text", "text", prompt)));
        return request(id, "turn/start", params);
    }

    /** CancelRequest：中断指定线程的当前回合。 */
    static Map<String,Object> cancelRequest(long id, String threadId, String turnId) {
        return request(id, "turn/interrupt", Map.of("threadId", threadId, "turnId", turnId));
    }

    /** 兼容旧名 interrupt。 */
    static Map<String,Object> interrupt(long id, String threadId, String turnId) {
        return cancelRequest(id, threadId, turnId);
    }

    /** AgentToolCall 解析：从通知参数中提取 tool call。 */
    static Map<String,Object> parseAgentToolCall(Map<String,Object> params) {
        if (params == null) return Map.of();
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("type", MessageType.AGENT_TOOL_CALL.camelCase);
        Object callId = params.get("callId");
        result.put("callId", callId == null ? "" : String.valueOf(callId));
        Object name = params.get("name");
        result.put("name", name == null ? "" : String.valueOf(name));
        Object args = params.get("arguments");
        result.put("arguments", args instanceof Map<?,?> ? args : params.get("input") == null ? Map.of() : params.get("input"));
        Object turnId = params.get("turnId");
        result.put("turnId", turnId == null ? "" : String.valueOf(turnId));
        return result;
    }

    private static Map<String,Object> request(long id, String method, Map<String,Object> params) {
        Map<String,Object> message = new LinkedHashMap<>();
        message.put("id", id);
        message.put("method", method);
        message.put("params", params);
        return message;
    }
}
