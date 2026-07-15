package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public final class ResultService {
    private final Path resultsRoot;
    private final Set<Path> seen = new HashSet<>();
    public ResultService(Path stateRoot) { resultsRoot = stateRoot.resolve("results"); }

    @SuppressWarnings("unchecked")
    public List<String> poll(WorkflowModel model) throws IOException {
        List<String> notices = new ArrayList<>(); if (!Files.isDirectory(resultsRoot)) return notices;
        try (var dirs = Files.list(resultsRoot)) {
            for (Path dir : dirs.filter(Files::isDirectory).toList()) {
                Path file = dir.resolve("result.json"); if (!Files.isRegularFile(file) || !seen.add(file)) continue;
                Map<String,Object> result = Json.object(Files.readString(file, StandardCharsets.UTF_8));
                String requestId = String.valueOf(result.getOrDefault("requestId", dir.getFileName().toString()));
                String status = String.valueOf(result.getOrDefault("status", "failed"));
                List<Object> nodeResults = (List<Object>) result.getOrDefault("nodeResults", List.of());
                for (Object item : nodeResults) if (item instanceof Map<?,?> raw) {
                    String id = String.valueOf(raw.get("nodeId")); WorkflowModel.Node node = model.byId(id); if (node == null) continue;
                    node.status = "succeeded".equals(raw.get("status")) ? WorkflowModel.Status.SUCCEEDED : "failed".equals(raw.get("status")) ? WorkflowModel.Status.FAILED : node.status;
                }
                List<Object> diagnostics = (List<Object>) result.getOrDefault("diagnostics", List.of());
                for (Object item : diagnostics) if (item instanceof Map<?,?> raw && "error".equals(raw.get("severity"))) {
                    WorkflowModel.Node node = model.byId(String.valueOf(raw.get("nodeId"))); if (node != null) { node.status = WorkflowModel.Status.FAILED; node.diagnostic = formatDiagnostic(raw); }
                }
                notices.add(requestId + " → " + status + ": " + result.getOrDefault("summary", "结果已回写"));
            }
        }
        return notices;
    }

    private static String formatDiagnostic(Map<?,?> d) {
        Object line = d.containsKey("line") ? d.get("line") : "?";
        Object column = d.containsKey("column") ? d.get("column") : "?";
        Object message = d.containsKey("message") ? d.get("message") : "未知错误";
        String location = d.get("file") == null ? "" : d.get("file") + ":" + line + ":" + column + " ";
        return location + message;
    }
}
