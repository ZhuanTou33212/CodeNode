package local.codenode;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class NodeControlApi {
    private final WorkflowModel model;
    private final Supplier<Path> projectRootSupplier;
    private final Supplier<WorkflowModel.Node> selectedNodeSupplier;
    private final Consumer<List<String>> selectNodesAction;
    private final Runnable repaintAction;
    private final Runnable saveAction;
    private final Runnable undoAction;
    private final Runnable redoAction;

    public NodeControlApi(WorkflowModel model, Supplier<Path> projectRootSupplier,
                          Supplier<WorkflowModel.Node> selectedNodeSupplier,
                          Consumer<List<String>> selectNodesAction,
                          Runnable repaintAction, Runnable saveAction,
                          Runnable undoAction, Runnable redoAction) {
        this.model = model;
        this.projectRootSupplier = projectRootSupplier;
        this.selectedNodeSupplier = selectedNodeSupplier;
        this.selectNodesAction = selectNodesAction;
        this.repaintAction = repaintAction;
        this.saveAction = saveAction;
        this.undoAction = undoAction;
        this.redoAction = redoAction;
    }

    public WorkflowModel.Node generateNode(int x, int y, String name, String category, String prompt,
                                           String valueType, int inputCount, int outputCount) {
        WorkflowModel.Node node = model.addNode(x, y);
        node.name = name == null ? "节点" : name;
        node.category = category == null ? "基础" : category;
        node.prompt = prompt == null ? "" : prompt;
        node.valueType = valueType == null ? "any" : valueType;
        node.inputs.clear();
        node.outputs.clear();
        for (int i = 0; i < inputCount; i++) {
            node.inputs.add(new WorkflowModel.Port("in" + (i + 1), "输入 " + (i + 1), node.valueType, false));
        }
        for (int i = 0; i < outputCount; i++) {
            node.outputs.add(new WorkflowModel.Port("out" + (i + 1), "输出 " + (i + 1), node.valueType, false));
        }
        model.touch();
        repaintAction.run();
        return node;
    }

    public WorkflowModel.Node generateAssetNode(int x, int y, String name, String relativePath, String assetType) {
        WorkflowModel.Node node = model.addAssetNode(x, y, name, relativePath,
                assetType == null ? NodeRegistry.classifyExtension(relativePath) : assetType);
        model.touch();
        repaintAction.run();
        return node;
    }

    public WorkflowModel.Node generateAssetBundleNode(int x, int y, String name, String bundleData, String assetType) {
        WorkflowModel.Node node = model.addAssetBundleNode(x, y, name, bundleData,
                assetType == null ? "image" : assetType);
        model.touch();
        repaintAction.run();
        return node;
    }

    public WorkflowModel.Node generateAssetBundleFromDirectory(int x, int y, String name, String directoryPath, String assetType) {
        Path root = projectRootSupplier.get();
        Path dir = root.resolve(directoryPath);
        if (!Files.isDirectory(dir)) return null;
        List<Map<String, String>> files = new ArrayList<>();
        try (var stream = Files.list(dir)) {
            for (Path file : stream.toList()) {
                if (Files.isRegularFile(file)) {
                    String rel = root.relativize(file).toString().replace('\\', '/');
                    String type = assetType != null ? assetType : NodeRegistry.classifyExtension(file.getFileName().toString());
                    files.add(Map.of("path", rel, "type", type));
                }
            }
        } catch (IOException ignored) {}
        StringBuilder json = new StringBuilder("{\"files\":[");
        for (int i = 0; i < files.size(); i++) {
            if (i > 0) json.append(",");
            Map<String, String> f = files.get(i);
            json.append("{\"path\":\"").append(escapeJson(f.get("path")))
                    .append("\",\"type\":\"").append(escapeJson(f.get("type"))).append("\"}");
        }
        json.append("]}");
        return generateAssetBundleNode(x, y, name, json.toString(), assetType != null ? assetType : "other");
    }

    public void moveNode(String nodeId, int x, int y) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null) { node.x = x; node.y = y; model.touch(); repaintAction.run(); }
    }

    public void moveNodes(Map<String, int[]> positions) {
        for (var entry : positions.entrySet()) {
            WorkflowModel.Node node = model.byId(entry.getKey());
            if (node != null) { node.x = entry.getValue()[0]; node.y = entry.getValue()[1]; }
        }
        model.touch();
        repaintAction.run();
    }

    public void setNodeValue(String nodeId, String field, String value) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        switch (field.toLowerCase(Locale.ROOT)) {
            case "name" -> node.name = value;
            case "prompt" -> node.prompt = value;
            case "artifact" -> node.artifact = value;
            case "category" -> node.category = value;
            case "relativepath" -> node.relativePath = value;
            case "assettype" -> node.assetType = value;
            case "bundledata" -> node.bundleData = value;
            case "nodecolor" -> node.nodeColor = value;
            case "valuetype" -> node.valueType = value;
            case "operation" -> node.operation = value;
            case "parentscopeid" -> node.parentScopeId = value;
            case "filenodeid" -> node.fileNodeId = value;
            case "scoperegion" -> node.scopeRegion = value;
            case "role" -> node.role = value;
            case "templateid" -> node.templateId = value;
            case "templatelanguage" -> node.templateLanguage = value;
            case "classificationkey" -> node.classificationKey = value;
            case "codebearing" -> node.codeBearing = Boolean.parseBoolean(value);
        }
        model.touch();
        repaintAction.run();
    }

    public void setNodeIntValue(String nodeId, String field, int value) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        switch (field.toLowerCase(Locale.ROOT)) {
            case "x" -> node.x = value;
            case "y" -> node.y = value;
            case "containerwidth" -> node.containerWidth = value;
            case "containerheight" -> node.containerHeight = value;
            case "nodewidth" -> node.nodeWidth = value;
            case "nodeheight" -> node.nodeHeight = value;
        }
        model.touch();
        repaintAction.run();
    }

    public void setNodeBoolValue(String nodeId, String field, boolean value) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        switch (field.toLowerCase(Locale.ROOT)) {
            case "collapsed" -> node.collapsed = value;
            case "muted" -> node.muted = value;
            case "rangemode" -> node.rangeMode = value;
            case "codebearing" -> node.codeBearing = value;
        }
        model.touch();
        repaintAction.run();
    }

    public void writeCode(String slotId, String code) {
        WorkflowModel.CodeSlot slot = model.codeSlot(slotId);
        if (slot == null) return;
        slot.activeCode = code;
        slot.activeRevision++;
        model.touch();
        repaintAction.run();
    }

    public void writeCodeForNode(String nodeId, String code) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        String slotId = node.nodeKind == WorkflowModel.NodeKind.FILE ? "file:" + nodeId :
                node.codeBearing ? "node:" + nodeId : "";
        if (!slotId.isBlank()) writeCode(slotId, code);
    }

    public void saveCode(String slotId) {
        WorkflowModel.CodeSlot slot = model.codeSlot(slotId);
        if (slot == null) return;
        slot.activeRevision++;
        model.touch();
        saveAction.run();
    }

    public String getCode(String slotId) {
        WorkflowModel.CodeSlot slot = model.codeSlot(slotId);
        return slot != null ? slot.activeCode : "";
    }

    public String getCodeForNode(String nodeId) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return "";
        String slotId = node.nodeKind == WorkflowModel.NodeKind.FILE ? "file:" + nodeId :
                node.codeBearing ? "node:" + nodeId : "";
        return getCode(slotId);
    }

    public void deleteNode(String nodeId) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null) { model.removeNode(node); repaintAction.run(); }
    }

    public void deleteNodes(List<String> nodeIds) {
        List<WorkflowModel.Node> nodes = nodeIds.stream().map(model::byId).filter(Objects::nonNull).toList();
        nodes.forEach(model::removeNode);
        if (!nodes.isEmpty()) repaintAction.run();
    }

    public void disconnectEdges(String sourceNodeId, String targetNodeId) {
        List<WorkflowModel.Edge> toRemove = model.edges().stream()
                .filter(e -> e.source().equals(sourceNodeId) && e.target().equals(targetNodeId)).toList();
        model.removeEdges(toRemove);
        if (!toRemove.isEmpty()) repaintAction.run();
    }

    public void disconnectAllEdges(String nodeId) {
        List<WorkflowModel.Edge> toRemove = model.edges().stream()
                .filter(e -> e.source().equals(nodeId) || e.target().equals(nodeId)).toList();
        model.removeEdges(toRemove);
        if (!toRemove.isEmpty()) repaintAction.run();
    }

    public WorkflowModel.Node duplicateNode(String nodeId, int offsetX, int offsetY) {
        WorkflowModel.Node source = model.byId(nodeId);
        if (source == null) return null;
        WorkflowModel.Node copy = model.duplicate(source, source.x + offsetX, source.y + offsetY);
        repaintAction.run();
        return copy;
    }

    public void toggleCollapsed(String nodeId) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null) { node.collapsed = !node.collapsed; model.touch(); repaintAction.run(); }
    }

    public void toggleMuted(String nodeId) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null) { node.muted = !node.muted; model.touch(); repaintAction.run(); }
    }

    public void clearGraph() {
        model.clear();
        repaintAction.run();
    }

    public void setNodeColor(String nodeId, String color) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null) { node.nodeColor = color; model.touch(); repaintAction.run(); }
    }

    public void setNodeType(String nodeId, String nodeKind) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        try {
            WorkflowModel.NodeKind kind = WorkflowModel.NodeKind.valueOf(nodeKind.toUpperCase(Locale.ROOT));
            node.nodeKind = kind;
            model.touch();
            repaintAction.run();
        } catch (IllegalArgumentException ignored) {}
    }

    public void setNodeMode(String nodeId, boolean rangeMode) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node != null && node.nodeKind == WorkflowModel.NodeKind.FILE) {
            if (node.rangeMode != rangeMode) model.toggleFileNodeMode(node);
            repaintAction.run();
        }
    }

    public void groupNodes(List<String> nodeIds, String groupName) {
        int minX=Integer.MAX_VALUE,minY=Integer.MAX_VALUE;
        List<WorkflowModel.Node> nodes=nodeIds.stream().map(model::byId).filter(Objects::nonNull).toList();
        for(WorkflowModel.Node n:nodes){if(n.x<minX)minX=n.x;if(n.y<minY)minY=n.y;}
        WorkflowModel.Node group=model.addGroupNode(minX-20,minY-40,groupName==null?"节点组":groupName);
        WorkflowModel.Node gi=model.addGroupInputNode(group.x+30,group.y+60,"节点组输入");
        gi.parentScopeId=group.id;
        WorkflowModel.Node go=model.addNodeGroupOutput(group.x+30,group.y+120,"节点组输出");
        go.parentScopeId=group.id;
        for(WorkflowModel.Node n:nodes){n.parentScopeId=group.id;n.x=n.x-minX+20;n.y=n.y-minY+20;}
        model.touch();repaintAction.run();
    }

    public void ungroup(String groupNodeId) {
        WorkflowModel.Node group = model.byId(groupNodeId);
        if (group == null || group.nodeKind != WorkflowModel.NodeKind.GROUP) return;
        List<WorkflowModel.Node> children = model.nodes().stream()
                .filter(n -> n.parentScopeId.equals(groupNodeId)).toList();
        int baseX = group.x, baseY = group.y;
        for (WorkflowModel.Node child : children) {
            if(child.nodeKind==WorkflowModel.NodeKind.GROUP_INPUT||child.nodeKind==WorkflowModel.NodeKind.GROUP_OUTPUT){
                model.removeNode(child);continue;
            }
            child.parentScopeId = "";
            child.x = baseX + child.x - 20;
            child.y = baseY + child.y - 20;
        }
        model.removeNode(group);
        model.touch();
        repaintAction.run();
    }

    public void setNodeStatus(String nodeId, String statusName) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return;
        try {
            node.status = WorkflowModel.Status.valueOf(statusName.toUpperCase(Locale.ROOT));
            model.touch();
            repaintAction.run();
        } catch (IllegalArgumentException ignored) {}
    }

    public void connectNodes(String sourceId, String sourcePortId, String targetId, String targetPortId) {
        WorkflowModel.Node source = model.byId(sourceId);
        WorkflowModel.Node target = model.byId(targetId);
        if (source == null || target == null) return;
        WorkflowModel.Port sp = model.output(source, sourcePortId);
        WorkflowModel.Port tp = model.input(target, targetPortId);
        if (sp != null && tp != null) model.connect(source, sp, target, tp);
        repaintAction.run();
    }

    public void expandAssetBundle(String bundleNodeId) {
        WorkflowModel.Node node = model.byId(bundleNodeId);
        if (node != null) model.expandAssetBundle(node);
        repaintAction.run();
    }

    public void selectNode(String nodeId) {
        selectNodesAction.accept(nodeId == null || nodeId.isBlank() ? List.of() : List.of(nodeId));
    }

    public void selectNodes(List<String> nodeIds) {
        selectNodesAction.accept(nodeIds == null ? List.of() : nodeIds);
    }

    public WorkflowModel.Node getSelectedNode() {
        return selectedNodeSupplier.get();
    }

    public void undo() {
        undoAction.run();
        repaintAction.run();
    }

    public void redo() {
        redoAction.run();
        repaintAction.run();
    }

    public void saveProject() {
        saveAction.run();
    }

    public Map<String, Object> getNodeState(String nodeId) {
        WorkflowModel.Node node = model.byId(nodeId);
        if (node == null) return Map.of();
        LinkedHashMap<String, Object> state = new LinkedHashMap<>();
        state.put("id", node.id); state.put("name", node.name); state.put("category", node.category);
        state.put("nodeKind", node.nodeKind.name()); state.put("valueType", node.valueType);
        state.put("status", node.status.name()); state.put("x", node.x); state.put("y", node.y);
        state.put("nodeColor", node.nodeColor); state.put("rangeMode", node.rangeMode);
        state.put("assetType", node.assetType); state.put("relativePath", node.relativePath);
        return state;
    }

    public List<Map<String, Object>> getAllNodeStates() {
        return model.nodes().stream().map(n -> getNodeState(n.id)).toList();
    }

    public Map<String, Object> getGraphState() {
        return Map.of(
                "nodeCount", model.nodes().size(),
                "edgeCount", model.edges().size(),
                "revision", model.revision()
        );
    }

    public void batchExecute(List<Map<String, Object>> commands) {
        for (Map<String, Object> cmd : commands) {
            String action = String.valueOf(cmd.getOrDefault("action", ""));
            switch (action) {
                case "generateNode" -> {
                    int x = ((Number) cmd.getOrDefault("x", 0)).intValue();
                    int y = ((Number) cmd.getOrDefault("y", 0)).intValue();
                    generateNode(x, y, str(cmd, "name"), str(cmd, "category"), str(cmd, "prompt"),
                            str(cmd, "valueType"), ((Number) cmd.getOrDefault("inputCount", 1)).intValue(),
                            ((Number) cmd.getOrDefault("outputCount", 1)).intValue());
                }
                case "generateAssetNode" -> generateAssetNode(
                        ((Number) cmd.getOrDefault("x", 0)).intValue(),
                        ((Number) cmd.getOrDefault("y", 0)).intValue(),
                        str(cmd, "name"), str(cmd, "relativePath"), str(cmd, "assetType"));
                case "generateAssetBundleNode" -> generateAssetBundleNode(
                        ((Number) cmd.getOrDefault("x", 0)).intValue(),
                        ((Number) cmd.getOrDefault("y", 0)).intValue(),
                        str(cmd, "name"), str(cmd, "bundleData"), str(cmd, "assetType"));
                case "generateAssetBundleFromDirectory" -> generateAssetBundleFromDirectory(
                        ((Number) cmd.getOrDefault("x", 0)).intValue(),
                        ((Number) cmd.getOrDefault("y", 0)).intValue(),
                        str(cmd, "name"), str(cmd, "directoryPath"), str(cmd, "assetType"));
                case "moveNode" -> {
                    String id = str(cmd, "nodeId");
                    int x = ((Number) cmd.getOrDefault("x", 0)).intValue();
                    int y = ((Number) cmd.getOrDefault("y", 0)).intValue();
                    moveNode(id, x, y);
                }
                case "setNodeValue" -> setNodeValue(str(cmd, "nodeId"), str(cmd, "field"), str(cmd, "value"));
                case "setNodeIntValue" -> setNodeIntValue(str(cmd, "nodeId"), str(cmd, "field"), ((Number) cmd.getOrDefault("value", 0)).intValue());
                case "setNodeBoolValue" -> setNodeBoolValue(str(cmd, "nodeId"), str(cmd, "field"), Boolean.parseBoolean(str(cmd, "value")));
                case "writeCode" -> writeCode(str(cmd, "slotId"), str(cmd, "code"));
                case "writeCodeForNode" -> writeCodeForNode(str(cmd, "nodeId"), str(cmd, "code"));
                case "saveCode" -> saveCode(str(cmd, "slotId"));
                case "getCode" -> { /* 需要在 batch 外处理 */ }
                case "setNodeColor" -> setNodeColor(str(cmd, "nodeId"), str(cmd, "color"));
                case "setNodeType" -> setNodeType(str(cmd, "nodeId"), str(cmd, "nodeKind"));
                case "setNodeMode" -> setNodeMode(str(cmd, "nodeId"), Boolean.parseBoolean(str(cmd, "rangeMode")));
                case "setNodeStatus" -> setNodeStatus(str(cmd, "nodeId"), str(cmd, "status"));
                case "groupNodes" -> {
                    @SuppressWarnings("unchecked")
                    List<String> ids = (List<String>) cmd.getOrDefault("nodeIds", List.of());
                    groupNodes(ids, str(cmd, "groupName"));
                }
                case "ungroup" -> ungroup(str(cmd, "nodeId"));
                case "deleteNode" -> deleteNode(str(cmd, "nodeId"));
                case "deleteNodes" -> {
                    @SuppressWarnings("unchecked")
                    List<String> ids = (List<String>) cmd.getOrDefault("nodeIds", List.of());
                    deleteNodes(ids);
                }
                case "duplicateNode" -> duplicateNode(str(cmd, "nodeId"),
                        ((Number) cmd.getOrDefault("offsetX", 30)).intValue(),
                        ((Number) cmd.getOrDefault("offsetY", 30)).intValue());
                case "connectNodes" -> connectNodes(str(cmd, "sourceId"), str(cmd, "sourcePortId"),
                        str(cmd, "targetId"), str(cmd, "targetPortId"));
                case "disconnectEdges" -> disconnectEdges(str(cmd, "sourceNodeId"), str(cmd, "targetNodeId"));
                case "disconnectAllEdges" -> disconnectAllEdges(str(cmd, "nodeId"));
                case "toggleCollapsed" -> toggleCollapsed(str(cmd, "nodeId"));
                case "toggleMuted" -> toggleMuted(str(cmd, "nodeId"));
                case "selectNode" -> selectNode(str(cmd, "nodeId"));
                case "selectNodes" -> {
                    @SuppressWarnings("unchecked")
                    List<String> ids = (List<String>) cmd.getOrDefault("nodeIds", List.of());
                    selectNodes(ids);
                }
                case "expandAssetBundle" -> expandAssetBundle(str(cmd, "nodeId"));
                case "undo" -> undo();
                case "redo" -> redo();
                case "clearGraph" -> clearGraph();
                case "save" -> saveProject();
            }
        }
        repaintAction.run();
    }

    private static String str(Map<String, Object> map, String key) {
        return String.valueOf(map.getOrDefault(key, ""));
    }

    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
