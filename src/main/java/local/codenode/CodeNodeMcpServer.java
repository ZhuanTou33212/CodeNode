package local.codenode;

import local.codenode.agent.tools.AgentToolContext;
import local.codenode.agent.tools.AgentToolRegistry;
import local.codenode.agent.tools.AgentToolResult;
import local.codenode.agent.tools.AgentToolSpec;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

/** Restricted stdio MCP facade over the project-local CodeNode queue. */
final class CodeNodeMcpServer {
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private final Path projectRoot;
    private final Path stateRoot;
    private AgentToolRegistry toolBridge;
    private final AgentToolContext bridgeContext;

    CodeNodeMcpServer(Path projectRoot) throws IOException {
        this.projectRoot = projectRoot.toAbsolutePath().normalize();
        this.stateRoot = this.projectRoot.resolve(".codenode");
        this.bridgeContext = new AgentToolContext(
                () -> this.projectRoot,
                () -> null,
                (level, what, detail) -> false,
                entry -> System.err.println("[agent-tool] " + entry));
        new QueueService(this.projectRoot);
    }

    /** 可选 MCP 出口：内嵌 Agent 默认不走 MCP（本地直调），此方法供外部进程暴露注册表中的工具。 */
    void registerToolBridge(AgentToolRegistry registry) {
        this.toolBridge = registry;
    }

    static void main(Path projectRoot) throws IOException { new CodeNodeMcpServer(projectRoot).run(System.in, System.out); }

    /** 标准命令行入口：java local.codenode.CodeNodeMcpServer <projectRoot>。 */
    public static void main(String[] args) throws IOException {
        if (args == null || args.length < 1 || args[0] == null || args[0].isBlank()) {
            throw new IllegalArgumentException("用法: java local.codenode.CodeNodeMcpServer <projectRoot>");
        }
        main(Path.of(args[0]));
    }

    void run(InputStream input, OutputStream output) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                Map<String,Object> request;
                try { request = Json.object(line); }
                catch (RuntimeException error) { write(writer, error(null, -32700, "Invalid JSON")); continue; }
                Object id = request.get("id");
                String method = String.valueOf(request.get("method"));
                if (id == null) continue;
                try { write(writer, response(id, dispatch(method, request.get("params")))); }
                catch (Exception failure) { write(writer, error(id, -32000, failure.getMessage())); }
            }
        }
    }

    private Object dispatch(String method, Object rawParams) throws IOException {
        return switch (method) {
            case "initialize" -> Map.of(
                    "protocolVersion", "2024-11-05",
                    "capabilities", Map.of("tools", Map.of("listChanged", false)),
                    "serverInfo", Map.of("name", "codenode-local-queue", "version", "0.5.0"));
            case "ping" -> Map.of();
            case "tools/list" -> Map.of("tools", tools());
            case "tools/call" -> callTool(asMap(rawParams));
            default -> throw new IllegalArgumentException("Unsupported MCP method: " + method);
        };
    }

    private List<Object> tools() {
        List<Object> result = new ArrayList<>();
        result.add(
                tool("codenode_list_requests", "列出项目本地申请槽中的申请", Map.of("type", "object", "properties", Map.of())));
        result.add(tool("codenode_read_request", "读取指定申请的 request.json 与 request.md", objectSchema("requestId")));
        result.add(tool("codenode_write_result", "将受审查的代码槽草稿结果写回指定申请", Map.of(
                "type", "object", "required", List.of("requestId", "result"), "properties", Map.of(
                        "requestId", Map.of("type", "string"), "result", Map.of("type", "object")))));
        if (toolBridge != null) {
            for (AgentToolSpec spec : toolBridge.listTools()) {
                result.add(tool(spec.name(), spec.description(),
                        spec.inputSchema() == null ? Map.of("type", "object", "properties", Map.of()) : spec.inputSchema()));
            }
        }
        return result;
    }

    private Object callTool(Map<String,Object> params) throws IOException {
        String name = String.valueOf(params.get("name"));
        Map<String,Object> arguments = asMap(params.get("arguments"));
        Object payload = switch (name) {
            case "codenode_list_requests" -> listRequests();
            case "codenode_read_request" -> readRequest(id(arguments));
            case "codenode_write_result" -> writeResult(id(arguments), asMap(arguments.get("result")));
            default -> bridgeTool(name, arguments);
        };
        return Map.of("content", List.of(Map.of("type", "text", "text", Json.stringify(payload))), "isError", false);
    }

    private Object bridgeTool(String name, Map<String,Object> arguments) {
        if (toolBridge == null || !toolBridge.contains(name)) {
            throw new IllegalArgumentException("Unknown CodeNode tool: " + name);
        }
        AgentToolResult result = toolBridge.execute(name, arguments, bridgeContext, bridgeContext.sessionScope());
        return Map.of("content", List.of(Map.of("type", "text", "text", result.toJson())), "isError", !result.ok());
    }

    private List<Object> listRequests() throws IOException {
        List<Object> rows = new ArrayList<>();
        for (QueueService.QueueEntry entry : new QueueService(projectRoot).entries())
            rows.add(Map.of("requestId", entry.requestId(), "status", entry.status()));
        return rows;
    }

    private Object readRequest(String requestId) throws IOException {
        Path directory = findRequestDirectory(requestId);
        return Map.of(
                "requestId", requestId,
                "request", Json.object(Files.readString(directory.resolve("request.json"), StandardCharsets.UTF_8)),
                "instructions", Files.readString(directory.resolve("request.md"), StandardCharsets.UTF_8));
    }

    private Object writeResult(String requestId, Map<String,Object> result) throws IOException {
        Path requestDirectory=findRequestDirectory(requestId);Map<String,Object> request=Json.object(Files.readString(requestDirectory.resolve("request.json"),StandardCharsets.UTF_8));
        Object embedded = result.get("requestId");
        if (embedded != null && !requestId.equals(String.valueOf(embedded))) throw new IllegalArgumentException("result.requestId 与目标申请不一致");
        validateResult(request,result);
        Map<String,Object> normalized = new LinkedHashMap<>(result);
        normalized.put("schemaVersion", "4.0");
        normalized.put("requestId", requestId);
        Path directory = confined(stateRoot.resolve("results").resolve(requestId));
        Files.createDirectories(directory);
        Path target = directory.resolve("result.json"), temporary = directory.resolve("result.json.tmp");
        Files.writeString(temporary, Json.stringify(normalized), StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        try { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException ignored) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
        return Map.of("requestId", requestId, "path", target.toString(), "acceptedForReview", true);
    }

    private void validateResult(Map<String,Object> request,Map<String,Object> result){Map<String,Object> target=asMap(request.get("target"));Set<String> allowed=new LinkedHashSet<>();Object rawIds=target.get("codeSlotIds");if(rawIds instanceof List<?> ids)ids.forEach(id->allowed.add(String.valueOf(id)));Map<String,Object> revisions=asMap(target.get("baseSlotRevisions"));Object rawResults=result.get("codeSlotResults");if(!(rawResults instanceof List<?> rows))throw new IllegalArgumentException("result.codeSlotResults 必须是数组");for(Object row:rows){Map<String,Object> slot=asMap(row);String slotId=String.valueOf(slot.get("slotId"));if(!allowed.contains(slotId))throw new IllegalArgumentException("结果包含申请范围外代码槽："+slotId);if(!(slot.get("baseRevision") instanceof Number revision)||!Objects.equals(revision.longValue(),((Number)revisions.get(slotId)).longValue()))throw new IllegalArgumentException("代码槽基础修订不匹配："+slotId);if(!(slot.get("code") instanceof String))throw new IllegalArgumentException("代码槽缺少 code："+slotId);if(!NodeRegistry.isKnown(String.valueOf(slot.get("classificationKey"))))throw new IllegalArgumentException("未知分类："+slot.get("classificationKey"));}}

    private Path findRequestDirectory(String requestId) throws IOException {
        requireId(requestId);
        for (String state : List.of("inbox", "processing", "completed", "failed", "cancelled", "rejected", "conflicted")) {
            Path candidate = confined(stateRoot.resolve("queue").resolve(state).resolve(requestId));
            if (Files.isRegularFile(candidate.resolve("request.json")) && Files.isRegularFile(candidate.resolve("request.md"))) return candidate;
        }
        throw new FileNotFoundException("找不到申请：" + requestId);
    }

    private Path confined(Path path) {
        Path normalized = path.toAbsolutePath().normalize();
        if (!normalized.startsWith(stateRoot)) throw new IllegalArgumentException("路径越过 .codenode 边界");
        return normalized;
    }

    private static String id(Map<String,Object> arguments) { String value = String.valueOf(arguments.get("requestId")); requireId(value); return value; }
    private static void requireId(String id) { if (id == null || !REQUEST_ID.matcher(id).matches()) throw new IllegalArgumentException("非法 requestId"); }
    private static Map<String,Object> objectSchema(String required) { return Map.of("type", "object", "required", List.of(required), "properties", Map.of(required, Map.of("type", "string"))); }
    private static Map<String,Object> tool(String name, String description, Map<String,Object> schema) { return Map.of("name", name, "description", description, "inputSchema", schema); }
    @SuppressWarnings("unchecked") private static Map<String,Object> asMap(Object value) { return value instanceof Map<?,?> map ? (Map<String,Object>) map : Map.of(); }
    private static Map<String,Object> response(Object id, Object result) { return envelope(id, "result", result); }
    private static Map<String,Object> error(Object id, int code, String message) { return envelope(id, "error", Map.of("code", code, "message", message == null ? "Unknown error" : message)); }
    private static Map<String,Object> envelope(Object id, String key, Object value) { Map<String,Object> map = new LinkedHashMap<>(); map.put("jsonrpc", "2.0"); map.put("id", id); map.put(key, value); return map; }
    private static void write(BufferedWriter writer, Map<String,Object> message) throws IOException { writer.write(Json.stringify(message).replace("\n", "")); writer.newLine(); writer.flush(); }
}
