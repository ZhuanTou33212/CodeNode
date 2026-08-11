/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import local.codenode.Json;
import local.codenode.util.BundleDataUtil;

public final class WorkflowModel {
    private final List<Node> nodes = new ArrayList<Node>();
    private final Map<String, Node> nodeIndex = new HashMap<String, Node>();
    private final List<Edge> edges = new ArrayList<Edge>();
    private final LinkedHashMap<String, CodeSlot> codeSlots = new LinkedHashMap();
    private final LinkedHashMap<String, VirtualFileSpace> fileSpaces = new LinkedHashMap();
    private int sequence = 1;
    private long revision;

    public List<Node> nodes() {
        return Collections.unmodifiableList(this.nodes);
    }

    public List<Edge> edges() {
        return Collections.unmodifiableList(this.edges);
    }

    public Collection<CodeSlot> codeSlots() {
        return Collections.unmodifiableCollection(this.codeSlots.values());
    }

    public CodeSlot codeSlot(String id) {
        return this.codeSlots.get(id);
    }

    public long revision() {
        return this.revision;
    }

    public void touch() {
        ++this.revision;
    }

    public List<Reroute> reroutes() {
        LinkedHashMap points = new LinkedHashMap();
        this.edges.forEach(e -> e.reroutes.forEach(p -> points.putIfAbsent(p.id, p)));
        return List.copyOf(points.values());
    }

    public Reroute rerouteById(String id) {
        return this.reroutes().stream().filter(point -> point.id.equals(id)).findFirst().orElse(null);
    }

    public Node addNode(int x, int y) {
        String id = "node-" + String.valueOf(UUID.randomUUID());
        ++this.sequence;
        Node node = new Node(id, "节点 " + (this.sequence - 1), x, y);
        this.nodes.add(node);
        this.nodeIndex.put(node.id, node);
        this.ensureNodeSlot(node);
        this.touch();
        return node;
    }

    public Node forceAddNode(String id, String name, int x, int y) {
        Node node = new Node(id, name, x, y);
        this.nodes.add(node);
        this.nodeIndex.put(node.id, node);
        this.ensureNodeSlot(node);
        this.touch();
        return node;
    }

    public Node addGroupOutput(int x, int y, String name) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "组输出" : name;
        node.nodeKind = NodeKind.GROUP_OUTPUT;
        node.category = "输入与输出";
        node.classificationKey = "io.group-output";
        node.codeBearing = false;
        node.inputs.clear();
        node.inputs.add(new Port("group", "代码组", "flow", true));
        node.outputs.clear();
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addFileNode(int x, int y, String name, String relativePath) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "文件" : name;
        node.nodeKind = NodeKind.FILE;
        node.category = "文件";
        node.classificationKey = "file.source";
        node.codeBearing = false;
        node.relativePath = relativePath == null ? "" : relativePath;
        node.inputs.clear();
        node.inputs.add(new Port("imports", "导入", "module", false));
        node.outputs.clear();
        node.outputs.add(new Port("exports", "导出", "module", false));
        this.codeSlots.remove("node:" + node.id);
        this.ensureFileSlot(node);
        this.touch();
        return node;
    }

    public Node addAssetNode(int x, int y, String name, String relativePath, String assetType) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "资源" : name;
        node.nodeKind = NodeKind.ASSET;
        node.category = "资产";
        node.classificationKey = "asset." + assetType;
        node.codeBearing = false;
        node.relativePath = relativePath == null ? "" : relativePath;
        node.assetType = assetType;
        node.inputs.clear();
        node.inputs.add(new Port("reference", "引用", "string", false));
        node.outputs.clear();
        node.outputs.add(new Port("resource", "资源", "module", false));
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addAssetBundleNode(int x, int y, String name, String bundleData, String assetType) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "资源组" : name;
        node.nodeKind = NodeKind.ASSET_BUNDLE;
        node.category = "资产组";
        node.classificationKey = "asset." + assetType;
        node.codeBearing = false;
        node.bundleData = bundleData == null ? "" : bundleData;
        node.assetType = assetType;
        node.inputs.clear();
        node.inputs.add(new Port("reference", "引用", "string", false));
        node.outputs.clear();
        node.outputs.add(new Port("resources", "资源组", "module", false));
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addGroupNode(int x, int y, String name) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "节点组" : name;
        node.nodeKind = NodeKind.GROUP;
        node.category = "节点组";
        node.classificationKey = "scope.group";
        node.codeBearing = false;
        node.containerWidth = 640;
        node.containerHeight = 400;
        node.inputs.clear();
        node.outputs.clear();
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addCaptureNode(int x, int y, String name) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "捕获" : name;
        node.nodeKind = NodeKind.CAPTURE;
        node.category = "捕获";
        node.classificationKey = "io.capture";
        node.codeBearing = false;
        node.inputs.clear();
        node.inputs.add(new Port("capture", "捕获", "any", false));
        node.outputs.clear();
        node.outputs.add(new Port("value", "值", "any", false));
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addGroupInputNode(int x, int y, String name) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "节点组输入" : name;
        node.nodeKind = NodeKind.GROUP_INPUT;
        node.category = "节点组";
        node.classificationKey = "io.node-group-input";
        node.codeBearing = false;
        node.inputs.clear();
        node.outputs.clear();
        node.outputs.add(new Port("value", "值", "any", false));
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public Node addNodeGroupOutput(int x, int y, String name) {
        Node node = this.addNode(x, y);
        node.name = name == null || name.isBlank() ? "节点组输出" : name;
        node.nodeKind = NodeKind.GROUP_OUTPUT;
        node.category = "节点组";
        node.classificationKey = "io.node-group-output";
        node.codeBearing = false;
        node.inputs.clear();
        node.inputs.add(new Port("value", "值", "any", true));
        node.outputs.clear();
        this.codeSlots.remove("node:" + node.id);
        this.touch();
        return node;
    }

    public List<Node> expandAssetBundle(Node bundleNode) {
        if (bundleNode.nodeKind != NodeKind.ASSET_BUNDLE || bundleNode.bundleData.isBlank()) {
            return List.of();
        }
        ArrayList<Node> created = new ArrayList<Node>();
        HashMap<String, String> memberIdToNewNodeId = new HashMap<String, String>();
        try {
            Map<String, Object> manifest = Json.object(bundleNode.bundleData);
            Object membersRaw = manifest.get("members");
            if (membersRaw instanceof List) {
                List members = (List)membersRaw;
                int index = 0;
                for (Object item : members) {
                    Object nameObj;
                    Object idObj;
                    String memberId;
                    String category;
                    Map member;
                    Object relObj;
                    String rel;
                    if (!(item instanceof Map) || (rel = (relObj = (member = (Map)item).get("relativePath")) == null ? "" : String.valueOf(relObj)).isBlank() || "null".equals(rel)) continue;
                    Object catObj = member.get("category");
                    String string = category = catObj == null ? "other" : String.valueOf(catObj);
                    if ("null".equals(category)) {
                        category = "other";
                    }
                    String string2 = memberId = (idObj = member.get("id")) == null ? "" : String.valueOf(idObj);
                    if ("null".equals(memberId)) {
                        memberId = "";
                    }
                    String name = (nameObj = member.get("name")) == null || "null".equals(String.valueOf(nameObj)) ? WorkflowModel.bundleFileName(rel) : String.valueOf(nameObj);
                    String assetType = BundleDataUtil.assetTypeForCategory(category);
                    Node asset = this.addAssetNode(bundleNode.x + 40 + index * 40, bundleNode.y + 60, name, rel, assetType);
                    asset.fileNodeId = bundleNode.id;
                    created.add(asset);
                    if (!memberId.isBlank()) {
                        memberIdToNewNodeId.put(memberId, asset.id);
                    }
                    ++index;
                }
            } else {
                Object files = manifest.get("files");
                if (files instanceof List) {
                    List list = (List)files;
                    for (Object item : list) {
                        String type;
                        if (!(item instanceof Map)) continue;
                        Map fileMap = (Map)item;
                        Object relObj = fileMap.get("path");
                        Object typeObj = fileMap.get("type");
                        String rel = relObj == null ? "" : String.valueOf(relObj);
                        String string = type = typeObj == null ? "" : String.valueOf(typeObj);
                        if (rel.isBlank() || "null".equals(rel) || type.isBlank() || "null".equals(type)) continue;
                        Node asset = this.addAssetNode(bundleNode.x + 40 + created.size() * 40, bundleNode.y + 60, WorkflowModel.bundleFileName(rel), rel, type);
                        asset.fileNodeId = bundleNode.id;
                        created.add(asset);
                    }
                }
            }
            this.migrateConnectionsOnExpand(bundleNode, memberIdToNewNodeId);
            this.nodes.remove(bundleNode);
            this.nodeIndex.remove(bundleNode.id);
            this.codeSlots.remove("file:" + bundleNode.id);
        }
        catch (Exception exception) {
            // empty catch block
        }
        this.touch();
        return created;
    }

    private static String bundleFileName(String relativePath) {
        if (relativePath == null) {
            return "";
        }
        int slash = relativePath.lastIndexOf(47);
        return slash < 0 ? relativePath : relativePath.substring(slash + 1);
    }

    public void migrateConnectionsOnExpand(Node bundleNode, Map<String, String> memberIdToNewNodeId) {
        if (bundleNode == null || memberIdToNewNodeId == null) {
            return;
        }
        for (Node node : this.nodes) {
            String target;
            if (!bundleNode.id.equals(node.groupInputNodeId)) continue;
            node.memberBinding = null;
            node.groupInputNodeId = target = memberIdToNewNodeId.values().stream().findFirst().orElse("");
            if (!target.isEmpty()) continue;
            System.out.println("[expandAssetBundle] 下游 groupInputNodeId 无法匹配成员，已置空: node=" + node.id);
        }
    }

    public Node ungroupAssetBundleToGroup(Node bundleNode) {
        if (bundleNode == null || bundleNode.nodeKind != NodeKind.ASSET_BUNDLE) {
            return null;
        }
        int x = bundleNode.x;
        int y = bundleNode.y;
        String name = bundleNode.name;
        String relPath = bundleNode.relativePath;
        String bundleData = bundleNode.bundleData;
        String downstreamRef = bundleNode.groupInputNodeId;
        bundleNode.nodeKind = NodeKind.GROUP;
        bundleNode.category = "节点组";
        bundleNode.classificationKey = "scope.group";
        bundleNode.codeBearing = false;
        bundleNode.role = "folder";
        bundleNode.containerWidth = 640;
        bundleNode.containerHeight = 400;
        bundleNode.relativePath = relPath;
        bundleNode.inputs.clear();
        bundleNode.outputs.clear();
        bundleNode.inputs.add(new Port("grp_in_value", "组输入", "any", false));
        bundleNode.outputs.add(new Port("grp_out_value", "组输出", "any", false));
        Node gi = this.addGroupInputNode(x + 30, y + 40, name + " 组输入");
        gi.parentScopeId = bundleNode.id;
        Node go = this.addNodeGroupOutput(x + 300, y + 40, name + " 组输出");
        go.parentScopeId = bundleNode.id;
        bundleNode.groupInputNodeId = gi.id;
        List<String> members = WorkflowModel.parseBundleMemberPaths(bundleData);
        for (int i = 0; i < members.size(); ++i) {
            Port in;
            String rel = members.get(i);
            if (rel.isBlank()) continue;
            String category = BundleDataUtil.categorizeAssetPath(rel);
            String assetType = BundleDataUtil.assetTypeForCategory(category);
            Node asset = this.addAssetNode(x + 40 + i % 2 * 200, y + 120 + i / 2 * 90, BundleDataUtil.nameOf(rel), rel, assetType);
            asset.parentScopeId = bundleNode.id;
            asset.fileNodeId = bundleNode.id;
            Port from = this.output(asset, "resource");
            Port port = in = i == 0 ? this.input(go, "value") : this.addPort(go, false);
            if (in != null) {
                in.name = BundleDataUtil.nameOf(rel);
            }
            if (from == null || in == null) continue;
            this.connect(asset, from, go, in);
        }
        if (!downstreamRef.isBlank()) {
            bundleNode.groupInputNodeId = downstreamRef;
        }
        this.touch();
        return bundleNode;
    }

    private static List<String> parseBundleMemberPaths(String bundleData) {
        ArrayList<String> out = new ArrayList<String>();
        if (bundleData == null || bundleData.isBlank()) {
            return out;
        }
        try {
            Map<String, Object> root = Json.object(bundleData);
            Object raw = root.get("members");
            if (raw instanceof List) {
                List members = (List)raw;
                for (Object item : members) {
                    Map m;
                    Object rel;
                    String value;
                    if (!(item instanceof Map) || (value = (rel = (m = (Map)item).get("relativePath")) == null ? "" : String.valueOf(rel)).isBlank() || "null".equals(value)) continue;
                    out.add(value);
                }
                return out;
            }
            raw = root.get("files");
            if (raw instanceof List) {
                List files = (List)raw;
                for (Object item : files) {
                    Map m;
                    Object rel;
                    String value;
                    if (!(item instanceof Map) || (value = (rel = (m = (Map)item).get("path")) == null ? "" : String.valueOf(rel)).isBlank() || "null".equals(value)) continue;
                    out.add(value);
                }
            }
        }
        catch (Exception exception) {
            // empty catch block
        }
        return out;
    }

    public void toggleFileNodeMode(Node node) {
        if (node.nodeKind != NodeKind.FILE) {
            return;
        }
        boolean wasRange = node.rangeMode;
        boolean bl = node.rangeMode = !node.rangeMode;
        if (wasRange && !node.rangeMode) {
            List<Node> children = this.nodes.stream().filter(n -> n.fileNodeId.equals(node.id)).toList();
            for (Node child : children) {
                child.fileNodeId = "";
            }
        }
        this.touch();
    }

    public boolean connect(Node source, Node target) {
        return this.connect(source, source.outputs.getFirst(), target, target.inputs.getFirst());
    }

    public boolean connect(Node source, Port sourcePort, Node target, Port targetPort) {
        return this.connectChecked(source, sourcePort, target, targetPort).connected();
    }

    public boolean connectNoRecompute(Node source, Port sourcePort, Node target, Port targetPort) {
        if (source == null || sourcePort == null || target == null || targetPort == null) {
            return false;
        }
        if (!(this.nodes.contains(source) && this.nodes.contains(target) && source.outputs.contains(sourcePort) && target.inputs.contains(targetPort))) {
            return false;
        }
        if (source == target) {
            return false;
        }
        this.edges.removeIf(e -> e.target.equals(target.id) && e.targetPort.equals(targetPort.id));
        this.edges.add(new Edge("edge-" + source.id + "-" + sourcePort.id + "-" + target.id + "-" + targetPort.id, source.id, sourcePort.id, target.id, targetPort.id));
        return true;
    }

    public ConnectionResult connectChecked(Node source, Port sourcePort, Node target, Port targetPort) {
        String inputType;
        if (source == null || sourcePort == null || target == null || targetPort == null) {
            return WorkflowModel.rejected("节点或端口不存在");
        }
        if (!(this.nodes.contains(source) && this.nodes.contains(target) && source.outputs.contains(sourcePort) && target.inputs.contains(targetPort))) {
            return WorkflowModel.rejected("只能从输出端口连接到输入端口");
        }
        if (source == target) {
            return WorkflowModel.rejected("不能连接节点自身");
        }
        if (this.edges.stream().anyMatch(e -> e.source.equals(source.id) && e.sourcePort.equals(sourcePort.id) && e.target.equals(target.id) && e.targetPort.equals(targetPort.id))) {
            return WorkflowModel.rejected("该连线已经存在");
        }
        String outputType = WorkflowModel.normalizedType(sourcePort.dataType);
        if (!WorkflowModel.compatible(outputType, inputType = WorkflowModel.normalizedType(targetPort.declaredType))) {
            return WorkflowModel.rejected("类型不兼容（" + outputType + " → " + inputType + "）");
        }
        this.edges.removeIf(e -> e.target.equals(target.id) && e.targetPort.equals(targetPort.id));
        this.edges.add(new Edge("edge-" + source.id + "-" + sourcePort.id + "-" + target.id + "-" + targetPort.id, source.id, sourcePort.id, target.id, targetPort.id));
        this.recomputeTypes();
        this.touch();
        return new ConnectionResult(true, "连接成功");
    }

    public void removeEdges(Collection<Edge> removed) {
        if (this.edges.removeAll(removed)) {
            this.recomputeTypes();
            this.touch();
        }
    }

    /** Removes many nodes in one transaction: one edge sweep, one reference sweep and one type recomputation. */
    public void removeNodes(Collection<Node> removed) {
        if (removed == null || removed.isEmpty()) return;
        LinkedHashSet<String> ids = removed.stream().filter(Objects::nonNull).map(n -> n.id).collect(Collectors.toCollection(LinkedHashSet::new));
        if (ids.isEmpty()) return;
        boolean changed = this.nodes.removeIf(n -> ids.contains(n.id));
        if (!changed) return;
        ids.forEach(this.nodeIndex::remove);
        this.edges.removeIf(e -> ids.contains(e.source) || ids.contains(e.target));
        this.codeSlots.keySet().removeIf(key -> ids.stream().anyMatch(id -> key.equals("node:" + id) || key.equals("file:" + id)));
        this.nodes.forEach(n -> {
            if (ids.contains(n.fileNodeId)) n.fileNodeId = "";
            if (ids.contains(n.parentScopeId)) n.parentScopeId = "";
        });
        this.recomputeTypes();
        this.touch();
    }
    public void removeNode(Node node) {
        if (this.nodes.remove(node)) {
            this.nodeIndex.remove(node.id);
            this.edges.removeIf(e -> e.source.equals(node.id) || e.target.equals(node.id));
            this.codeSlots.remove("node:" + node.id);
            this.codeSlots.remove("file:" + node.id);
            this.nodes.forEach(n -> {
                if (n.fileNodeId.equals(node.id)) {
                    n.fileNodeId = "";
                }
                if (n.parentScopeId.equals(node.id)) {
                    n.parentScopeId = "";
                }
            });
            this.recomputeTypes();
            this.touch();
        }
    }

    public void removePort(Node node, Port port, boolean output) {
        if ((output ? node.outputs : node.inputs).remove(port)) {
            this.edges.removeIf(e -> output ? e.source.equals(node.id) && e.sourcePort.equals(port.id) : e.target.equals(node.id) && e.targetPort.equals(port.id));
            this.recomputeTypes();
            this.touch();
        }
    }

    public int replacePorts(Node node, List<Port> inputs, List<Port> outputs) {
        Set inputIds = inputs.stream().map(p -> p.id).collect(Collectors.toSet());
        Set outputIds = outputs.stream().map(p -> p.id).collect(Collectors.toSet());
        int before = this.edges.size();
        node.inputs.clear();
        node.inputs.addAll(inputs);
        node.outputs.clear();
        node.outputs.addAll(outputs);
        this.edges.removeIf(edge -> edge.target.equals(node.id) && !inputIds.contains(edge.targetPort) || edge.source.equals(node.id) && !outputIds.contains(edge.sourcePort));
        this.edges.removeIf(edge -> {
            Node source = this.byId(edge.source);
            Node target = this.byId(edge.target);
            Port from = source == null ? null : this.output(source, edge.sourcePort);
            Port to = target == null ? null : this.input(target, edge.targetPort);
            return from == null || to == null || !WorkflowModel.compatible(WorkflowModel.normalizedType(from.dataType), WorkflowModel.normalizedType(to.declaredType));
        });
        this.recomputeTypes();
        this.touch();
        return before - this.edges.size();
    }

    public Port addPort(Node node, boolean output) {
        List<Port> ports = output ? node.outputs : node.inputs;
        String prefix = output ? "out" : "in";
        int index = 1;
        while (WorkflowModel.hasPort(ports, prefix + index)) {
            ++index;
        }
        Port port = new Port(prefix + index, output ? "输出 " + index : "输入 " + index, "any", false);
        ports.add(port);
        this.touch();
        return port;
    }

    private static boolean hasPort(List<Port> ports, String id) {
        return ports.stream().anyMatch(p -> p.id.equals(id));
    }

    public Node duplicate(Node source, int x, int y) {
        Node copy = this.addNode(x, y);
        WorkflowModel.copyNodeFields(source, copy);
        copy.name = source.name + " 副本";
        copy.parentScopeId = "";
        copy.fileNodeId = "";
        if (!copy.codeBearing) {
            this.codeSlots.remove("node:" + copy.id);
        }
        if (copy.nodeKind == NodeKind.FILE) {
            this.ensureFileSlot(copy);
        }
        this.touch();
        return copy;
    }

    public Node byId(String id) {
        return this.nodeIndex.get(id);
    }

    public Port input(Node node, String id) {
        return node.inputs.stream().filter(p -> p.id.equals(id)).findFirst().orElse(null);
    }

    public Port output(Node node, String id) {
        return node.outputs.stream().filter(p -> p.id.equals(id)).findFirst().orElse(null);
    }

    public void replaceContents(Collection<Node> replacementNodes, Collection<Edge> replacementEdges) {
        this.replaceContents(replacementNodes, replacementEdges, List.of(), 0L);
    }

    public void replaceContents(Collection<Node> replacementNodes, Collection<Edge> replacementEdges, Collection<CodeSlot> replacementSlots, long graphRevision) {
        this.nodes.clear();
        this.nodeIndex.clear();
        this.edges.clear();
        this.codeSlots.clear();
        this.fileSpaces.clear();
        this.nodes.addAll(replacementNodes);
        replacementNodes.forEach(n -> this.nodeIndex.put(n.id, (Node)n));
        this.edges.addAll(replacementEdges);
        replacementSlots.forEach(slot -> this.codeSlots.put(slot.id, (CodeSlot)slot));
        this.nodes.stream().filter(n -> n.codeBearing).forEach(this::ensureNodeSlot);
        this.nodes.stream().filter(n -> n.nodeKind == NodeKind.FILE).forEach(this::ensureFileSlot);
        this.sequence = this.nodes.size() + 1;
        this.revision = graphRevision;
        this.recomputeTypes();
        this.refreshFileSpaces();
    }

    public WorkflowModel deepCopy() {
        WorkflowModel copy = new WorkflowModel();
        List<Node> copiedNodes = this.nodes.stream().map(WorkflowModel::copyNode).toList();
        HashMap<String, Reroute> points = new HashMap<String, Reroute>();
        ArrayList<Edge> copiedEdges = new ArrayList<Edge>();
        for (Edge edge : this.edges) {
            ArrayList<Reroute> copiedPoints = new ArrayList<Reroute>();
            for (Reroute point : edge.reroutes) {
                copiedPoints.add(points.computeIfAbsent(point.id, id -> new Reroute((String)id, point.x, point.y)));
            }
            copiedEdges.add(new Edge(edge.id, edge.source, edge.sourcePort, edge.target, edge.targetPort, copiedPoints));
        }
        List<CodeSlot> copiedSlots = this.codeSlots.values().stream().map(WorkflowModel::copySlot).toList();
        copy.replaceContents(copiedNodes, copiedEdges, copiedSlots, this.revision);
        return copy;
    }

    public void replaceFrom(WorkflowModel source) {
        WorkflowModel copy = source.deepCopy();
        this.replaceContents(copy.nodes, copy.edges, copy.codeSlots.values(), copy.revision);
    }

    public void applyRuntimeFrom(WorkflowModel source) {
        Object other;
        for (Node node : this.nodes) {
            other = source.byId(node.id);
            if (other == null) continue;
            node.status = ((Node)other).status;
            node.diagnostic = ((Node)other).diagnostic;
            node.classificationKey = ((Node)other).classificationKey;
            node.category = ((Node)other).category;
        }
        for (CodeSlot slot : this.codeSlots.values()) {
            other = source.codeSlot(slot.id);
            if (other == null) continue;
            slot.language = ((CodeSlot)other).language;
            slot.activeRevision = ((CodeSlot)other).activeRevision;
            slot.activeCode = ((CodeSlot)other).activeCode;
            slot.previousCode = ((CodeSlot)other).previousCode;
            slot.previousSourceRevision = ((CodeSlot)other).previousSourceRevision;
            slot.lastAppliedRequestId = ((CodeSlot)other).lastAppliedRequestId;
            slot.draft = ((CodeSlot)other).draft == null ? null : new CodeDraft(((CodeSlot)other).draft.requestId, ((CodeSlot)other).draft.baseRevision, ((CodeSlot)other).draft.code, ((CodeSlot)other).draft.classificationKey);
        }
        this.revision = source.revision;
    }

    private static Node copyNode(Node source) {
        Node copy = new Node(source.id, source.name, source.x, source.y);
        WorkflowModel.copyNodeFields(source, copy);
        return copy;
    }

    private static void copyNodeFields(Node source, Node copy) {
        copy.prompt = source.prompt;
        copy.artifact = source.artifact;
        copy.category = source.category;
        copy.templateLibrary = source.templateLibrary;
        copy.templateId = source.templateId;
        copy.templateVersion = source.templateVersion;
        copy.templateLanguage = source.templateLanguage;
        copy.nodeKind = source.nodeKind;
        copy.valueType = source.valueType;
        copy.operation = source.operation;
        copy.classificationKey = source.classificationKey;
        copy.codeBearing = source.codeBearing;
        copy.parentScopeId = source.parentScopeId;
        copy.scopeRegion = source.scopeRegion;
        copy.fileNodeId = source.fileNodeId;
        copy.relativePath = source.relativePath;
        copy.role = source.role;
        copy.containerWidth = source.containerWidth;
        copy.containerHeight = source.containerHeight;
        copy.collapsed = source.collapsed;
        copy.muted = source.muted;
        copy.detailMode = source.detailMode;
        copy.rangeMode = source.rangeMode;
        copy.nodeColor = source.nodeColor;
        copy.assetType = source.assetType;
        copy.bundleData = source.bundleData;
        copy.groupInputNodeId = source.groupInputNodeId;
        copy.bundleCollapsed = source.bundleCollapsed;
        copy.memberBinding = source.memberBinding;
        copy.nodeWidth = source.nodeWidth;
        copy.nodeHeight = source.nodeHeight;
        copy.status = source.status;
        copy.diagnostic = source.diagnostic;
        copy.inputs.clear();
        copy.outputs.clear();
        source.inputs.forEach(p -> copy.inputs.add(new Port(p.id, p.name, p.declaredType, p.dataType, p.required)));
        source.outputs.forEach(p -> copy.outputs.add(new Port(p.id, p.name, p.declaredType, p.dataType, p.required)));
    }

    private static CodeSlot copySlot(CodeSlot source) {
        CodeSlot copy = new CodeSlot(source.id, source.ownerKind, source.ownerId);
        copy.language = source.language;
        copy.activeRevision = source.activeRevision;
        copy.activeCode = source.activeCode;
        copy.previousCode = source.previousCode;
        copy.previousSourceRevision = source.previousSourceRevision;
        copy.lastAppliedRequestId = source.lastAppliedRequestId;
        copy.draft = source.draft == null ? null : new CodeDraft(source.draft.requestId, source.draft.baseRevision, source.draft.code, source.draft.classificationKey);
        return copy;
    }

    public Reroute addReroute(Edge edge, int x, int y) {
        Reroute point = new Reroute(x, y);
        edge.reroutes.add(point);
        return point;
    }

    public void removeReroute(Edge edge, Reroute point) {
        edge.reroutes.remove(point);
    }

    public void removeReroute(Reroute point) {
        this.edges.forEach(edge -> edge.reroutes.removeIf(candidate -> candidate.id.equals(point.id)));
    }

    public void clear() {
        this.nodes.clear();
        this.nodeIndex.clear();
        this.edges.clear();
        this.codeSlots.clear();
        this.fileSpaces.clear();
        this.sequence = 1;
        this.revision = 0L;
    }

    public CodeSlot ensureNodeSlot(Node node) {
        if (!node.codeBearing) {
            return null;
        }
        return this.codeSlots.computeIfAbsent("node:" + node.id, id -> new CodeSlot((String)id, "node", node.id));
    }

    public void setCodeBearing(Node node, boolean value) {
        node.codeBearing = value;
        if (value) {
            this.ensureNodeSlot(node);
        } else {
            this.codeSlots.remove("node:" + node.id);
        }
        this.touch();
    }

    public CodeSlot ensureFileSlot(Node node) {
        if (node.nodeKind != NodeKind.FILE) {
            throw new IllegalArgumentException("不是文件节点");
        }
        return this.codeSlots.computeIfAbsent("file:" + node.id, id -> new CodeSlot((String)id, "file", node.id));
    }

    public CodeSlot ensureDefaultFileSlot() {
        return this.codeSlots.computeIfAbsent("file:default", id -> new CodeSlot((String)id, "file", "default"));
    }

    public String codeSlotId(Node node, Mode mode) {
        if (mode == Mode.EXECUTABLE) {
            return node.codeBearing ? "node:" + node.id : "";
        }
        if (node.nodeKind == NodeKind.FILE) {
            return "file:" + node.id;
        }
        if (!node.fileNodeId.isBlank()) {
            return "file:" + node.fileNodeId;
        }
        if (this.nodes.stream().noneMatch(n -> n.nodeKind == NodeKind.FILE)) {
            return "file:default";
        }
        return "";
    }

    public List<Node> groupOutputs() {
        return this.nodes.stream().filter(n -> n.nodeKind == NodeKind.GROUP_OUTPUT).toList();
    }

    public Collection<VirtualFileSpace> fileSpaces() {
        return Collections.unmodifiableCollection(this.fileSpaces.values());
    }

    public VirtualFileSpace fileSpace(String id) {
        return this.fileSpaces.get(id);
    }

    public void putFileSpace(VirtualFileSpace space) {
        this.fileSpaces.put(space.id, space);
    }

    public void refreshFileSpaces() {
        HashMap<String, VirtualFileSpace> previous = new HashMap<String, VirtualFileSpace>();
        for (VirtualFileSpace existing : this.fileSpaces.values()) {
            VirtualFileSpace keep = new VirtualFileSpace(existing.id, existing.name, existing.fileNodeId);
            keep.relation = existing.relation;
            keep.relatedSpaceIds.addAll(existing.relatedSpaceIds);
            previous.put(existing.id, keep);
        }
        this.fileSpaces.clear();
        boolean hasFileNode = this.nodes.stream().anyMatch(n -> n.nodeKind == NodeKind.FILE);
        if (!hasFileNode) {
            VirtualFileSpace defaultSpace = new VirtualFileSpace("space:default", "默认文件空间", "");
            defaultSpace.relation = SpaceRelation.PARALLEL;
            defaultSpace.slotId = "file:default";
            for (Node node : this.nodes) {
                if (node.nodeKind == NodeKind.FILE) continue;
                defaultSpace.includedNodeIds.add(node.id);
            }
            for (Node group : this.validGroupOutputsWithUpstream().keySet()) {
                defaultSpace.groupOutputNodeIds.add(group.id);
            }
            this.fileSpaces.put(defaultSpace.id, defaultSpace);
        } else {
            Map<Node, Set<String>> groupUpstream = this.validGroupOutputsWithUpstream();
            for (Node fileNode : this.nodes) {
                if (fileNode.nodeKind != NodeKind.FILE) continue;
                VirtualFileSpace space = new VirtualFileSpace("space:" + fileNode.id, fileNode.name, fileNode.id);
                space.relation = SpaceRelation.PARALLEL;
                space.slotId = "file:" + fileNode.id;
                for (Node node : this.nodes) {
                    if (node.id.equals(fileNode.id) || !node.fileNodeId.equals(fileNode.id)) continue;
                    space.includedNodeIds.add(node.id);
                }
                for (Map.Entry<Node, Set<String>> entry : groupUpstream.entrySet()) {
                    if (entry.getValue().contains(fileNode.id))
                        space.groupOutputNodeIds.add(entry.getKey().id);
                }
                this.fileSpaces.put(space.id, space);
            }
        }
        for (VirtualFileSpace space : this.fileSpaces.values()) {
            VirtualFileSpace prior = (VirtualFileSpace)previous.get(space.id);
            if (prior == null) continue;
            space.relation = prior.relation;
            space.relatedSpaceIds.clear();
            space.relatedSpaceIds.addAll(prior.relatedSpaceIds);
        }
    }

    private Map<Node, Set<String>> validGroupOutputsWithUpstream() {
        Map<Node, Set<String>> result = new LinkedHashMap<Node, Set<String>>();
        for (Node group : this.groupOutputs()) {
            Set<String> upstream = this.upstreamIncludingMutedIds(group);
            if (upstream.isEmpty()) continue;
            if (group.inputs.stream().filter(p -> p.required).allMatch(p -> this.edges.stream().anyMatch(e -> e.target.equals(group.id) && e.targetPort.equals(p.id))))
                result.put(group, upstream);
        }
        return result;
    }

    private Set<String> upstreamIncludingMutedIds(Node output) {
        Set<String> ids = new LinkedHashSet<String>();
        if (output == null || output.nodeKind != NodeKind.GROUP_OUTPUT) return ids;
        boolean linked = false;
        for (Edge edge : this.edges) if (edge.target.equals(output.id)) { linked = true; break; }
        if (!linked) return ids;
        String fileBoundary = output.fileNodeId;
        ArrayDeque<String> todo = new ArrayDeque<String>();
        todo.add(output.id);
        while (!todo.isEmpty()) {
            String id = todo.removeFirst();
            for (Edge edge : this.edges) if (edge.target.equals(id)) {
                Node source = this.byId(edge.source);
                if (source == null || !WorkflowModel.insideFileBoundary(source, fileBoundary) || !ids.add(edge.source)) continue;
                todo.add(edge.source);
            }
        }
        ids.remove(output.id);
        return ids;
    }

    public List<Node> upstreamOf(Node output) {
        return this.upstreamIncludingMuted(output).stream().filter(node -> !node.muted).toList();
    }

    public List<Node> upstreamIncludingMuted(Node output) {
        if (output == null || output.nodeKind != NodeKind.GROUP_OUTPUT) {
            return List.of();
        }
        boolean linked = this.edges.stream().anyMatch(e -> e.target.equals(output.id));
        if (!linked) {
            return List.of();
        }
        String fileBoundary = output.fileNodeId;
        LinkedHashSet<String> ids = new LinkedHashSet<String>();
        ArrayDeque<String> todo = new ArrayDeque<String>();
        todo.add(output.id);
        while (!todo.isEmpty()) {
            String id = (String)todo.removeFirst();
            for (Edge edge : this.edges) {
                Node source;
                if (!edge.target.equals(id) || (source = this.byId(edge.source)) == null || !WorkflowModel.insideFileBoundary(source, fileBoundary) || !ids.add(edge.source)) continue;
                todo.add(edge.source);
            }
        }
        return ids.stream().map(this::byId).filter(Objects::nonNull).filter(node -> node.nodeKind != NodeKind.GROUP_OUTPUT).toList();
    }

    public boolean isValidGroupOutput(Node node) {
        return node != null && node.nodeKind == NodeKind.GROUP_OUTPUT && !this.upstreamOf(node).isEmpty() && node.inputs.stream().filter(p -> p.required).allMatch(p -> this.edges.stream().anyMatch(e -> e.target.equals(node.id) && e.targetPort.equals(p.id)));
    }

    private static boolean insideFileBoundary(Node node, String fileBoundary) {
        return fileBoundary == null || fileBoundary.isBlank() || node.id.equals(fileBoundary) || node.fileNodeId.equals(fileBoundary);
    }

    public void recomputeTypes() {
        this.nodes.forEach(n -> n.inputs.forEach(p -> {
            p.dataType = WorkflowModel.normalizedType(p.declaredType);
        }));
        for (Edge edge : this.edges) {
            Node source = this.byId(edge.source);
            Node target = this.byId(edge.target);
            if (source == null || target == null) continue;
            Port from = this.output(source, edge.sourcePort);
            Port to = this.input(target, edge.targetPort);
            if (from == null || to == null || !WorkflowModel.isAny(to.declaredType) || from.dataType.isBlank()) continue;
            to.dataType = from.dataType;
        }
    }

    private static String normalizedType(String type) {
        return type == null || type.isBlank() ? "any" : type;
    }

    private static boolean isAny(String type) {
        return type == null || type.isBlank() || type.equalsIgnoreCase("any");
    }

    private static ConnectionResult rejected(String reason) {
        return new ConnectionResult(false, "连接失败：" + reason);
    }

    private static boolean compatible(String outputType, String inputType) {
        String input;
        if (WorkflowModel.isAny(outputType) || WorkflowModel.isAny(inputType)) {
            return true;
        }
        String output = WorkflowModel.canonicalType(outputType);
        return output.equals(input = WorkflowModel.canonicalType(inputType)) || output.equals("integer") && input.equals("number");
    }

    private static String canonicalType(String type) {
        return switch (type.trim().toLowerCase(Locale.ROOT)) {
            case "int", "integer" -> "integer";
            case "float", "double", "number", "decimal" -> "number";
            case "bool", "boolean" -> "boolean";
            default -> type.trim().toLowerCase(Locale.ROOT);
        };
    }

    public void clearStatuses() {
        this.nodes.forEach(n -> {
            n.status = Status.IDLE;
            n.diagnostic = "";
        });
    }

    public static final class CodeSlot {
        public final String id;
        public final String ownerKind;
        public final String ownerId;
        public String language = "java";
        public long activeRevision;
        public String activeCode = "";
        public String previousCode = "";
        public long previousSourceRevision = -1L;
        public String lastAppliedRequestId = "";
        public CodeDraft draft;

        public CodeSlot(String id, String ownerKind, String ownerId) {
            this.id = id;
            this.ownerKind = ownerKind;
            this.ownerId = ownerId;
        }
    }

    public static final class Reroute {
        public final String id;
        public int x;
        public int y;

        public Reroute(int x, int y) {
            this("reroute-" + String.valueOf(UUID.randomUUID()), x, y);
        }

        public Reroute(String id, int x, int y) {
            this.id = id;
            this.x = x;
            this.y = y;
        }
    }

    public static final class Node {
        public final String id;
        public String name;
        public String prompt;
        public String artifact;
        public String category = "基础";
        public String templateLibrary = "custom";
        public String templateId = "blank";
        public String templateVersion = "1.0";
        public String templateLanguage = "neutral";
        public NodeKind nodeKind = NodeKind.REGULAR;
        public String valueType = "any";
        public String operation = "";
        public String classificationKey = "foundation.object";
        public boolean codeBearing = true;
        public String parentScopeId = "";
        public String scopeRegion = "body";
        public String fileNodeId = "";
        public String relativePath = "";
        public String role = "";
        public int containerWidth = 520;
        public int containerHeight = 320;
        public int x;
        public int y;
        public boolean collapsed;
        public boolean muted;
        public boolean detailMode;
        public boolean rangeMode;
        public boolean readOnly;
        public String nodeColor = "";
        public String assetType = "";
        public String bundleData = "";
        public String groupInputNodeId = "";
        public boolean bundleCollapsed = true;
        public String memberBinding;
        public int nodeWidth = 215;
        public int nodeHeight = 92;
        public Status status = Status.IDLE;
        public String diagnostic = "";
        public boolean composite;
        public final List<Port> inputs = new ArrayList<Port>();
        public final List<Port> outputs = new ArrayList<Port>();

        public Node(String id, String name, int x, int y) {
            this.id = id;
            this.name = name;
            this.x = x;
            this.y = y;
            this.prompt = "说明这个节点应完成的工作";
            this.artifact = "output/" + id + ".java";
            this.inputs.add(new Port("in", "输入", "any", false));
            this.outputs.add(new Port("out", "输出", "any", false));
        }
    }

    public static enum NodeKind {
        REGULAR,
        SCOPE,
        CONDITION,
        CALCULATION,
        FILE,
        GROUP_OUTPUT,
        ASSET,
        ASSET_BUNDLE,
        GROUP,
        CAPTURE,
        GROUP_INPUT;

    }

    public static final class Port {
        public final String id;
        public String name;
        public String declaredType;
        public String dataType;
        public boolean required;

        public Port(String id, String name, String dataType, boolean required) {
            this(id, name, dataType, dataType, required);
        }

        public Port(String id, String name, String declaredType, String dataType, boolean required) {
            this.id = id;
            this.name = name;
            this.declaredType = declaredType;
            this.dataType = dataType;
            this.required = required;
        }
    }

    public record ConnectionResult(boolean connected, String reason) {
    }

    public record Edge(String id, String source, String sourcePort, String target, String targetPort, List<Reroute> reroutes) {
        public Edge(String id, String source, String sourcePort, String target, String targetPort) {
            this(id, source, sourcePort, target, targetPort, new ArrayList<Reroute>());
        }
    }

    public static enum Status {
        IDLE,
        QUEUED,
        PROCESSING,
        REVIEW_READY,
        ACCEPTED,
        SUCCEEDED,
        FAILED,
        CANCELLED,
        REJECTED,
        CONFLICTED;

    }

    public static final class CodeDraft {
        public String requestId;
        public long baseRevision;
        public String code;
        public String classificationKey;

        public CodeDraft(String requestId, long baseRevision, String code, String classificationKey) {
            this.requestId = requestId;
            this.baseRevision = baseRevision;
            this.code = code;
            this.classificationKey = classificationKey;
        }
    }

    public static enum Mode {
        EXECUTABLE("executable-workflow", "节点程序模式"),
        MARKDOWN("markdown-blueprint", "Markdown 请求模式");

        public final String wireName;
        public final String label;

        private Mode(String wireName, String label) {
            this.wireName = wireName;
            this.label = label;
        }

        public String toString() {
            return this.label;
        }
    }

    public static final class VirtualFileSpace {
        public String id;
        public String name;
        public String fileNodeId;
        public String slotId;
        public final List<String> includedNodeIds = new ArrayList<String>();
        public SpaceRelation relation = SpaceRelation.PARALLEL;
        public final List<String> relatedSpaceIds = new ArrayList<String>();
        public final List<String> groupOutputNodeIds = new ArrayList<String>();

        public VirtualFileSpace() {
        }

        public VirtualFileSpace(String id, String name, String fileNodeId) {
            this.id = id;
            this.name = name;
            this.fileNodeId = fileNodeId;
        }

        public boolean isVirtual() {
            return this.fileNodeId == null || this.fileNodeId.isBlank();
        }
    }

    public static enum SpaceRelation {
        PARALLEL,
        CONTAIN,
        REFERENCE;

    }
}
