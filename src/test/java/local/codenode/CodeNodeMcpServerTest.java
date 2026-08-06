package local.codenode;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class CodeNodeMcpServerTest {
    @TempDir Path temp;

    @Test void listsRestrictedQueueTools() throws Exception {
        String output = exchange(Map.of("jsonrpc", "2.0", "id", 1, "method", "tools/list", "params", Map.of()));
        Map<String,Object> response = Json.object(output);
        Map<?,?> result = (Map<?,?>) response.get("result");
        List<?> tools = (List<?>) result.get("tools");
        assertEquals(List.of("codenode_list_requests", "codenode_read_request", "codenode_write_result"),
                tools.stream().map(tool -> String.valueOf(((Map<?,?>)tool).get("name"))).toList());
    }

    @Test void writesOnlyAReviewResultForExistingRequest() throws Exception {
        Path request = temp.resolve(".codenode/queue/inbox/request-1");
        Files.createDirectories(request);
        Files.writeString(request.resolve("request.json"), Json.stringify(Map.of("target",Map.of("codeSlotIds",List.of("node:one"),"baseSlotRevisions",Map.of("node:one",0)))), StandardCharsets.UTF_8);
        Files.writeString(request.resolve("request.md"), "instructions", StandardCharsets.UTF_8);
        Map<String,Object> call = Map.of("jsonrpc", "2.0", "id", 2, "method", "tools/call", "params", Map.of(
                "name", "codenode_write_result", "arguments", Map.of("requestId", "request-1", "result", Map.of("status", "succeeded","codeSlotResults",List.of(Map.of("slotId","node:one","baseRevision",0,"code","class Main {}","classificationKey","agent.custom"))))));
        Map<String,Object> response = Json.object(exchange(call));
        assertTrue(response.containsKey("result"));
        Map<String,Object> saved = Json.object(Files.readString(temp.resolve(".codenode/results/request-1/result.json")));
        assertEquals("4.0", saved.get("schemaVersion"));
        assertEquals("request-1", saved.get("requestId"));
    }

    @Test void rejectsTraversalIds() throws Exception {
        Map<String,Object> call = Map.of("jsonrpc", "2.0", "id", 3, "method", "tools/call", "params", Map.of(
                "name", "codenode_read_request", "arguments", Map.of("requestId", "../outside")));
        assertTrue(Json.object(exchange(call)).containsKey("error"));
        assertFalse(Files.exists(temp.resolve("outside")));
    }

    private String exchange(Map<String,Object> request) throws Exception {
        String line = Json.stringify(request).replace("\n", "") + "\n";
        ByteArrayInputStream input = new ByteArrayInputStream(line.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        new CodeNodeMcpServer(temp).run(input, output);
        return output.toString(StandardCharsets.UTF_8).trim();
    }
}
