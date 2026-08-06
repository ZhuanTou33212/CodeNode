package local.codenode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 项目全量解析：递归扫描源码与资产文件，忽略构建/缓存目录与中间产物，
 * 输出分类结果供 ProjectGraphBuilder 建图使用。
 */
public final class ProjectScanner {

    /** 递归扫描时需要整体跳过的目录名（任意层级命中即跳过子树）。 */
    private static final Set<String> IGNORED_DIRS = Set.of(
        "target", "build", ".git", ".idea", "node_modules", "dist", "out", ".gradle", "cache"
    );

    /** 需要忽略的文件后缀。 */
    private static final Set<String> IGNORED_EXTS = Set.of("class", "jar", "war", "log", "tmp");

    /** 源码文件后缀 → 语言名。 */
    private static final Map<String,String> SOURCE_LANGS = Map.of(
        "java", "java", "kt", "kotlin", "py", "python"
    );

    /** 资产文件后缀（任务指定 json/png/xml/ogg/txt，其余常见资源由 classifyExtension 兜底）。 */
    private static final Set<String> ASSET_EXTS = Set.of(
        "json", "png", "xml", "ogg", "txt",
        "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tga", "dds", "psd",
        "wav", "mp3", "flac", "aac", "m4a", "opus",
        "mp4", "avi", "mkv", "mov", "webm",
        "fbx", "obj", "gltf", "glb", "blend", "stl", "dae", "usd", "usdz", "abc", "ply",
        "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "gradle", "proto", "csv",
        "md", "html", "css", "scss", "less"
    );

    /** 单文件源码信息。 */
    public record SourceFile(String relativePath, String name, String language, String packageName, List<String> imports) {}

    /** 单文件资产信息。 */
    public record AssetFile(String relativePath, String name, String assetType) {}

    /** 扫描结果容器：源码 + 资产分类输出。 */
    public record ScanResult(List<SourceFile> sourceFiles, List<AssetFile> assetFiles) {

        public ScanResult {
            sourceFiles = List.copyOf(sourceFiles);
            assetFiles  = List.copyOf(assetFiles);
        }

        public int total() { return sourceFiles.size() + assetFiles.size(); }
    }

    private ProjectScanner() {}

    /** 递归扫描项目根目录，返回按相对路径排序的源码与资产分类结果。 */
    public static ScanResult scan(Path root) throws IOException {
        if (root == null) throw new NoSuchFileException("项目根目录为空");
        Path absoluteRoot = root.toAbsolutePath().normalize();
        if (!Files.isDirectory(absoluteRoot)) throw new NoSuchFileException("目录不存在: " + absoluteRoot);

        List<SourceFile> sources = new ArrayList<>();
        List<AssetFile> assets = new ArrayList<>();
        final Map<Path,List<String>> importCache = new LinkedHashMap<>();

        Files.walkFileTree(absoluteRoot, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(absoluteRoot) && IGNORED_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String name = file.getFileName().toString();
                String ext = extension(name);
                if (IGNORED_EXTS.contains(ext)) return FileVisitResult.CONTINUE;
                String relative = absoluteRoot.relativize(file.toAbsolutePath().normalize())
                        .toString().replace('\\', '/');
                String language = SOURCE_LANGS.get(ext);
                if (language != null) {
                    List<String> imports = importCache.computeIfAbsent(file, ProjectScanner::readImports);
                    sources.add(new SourceFile(relative, name, language, packageOf(file, relative, language), imports));
                } else if (ASSET_EXTS.contains(ext) || !"other".equals(NodeRegistry.classifyExtension(name))) {
                    assets.add(new AssetFile(relative, name, NodeRegistry.classifyExtension(name)));
                }
                return FileVisitResult.CONTINUE;
            }
        });

        sources.sort(Comparator.comparing(SourceFile::relativePath));
        assets.sort(Comparator.comparing(AssetFile::relativePath));
        return new ScanResult(sources, assets);
    }

    /** 提取小写扩展名（不含点）。 */
    private static String extension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** 读取源码文件头部的 package 声明与 import 语句。 */
    private static final Pattern PACKAGE_PATTERN = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;");
    private static final Pattern IMPORT_PATTERN = Pattern.compile("^\\s*import\\s+([\\w.]+)\\s*;");
    private static final Pattern PY_FROM_PATTERN = Pattern.compile("^\\s*from\\s+([\\w.]+)\\s+import\\b");

    /** 读取源码文件前若干行的 import 语句列表（正则提取）。 */
    private static List<String> readImports(Path file) {
        List<String> imports = new ArrayList<>();
        try {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            int scanned = Math.min(lines.size(), 300);
            for (int i = 0; i < scanned; i++) {
                String line = lines.get(i).trim();
                Matcher imp = IMPORT_PATTERN.matcher(line);
                if (imp.find()) {
                    String value = imp.group(1);
                    // 忽略 java 标准库与单段导入（无类名无意义）
                    if (value.contains(".") && !value.startsWith("java.") && !value.startsWith("javax.")
                            && !value.startsWith("sun.") && !value.startsWith("jdk.")
                            && !value.startsWith("kotlin.")) {
                        imports.add(value);
                    }
                    continue;
                }
                Matcher from = PY_FROM_PATTERN.matcher(line);
                if (from.find()) {
                    imports.add(from.group(1));
                    continue;
                }
                if (i >= 60 && !line.startsWith("import ") && !line.startsWith("from ")) break;
            }
        } catch (IOException ignored) {
            // 读取失败不影响整体扫描
        }
        return List.copyOf(imports);
    }

    /** 解析源码包名：优先文件头部 package 声明；缺失时用相对路径回退（剥离 src 前缀）。 */
    private static String packageOf(Path file, String relative, String language) {
        if ("python".equals(language)) return "";
        String declared = null;
        try {
            List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            int scanned = Math.min(lines.size(), 200);
            for (int i = 0; i < scanned; i++) {
                String line = lines.get(i).trim();
                Matcher matcher = PACKAGE_PATTERN.matcher(line);
                if (matcher.find()) {
                    declared = matcher.group(1);
                    break;
                }
                if (i >= 60 && !line.startsWith("package ") && !line.startsWith("import ")) break;
            }
        } catch (IOException ignored) {
            // 读取失败时走路径回退
        }
        if (declared != null && !declared.isBlank()) return declared;
        int slash = relative.lastIndexOf('/');
        if (slash <= 0) return "";
        String dir = relative.substring(0, slash);
        // 剥离常见源码根前缀，如 src/main/java、src/main/kotlin、src
        for (String prefix : new String[]{"src/main/java/", "src/main/kotlin/", "src/", "app/src/main/java/", "app/src/main/kotlin/"}) {
            if (dir.startsWith(prefix)) return dir.substring(prefix.length()).replace('/', '.');
        }
        return dir.replace('/', '.');
    }
}
