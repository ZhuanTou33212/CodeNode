/*
 * Decompiled with CFR 0.152.
 */
package local.codenode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import local.codenode.NodeRegistry;
import local.codenode.ProjectScanner;
import local.codenode.WorkflowModel;
import local.codenode.util.BundleDataUtil;

public final class DirectoryGraphBuilder {
    private static final Set<String> RESOURCE_PACK_DIRS = Set.of("assets", "models", "textures", "blockstates", "lang", "particles", "shaders", "atlases", "recipes", "tags");
    private static final int MAX_NODES = 30000;
    private final WorkflowModel model;
    private final Path absoluteRoot;
    private final Progress progress;
    private int totalFiles;

    private DirectoryGraphBuilder(WorkflowModel model, Path root, Progress progress) {
        this.model = model;
        this.absoluteRoot = root.toAbsolutePath().normalize();
        this.progress = progress;
    }

    public static WorkflowModel build(WorkflowModel model, Path root) throws IOException {
        return DirectoryGraphBuilder.build(model, root, null);
    }

    public static WorkflowModel build(WorkflowModel model, Path root, Progress progress) throws IOException {
        if (model == null) {
            return model;
        }
        if (root == null) {
            throw new NoSuchFileException("项目根目录为空");
        }
        Path absolute = root.toAbsolutePath().normalize();
        if (!Files.isDirectory(absolute, new LinkOption[0])) {
            throw new NoSuchFileException("目录不存在: " + String.valueOf(absolute));
        }
        return new DirectoryGraphBuilder(model, absolute, progress).scanAndBuild();
    }

    private WorkflowModel scanAndBuild() throws IOException {
        DirEntry rootEntry = new DirEntry();
        rootEntry.name = this.absoluteRoot.getFileName() == null ? "工程根" : this.absoluteRoot.getFileName().toString();
        rootEntry.relativePath = "";
        rootEntry.path = this.absoluteRoot;
        this.walk(this.absoluteRoot, rootEntry);
        DirectoryGraphBuilder.classifyDirs(rootEntry);
        this.totalFiles = DirectoryGraphBuilder.countFiles(rootEntry);
        this.report("识别目录并建图", 0, this.totalFiles);
        // 根目录直接展开：直属子目录/文件作为顶层节点（不额外包一层根组）
        int cy = 40;
        for (DirEntry child : rootEntry.dirs) {
            WorkflowModel.Node childNode = this.buildDir(child, 40, cy, "");
            cy += DirectoryGraphBuilder.slotHeight(childNode);
        }
        for (FileEntry file : rootEntry.files) {
            this.createFileNode(file, 40, cy, "");
            cy += 110;
        }
        if (this.model.nodes().size() > 30000) {
            throw new IOException("目录规模过大（节点超过 30000 个），已停止建图，请选择更小的子目录");
        }
        this.model.recomputeTypes();
        this.model.touch();
        this.report("完成", this.totalFiles, this.totalFiles);
        return this.model;
    }

    private void report(String stage, int done, int total) {
        if (this.progress != null) {
            this.progress.report(stage, done, total);
        }
    }

    private static int countFiles(DirEntry entry) {
        int count = entry.files.size();
        for (DirEntry child : entry.dirs) {
            count += DirectoryGraphBuilder.countFiles(child);
        }
        return count;
    }

    private static String extension(String filename) {
        int dot = filename == null ? -1 : filename.lastIndexOf(46);
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private void walk(Path dir, DirEntry entry) throws IOException {
        ArrayList<Path> subdirs = new ArrayList<Path>();
        ArrayList<Path> childFiles = new ArrayList<Path>();
        try (Stream<Path> stream = Files.list(dir);){
            for (Path child : stream.toList()) {
                if (Files.isDirectory(child, new LinkOption[0])) {
                    subdirs.add(child);
                    continue;
                }
                if (!Files.isRegularFile(child, new LinkOption[0])) continue;
                childFiles.add(child);
            }
        }
        subdirs.sort(Comparator.comparing(Path::getFileName));
        childFiles.sort(Comparator.comparing(Path::getFileName));
        for (Path subdir : subdirs) {
            String dirName = subdir.getFileName().toString();
            if (ProjectScanner.isIgnoredDirName(dirName)) continue;
            if (entry.files.size() > 30000) {
                throw new IOException("目录规模过大（文件超过 30000 个），请选择更小的子目录");
            }
            DirEntry child = new DirEntry();
            child.name = dirName;
            child.relativePath = this.relativeOf(subdir);
            child.path = subdir;
            this.walk(subdir, child);
            entry.dirs.add(child);
        }
        for (Path file : childFiles) {
            String relative;
            FileEntry fe;
            String name = file.getFileName().toString();
            String ext = DirectoryGraphBuilder.extension(name);
            if (ProjectScanner.isIgnoredExt(ext) || (fe = DirectoryGraphBuilder.classifyFile(name, relative = this.relativeOf(file), ext)) == null) continue;
            if (entry.files.size() >= 30000) {
                throw new IOException("目录规模过大（文件超过 30000 个），请选择更小的子目录");
            }
            entry.files.add(fe);
        }
    }

    private String relativeOf(Path path) {
        return this.absoluteRoot.relativize(path.toAbsolutePath().normalize()).toString().replace('\\', '/');
    }

    private static FileEntry classifyFile(String name, String relative, String ext) {
        String language = ProjectScanner.sourceLanguage(ext);
        if (language != null) {
            return new FileEntry(relative, name, "source", language, "");
        }
        String assetType = DirectoryGraphBuilder.assetTypeOf(name, relative, ext);
        if (!assetType.isBlank()) {
            return new FileEntry(relative, name, "asset", "", assetType);
        }
        return new FileEntry(relative, name, "other", "", "");
    }

    private static String assetTypeOf(String name, String relative, String ext) {
        String category = NodeRegistry.classifyExtension(name);
        if (Set.of("image", "model", "texture", "animation", "particle", "audio", "video").contains(category)) {
            return category;
        }
        if (Set.of("json", "txt", "xml", "mcmeta", "properties", "lang", "cfg", "conf").contains(ext)) {
            String normalized = relative.replace('\\', '/');
            for (String marker : RESOURCE_PACK_DIRS) {
                if (!normalized.contains("/" + marker + "/") && !normalized.startsWith(marker + "/")) continue;
                return "other";
            }
        }
        return "";
    }

    private static void classifyDirs(DirEntry entry) {
        for (DirEntry child : entry.dirs) {
            DirectoryGraphBuilder.classifyDirs(child);
        }
        entry.assetLeaf = entry.dirs.isEmpty() && !entry.files.isEmpty() && entry.files.stream().allMatch(f -> "asset".equals(f.kind()));
    }

    private WorkflowModel.Node buildDir(DirEntry dir, int x, int y, String parentScopeId) {
        return this.buildGroup(dir, x, y, parentScopeId);
    }

    private WorkflowModel.Node buildAssetBundle(DirEntry dir, int x, int y, String parentScopeId) {
        List<String> relativePaths = dir.files.stream().map(FileEntry::relativePath).toList();
        String bundleData = BundleDataUtil.buildV2BundleData(this.absoluteRoot, relativePaths);
        String dominantType = DirectoryGraphBuilder.dominantAssetType(dir.files);
        WorkflowModel.Node bundle = this.model.addAssetBundleNode(x, y, dir.name + " 资源组", bundleData, dominantType);
        bundle.relativePath = dir.relativePath;
        bundle.parentScopeId = parentScopeId;
        bundle.role = "folder";
        bundle.prompt = "资产目录: " + (dir.relativePath.isBlank() ? "(根)" : dir.relativePath) + "\n资源数: " + dir.files.size() + "\n输出端口包含每个内部资产的名称";
        return bundle;
    }

    private WorkflowModel.Node buildGroup(DirEntry dir, int x, int y, String parentScopeId) {
        WorkflowModel.Node group = this.model.addGroupNode(x, y, dir.name);
        group.relativePath = dir.relativePath;
        group.parentScopeId = parentScopeId;
        group.role = "folder";
        group.prompt = "文件夹: " + (dir.relativePath.isBlank() ? "（工程根）" : dir.relativePath) + "\n组输出收集组内全部内容，子组输出向上汇聚";
        group.inputs.clear();
        group.outputs.clear();
        group.inputs.add(new WorkflowModel.Port("grp_in_value", "组输入", "any", false));
        group.outputs.add(new WorkflowModel.Port("grp_out_value", "组输出", "any", false));
        WorkflowModel.Node gi = this.model.addGroupInputNode(x + 30, y + 40, dir.name + " 组输入");
        gi.parentScopeId = group.id;
        WorkflowModel.Node go = this.model.addNodeGroupOutput(x + 300, y + 40, dir.name + " 组输出");
        go.parentScopeId = group.id;
        group.groupInputNodeId = gi.id;
        ArrayList<WorkflowModel.Node> contents = new ArrayList<WorkflowModel.Node>();
        int cy = y + 140;
        for (DirEntry child : dir.dirs) {
            WorkflowModel.Node childNode = this.buildDir(child, x + 60, cy, group.id);
            contents.add(childNode);
            this.report("识别目录并建图", this.model.nodes().size(), this.totalFiles);
            cy += DirectoryGraphBuilder.slotHeight(childNode);
        }
        for (FileEntry file : dir.files) {
            WorkflowModel.Node fileNode = this.createFileNode(file, x + 60, cy, group.id);
            contents.add(fileNode);
            this.report("识别目录并建图", this.model.nodes().size(), this.totalFiles);
            cy += 110;
        }
        boolean valuePortUsed = false;
        for (WorkflowModel.Node content : contents) {
            WorkflowModel.Port in;
            WorkflowModel.Port out = DirectoryGraphBuilder.contentOutput(content);
            if (out == null) continue;
            if (!valuePortUsed) {
                in = this.model.input(go, "value");
                valuePortUsed = in != null;
            } else {
                in = this.model.addPort(go, false);
            }
            if (in == null) continue;
            in.name = content.name;
            this.model.connectNoRecompute(content, out, go, in);
        }
        // 画布上组节点保持紧凑尺寸（Blender 节点组风格），内部内容仅在组视图内可见
        group.containerWidth = 280;
        group.containerHeight = 150;
        return group;
    }

    private WorkflowModel.Node createFileNode(FileEntry file, int x, int y, String parentScopeId) {
        WorkflowModel.Node node;
        if ("asset".equals(file.kind())) {
            node = this.model.addAssetNode(x, y, file.name(), file.relativePath(), file.assetType());
            node.parentScopeId = parentScopeId;
            node.prompt = "资产: " + file.relativePath() + "\n类型: " + NodeRegistry.assetTypeLabel(file.assetType());
        } else {
            node = this.model.addFileNode(x, y, file.name(), file.relativePath());
            node.parentScopeId = parentScopeId;
            String language = file.kind().equals("source") && !file.language().isBlank() ? file.language() : "text";
            node.prompt = "语言: " + language + "\n路径: " + file.relativePath();
        }
        return node;
    }

    private static WorkflowModel.Port contentOutput(WorkflowModel.Node node) {
        return switch (node.nodeKind) {
            case WorkflowModel.NodeKind.GROUP -> node.outputs.stream().filter(p -> p.id.equals("grp_out_value")).findFirst().orElse(null);
            case WorkflowModel.NodeKind.ASSET_BUNDLE -> node.outputs.stream().filter(p -> p.id.equals("resources")).findFirst().orElse(null);
            case WorkflowModel.NodeKind.FILE -> node.outputs.stream().filter(p -> p.id.equals("exports")).findFirst().orElse(null);
            case WorkflowModel.NodeKind.ASSET -> node.outputs.stream().filter(p -> p.id.equals("resource")).findFirst().orElse(null);
            default -> node.outputs.isEmpty() ? null : node.outputs.getFirst();
        };
    }

    private static int slotHeight(WorkflowModel.Node node) {
        if (node.nodeKind == WorkflowModel.NodeKind.GROUP) {
            return 170;
        }
        if (node.nodeKind == WorkflowModel.NodeKind.ASSET_BUNDLE) {
            return 150;
        }
        return 110;
    }

    private static String dominantAssetType(List<FileEntry> files) {
        LinkedHashMap<String, Integer> counts = new LinkedHashMap<String, Integer>();
        for (FileEntry file : files) {
            counts.merge(file.assetType().isBlank() ? "other" : file.assetType(), 1, Integer::sum);
        }
        return counts.entrySet().stream().max(Comparator.comparingInt(Map.Entry::getValue)).map(Map.Entry::getKey).orElse("other");
    }

    public static interface Progress {
        public void report(String var1, int var2, int var3);
    }

    private static final class DirEntry {
        String name;
        String relativePath;
        Path path;
        final List<DirEntry> dirs = new ArrayList<DirEntry>();
        final List<FileEntry> files = new ArrayList<FileEntry>();
        boolean assetLeaf;

        private DirEntry() {
        }
    }

    private record FileEntry(String relativePath, String name, String kind, String language, String assetType) {
    }
}
