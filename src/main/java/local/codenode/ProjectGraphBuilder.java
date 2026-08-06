package local.codenode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * 项目全量解析建图：接收 WorkflowModel 与 ProjectScanner 扫描结果，
 * 将源码按 package 分组建 GROUP（无 package 独立 FILE），按 import 建立跨包
 * 组级连线，资产按父目录聚类为 ASSET_BUNDLE。
 */
public final class ProjectGraphBuilder {

    private static final int GROUP_INIT_X = 40;
    private static final int GROUP_GAP_Y = 220;
    private static final int ASSET_INIT_X = 40;
    private static final int ASSET_GAP_Y = 130;

    private ProjectGraphBuilder() {}

    /** 在传入的 model 上构建项目分析图，返回同一个 model（便于链式调用）。 */
    public static WorkflowModel build(WorkflowModel model, ProjectScanner.ScanResult scan) {
        return build(model, scan, null);
    }

    /** 在传入的 model 上构建项目分析图；root 非空时为 ASSET_BUNDLE 计算成员 size/checksum。 */
    public static WorkflowModel build(WorkflowModel model, ProjectScanner.ScanResult scan, java.nio.file.Path root) {
        if (model == null || scan == null) return model;

        // ---------- 1. 按 package 分组；无 package 的文件独立成 FILE ----------
        Map<String, List<ProjectScanner.SourceFile>> byPackage = new TreeMap<>();
        for (ProjectScanner.SourceFile sf : scan.sourceFiles()) {
            String pkg = normalizePackage(sf.packageName());
            byPackage.computeIfAbsent(pkg, key -> new ArrayList<>()).add(sf);
        }

        Map<String, WorkflowModel.Node> groups = new LinkedHashMap<>();
        int groupY = 40;
        for (Map.Entry<String, List<ProjectScanner.SourceFile>> entry : byPackage.entrySet()) {
            String pkg = entry.getKey();
            if (pkg.isBlank()) continue;
            WorkflowModel.Node group = model.addGroupNode(GROUP_INIT_X, groupY, pkg);
            applyAnalysisFields(group, "analysis.java");
            group.role = "package";
            group.prompt = "包 " + pkg + "（" + entry.getValue().size() + " 个源文件）";
            groups.put(pkg, group);
            groupY += GROUP_GAP_Y;
        }

        // ---------- 2. FILE 子节点（组内）与独立 FILE 节点（无 package） ----------
        int standaloneY = 40;
        for (Map.Entry<String, List<ProjectScanner.SourceFile>> entry : byPackage.entrySet()) {
            String pkg = entry.getKey();
            WorkflowModel.Node group = groups.get(pkg);
            for (ProjectScanner.SourceFile sf : entry.getValue()) {
                WorkflowModel.Node file = model.addFileNode(0, 0, sf.name(), sf.relativePath());
                applyAnalysisFields(file, "analysis." + normalizeLanguage(sf.language()));
                file.parentScopeId = group == null ? "" : group.id;
                file.prompt = "语言: " + sf.language() + "\n包: " + (pkg.isBlank() ? "(无)" : pkg)
                        + "\n路径: " + sf.relativePath() + "\nimports: " + sf.imports().size();
                if (group == null) {
                    file.x = 40;
                    file.y = standaloneY;
                    standaloneY += 110;
                }
            }
        }

        // ---------- 3. 每个 GROUP 添加组输入 / 组输出节点 ----------
        for (Map.Entry<String, WorkflowModel.Node> entry : groups.entrySet()) {
            WorkflowModel.Node group = entry.getValue();
            WorkflowModel.Node groupInput = model.addGroupInputNode(group.x, group.y + 90, entry.getKey() + " 输入");
            groupInput.parentScopeId = group.id;
            groupInput.prompt = "包 " + entry.getKey() + " 的组输入";
            WorkflowModel.Node groupOutput = model.addGroupOutput(group.x + 480, group.y + 90, entry.getKey() + " 输出");
            groupOutput.parentScopeId = group.id;
            groupOutput.prompt = "包 " + entry.getKey() + " 的组输出";
            group.groupInputNodeId = groupInput.id;
        }

        // ---------- 4. import 解析 → 跨包组级连线 ----------
        // 语义：selfPkg import impPkg → impPkg 的组输入 value → selfPkg 的组输出 group
        for (ProjectScanner.SourceFile sf : scan.sourceFiles()) {
            String selfPkg = normalizePackage(sf.packageName());
            if (selfPkg.isBlank()) continue;
            WorkflowModel.Node selfGroup = groups.get(selfPkg);
            if (selfGroup == null) continue;
            WorkflowModel.Node selfOutput = groupOutputOf(model, selfGroup.id);
            if (selfOutput == null) continue;
            for (String imported : sf.imports()) {
                String impPkg = packageOfImport(imported, groups.keySet());
                if (impPkg == null || impPkg.isBlank() || impPkg.equals(selfPkg)) continue;
                WorkflowModel.Node impGroup = groups.get(impPkg);
                if (impGroup == null) continue;
                WorkflowModel.Node impInput = groupInputOf(model, impGroup.id);
                if (impInput == null) continue;
                WorkflowModel.Port from = model.output(impInput, "value");
                WorkflowModel.Port to = model.input(selfOutput, "group");
                if (from != null && to != null) {
                    model.connect(impInput, from, selfOutput, to);
                }
            }
        }

        // ---------- 5. 资产按父目录聚类 → ASSET_BUNDLE ----------
        Map<String, List<ProjectScanner.AssetFile>> byDir = new TreeMap<>();
        for (ProjectScanner.AssetFile af : scan.assetFiles()) {
            String dir = parentDirectory(af.relativePath());
            byDir.computeIfAbsent(dir, key -> new ArrayList<>()).add(af);
        }
        int assetY = 40;
        for (Map.Entry<String, List<ProjectScanner.AssetFile>> entry : byDir.entrySet()) {
            String dir = entry.getKey();
            List<ProjectScanner.AssetFile> assets = entry.getValue();
            String bundleData = buildV2BundleData(assets, root);
            if (bundleData == null) continue;
            String dominantType = assets.getFirst().assetType();
            String label = dir.isBlank() ? "(根目录) " + assets.size() + " 项" : dir + " (" + assets.size() + " 项)";
            WorkflowModel.Node bundle = model.addAssetBundleNode(ASSET_INIT_X, assetY, label, bundleData, dominantType);
            applyAnalysisFields(bundle, "analysis.default");
            bundle.prompt = "资产目录: " + (dir.isBlank() ? "(根目录)" : dir) + "\n资源数: " + assets.size();
            assetY += ASSET_GAP_Y;
        }

        return model;
    }

    /** 资产聚类 → 分类统计 → members 数组 → v2 bundleData JSON；root 为 null 时不读磁盘。空资产返回 null 以跳过创建。 */
    public static String buildV2BundleData(List<ProjectScanner.AssetFile> assets, java.nio.file.Path root) {
        if (assets == null || assets.isEmpty()) return null;
        List<String> relativePaths = assets.stream().map(ProjectScanner.AssetFile::relativePath).toList();
        return local.codenode.util.BundleDataUtil.buildV2BundleData(root, relativePaths);
    }

    /** 设置项目分析通用分类字段。 */
    private static void applyAnalysisFields(WorkflowModel.Node node, String classificationKey) {
        node.category = "项目分析";
        node.classificationKey = classificationKey;
    }

    /** 将 package 名归一化（空白 → ""，去除尾部点）。 */
    private static String normalizePackage(String pkg) {
        if (pkg == null) return "";
        String trimmed = pkg.trim();
        while (trimmed.endsWith(".")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        return trimmed;
    }

    private static String normalizeLanguage(String language) {
        if (language == null) return "default";
        return switch (language.toLowerCase(Locale.ROOT)) {
            case "kt", "kotlin" -> "kotlin";
            case "py", "python" -> "python";
            default -> "java";
        };
    }

    /** 从 import 语句提取包名：与已有组名做最长前缀匹配（如 com.qianxin.teaart.block.Xxx → com.qianxin.teaart.block）。 */
    private static String packageOfImport(String imported, Set<String> knownGroups) {
        if (imported == null) return null;
        String value = imported.trim();
        if (value.isBlank()) return null;
        int dot = value.indexOf('.');
        if (dot < 0) return null;
        // 候选 = 依次去掉末尾段，找到第一个能匹配已有组的
        String candidate = value;
        while (true) {
            int lastDot = candidate.lastIndexOf('.');
            if (lastDot < 0) return null;
            candidate = candidate.substring(0, lastDot);
            if (knownGroups.contains(candidate)) return candidate;
            if (!candidate.contains(".")) return null;
        }
    }

    /** 组内第一个 GROUP_INPUT 节点。 */
    private static WorkflowModel.Node groupInputOf(WorkflowModel model, String groupId) {
        return model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT && n.parentScopeId.equals(groupId))
                .findFirst().orElse(null);
    }

    /** 组内第一个 GROUP_OUTPUT 节点。 */
    private static WorkflowModel.Node groupOutputOf(WorkflowModel model, String groupId) {
        return model.nodes().stream()
                .filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT && n.parentScopeId.equals(groupId))
                .findFirst().orElse(null);
    }

    /** 资产相对路径的父目录（无斜杠 → ""）。 */
    private static String parentDirectory(String relativePath) {
        if (relativePath == null) return "";
        int slash = relativePath.lastIndexOf('/');
        return slash < 0 ? "" : relativePath.substring(0, slash);
    }
}
