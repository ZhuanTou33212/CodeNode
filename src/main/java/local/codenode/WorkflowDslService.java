/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import local.codenode.NodeRegistry;
import local.codenode.WorkflowModel;
import local.codenode.util.BundleDataUtil;

public final class WorkflowDslService {
    public Document decode(WorkflowModel model, List<WorkflowModel.Node> included, WorkflowModel.Node target) {
        if (included == null || included.isEmpty()) {
            throw new IllegalArgumentException("DSL 范围不能为空");
        }
        LinkedHashSet<String> allowed = new LinkedHashSet<String>();
        included.forEach(node -> allowed.add(node.id));
        ArrayList<String> roots = new ArrayList<String>();
        if (target != null && target.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
            for (WorkflowModel.Edge edge : model.edges()) {
                if (!edge.target().equals(target.id) || !allowed.contains(edge.source())) continue;
                roots.add(edge.source());
            }
        } else if (target != null && allowed.contains(target.id)) {
            roots.add(target.id);
        } else if (target != null && target.nodeKind == WorkflowModel.NodeKind.GROUP && allowed.contains(target.id)) {
            Set<String> inside = WorkflowDslService.insideScope(model, target.id);
            WorkflowModel.Node go = WorkflowDslService.groupOutputOf(model, target.id);
            if (go != null && inside.contains(go.id)) {
                for (WorkflowModel.Edge edge : model.edges()) {
                    if (!edge.target().equals(go.id) || !inside.contains(edge.source())) continue;
                    roots.add(edge.source());
                }
            } else {
                roots.add(target.id);
            }
        }
        if (roots.isEmpty()) {
            roots.add(included.getLast().id);
        }
        ArrayList<Map<String, Object>> bodies = new ArrayList<Map<String, Object>>();
        ArrayList<String> expressions = new ArrayList<String>();
        for (String root : roots) {
            HashSet<String> visiting = new HashSet<String>();
            NodeExpression value = this.build(model, root, allowed, visiting);
            expressions.add(value.text);
            bodies.add(value.ast);
        }
        Map<String, Object> ast = roots.size() == 1 ? (Map<String, Object>)bodies.getFirst() : Map.of("type", "sequence", "body", bodies);
        return new Document(String.join((CharSequence)";", expressions), ast);
    }

    private NodeExpression build(WorkflowModel model, String nodeId, Set<String> allowed, Set<String> visiting) {
        if (!visiting.add(nodeId)) {
            throw new IllegalArgumentException("DSL 检测到隐式循环：" + nodeId);
        }
        List<WorkflowModel.Edge> incoming = model.edges().stream().filter(edge -> edge.target().equals(nodeId) && allowed.contains(edge.source())).toList();
        ArrayList<NodeExpression> dependencies = new ArrayList<NodeExpression>();
        for (WorkflowModel.Edge edge2 : incoming) {
            dependencies.add(this.build(model, edge2.source(), allowed, visiting));
        }
        visiting.remove(nodeId);
        String text = nodeId + (String)(dependencies.isEmpty() ? "" : "(" + String.join((CharSequence)",", dependencies.stream().map(value -> value.text).toList()) + ")");
        Map<String, Object> ast = dependencies.isEmpty() ? Map.of("type", "reference", "nodeId", nodeId) : Map.of("type", "call", "nodeId", nodeId, "arguments", dependencies.stream().map(value -> value.ast).toList());
        return new NodeExpression(text, ast);
    }

    public Architecture decodeArchitecture(WorkflowModel model) {
        if (model == null) {
            throw new IllegalArgumentException("工作台为空");
        }
        List<WorkflowModel.Node> roots = WorkflowDslService.rootsOf(model);
        StringBuilder md = new StringBuilder("# 项目分析架构\n");
        ArrayList<Map<String, Object>> groupAst = new ArrayList<Map<String, Object>>();
        for (WorkflowModel.Node root : roots) {
            groupAst.add(this.architectureEntry(model, root, md, 1));
        }
        LinkedHashMap<String, Object> ast = new LinkedHashMap<String, Object>();
        ast.put("type", "project-architecture");
        ast.put("rootCount", roots.size());
        ast.put("groups", groupAst);
        return new Architecture(md.toString().trim(), ast);
    }

    private static List<WorkflowModel.Node> rootsOf(WorkflowModel model) {
        ArrayList<WorkflowModel.Node> roots = new ArrayList<WorkflowModel.Node>();
        for (WorkflowModel.Node n : model.nodes()) {
            if (n.nodeKind != WorkflowModel.NodeKind.GROUP || n.parentScopeId != null && !n.parentScopeId.isBlank()) continue;
            roots.add(n);
        }
        if (!roots.isEmpty()) {
            return roots;
        }
        for (WorkflowModel.Node n : model.nodes()) {
            if (n.parentScopeId != null && !n.parentScopeId.isBlank()) continue;
            roots.add(n);
        }
        return roots;
    }

    private Map<String, Object> architectureEntry(WorkflowModel model, WorkflowModel.Node node, StringBuilder md, int depth) {
        if (node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
            return this.bundleEntry(node, md, depth);
        }
        if (node.nodeKind == WorkflowModel.NodeKind.GROUP) {
            md.append(WorkflowDslService.indent(depth)).append("- 📁 组 `").append(node.name).append("`");
            if (node.relativePath != null && !node.relativePath.isBlank()) {
                md.append(" 路径 `").append(node.relativePath).append("`");
            }
            md.append("\n");
            ArrayList<Map<String, Object>> children = new ArrayList<Map<String, Object>>();
            ArrayList<Map<String, Object>> files = new ArrayList<Map<String, Object>>();
            for (WorkflowModel.Node child : model.nodes()) {
                if (child == node || !node.id.equals(child.parentScopeId) || child.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT || child.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) continue;
                if (child.nodeKind == WorkflowModel.NodeKind.GROUP || child.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
                    children.add(this.architectureEntry(model, child, md, depth + 1));
                    continue;
                }
                if (child.nodeKind == WorkflowModel.NodeKind.FILE) {
                    files.add(WorkflowDslService.fileEntry(child));
                    md.append(WorkflowDslService.indent(depth + 1)).append("- 📄 文件 `").append(child.name).append("` 路径 `").append(child.relativePath).append("`\n");
                    continue;
                }
                if (child.nodeKind != WorkflowModel.NodeKind.ASSET) continue;
                md.append(WorkflowDslService.indent(depth + 1)).append("- 🖼 资产 `").append(child.name).append("` 类型 `").append(NodeRegistry.assetTypeLabel(child.assetType)).append("` 路径 `").append(child.relativePath).append("`\n");
            }
            LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
            entry.put("type", "group");
            entry.put("name", node.name);
            entry.put("relativePath", node.relativePath == null ? "" : node.relativePath);
            if (!files.isEmpty()) {
                entry.put("files", files);
            }
            if (!children.isEmpty()) {
                entry.put("children", children);
            }
            return entry;
        }
        LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
        entry.put("type", node.nodeKind.name().toLowerCase(Locale.ROOT));
        entry.put("name", node.name);
        entry.put("relativePath", node.relativePath);
        md.append(WorkflowDslService.indent(depth)).append("- 节点 `").append(node.name).append("`\n");
        return entry;
    }

    private Map<String, Object> bundleEntry(WorkflowModel.Node node, StringBuilder md, int depth) {
        List<String> names;
        BundleDataUtil.BundleView view = BundleDataUtil.parseV2(node.bundleData);
        md.append(WorkflowDslService.indent(depth)).append("- 🗂 资源组 `").append(node.name).append("`（").append(view.memberCount()).append(" 个资产）");
        if (node.relativePath != null && !node.relativePath.isBlank()) {
            md.append(" 路径 `").append(node.relativePath).append("`");
        }
        if (!(names = view.members().stream().map(BundleDataUtil.BundleMember::name).toList()).isEmpty()) {
            md.append("：").append(String.join((CharSequence)"、", names));
        }
        md.append("\n");
        LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
        entry.put("type", "asset-bundle");
        entry.put("name", node.name);
        entry.put("relativePath", node.relativePath == null ? "" : node.relativePath);
        entry.put("memberCount", view.memberCount());
        entry.put("members", names);
        return entry;
    }

    private static Map<String, Object> fileEntry(WorkflowModel.Node node) {
        LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
        entry.put("type", "file");
        entry.put("name", node.name);
        entry.put("relativePath", node.relativePath == null ? "" : node.relativePath);
        return entry;
    }

    private static Set<String> insideScope(WorkflowModel model, String scopeId) {
        LinkedHashSet<String> inside = new LinkedHashSet<String>();
        ArrayDeque<String> queue = new ArrayDeque<String>();
        queue.add(scopeId);
        while (!queue.isEmpty()) {
            String id = (String)queue.removeFirst();
            if (!inside.add(id)) continue;
            for (WorkflowModel.Node n : model.nodes()) {
                if (!id.equals(n.parentScopeId)) continue;
                queue.add(n.id);
            }
        }
        return inside;
    }

    private static WorkflowModel.Node groupOutputOf(WorkflowModel model, String groupId) {
        for (WorkflowModel.Node n : model.nodes()) {
            if (n.nodeKind != WorkflowModel.NodeKind.GROUP_OUTPUT || !groupId.equals(n.parentScopeId)) continue;
            return n;
        }
        return null;
    }

    private static String indent(int depth) {
        return "  ".repeat(Math.max(0, depth));
    }

    private record NodeExpression(String text, Map<String, Object> ast) {
    }

    public record Document(String expression, Map<String, Object> ast) {
    }

    public record Architecture(String markdown, Map<String, Object> ast) {
    }
}
