/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import local.codenode.LocalCompiler;
import local.codenode.WorkflowModel;
import local.codenode.util.BundleDataUtil;

public final class RuntimeTraceService {
    private RuntimeTraceService() {
    }

    public static Map<String, Object> trace(WorkflowModel model, Path root, String targetId, List<String> args, long timeoutSeconds) {
        WorkflowModel.Node target;
        LinkedHashMap<String, Object> trace = new LinkedHashMap<String, Object>();
        if (model == null) {
            trace.put("error", "工作台模型不可用");
            return trace;
        }
        WorkflowModel.Node node = target = targetId == null || targetId.isBlank() ? null : model.byId(targetId);
        if (target == null) {
            trace.put("error", "目标节点不存在: " + targetId);
            return trace;
        }
        Set<String> scope = RuntimeTraceService.scopeIds(model, target);
        ArrayList codes = new ArrayList();
        LinkedHashMap<String, String> sources = new LinkedHashMap<String, String>();
        for (WorkflowModel.Node node2 : model.nodes()) {
            WorkflowModel.CodeSlot slot;
            if (!scope.contains(node2.id) || (slot = RuntimeTraceService.codeSlotOf(model, node2)) == null || slot.activeCode == null || slot.activeCode.isBlank()) continue;
            String rel = RuntimeTraceService.sourceRelativePath(model, node2);
            String fileName = RuntimeTraceService.sourceFileName(rel, slot.activeCode);
            sources.put(fileName, slot.activeCode);
            LinkedHashMap<String, Object> code = new LinkedHashMap<String, Object>();
            code.put("nodeId", node2.id);
            code.put("name", node2.name);
            code.put("path", fileName);
            code.put("language", slot.language);
            code.put("lines", slot.activeCode.lines().count());
            codes.add(code);
        }
        List<String> assets = RuntimeTraceService.collectAssets(model, scope);
        String mainClass = RuntimeTraceService.findMainClass(sources);
        trace.put("target", target.id);
        trace.put("targetName", target.name);
        trace.put("targetKind", target.nodeKind.name());
        trace.put("programs", codes.size());
        trace.put("codes", codes);
        trace.put("assets", assets);
        trace.put("assetCount", assets.size());
        trace.put("mainClass", mainClass);
        trace.put("runtimeProjectRoot", root == null ? "" : root.toString());
        if (sources.isEmpty()) {
            trace.put("compiled", false);
            trace.put("output", "");
            trace.put("error", "目标作用域内没有任何可运行的代码");
            trace.put("exitCode", -1);
            trace.put("durationMs", 0);
            return trace;
        }
        LocalCompiler.RunResult run = LocalCompiler.compileAndRun(sources, mainClass, args, timeoutSeconds);
        trace.put("compiled", run.compiled());
        trace.put("exitCode", run.exitCode());
        trace.put("output", run.output());
        trace.put("error", run.error());
        trace.put("durationMs", run.durationMs());
        trace.put("ok", run.ok());
        return trace;
    }

    static Set<String> scopeIds(WorkflowModel model, WorkflowModel.Node target) {
        LinkedHashSet<String> ids = new LinkedHashSet<String>();
        String groupId = "";
        if (target.nodeKind == WorkflowModel.NodeKind.GROUP) {
            groupId = target.id;
        } else if (target.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT) {
            groupId = target.parentScopeId;
        }
        if (!groupId.isBlank()) {
            ArrayDeque<String> queue = new ArrayDeque<String>();
            queue.add(groupId);
            while (!queue.isEmpty()) {
                String id = (String)queue.removeFirst();
                if (!ids.add(id)) continue;
                for (WorkflowModel.Node n : model.nodes()) {
                    if (!id.equals(n.parentScopeId)) continue;
                    queue.add(n.id);
                }
            }
            return ids;
        }
        ArrayDeque<String> queue = new ArrayDeque<String>();
        queue.add(target.id);
        while (!queue.isEmpty()) {
            String id = (String)queue.removeFirst();
            if (!ids.add(id)) continue;
            for (WorkflowModel.Edge edge : model.edges()) {
                if (!edge.target().equals(id)) continue;
                queue.add(edge.source());
            }
        }
        return ids;
    }

    private static WorkflowModel.CodeSlot codeSlotOf(WorkflowModel model, WorkflowModel.Node node) {
        if (node.nodeKind == WorkflowModel.NodeKind.FILE) {
            return model.codeSlot("file:" + node.id);
        }
        if (node.codeBearing) {
            return model.codeSlot("node:" + node.id);
        }
        return null;
    }

    private static String sourceRelativePath(WorkflowModel model, WorkflowModel.Node node) {
        if (node.nodeKind == WorkflowModel.NodeKind.FILE) {
            if (node.relativePath != null && !node.relativePath.isBlank()) {
                return node.relativePath;
            }
            return node.name;
        }
        return "node-" + node.id + ".java";
    }

    static String sourceFileName(String relativePath, String code) {
        String key = relativePath == null ? "Main.java" : relativePath;
        Matcher matcher = Pattern.compile("(?:public\\s+)?(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)").matcher(code);
        if (!matcher.find()) {
            return key;
        }
        String className = matcher.group(1);
        String base = key.replace('\\', '/');
        int slash = base.lastIndexOf(47);
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        if (base.endsWith(".java")) {
            base = base.substring(0, base.length() - 5);
        }
        if (base.equals(className)) {
            return key;
        }
        return (slash >= 0 ? key.substring(0, slash + 1) : "") + className + ".java";
    }

    public static String findMainClass(Map<String, String> sources) {
        if (sources == null) {
            return "";
        }
        for (Map.Entry<String, String> entry : sources.entrySet()) {
            Matcher matcher;
            String code = entry.getValue();
            if (code == null || !code.contains("public static void main") || !(matcher = Pattern.compile("(?:public\\s+)?class\\s+([A-Za-z_$][\\w$]*)").matcher(code)).find()) continue;
            return matcher.group(1);
        }
        return "";
    }

    private static List<String> collectAssets(WorkflowModel model, Set<String> scope) {
        ArrayList<String> assets = new ArrayList<String>();
        for (WorkflowModel.Node node : model.nodes()) {
            if (!scope.contains(node.id)) continue;
            if (node.nodeKind == WorkflowModel.NodeKind.ASSET) {
                assets.add("asset:" + (node.relativePath.isBlank() ? node.name : node.relativePath));
                continue;
            }
            if (node.nodeKind != WorkflowModel.NodeKind.ASSET_BUNDLE) continue;
            BundleDataUtil.BundleView view = BundleDataUtil.parseV2(node.bundleData);
            for (BundleDataUtil.BundleMember member : view.members()) {
                assets.add("bundle:" + member.relativePath());
            }
        }
        return assets;
    }
}
