package local.codenode;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 验证扫描产生的节点对象字段均非 null，避免 UI 层 NPE 导致 "NULL" 报错。 */
public class ScanNodeNullSafetyTest {

    @Test
    void allScanNodesHaveNonNullPromptAndArtifact() throws Exception {
        java.nio.file.Path root = java.nio.file.Files.createTempDirectory("null-safety");
        java.nio.file.Files.createDirectories(root.resolve("src/main/java/com/demo"));
        java.nio.file.Files.createDirectories(root.resolve("assets/demo/textures"));
        java.nio.file.Files.writeString(root.resolve("src/main/java/com/demo/Main.java"),
                "package com.demo;\npublic class Main {}\n", java.nio.charset.StandardCharsets.UTF_8);
        java.nio.file.Files.writeString(root.resolve("assets/demo/textures/stone.png"), "x", java.nio.charset.StandardCharsets.UTF_8);
        try {
            WorkflowModel model = new WorkflowModel();
            DirectoryGraphBuilder.build(model, root);
            List<String> nullFields = new ArrayList<>();
            for (WorkflowModel.Node node : model.nodes()) {
                if (node.prompt == null) nullFields.add(node.id + ".prompt");
                if (node.artifact == null) nullFields.add(node.id + ".artifact");
                if (node.name == null) nullFields.add(node.id + ".name");
                if (node.category == null) nullFields.add(node.id + ".category");
                if (node.classificationKey == null) nullFields.add(node.id + ".classificationKey");
            }
            assertTrue(nullFields.isEmpty(), "存在 null 字段: " + nullFields);
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    void groupInputOutputNodesHaveNonNullFields() {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node group = model.addGroupNode(0, 0, "组");
        WorkflowModel.Node gi = model.addGroupInputNode(10, 10, "组输入");
        gi.parentScopeId = group.id;
        WorkflowModel.Node go = model.addNodeGroupOutput(20, 20, "组输出");
        go.parentScopeId = group.id;
        for (WorkflowModel.Node node : List.of(group, gi, go)) {
            assertNotNull(node.prompt, node.id + " prompt 为 null");
            assertNotNull(node.artifact, node.id + " artifact 为 null");
            assertNotNull(node.name, node.id + " name 为 null");
            assertNotNull(node.category, node.id + " category 为 null");
        }
    }

    private static void deleteRecursive(java.nio.file.Path dir) throws Exception {
        if (dir == null || !java.nio.file.Files.exists(dir)) return;
        try (var stream = java.nio.file.Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder())
                    .forEach(p -> { try { java.nio.file.Files.deleteIfExists(p); } catch (Exception ignored) {} });
        }
    }
}
