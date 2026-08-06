package local.codenode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** 全量解析流水线自检：扫描 -> 建图 -> 布局 -> 保存/回读（非 @Test，避免污染测试计数）。 */
public class FullScanSmokeTest {
    public static void main(String[] args) throws Exception {
        Path root = Path.of("E:\\teaCraft\\branch.1\\teacraft");
        if (!Files.isDirectory(root)) {
            System.out.println("[SKIP] 测试目录不存在: " + root);
            return;
        }
        ProjectScanner.ScanResult scan = ProjectScanner.scan(root);
        System.out.println("[SCAN] sourceFiles=" + scan.sourceFiles().size()
                + " assetFiles=" + scan.assetFiles().size());
        for (ProjectScanner.SourceFile sf : scan.sourceFiles().stream().limit(5).toList())
            System.out.println("  src: " + sf.relativePath() + " pkg=[" + sf.packageName()
                    + "] imports=" + sf.imports().size());

        WorkflowModel model = new WorkflowModel();
        ProjectGraphBuilder.build(model, scan);
        long groups = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP).count();
        long files = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.FILE).count();
        long bundles = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE).count();
        long groupIns = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_INPUT).count();
        long groupOuts = model.nodes().stream().filter(n -> n.nodeKind == WorkflowModel.NodeKind.GROUP_OUTPUT).count();
        System.out.println("[GRAPH] nodes=" + model.nodes().size() + " edges=" + model.edges().size()
                + " GROUP=" + groups + " FILE=" + files + " ASSET_BUNDLE=" + bundles
                + " GROUP_INPUT=" + groupIns + " GROUP_OUTPUT=" + groupOuts);

        AutoLayout.layout(model, null);
        boolean overlap = false;
        List<WorkflowModel.Node> nodes = model.nodes();
        for (int i = 0; i < nodes.size(); i++)
            for (int j = i + 1; j < nodes.size(); j++) {
                WorkflowModel.Node a = nodes.get(i), b = nodes.get(j);
                if (a.id.equals(b.id)) continue;
                if (isChildOf(a, b) || isChildOf(b, a)) continue;
                int aw = width(a), ah = height(a), bw = width(b), bh = height(b);
                if (a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah) {
                    System.out.println("  [OVERLAP] " + a.id + "(" + a.x + "," + a.y + "," + aw + "x" + ah + ") vs "
                            + b.id + "(" + b.x + "," + b.y + "," + bw + "x" + bh + ")");
                    overlap = true;
                }
            }
        System.out.println("[LAYOUT] overlap=" + overlap
                + " minX=" + nodes.stream().mapToInt(n -> n.x).min().orElse(0)
                + " maxX=" + nodes.stream().mapToInt(n -> n.x).max().orElse(0)
                + " minY=" + nodes.stream().mapToInt(n -> n.y).min().orElse(0)
                + " maxY=" + nodes.stream().mapToInt(n -> n.y).max().orElse(0));

        Path out = root.resolve("output/full-scan-smoke.cnode");
        Files.createDirectories(out.getParent());
        CnodeProjectCodec codec = new CnodeProjectCodec();
        codec.save(out, model, new CnodeProjectCodec.Metadata(
                "smoke-" + System.currentTimeMillis(), "全量解析自检",
                java.time.Instant.now(), new CnodeProjectCodec.Settings(
                WorkflowModel.Mode.MARKDOWN, "java", "output/full-scan.java", "docs/full-scan.md",
                null, 0, 0, 1.0, null)));
        CnodeProjectCodec.Loaded loaded = codec.load(out);
        System.out.println("[SAVE] 回读 mode=" + loaded.metadata().settings().mode()
                + " nodes=" + loaded.model().nodes().size()
                + " edges=" + loaded.model().edges().size() + " path=" + out);
    }

    private static boolean isChildOf(WorkflowModel.Node a, WorkflowModel.Node b) {
        return !a.parentScopeId.isBlank() && a.parentScopeId.equals(b.id);
    }

    private static int width(WorkflowModel.Node n) {
        if (n.nodeKind == WorkflowModel.NodeKind.GROUP) return Math.max(320, n.containerWidth);
        if (n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) return 140;
        return 120;
    }

    private static int height(WorkflowModel.Node n) {
        if (n.nodeKind == WorkflowModel.NodeKind.GROUP) return Math.max(220, n.containerHeight);
        if (n.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) return 120;
        if (n.nodeKind == WorkflowModel.NodeKind.FILE) return 92;
        return 60;
    }
}
