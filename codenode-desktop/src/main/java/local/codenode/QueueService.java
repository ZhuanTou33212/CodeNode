package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;

public final class QueueService {
    private final Path projectRoot;
    private final Path stateRoot;

    public QueueService(Path projectRoot) throws IOException {
        this.projectRoot = projectRoot.toAbsolutePath().normalize();
        this.stateRoot = this.projectRoot.resolve(".codenode");
        for (String dir : List.of("queue/staging", "queue/inbox", "queue/processing", "queue/completed", "queue/failed", "queue/cancelled", "results"))
            Files.createDirectories(stateRoot.resolve(dir));
        Path descriptor = stateRoot.resolve("project.json");
        if (!Files.exists(descriptor)) Files.writeString(descriptor, Json.stringify(Map.of("schemaVersion", "3.0", "projectRoot", this.projectRoot.toString(), "transport", "local-file-queue")), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    }

    public Path projectRoot() { return projectRoot; }
    public Path stateRoot() { return stateRoot; }

    public List<QueueEntry> entries() throws IOException {
        List<QueueEntry> entries=new ArrayList<>();
        for(String status:List.of("inbox","processing","completed","failed","cancelled")){
            Path directory=stateRoot.resolve("queue").resolve(status);
            try(var children=Files.list(directory)){children.filter(Files::isDirectory).forEach(path->entries.add(new QueueEntry(path.getFileName().toString(),status,path)));}
        }
        entries.sort(Comparator.comparing(QueueEntry::requestId).reversed());return entries;
    }

    public Submission submit(WorkflowModel model, WorkflowModel.Mode mode, WorkflowModel.Node selected,
                             boolean selectedOnly, String language, String outputPath) throws IOException {
        if (selected == null) throw new IllegalArgumentException("请先选择一个节点");
        String stamp = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS").withZone(java.time.ZoneOffset.UTC).format(Instant.now());
        String requestId = "request-" + stamp;
        List<WorkflowModel.Node> included = selectedOnly ? List.of(selected) : (mode == WorkflowModel.Mode.MARKDOWN ? model.nodes() : reachable(model, selected));
        Set<String> ids = new LinkedHashSet<>(); included.forEach(n -> ids.add(n.id));
        List<Map<String,Object>> nodes = included.stream().map(n -> nodeMap(n, mode)).toList();
        List<Map<String,Object>> edges = model.edges().stream().filter(e -> ids.contains(e.source()) && ids.contains(e.target()))
            .map(e -> Map.<String,Object>of("id", e.id(), "source", List.of(e.source(), e.sourcePort()), "target", List.of(e.target(), e.targetPort()), "kind", "data")).toList();

        boolean executable = mode == WorkflowModel.Mode.EXECUTABLE;
        String action = executable ? (selectedOnly ? "build-node" : "build-program") : (selectedOnly ? "build-markdown" : "analyze-project");
        Map<String,Object> request = new LinkedHashMap<>();
        request.put("schemaVersion", "3.0"); request.put("requestId", requestId); request.put("transport", "local-file-queue");
        request.put("createdAt", Instant.now().toString()); request.put("mode", mode.wireName); request.put("action", action);
        String scopeKind = selectedOnly ? "selected-node" : (executable ? "reachable-graph" : "project");
        request.put("scope", Map.of("kind", scopeKind, "targetNodeId", selected.id));
        request.put("language", language);
        if (executable) { request.put("entry", selected.id); request.put("expression", selected.id); }
        request.put("prompt", selected.prompt);
        request.put("output", Map.of("workspaceRoot", projectRoot.toString(), "relativePath", validateRelative(outputPath), "artifactPolicy", executable ? "executable" : "markdown-only"));
        request.put("execution", Map.of("compile", executable, "run", executable));
        request.put("nodes", nodes); request.put("edges", edges); request.put("requiresConfirmation", true);

        Path staging = stateRoot.resolve("queue/staging").resolve(requestId);
        Path inbox = stateRoot.resolve("queue/inbox").resolve(requestId);
        Files.createDirectory(staging);
        Files.writeString(staging.resolve("request.json"), Json.stringify(request), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        Files.writeString(staging.resolve("request.md"), markdown(requestId, mode, action, selected, included, outputPath, language), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        try { Files.move(staging, inbox, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException e) { Files.move(staging, inbox); }
        included.forEach(n -> n.status = WorkflowModel.Status.QUEUED);
        return new Submission(requestId, inbox, "处理 CodeNode 本地申请 " + requestId);
    }

    private String validateRelative(String value) {
        Path path = Path.of(value.trim()).normalize();
        if (path.isAbsolute() || path.startsWith("..") || value.isBlank()) throw new IllegalArgumentException("输出位置必须是项目内的相对路径");
        return path.toString().replace('\\', '/');
    }

    private static List<WorkflowModel.Node> reachable(WorkflowModel model, WorkflowModel.Node target) {
        LinkedHashSet<String> ids = new LinkedHashSet<>(); ArrayDeque<String> todo = new ArrayDeque<>(); todo.add(target.id);
        while (!todo.isEmpty()) { String id = todo.removeFirst(); if (!ids.add(id)) continue; model.edges().stream().filter(e -> e.target().equals(id)).forEach(e -> todo.add(e.source())); }
        return ids.stream().map(model::byId).filter(Objects::nonNull).toList();
    }

    private static Map<String,Object> nodeMap(WorkflowModel.Node n, WorkflowModel.Mode mode) {
        Map<String,Object> node = new LinkedHashMap<>(); node.put("id", n.id); node.put("name", n.name); node.put("category", mode == WorkflowModel.Mode.EXECUTABLE ? n.category : "document");
        node.put("prompt", n.prompt); node.put("artifact", n.artifact); node.put("inputs", n.inputs.stream().map(QueueService::portMap).toList());
        node.put("outputs", n.outputs.stream().map(QueueService::portMap).toList()); return node;
    }
    private static Map<String,Object> portMap(WorkflowModel.Port port) { return Map.of("id",port.id,"name",port.name,"dataType",port.dataType,"required",port.required); }
    private static String markdown(String id, WorkflowModel.Mode mode, String action, WorkflowModel.Node selected, List<WorkflowModel.Node> nodes, String output, String language) {
        return "# CodeNode 本地申请 " + id + "\n\n- 模式：`" + mode.wireName + "`\n- 语言：`" + language + "`\n- 动作：`" + action + "`\n- 目标节点：`" + selected.id + "`\n- 输出：`" + output + "`\n\n## 需求\n\n" + selected.prompt + "\n\n## 节点\n\n" + nodes.stream().map(n -> "- `" + n.id + "` " + n.name).reduce("", (a,b) -> a + b + "\n");
    }
    public record Submission(String requestId, Path inboxPath, String codexPrompt) {}
    public record QueueEntry(String requestId,String status,Path path) { @Override public String toString(){return requestId+"   ["+status+"]";} }
}
